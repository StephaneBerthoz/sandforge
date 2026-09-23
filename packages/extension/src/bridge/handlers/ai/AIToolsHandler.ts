import type { HandlerDeps, DomainHandler, InboundRequest } from '../HandlerTypes.js';
import { buildResponse } from '../HandlerTypes.js';
import {
  validatePayload,
  aiNl2SoqlPayloadSchema,
  aiForgePlanPayloadSchema,
  aiGeneratePipelinePayloadSchema,
} from '../../validatePayload.js';
import type { AIModules } from '../AIHandler.js';
import { extractErrorMessage } from '../../../core/common/extractErrorMessage.js';
import { getJsforceConnection } from '../../../core/connection/ConnectionHelper.js';
import { SchemaCache } from '../../../core/metadata/SchemaCache.js';
import {
  resolveMentionedObjects,
  type SObjectCatalogEntry,
} from '../../../modules/ai/mentionedObjects.js';
import type { NL2SOQL, NL2SOQLResult, SchemaContext } from '../../../modules/ai/NL2SOQL.js';
import type { OrgInfo } from '../../../modules/ai/PipelineGenerator.js';
import { checkForgeRootQuery } from '../../../modules/ai/forgeRootQuery.js';

/** Message types handled by AIToolsHandler. */
const AI_TOOLS_TYPES = new Set(['ai:nl2soql', 'ai:forge-plan', 'ai:generate-pipeline']);

/** What an AI feature answers when a prompt comes in and no provider is set up. */
const AI_NOT_CONFIGURED = 'AI not configured. Set your API key in Settings > AI.';

/**
 * The type the pipeline model is told an org has. The registry stores an
 * `OrgType` ('Production', 'Sandbox', ...) and the prompt shows the lowercase
 * names of {@link OrgInfo}; the cast that stood here passed 'Production'
 * through as is. An org the registry does not know, or whose stored type is
 * none of these, is described as production, the tier the guard gives it: the
 * model plans the draft from this word, and was told "sandbox" about an org
 * nothing showed to be one.
 */
function pipelineOrgType(orgType: string | undefined): OrgInfo['type'] {
  switch (orgType) {
    case 'Production':
      return 'production';
    case 'Sandbox':
      return 'sandbox';
    case 'Developer':
      return 'developer';
    case 'Scratch':
      return 'scratch';
    default:
      return 'production';
  }
}

/** One object of a {@link SchemaContext}, trimmed to what the prompt prints. */
type DescribedObject = SchemaContext['objects'][number];

/** Minimal jsforce surface this handler needs from a connection. */
interface SchemaConnection {
  describeGlobal(): Promise<{ sobjects: SObjectCatalogEntry[] }>;
  describe(name: string): Promise<{
    name: string;
    label?: string;
    fields: Array<{ name: string; label?: string; type: string; relationshipName?: string | null }>;
  }>;
  /** A REST call relative to the API version root, as jsforce resolves `/query/…`. */
  request(url: string): Promise<unknown>;
}

/**
 * Sub-handler for AI tool messages.
 *
 * Handles NL2SOQL translation, Forge's root query drafts and pipeline
 * generation. Error resolution is not one of them and has no channel in
 * either direction: a failure is resolved once by `sendOperationFailed`, on
 * the side that raises it, and the suggestion is shown there as a VS Code
 * notification.
 */
export class AIToolsHandler implements DomainHandler {
  private aiModules?: AIModules;

  /**
   * Per-org describeGlobal catalog. Same keys, TTL and shape as the caches in
   * `ForgeHandler` and `FrozenDatasetHandler`: org id in the key so switching
   * org can never read another org's schema, 5 minutes so a freshly deployed
   * SObject shows up without a reload. One call returns 1453 entries / ~1.3 MB
   * on a measured Developer Edition, so re-fetching it per keystroke is not
   * an option.
   */
  private readonly describeGlobalCache = new SchemaCache<SObjectCatalogEntry[]>({
    defaultTtl: 5 * 60_000,
    maxSize: 16,
    maxSizeBytes: 50 * 1024 * 1024,
  });

