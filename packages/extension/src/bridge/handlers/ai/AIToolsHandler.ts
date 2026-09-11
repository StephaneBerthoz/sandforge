import type { HandlerDeps, DomainHandler, InboundRequest } from '../HandlerTypes.js';
import { buildResponse } from '../HandlerTypes.js';
import {
  validatePayload,
  aiNl2SoqlPayloadSchema,
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
import type { SchemaContext } from '../../../modules/ai/NL2SOQL.js';

/** Message types handled by AIToolsHandler. */
const AI_TOOLS_TYPES = new Set(['ai:nl2soql', 'ai:generate-pipeline']);

/** One object of a {@link SchemaContext}, trimmed to what the prompt prints. */
type DescribedObject = SchemaContext['objects'][number];

/** Minimal jsforce surface this handler needs from a connection. */
interface SchemaConnection {
  describeGlobal(): Promise<{ sobjects: SObjectCatalogEntry[] }>;
  describe(name: string): Promise<{
    name: string;
    label?: string;
    fields: Array<{ name: string; label?: string; type: string }>;
  }>;
}

/**
 * Sub-handler for AI tool messages.
 *
 * Handles NL2SOQL translation and pipeline generation. Error resolution has no
 * inbound channel: a failure is resolved once by `sendOperationFailed`, on the
 * side that raises it — see the note on `AIResolveErrorResponse`.
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
      if (!this.aiModules?.nl2soql) {
        throw new Error('AI not configured. Set your API key in Settings > AI.');
      }
      const conn = (await getJsforceConnection(
        orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      )) as unknown as SchemaConnection;
      const catalog = await this.loadCatalog(orgId, conn);
      const mentioned = resolveMentionedObjects(query, catalog);
      const described = await this.describeObjects(orgId, conn, mentioned);

      // What the model sees and what the validator checks are deliberately
      // different. The prompt carries the described objects when the request
      // named any: the full catalog is ~21 500 tokens of names the model
      // cannot build a SELECT from, so it is a last resort, sent only when
      // nothing was recognised and the alternative is a prompt with no schema
      // at all. The validator additionally holds every catalog entry as a bare
      // name, so a FROM on an object nobody described is reported as
      // unverified instead of as a non-existent object.
      const promptContext: SchemaContext = {
        objects:
          described.length > 0
            ? described
            : catalog.map((s) => ({ apiName: s.name, label: s.label, fields: [] })),
      };
      const describedNames = new Set(described.map((o) => o.apiName));
      const validationContext: SchemaContext = {
        objects: [
          ...described,
          ...catalog
            .filter((s) => !describedNames.has(s.name))
            .map((s) => ({ apiName: s.name, label: s.label, fields: [] })),
        ],
      };

      const result = await this.aiModules.nl2soql.generateSOQL(query, promptContext);
      const validation = this.aiModules.nl2soql.validateSOQL(result.soql, validationContext);

      // A rejected query is still shown: the draft is the useful part, the
      // error says which piece of it the org does not have. Swallowing it
      // would leave the user with nothing to correct.
      //
      // `verified` travels with it because an accepted draft is two different
      // things: one whose fields came back from a describe, and one written
      // against an object nobody could describe. Computing the difference and
      // dropping it would put both on screen as the same answer.
      const response = buildResponse(this.deps, msg, 'ai:nl2soql:response', {
        success: validation.valid,
        soql: result.soql,
        explanation: result.explanation,
        verified: validation.verified,
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
      const cacheKey = `${orgId}::${name}`;
      const cached = this.describeCache.get(cacheKey);
      if (cached) {
        out.push(cached);
        continue;
      }
      try {
        const meta = await conn.describe(name);
        const object: DescribedObject = {
          apiName: meta.name,
          label: meta.label ?? meta.name,
          fields: meta.fields.map((f) => ({
            apiName: f.name,
            label: f.label ?? f.name,
            type: f.type,
          })),
        };
        this.describeCache.set(cacheKey, object);
        out.push(object);
      } catch (err: unknown) {
        this.deps.log(`[WARN] ai:nl2soql describe ${name}: ${extractErrorMessage(err)}`);
      }
    }
    return out;
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
          type: (org?.orgType ?? 'sandbox') as 'production' | 'sandbox' | 'developer' | 'scratch',
        };
      });
      const result = await this.aiModules.pipelineGenerator.generatePipeline(
        description,
        availableOrgs,
      );
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