  /**
   * Per-object describes, already trimmed to apiName/label/type.
   *
   * The trimmed form is what both the prompt and the validator read, and it is
   * two orders of magnitude smaller than the raw describe (Account: 244 KB raw
   * → 3.6 KB of prompt), so the byte cap is generous and the entry cap does
   * the real bounding.
   */
  private readonly describeCache = new SchemaCache<DescribedObject>({
    defaultTtl: 5 * 60_000,
    maxSize: 50,
    maxSizeBytes: 20 * 1024 * 1024,
  });

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {}

  /**
   * Inject the model-backed modules. Passing `undefined` takes them
   * away, so an AI switched off mid-session stops NL2SOQL, error resolution
   * and pipeline drafts from reaching a provider.
   */
  setAIModules(modules: AIModules | undefined): void {
    this.aiModules = modules;
  }

  /**
   * Drop the catalogue and describes of an org that is no longer the org it
   * was: a refreshed sandbox takes production's schema as of the refresh, and
   * a query checked against its old fields could name one it lost.
   *
   * @param orgId - The registered org.
   */
  forgetOrg(orgId: string): void {
    this.describeGlobalCache.invalidate(orgId);
    this.describeCache.invalidateByPrefix(`${orgId}::`);
  }

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: InboundRequest): Promise<boolean> {
    if (!AI_TOOLS_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'ai:nl2soql':
        await this.handleNL2SOQL(msg);
        return true;
      case 'ai:forge-plan':
        await this.handleForgePlan(msg);
        return true;
      case 'ai:generate-pipeline':
        await this.handleGeneratePipeline(msg);
        return true;
      default:
        return false;
    }
  }

  private async handleNL2SOQL(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(aiNl2SoqlPayloadSchema, msg, 'ai:error', this.deps);
    if (!parsed) return;
    const { query, orgId } = parsed;
    try {
      const nl2soql = this.aiModules?.nl2soql;
      if (!nl2soql) {
        throw new Error(AI_NOT_CONFIGURED);
      }
      const conn = await this.connect(orgId);
      const catalog = await this.loadCatalog(orgId, conn);
      const { result, described } = await this.draft(nl2soql, query, orgId, conn, catalog);

      // The validator holds every catalog entry the prompt did not describe as
      // a bare name, so a FROM on an object nobody described is reported as
      // unverified instead of as a non-existent object.
      const describedNames = new Set(described.map((o) => o.apiName));
      const validationContext: SchemaContext = {
        objects: [
          ...described,
          ...catalog
            .filter((s) => !describedNames.has(s.name))
            .map((s) => ({ apiName: s.name, label: s.label, fields: [] })),
        ],
      };

      const validation = nl2soql.validateSOQL(result.soql, validationContext);

      // A rejected query is still shown: the draft is the useful part, the
      // error says which piece of it the org does not have. Swallowing it
      // would leave the user with nothing to correct.
      //
      // `verified` travels with it because an accepted draft is two different
      // things: one whose fields came back from a describe, and one nothing
      // was compared against. Computing the difference and dropping it would
      // put both on screen as the same answer. The reason travels too: the
      // panel has one sentence per cause, and guessing which applies from the
      // draft alone would put the wrong one on screen.
      const response = buildResponse(this.deps, msg, 'ai:nl2soql:response', {
        success: validation.valid,
        soql: result.soql,
        explanation: result.explanation,
        verified: validation.verified,
        ...(validation.unverifiedReason ? { unverifiedReason: validation.unverifiedReason } : {}),
        ...(validation.valid ? {} : { error: validation.errors.join(' ') }),
      });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      this.deps.log(`[ERR] ai:nl2soql: ${extractErrorMessage(err)}`);
      const errResp = buildResponse(this.deps, msg, 'ai:nl2soql:response', {
        success: false,
        error: extractErrorMessage(err),
      });
      this.deps.broker.postToWebview(errResp);
    }
  }

  /**
   * Draft the query Forge's discovery starts from, or check again one the user
   * edited, against the source org.
   *
   * The draft is NL2SOQL's, from the same prompt context, so the model is sent
   * nothing more than the Seed helper sends it. The check is Forge's own: the
   * object after FROM, then every field and relationship the query names at
   * its top level, then the org's parser (see `checkForgeRootQuery`). An
   * edited query reaches no model and is sent with no provider set up.
   *
   * A draft that fails the check is still returned with what was found, so the
   * user can correct it rather than start over. Nothing here discovers or
   * writes anything: the user runs the query from the Forge form.
   */
  private async handleForgePlan(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(aiForgePlanPayloadSchema, msg, 'ai:error', this.deps);
    if (!parsed) return;
    const { orgId, prompt } = parsed;
    try {
      const nl2soql = this.aiModules?.nl2soql;
      if (prompt !== undefined && !nl2soql) {
        this.deps.broker.postToWebview(
          buildResponse(this.deps, msg, 'ai:forge-plan:response', {
            success: false,
            code: 'AI_NOT_CONFIGURED',
            error: AI_NOT_CONFIGURED,
          }),
        );
        return;
      }
      const conn = await this.connect(orgId);
      const catalog = await this.loadCatalog(orgId, conn);
      let soql = parsed.soql ?? '';
      let explanation: string | undefined;
      if (prompt !== undefined && nl2soql) {
        const { result } = await this.draft(nl2soql, prompt, orgId, conn, catalog);
        soql = result.soql;
        explanation = result.explanation;
      }

      const check = await checkForgeRootQuery(soql, {
        catalog,
        describe: async (name) => {
          const object = await this.describeObject(orgId, conn, name);
          return {
            name: object.apiName,
            label: object.label,
            fields: object.fields.map((f) => ({
              name: f.apiName,
              relationshipName: f.relationshipName,
            })),
          };
        },
        explain: (query) => conn.request(`/query/?explain=${encodeURIComponent(query)}`),
      });

      this.deps.broker.postToWebview(
        buildResponse(this.deps, msg, 'ai:forge-plan:response', {
          success: check.problems.length === 0,
          soql,
          ...(explanation ? { explanation } : {}),
          ...(check.rootObject ? { rootObject: check.rootObject } : {}),
          ...(check.rootLabel ? { rootLabel: check.rootLabel } : {}),
          fieldsChecked: check.fieldsChecked,
          problems: check.problems,
        }),
      );
    } catch (err: unknown) {
      this.deps.log(`[ERR] ai:forge-plan: ${extractErrorMessage(err)}`);
      this.deps.broker.postToWebview(
        buildResponse(this.deps, msg, 'ai:forge-plan:response', {
          success: false,
          error: extractErrorMessage(err),
        }),
      );
    }
  }

  /** The org's connection, reduced to what this handler calls on it. */
  private async connect(orgId: string): Promise<SchemaConnection> {
    return (await getJsforceConnection(
      orgId,
      this.deps.orgRegistry,
      this.deps.orgManager,
    )) as unknown as SchemaConnection;
  }

  /**
   * Ask the model for a query, with the schema of the objects the request
   * names.
   *
   * The prompt carries the described objects when the request named any: the
   * full catalog is ~21 500 tokens of names the model cannot build a SELECT
   * from, so it is a last resort, sent only when nothing was recognised and
   * the alternative is a prompt with no schema at all.
   */
  private async draft(
    nl2soql: NL2SOQL,
    request: string,
    orgId: string,
    conn: SchemaConnection,
    catalog: SObjectCatalogEntry[],
  ): Promise<{ result: NL2SOQLResult; described: DescribedObject[] }> {
    const mentioned = resolveMentionedObjects(request, catalog);
    const described = await this.describeObjects(orgId, conn, mentioned);
    const promptContext: SchemaContext = {
      objects:
        described.length > 0
          ? described
          : catalog.map((s) => ({ apiName: s.name, label: s.label, fields: [] })),
    };
    const result = await nl2soql.generateSOQL(request, promptContext);
    return { result, described };
  }

  /**
   * describeGlobal for an org, reduced to the fields matching needs, cached.
   *
   * Objects that cannot appear in a FROM clause are dropped here: on the
   * measured org that is 234 of 1453 entries the model would otherwise be
   * invited to query, and their names are the only thing this list costs.
   */
  private async loadCatalog(orgId: string, conn: SchemaConnection): Promise<SObjectCatalogEntry[]> {
    const cached = this.describeGlobalCache.get(orgId);
    if (cached) return cached;
    const globalDesc = await conn.describeGlobal();
    const catalog = globalDesc.sobjects
      .filter((s) => s.queryable !== false)
      .map((s) => ({
        name: s.name,
        label: s.label,
        labelPlural: s.labelPlural,
        queryable: s.queryable,
      }));
    this.describeGlobalCache.set(orgId, catalog);
    return catalog;
  }

  /**
   * Describe the named objects, one REST round trip each (~2 s measured),
   * serving repeats from cache. An object that fails to describe is dropped
   * rather than failing the request: a query over the remaining objects is
   * still worth returning, and it will simply come back unverified.
   */
  private async describeObjects(
    orgId: string,
    conn: SchemaConnection,
    names: readonly string[],
  ): Promise<DescribedObject[]> {
    const out: DescribedObject[] = [];
    for (const name of names) {
      try {
        out.push(await this.describeObject(orgId, conn, name));
      } catch (err: unknown) {
        this.deps.log(`[WARN] ai:nl2soql describe ${name}: ${extractErrorMessage(err)}`);
      }
    }
    return out;
  }

  /**
   * Describe one object, serving a repeat from cache; throws what the org
   * answered when it cannot.
   */
  private async describeObject(
    orgId: string,
    conn: SchemaConnection,
    name: string,
  ): Promise<DescribedObject> {
    const cacheKey = `${orgId}::${name}`;
    const cached = this.describeCache.get(cacheKey);
    if (cached) return cached;
    const meta = await conn.describe(name);
    const object: DescribedObject = {
      apiName: meta.name,
      label: meta.label ?? meta.name,
      fields: meta.fields.map((f) => ({
        apiName: f.name,
        label: f.label ?? f.name,
        type: f.type,
        ...(f.relationshipName ? { relationshipName: f.relationshipName } : {}),
      })),
    };
    this.describeCache.set(cacheKey, object);
    return object;
  }

  private async handleGeneratePipeline(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(aiGeneratePipelinePayloadSchema, msg, 'ai:error', this.deps);
    if (!parsed) return;
    const { description, orgIds } = parsed;
    try {
      if (!this.aiModules?.pipelineGenerator) {
        throw new Error(
          'AI not configured. Set your API key in Settings > AI to enable this feature.',
        );
      }
      const availableOrgs = (orgIds ?? []).map((id: string) => {
        const org = this.deps.orgManager.getOrg(id);
        return {
          orgId: id,
          alias: org?.alias ?? id,
          type: pipelineOrgType(org?.orgType),
        };
      });
      const result = await this.aiModules.pipelineGenerator.generatePipeline(
        description,
        availableOrgs,
      );
      // A keyword match always yields a step, so a draft with none is a model
      // reply nothing could be read from. Answered as a success it opened an
      // empty canvas with no word of why; refused, the page shows the reason.
      if (result.steps.length === 0) {
        throw new Error(
          'The AI returned a pipeline with no steps, so there is nothing to load. Name the operations it should run, for example: sync Account from dev to uat, then compare.',
        );
      }
      const response = buildResponse(this.deps, msg, 'ai:generate-pipeline:response', {
        success: true,
        pipeline: result as unknown as Record<string, unknown>,
      });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      this.deps.log(`[ERR] ai:generate-pipeline: ${extractErrorMessage(err)}`);
      const errResp = buildResponse(this.deps, msg, 'ai:generate-pipeline:response', {
        success: false,
        error: extractErrorMessage(err),
      });
      this.deps.broker.postToWebview(errResp);
    }
  }
}
