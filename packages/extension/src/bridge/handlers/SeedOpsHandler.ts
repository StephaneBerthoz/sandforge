import type {
  GuardDecision,
  SeedTemplate,
  PersonaMsg,
  SeedExecutionResult,
  SeedExecuteRequest,
} from '@sandforge/shared';
import {
  recordWriteHeaders,
  integerDigitsOf,
  sanitizeSoqlObjectName,
  guardTierOf,
} from '@sandforge/shared';
import type {
  HandlerDeps,
  DomainHandler,
  GrappeEventEnvelope,
  InboundRequest,
  OperationFailureContext,
} from './HandlerTypes.js';
import {
  buildResponse,
  sendHandlerError,
  sendOperationStarted,
  sendOperationProgress,
  sendOperationCompleted,
  sendOperationFailed,
  objectsFailureContext,
  postGrappeEvent,
  readGrappeConfig,
  robustnessConfigOf,
  bulkManagerOf,
  PRODUCTION_GUARD_MISSING,
  GUARD_REFUSAL,
  guardBlockedError,
  guardRefusalCode,
} from './HandlerTypes.js';
import { SeedTemplateStore } from '../../modules/seed/SeedTemplateStore.js';
import { SeedTemplateManager } from '../../modules/seed/SeedTemplateManager.js';
import { AIPersonaManager } from '../../modules/ai/AIPersonaManager.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { isNetworkError } from '../../core/common/isNetworkError.js';
import {
  validatePayload,
  seedExecutePayloadSchema,
  seedDescribeGlobalPayloadSchema,
  seedDescribeObjectPayloadSchema,
  seedTemplateIdPayloadSchema,
  seedTemplateSavePayloadSchema,
  seedCreatePersonaPayloadSchema,
} from '../validatePayload.js';
import { RetryableOperation } from '../../core/engine/RetryableOperation.js';
import { TimeoutManager } from '../../core/engine/TimeoutManager.js';
import { BulkApiExecutor } from '../../core/engine/BulkApiExecutor.js';
import type {
  BulkApiConnection,
  BulkApiExecutorDeps,
  BulkExecutionResult,
} from '../../core/engine/BulkApiExecutor.js';
import { ChunkedBulkExecutor } from '../../core/engine/ChunkedBulkExecutor.js';
import type { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import type { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import type {
  InsertedRow,
  InsertResult,
  SeedProgressEvent,
} from '../../modules/seed/SeedOrchestrator.js';
import {
  bulkSaveErrorDetail,
  formatSaveError,
  saveErrorDetail,
} from '../../core/common/existingRecordMatch.js';
import type { SeedRunCreations } from '../../modules/seed/SeedRunCreations.js';
import {
  personRecordTypes,
  seedRecordTypeOptions,
  templateForAccountKinds,
} from '../../modules/seed/seedRecordTypes.js';
import { ACCOUNT, leftOutForAccountKind } from '../../core/common/platformRecords.js';
import { consultProductionGuard } from '../../core/precheck/consultProductionGuard.js';
import { seedStorageGate } from '../../modules/seed/seedStorage.js';
import { formatMB } from '../../modules/forge/ForgeRunGate.js';
import { seedLocaleOf } from '../../modules/seed/seedLocale.js';
import { objectsUnderDuplicateRules } from '../../modules/seed/seedDuplicateRules.js';
import { emptyCounts, recordWriteRun } from '../../modules/audit/auditTrail.js';
import { isUncopyableObject } from '@sandforge/shared';

/** Record count threshold above which streaming pipeline is used per object. */
const STREAMING_THRESHOLD = 10_000;

/** The code a seed refused for the data storage it takes is answered with. */
const SEED_STORAGE_EXCEEDED = 'SEED_STORAGE_EXCEEDED';

/** What a seed runs with once its request is read. */
interface SeedRunPayload {
  orgId: string;
  template: Record<string, unknown>;
  /** The objects written as person accounts (`templateForAccountKinds`). */
  personObjects: string[];
  /** The locale its people and places are drawn in. */
  locale: string;
}

/**
 * Extra `operation:failed` payload for transport-level seed failures.
 *
 * Seeds are INSERTs — replaying a whole template after partial inserts would
 * duplicate records, so failed seeds are NEVER queued for offline replay
 * (sync upserts are quasi-idempotent and keep the auto-replay). On a network
 * error the failure payload carries an explicit hint instead: the user
 * re-runs the template manually from the Seed module once the org is
 * reachable again, with validation and production guards re-applied.
 *
 * Returns undefined for non-network errors (no hint added).
 */
function buildOfflineReplayHint(
  err: unknown,
  operationId: string,
  log: (msg: string) => void,
): Record<string, unknown> | undefined {
  if (!isNetworkError(err)) {
    return undefined;
  }
  log(`[OFFLINE] seed NOT queued for replay (inserts are not idempotent): ${operationId}`);
  return {
    offlineReplayAvailable: false,
    retryHint:
      'Seed operations are not queued for offline replay (inserts are not idempotent — replaying could duplicate records). Re-run the template manually once the org is reachable again.',
  };
}

/**
 * Created ids and error messages posted back per object, at most. The whole
 * lists went over the bridge: a 50,000-record seed serialised 50,000 ids into
 * one message for a results step that shows counts. recordsCreated and
 * recordsFailed keep the totals, and `truncated` says the lists were cut.
 */
const MAX_RESULT_ENTRIES_PER_OBJECT = 1_000;

/** The result as it is posted to the webview, with its per-object lists capped. */
function capResultForBridge(result: SeedExecutionResult): SeedExecutionResult {
  if (!Array.isArray(result.objectResults)) return result;
  return {
    ...result,
    objectResults: result.objectResults.map((objectResult) => {
      const truncated =
        objectResult.createdIds.length > MAX_RESULT_ENTRIES_PER_OBJECT ||
        objectResult.errors.length > MAX_RESULT_ENTRIES_PER_OBJECT;
      if (!truncated) return objectResult;
      return {
        ...objectResult,
        createdIds: objectResult.createdIds.slice(0, MAX_RESULT_ENTRIES_PER_OBJECT),
        errors: objectResult.errors.slice(0, MAX_RESULT_ENTRIES_PER_OBJECT),
        truncated,
      };
    }),
  };
}

/** Why a seed that wrote nothing failed: the first thing one of its objects was refused for. */
function seedFailureReason(result: SeedExecutionResult): string {
  const first = result.objectResults.flatMap((object) => object.errors)[0];
  return first ?? 'The seed wrote no records.';
}

/** The most errors kept for one refused record; the rest are counted. */
const MAX_ERRORS_PER_RECORD = 5;

/**
 * What the org said about one refused record, as one entry: the orchestrator
 * counts refused records by the entries. Every error is kept, up to
 * {@link MAX_ERRORS_PER_RECORD}. Only the first used to be: a row refused for
 * a missing name and a bad email said only the first, and the run that fixed
 * it met the second.
 *
 * Each error is written with its code and the fields it named
 * (`formatSaveError`), as a Bulk API job's `sf__Error` carries them: the
 * message alone was kept, and the results could neither group the refusals of
 * a run by what refused them nor say what to do about one.
 */
function recordErrorText(errors: readonly unknown[] | undefined): string {
  const messages = (errors ?? [])
    .map((error) => formatSaveError(error))
    .filter((message) => message !== '' && message !== 'Unknown error');
  if (messages.length === 0) return 'Unknown insert error';
  const kept = messages.slice(0, MAX_ERRORS_PER_RECORD).join('; ');
  const more = messages.length - MAX_ERRORS_PER_RECORD;
  return more > 0 ? `${kept} (and ${more} more)` : kept;
}

/**
 * What a Bulk API job answered for each record, in the order sent, its
 * refusals read with the code and fields of their `sf__Error`
 * (`bulkSaveErrorDetail`): what a row refused on a field a validation rule
 * named is sent again from. Nothing when the job's answer cannot be laid on
 * the records one for one — a row matched to none, a record written without
 * its id said — or when the cancel aborted it: a row is never sent again on a
 * guess.
 */
function bulkRows(result: BulkExecutionResult, sent: number): InsertedRow[] | undefined {
  if (result.aborted || result.outcomes.length !== sent || (result.unmatchedIds?.length ?? 0) > 0) {
    return undefined;
  }
  if (result.failures.some((failure) => failure.recordIndex < 0)) return undefined;
  const rows: InsertedRow[] = new Array<InsertedRow>(sent);
  for (const outcome of result.outcomes) {
    if (outcome.recordIndex < 0 || outcome.recordIndex >= sent) return undefined;
    if (outcome.success) {
      if (!outcome.id) return undefined;
      rows[outcome.recordIndex] = { id: outcome.id };
    } else {
      const error = outcome.error ?? 'Unknown error';
      const detail = bulkSaveErrorDetail(error);
      rows[outcome.recordIndex] = { error, ...(detail ? { errorDetails: [detail] } : {}) };
    }
  }
  return rows.every((row) => row !== undefined) ? rows : undefined;
}

/** Message types handled by SeedOpsHandler. */
const SEED_TYPES = new Set([
  'seed:execute',
  'seed:describe-global',
  'seed:describe-object',
  'seed:template:save',
  'seed:template:load',
  'seed:template:list',
  'seed:template:delete',
  'seed:list-personas',
  'seed:create-persona',
]);

/**
 * Domain handler for seed-related webview-to-extension messages.
 *
 * Routes seed:* message types to schema description and data generation
 * operations against Salesforce orgs, with production guard checks,
 * performance tracking, retry, timeout, and bulk API support.
 */
export class SeedOpsHandler implements DomainHandler {
  /** Persistence facade for seed templates. */
  private readonly seedTemplateStore: SeedTemplateStore;

  /** Template manager backed by persistent store. */
  private readonly templateManager: SeedTemplateManager;

  /** AI persona manager for built-in and custom personas. */
  private readonly personaManager: AIPersonaManager;

  /** Background operation registry for detached execution. */
  private registry?: BackgroundOperationRegistry;

  /** Live operation tracker feeding the Monitor "live operations" panel. */
  private liveTracker?: LiveOperationTracker;

  /** What each run created, kept on disk for its removal. */
  private runCreations?: SeedRunCreations;

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {
    this.seedTemplateStore = new SeedTemplateStore(deps.configStore);
    this.templateManager = new SeedTemplateManager(
      () => crypto.randomUUID(),
      () => new Date().toISOString(),
      this.seedTemplateStore,
    );
    this.personaManager = new AIPersonaManager();
  }

  /**
   * Set the background operation registry for detached execution.
   * Called from ExtensionHandlers after construction.
   *
   * @param registry - The shared BackgroundOperationRegistry instance.
   */
  setRegistry(registry: BackgroundOperationRegistry): void {
    this.registry = registry;
  }

  /**
   * Inject the live operation tracker so seed executions show up in the
   * Monitor "live operations" panel. Called from ExtensionHandlers.
   *
   * @param tracker - The shared LiveOperationTracker instance.
   */
  setLiveOperationTracker(tracker: LiveOperationTracker): void {
    this.liveTracker = tracker;
  }

  /**
   * Where each run keeps what it created, whole, for its removal from the
   * results (`seed:remove`): the results the page gets carry the first
   * thousand ids of an object at most.
   */
  setRunCreations(store: SeedRunCreations): void {
    this.runCreations = store;
  }

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: InboundRequest): Promise<boolean> {
    if (!SEED_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'seed:describe-global':
        await this.handleDescribeGlobal(msg);
        return true;
      case 'seed:describe-object':
        await this.handleDescribeObject(msg);
        return true;
      case 'seed:execute':
        await this.handleExecute(msg);
        return true;
      case 'seed:template:save':
        await this.handleTemplateSave(msg);
        return true;
      case 'seed:template:load':
        await this.handleTemplateLoad(msg);
        return true;
      case 'seed:template:list':
        await this.handleTemplateList(msg);
        return true;
      case 'seed:template:delete':
        await this.handleTemplateDelete(msg);
        return true;
      case 'seed:list-personas':
        await this.handleListPersonas(msg);
        return true;
      case 'seed:create-persona':
        await this.handleCreatePersona(msg);
        return true;
      default:
        return false;
    }
  }

  /** Save a seed template (create new or update existing). */
  private async handleTemplateSave(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(seedTemplateSavePayloadSchema, msg, 'seed:error', this.deps);
    if (!parsed) return;
    try {
      const template = parsed.template as unknown as SeedTemplate;

      if (template.id && this.templateManager.get(template.id)) {
        const updated = this.templateManager.update(template.id, template);
        const response = buildResponse(this.deps, msg, 'seed:template:save:response', {
          success: true,
          id: updated.id,
        });
        this.deps.broker.postToWebview(response);
        this.deps.log(`[TX] ${response.type} id=${response.id}`);
      } else {
        const created = this.templateManager.create(template);
        const response = buildResponse(this.deps, msg, 'seed:template:save:response', {
          success: true,
          id: created.id,
        });
        this.deps.broker.postToWebview(response);
        this.deps.log(`[TX] ${response.type} id=${response.id}`);
      }
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'seed:template:save', 'seed:error', msg, err);
    }
  }

  /** Load a seed template by ID. */
  private async handleTemplateLoad(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(seedTemplateIdPayloadSchema, msg, 'seed:error', this.deps);
    if (!parsed) return;
    try {
      const template = this.seedTemplateStore.load(parsed.id);
      const response = buildResponse(this.deps, msg, 'seed:template:load:response', {
        template: (template as unknown as Record<string, unknown>) ?? null,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'seed:template:load', 'seed:error', msg, err);
    }
  }

  /** List all seed templates (summary view). */
  private async handleTemplateList(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    try {
      const templates = this.seedTemplateStore.list();
      const summaries = templates.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        tags: t.tags,
        updatedAt: t.updatedAt,
        objectCount: t.objects.length,
        totalRecords: t.objects.reduce((sum, o) => sum + o.recordCount, 0),
      }));
      const response = buildResponse(this.deps, msg, 'seed:template:list:response', {
        templates: summaries,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'seed:template:list', 'seed:error', msg, err);
    }
  }

  /** Delete a seed template by ID. */
  private async handleTemplateDelete(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(seedTemplateIdPayloadSchema, msg, 'seed:error', this.deps);
    if (!parsed) return;
    try {
      const success = this.seedTemplateStore.delete(parsed.id);
      const response = buildResponse(this.deps, msg, 'seed:template:delete:response', { success });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'seed:template:delete', 'seed:error', msg, err);
    }
  }

  /** List all built-in and custom personas. */
  private async handleListPersonas(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    try {
      const builtIn = this.personaManager.getBuiltInPersonas();
      const custom = this.personaManager.getCustomPersonas();
      const personas: PersonaMsg[] = [...builtIn, ...custom].map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        industry: p.industry,
        locale: p.locale,
        dataPatterns: p.dataPatterns,
      }));
      const response = buildResponse(this.deps, msg, 'seed:list-personas:response', { personas });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'seed:list-personas', 'seed:error', msg, err);
    }
  }

  /** Create a custom persona from a text description using AI. */
  private async handleCreatePersona(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(seedCreatePersonaPayloadSchema, msg, 'seed:error', this.deps);
    if (!parsed) return;
    try {
      const payload = parsed;
      if (!payload.description || payload.description.trim().length === 0) {
        const response = buildResponse(this.deps, msg, 'seed:create-persona:response', {
          persona: {
            id: '',
            name: '',
            description: '',
            industry: '',
            locale: '',
            dataPatterns: {},
          },
          success: false,
          error: 'Description is required to create a custom persona',
        });
        this.deps.broker.postToWebview(response);
        return;
      }

      const services = this.deps.services;
      if (!services?.isAIEnabled()) {
        throw new Error(
          'AI is disabled. Enable sandforge.ai.enabled and add your Anthropic API key in ' +
            'SandForge Settings > AI > API key to create custom personas.',
        );
      }
      // Route through the unified AI client (breaker + budget + redaction).
      // A missing key surfaces AnthropicAdapter's explicit "not configured" error.
      const aiProvider = async (prompt: string): Promise<string> => {
        const result = await services.aiClient().chat({
          messages: [{ role: 'user', content: prompt }],
        });
        return result.text;
      };

      const persona = await this.personaManager.createCustomPersona(
        payload.description,
        aiProvider,
      );
      const personaMsg: PersonaMsg = {
        id: persona.id,
        name: persona.name,
        description: persona.description,
        industry: persona.industry,
        locale: persona.locale,
        dataPatterns: persona.dataPatterns,
      };
      const response = buildResponse(this.deps, msg, 'seed:create-persona:response', {
        persona: personaMsg,
        success: true,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'seed:create-persona', 'seed:error', msg, err);
    }
  }

  /**
   * Build the AI call function for seed data generation.
   * When AI is enabled, routes prompts through the unified client (breaker +
   * budget). When AI is disabled — or when a call fails (missing key, open
   * breaker, token budget, network, or an answer the model declined, cut off
   * or left empty) — returns '[]': FieldMapper then fills every ai_generate
   * field the call left empty with a generated sentence, so the run continues
   * and the refusal is only logged.
   */
  private buildSeedCallAI(): (prompt: string) => Promise<string> {
    const services = this.deps.services;
    if (!services?.isAIEnabled()) {
      return async () => '[]';
    }
    return async (prompt: string): Promise<string> => {
      try {
        const result = await services.aiClient().chat({
          messages: [{ role: 'user', content: prompt }],
        });
        return result.text;
      } catch (err: unknown) {
        this.deps.log(
          `[AI] seed data generation failed, falling back to faker: ${extractErrorMessage(err)}`,
        );
        return '[]';
      }
    };
  }

  private async handleDescribeGlobal(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(seedDescribeGlobalPayloadSchema, msg, 'seed:error', this.deps);
    if (!parsed) return;
    const payload = parsed;
    const config = robustnessConfigOf(this.deps);

    try {
      const conn = await getJsforceConnection(
        payload.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );

      const timeout = new TimeoutManager(config.timeouts.describeGlobal);
      const result = await timeout.withTimeout('describe-global', () => conn.describeGlobal());

      const objects = result.sobjects
        .filter((s: { createable: boolean }) => s.createable)
        // See SeedCloneHandler: `createable` is not "a copy can make one".
        .filter((s: { name: string }) => !isUncopyableObject(s.name))
        .map((s: { name: string; label: string }) => ({
          apiName: s.name,
          label: s.label,
          recordCount: 0,
          dependencies: [],
        }));

      const response = buildResponse(this.deps, msg, 'seed:describe-global:response', { objects });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'seed:describe-global', 'seed:error', msg, err);
    }
  }

  private async handleDescribeObject(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(seedDescribeObjectPayloadSchema, msg, 'seed:error', this.deps);
    if (!parsed) return;
    const payload = parsed;
    const config = robustnessConfigOf(this.deps);

    try {
      const conn = await getJsforceConnection(
        payload.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const safeObjectName = sanitizeSoqlObjectName(payload.objectApiName);

      const timeout = new TimeoutManager(config.timeouts.describe);
      const result = await timeout.withTimeout('describe-object', () =>
        conn.describe(safeObjectName),
      );

      const fields = (
        result.fields as {
          name: string;
          label: string;
          type: string;
          nillable: boolean;
          defaultedOnCreate: boolean;
          picklistValues?: { value: string }[];
          referenceTo?: string[];
          length: number;
          createable: boolean;
          precision?: number;
          scale?: number;
          digits?: number;
        }[]
      )
        .filter((f) => f.createable)
        .map((f) => ({
          fieldApiName: f.name,
          label: f.label,
          type: f.type,
          required: !f.nillable && !f.defaultedOnCreate,
          picklistValues: f.picklistValues?.map((pv) => pv.value) ?? [],
          referenceTo: f.referenceTo ?? [],
          length: f.length,
          integerDigits: integerDigitsOf(f),
          // The wizard gives each field its first rule from this description
          // alone, and a name field holds a person's name on a contact and a
          // company's on an account.
          objectApiName: payload.objectApiName,
        }));

      // The record types the panel lets a seed choose, a person account's
      // marked: it offered none, and person accounts were seeded from the
      // command line only.
      const recordTypes = seedRecordTypeOptions(
        safeObjectName,
        (result as { recordTypeInfos?: unknown }).recordTypeInfos,
        safeObjectName === ACCOUNT ? await personRecordTypes(conn) : [],
      );
      const response = buildResponse(this.deps, msg, 'seed:describe-object:response', {
        objectApiName: payload.objectApiName,
        objectLabel: (result as { label: string }).label,
        fields,
        recordTypes,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'seed:describe-object', 'seed:error', msg, err);
    }
  }

  private async handleExecute(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const validated = validatePayload(seedExecutePayloadSchema, msg, 'seed:error', this.deps);
    if (!validated) return;
    // The declared message type must accept what the schema lets through:
    // this assignment fails to compile when the two drift apart.
    const parsed: SeedExecuteRequest['payload'] & typeof validated = validated;
    // Seed has no dry run. The flag used to return `{ dryRun: true,
    // insertedCount: 0, results: [] }` before generating anything: nothing was
    // written, but nothing was previewed either, and the answer read as a
    // preview that had passed. Refused here, before the org is touched.
    if (parsed.dryRun === true) {
      sendHandlerError(
        this.deps,
        'seed:execute',
        'seed:error',
        msg,
        new Error('Seed has no dry run: remove "dryRun" from this request to run the seed.'),
        { code: 'DRY_RUN_UNSUPPORTED', retryable: false },
      );
      return;
    }
    // The request id is the operation id, as for sync: the page knows the id of
    // the request it sent, so it can match operation:* events and aim
    // execution:abort at its own run rather than whichever run reported last.
    const operationId = msg.id;
    const failure: OperationFailureContext = { module: 'seed', operation: msg.type };

    try {
      // Fill per-object batch sizes from the `sandforge.seed.defaultBatchSize`
      // setting when the webview omitted them.
      const defaultBatchSize =
        this.deps.services?.getSandforgeSetting?.('seed.defaultBatchSize', 200) ?? 200;
      const objects = parsed.template.objects.map((o) => ({
        ...o,
        batchSize: o.batchSize ?? defaultBatchSize,
      }));
      Object.assign(failure, objectsFailureContext(objects));
      const conn = await getJsforceConnection(
        parsed.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );

      // Each account written as the kind its record types give it, as the
      // command line writes them: a person account without Name, a business
      // account without a person's fields. A person type and a business type
      // chosen together are refused before the guard is asked or anything is
      // written.
      const asTemplate = { ...parsed.template, objects } as unknown as SeedTemplate;
      const kinds = asTemplate.objects.some((o) => o.objectApiName === ACCOUNT)
        ? templateForAccountKinds(asTemplate, await personRecordTypes(conn))
        : { template: asTemplate, personObjects: [] };
      if ('refusal' in kinds) {
        sendHandlerError(this.deps, 'seed:execute', 'seed:error', msg, new Error(kinds.refusal), {
          code: 'RECORD_TYPES_MIXED',
          retryable: false,
        });
        return;
      }
      const payload: SeedRunPayload = {
        orgId: parsed.orgId,
        template: kinds.template as unknown as Record<string, unknown>,
        personObjects: kinds.personObjects,
        // The people and places of a seed are drawn in the org's own locale
        // unless the request names one: the panel drew every seed in en_US.
        locale: await seedLocaleOf(parsed.locale, conn),
      };

      // Planned record total, known upfront from the template. It feeds the
      // Production Guard impact summary (the sentence the user reads in the
      // production confirmation modal) and the Monitor "live operations" panel.
      const plannedRecords = parsed.template.objects.reduce((sum, o) => sum + o.recordCount, 0);

      // The storage the records take against what the org has left, before the
      // guard is asked and before anything is written: a template three times
      // a Developer Edition's 5 MB filled the org part way through its run.
      const org = this.deps.orgManager.getOrg(payload.orgId);
      const storage = await seedStorageGate(
        conn,
        kinds.template,
        kinds.personObjects,
        org?.alias ?? payload.orgId,
      );
      if (storage.check.verdict === 'unread') {
        this.deps.log(
          `[WARN] seed:execute ${operationId}: the data storage the org has left could not be ` +
            `read (${storage.check.unread}): whether the records fit is not known`,
        );
      }
      if (storage.refusal) {
        recordWriteRun(this.deps, {
          action: 'seed_execute',
          module: 'seed',
          operationId,
          orgId: payload.orgId,
          outcome: 'stopped',
          code: SEED_STORAGE_EXCEEDED,
        });
        const check = storage.check;
        sendHandlerError(this.deps, 'seed:execute', 'seed:error', msg, new Error(storage.refusal), {
          code: SEED_STORAGE_EXCEEDED,
          retryable: false,
          extraPayload:
            check.verdict === 'unread'
              ? {}
              : {
                  estimateMB: Number(formatMB(check.estimateMB)),
                  remainingMB: check.remainingMB,
                  maxMB: check.maxMB,
                  org: org?.alias ?? payload.orgId,
                },
        });
        sendOperationFailed(this.deps, operationId, storage.refusal, false, { context: failure });
        return;
      }

      // Production guard check. No write without it: a guard that was never
      // injected refuses the run instead of waving it through.
      const guard = this.deps.infraServices?.productionGuard;
      if (!guard) {
        recordWriteRun(this.deps, {
          action: 'seed_execute',
          module: 'seed',
          operationId,
          orgId: payload.orgId,
          outcome: 'stopped',
          code: PRODUCTION_GUARD_MISSING.code,
        });
        sendHandlerError(
          this.deps,
          'seed:execute',
          'seed:error',
          msg,
          new Error(PRODUCTION_GUARD_MISSING.message),
          { code: PRODUCTION_GUARD_MISSING.code, retryable: false },
        );
        sendOperationFailed(this.deps, operationId, PRODUCTION_GUARD_MISSING.message, false, {
          context: failure,
        });
        return;
      }
      const guardRequest = {
        orgId: payload.orgId,
        orgTier: guardTierOf(org),
        operation: 'insert' as const,
        objectName: 'SeedData',
        recordCount: plannedRecords,
        module: 'seed',
      };
      const { check, decision } = await consultProductionGuard(guard, guardRequest);
      // What the run carries to the audit trail when it ends.
      const guardDecision = decision;
      if (decision === 'refused' || decision === 'declined') {
        recordWriteRun(this.deps, {
          action: 'seed_execute',
          module: 'seed',
          operationId,
          orgId: payload.orgId,
          outcome: 'stopped',
          guard: decision,
        });
      }
      if (decision === 'refused') {
        throw guardBlockedError(check.blockedReason ?? check.impactSummary);
      }
      // `safety.requireProdConfirmation`: explicit user consent before
      // writing to a production org.
      if (decision === 'declined') {
        const message = 'Operation cancelled by user (production confirmation declined).';
        // Settle the in-flight useBridgeMutation listener on seed:error
        // (same dual-channel contract as sync — without it the mutation
        // spun until its 120 s timeout). Correlated to the request so the
        // webview can drop stale error responses. The code is the one every
        // write path declines with, so the page says it in the interface
        // language instead of showing this English prose.
        sendHandlerError(this.deps, 'seed:execute', 'seed:error', msg, new Error(message), {
          code: GUARD_REFUSAL.declined,
          retryable: false,
        });
        sendOperationFailed(this.deps, operationId, message, false, { context: failure });
        return;
      }

      // Start performance tracking
      this.deps.infraServices?.performanceTracker?.start(operationId, 'seed');

      const description = 'Seed data generation';
      sendOperationStarted(this.deps, operationId, 'seed', description);
      // Feed the Monitor "live operations" panel with the same planned total.
      this.liveTracker?.register(operationId, 'seed', description, plannedRecords);

      // Create AbortController for this operation
      const abortController = new AbortController();

      // Build the execution promise (runs detached in the background)
      const executionPromise = this.executeSeed(
        msg,
        conn,
        payload,
        operationId,
        abortController,
        failure,
        guardDecision,
      );

      // Register with BackgroundOperationRegistry if available
      if (this.registry) {
        this.registry.register(operationId, 'seed', description, executionPromise, abortController);
      } else {
        // Fallback: await directly when no registry is available
        await executionPromise;
      }

      // Return immediately -- execution continues in background
    } catch (err: unknown) {
      this.deps.infraServices?.performanceTracker?.complete(operationId);
      // No-op when the operation never reached registration (connection or
      // guard failure happens before sendOperationStarted).
      this.liveTracker?.fail(operationId, extractErrorMessage(err));
      // Dual channel, single display (same contract as sync): `operation:failed`
      // carries the lifecycle; `seed:error` settles the in-flight webview
      // mutation (useBridgeMutation listens on seed:execute:response /
      // seed:error — without it the user stared at a 120 s timeout). Both
      // carry the offline retryHint on transport failures.
      const offlineHint = buildOfflineReplayHint(err, operationId, this.deps.log);
      sendHandlerError(this.deps, 'seed:execute', 'seed:error', msg, err, {
        code: guardRefusalCode(err),
        retryable: true,
        extraPayload: offlineHint,
      });
      sendOperationFailed(this.deps, operationId, extractErrorMessage(err), true, {
        extraPayload: offlineHint,
        context: failure,
      });
    }
  }

  /**
   * Execute seed operation in the background.
   * Extracted from handleExecute to allow detached execution via BackgroundOperationRegistry.
   *
   * Failures are reported on `seed:error` + `operation:failed` and converted to
   * a `{ status: 'failure' }` result rather than a rejection — the same
   * contract as executeSync. The registry reads that status and marks the
   * operation 'failed' (resolving `undefined` would mark a failed seed
   * 'completed' and fire a lying "seed completed" notification); a rejection
   * would double-emit on the no-registry fallback path where handleExecute
   * awaits this promise inside its own try/catch.
   *
   * A run the registry's abort stopped ends as cancelled, with the objects it
   * reached answered to the page and recorded. An error thrown while a cancel
   * is pending is still a failure: only the orchestrator, stopping at the
   * cancel, says a run was cancelled.
   */
  private async executeSeed(
    msg: InboundRequest,
    conn: Awaited<ReturnType<typeof getJsforceConnection>>,
    payload: SeedRunPayload,
    operationId: string,
    abortController: AbortController,
    failure: OperationFailureContext,
    guardDecision?: GuardDecision,
  ): Promise<{ status: 'failure' } | void> {
    const robustnessConfig = robustnessConfigOf(this.deps);
    const startedAt = new Date().toISOString();
    const templateName = (payload.template as { name?: unknown }).name;
    /** Where the records came from: the template the generator filled in. */
    const source = {
      origin: 'generator' as const,
      ...(typeof templateName === 'string' ? { label: templateName } : {}),
    };

    try {
      // Build robustness-aware insert function
      const bulkExecutor = new BulkApiExecutor(robustnessConfig.bulk.threshold);
      const bulkManager = bulkManagerOf(this.deps);
      const retryOp = new RetryableOperation({
        retryConfig: robustnessConfig.retry,
        // A batch the org failed on is not sent again once the seed is
        // cancelled, and its backoff is not waited out, as in the writer Sync
        // writes through.
        signal: abortController.signal,
        onRetry: (attempt, classified, delay) => {
          this.deps.log(
            `[RETRY] seed insert attempt=${attempt} code=${classified.originalError.statusCode} delay=${delay}ms`,
          );
        },
      });
      const handlerDeps = this.deps;
      // What the run creates, written down as each insert returns: a window
      // closed under the run, or a host that stopped, left what it had
      // inserted with nothing to take it back from, the run being kept once
      // it ended. The orchestrator runs under this id, which its result and
      // the page's removal name.
      const runId = crypto.randomUUID();
      const kept = this.runCreations?.recorder({ runId, targetOrgId: payload.orgId, startedAt });
      // Records written before the insert now running, and the run's total,
      // from the orchestrator's report before each object and each partition.
      // The bulk paths count within one insert call; offsetting them keeps the
      // overall bar from dropping back to 0 when the next call starts.
      const runProgress = { base: 0, total: 0 };
      const reportInsertProgress = (processed: number, total: number, step: string): void => {
        const overall = runProgress.base + processed;
        const overallTotal = Math.max(runProgress.total, overall, total, 1);
        const pct = Math.round((overall / overallTotal) * 100);
        sendOperationProgress(handlerDeps, operationId, pct, overall, overallTotal, step);
        this.liveTracker?.updateProgress(operationId, pct, overall, overallTotal, step);
      };

      // An object an active duplicate rule watches goes through REST, whose
      // header lets the rule's matches be saved, rather than as a Bulk API job,
      // which carries none (`objectsUnderDuplicateRules`). Read once for the run.
      let duplicateRules: Promise<ReadonlySet<string> | undefined> | undefined;
      const watchedByDuplicateRule = async (objectApiName: string): Promise<boolean> => {
        duplicateRules ??= objectsUnderDuplicateRules(conn).then((ruled) => {
          if (!ruled) {
            this.deps.log(
              `[WARN] seed:execute ${operationId}: the org's duplicate rules could not be read: ` +
                'an object of more than the Bulk API threshold goes as a Bulk API job, which a ' +
                'duplicate rule may refuse',
            );
          }
          return ruled;
        });
        const watched = (await duplicateRules)?.has(objectApiName) === true;
        if (watched) {
          this.deps.log(
            `[INFO] seed:execute ${operationId}: ${objectApiName} goes through REST: an active ` +
              'duplicate rule watches it, which a Bulk API job cannot waive',
          );
        }
        return watched;
      };

      const insertRecords = async (
        _orgId: string,
        objectApiName: string,
        records: Record<string, unknown>[],
        batchSize: number,
      ): Promise<InsertResult> => {
        // Streaming path for large record sets
        if (records.length > STREAMING_THRESHOLD) {
          // A cancel that came before the insert opens no job: see the Bulk
          // API path.
          if (abortController.signal.aborted) return { successIds: [], errors: [], stopped: true };
          const chunkedExecutor = new ChunkedBulkExecutor({ signal: abortController.signal });
          const bulkDeps: BulkApiExecutorDeps = {
            connection: conn as unknown as BulkApiConnection,
            bulkManager,
            onProgress: (processed, total) => {
              reportInsertProgress(processed, total, `Streaming insert ${objectApiName}`);
            },
          };
          const streamResult = await chunkedExecutor.executeChunked(
            bulkDeps,
            objectApiName,
            'insert',
            chunkedExecutor.createChunkGenerator(records),
            records.length,
          );
          return {
            successIds: streamResult.successIds,
            errors: streamResult.errors,
            // An upload the cancel stopped answers with nothing written: told
            // nothing more, the run went on to the next object.
            ...(streamResult.aborted ? { stopped: true } : {}),
          };
        }

        if (
          bulkExecutor.shouldUseBulkApi(records.length) &&
          !(await watchedByDuplicateRule(objectApiName))
        ) {
          // Bulk API 2.0 path. A cancel that came before the insert opens no
          // job: the executor opened one all the same, then aborted it before
          // its upload, which wrote nothing but asked the org for a job, and
          // for its abort, for an insert that never started.
          if (abortController.signal.aborted) return { successIds: [], errors: [], stopped: true };
          const bulkDeps: BulkApiExecutorDeps = {
            connection: conn as unknown as BulkApiConnection,
            bulkManager,
            onProgress: (processed, total) => {
              reportInsertProgress(processed, total, `Bulk insert ${objectApiName}`);
            },
            signal: abortController.signal,
          };
          const bulkResult = await bulkExecutor.executeBulk(
            bulkDeps,
            objectApiName,
            'insert',
            records,
          );
          const rows = bulkRows(bulkResult, records.length);
          return {
            successIds: bulkResult.successIds,
            errors: bulkResult.failures.map((f) => f.error),
            ...(rows ? { rows } : {}),
            // The cancel aborted the job before it was closed, as it does a
            // streamed upload: none of its records was written.
            ...(bulkResult.aborted ? { stopped: true } : {}),
          };
        }

        // REST API path with retry and batching
        const successIds: string[] = [];
        const errors: string[] = [];
        // What the org answered per record, in order: a row refused on fields
        // a validation rule named is sent again without them from it.
        const rows: InsertedRow[] = [];

        for (let i = 0; i < records.length; i += batchSize) {
          // A cancel stops the insert before each batch, with what the
          // batches before it created: the rest of a large object used to be
          // inserted after the seed was cancelled. The first batch included,
          // as in the writer Sync writes through: the run looks at the cancel
          // just before it inserts, and nothing between the two waits today,
          // but a cancel that came between them would still send a batch.
          if (abortController.signal.aborted) {
            return { successIds, errors, rows, stopped: true };
          }
          const batch = records.slice(i, i + batchSize);
          const retryResult = await retryOp.execute(async () => {
            // Seeded rows are invented and land in an org that may already
            // hold rows like them — a duplicate rule stops exactly that. Forge
            // learnt it in 1.25.3 and Sync in 1.28.0; a hundred seeded
            // contacts were refused here for want of the same header. A
            // unique index still refuses, which is right.
            return conn
              .sobject(objectApiName)
              .create(batch, { headers: recordWriteHeaders() }) as Promise<
              Array<{ success: boolean; id?: string; errors?: Array<{ message: string }> }>
            >;
          });
          // The batch failed and the cancel came before it was tried again:
          // none of it was created, and nothing after it is sent.
          if (retryResult.cancelled) return { successIds, errors, rows, stopped: true };

          if (retryResult.success && retryResult.result) {
            for (const r of retryResult.result) {
              if (r.success && r.id) {
                successIds.push(r.id);
                rows.push({ id: r.id });
              } else {
                const error = recordErrorText(r.errors);
                errors.push(error);
                rows.push({ error, errorDetails: (r.errors ?? []).map(saveErrorDetail) });
              }
            }
          } else {
            // The whole batch is lost, not one record: `errors.length` is what
            // SeedOrchestrator reports as recordsFailed, so a single push made
            // a 180-record wipe-out read as "1 failed".
            const failMsg = retryResult.error?.message ?? 'Insert failed after retries';
            for (let k = 0; k < batch.length; k++) {
              errors.push(failMsg);
              rows.push({ error: failMsg });
            }
          }
        }

        return { successIds, errors, rows };
      };
      const insertFn = async (
        orgId: string,
        objectApiName: string,
        records: Record<string, unknown>[],
        batchSize: number,
      ): Promise<InsertResult> => {
        const answer = await insertRecords(orgId, objectApiName, records, batchSize);
        kept?.note(objectApiName, answer.successIds);
        return answer;
      };
      /** Say a run's creations could not all be kept, and let the run end as it did. */
      const keptFailed = (err: unknown): void =>
        this.deps.log(
          `[WARN] seed:execute ${operationId}: what the run created could not all be kept, ` +
            `so removing it may leave some of it in the org: ${extractErrorMessage(err)}`,
        );

      // Lazy-import seed dependencies
      const { SeedValidator } = await import('../../modules/seed/SeedValidator.js');
      const { DataPlanBuilder } = await import('../../modules/seed/DataPlanBuilder.js');
      const { FieldMapper } = await import('../../modules/seed/FieldMapper.js');
      const { ReferenceLinker } = await import('../../modules/seed/ReferenceLinker.js');
      const { AIDataGenerator } = await import('../../modules/seed/AIDataGenerator.js');
      const { FakerFallback } = await import('../../modules/seed/FakerFallback.js');
      const { readExistingParentIds } = await import('../../modules/seed/existingParents.js');
      const { seedObjectAccess } = await import('../../modules/seed/seedObjectAccess.js');
      const { describedFieldsOf } = await import('../../modules/seed/describedFields.js');

      const aiGenerator = new AIDataGenerator(this.buildSeedCallAI());
      const fakerFallback = new FakerFallback(payload.locale);
      const fieldMapper = new FieldMapper({ aiGenerator, fakerFallback });
      const referenceLinker = new ReferenceLinker();
      const validator = new SeedValidator();
      const planBuilder = new DataPlanBuilder();

      const { SeedGrappeAdapter } = await import('../../modules/seed/SeedGrappeAdapter.js');

      const grappeConfig = readGrappeConfig(this.deps.services);

      // One describe of the org per object, kept for the run. A template names
      // fields an org may not have: without this, one missing field refuses
      // every record of the object. See `describeCreateableFields`. The same
      // describe gives the values of its picklists, which a template's random
      // picks are kept to (`describePicklistValues`).
      const describedFields = describedFieldsOf((objectApiName) => conn.describe(objectApiName));

      const seedDeps = {
        validator,
        describeCreateableFields: describedFields.createable,
        describePicklistValues: describedFields.picklistValues,
        // What the org requires and the template names no rule for, less what
        // the kind of account written does not take.
        describeRequiredFields: async (objectApiName: string) =>
          (await describedFields.required(objectApiName)).filter(
            (field) =>
              !leftOutForAccountKind(
                objectApiName,
                field.fieldApiName,
                payload.personObjects.includes(objectApiName) ? 'person' : 'business',
              ),
          ),
        // An object the org has not, or the user may not create, is skipped
        // with the reason, before its records are generated.
        objectAccess: seedObjectAccess(conn),
        // A relation may draw its parents from records already in this org.
        readExistingParentIds: (objectApiName: string, where: string | undefined, limit: number) =>
          readExistingParentIds(conn, objectApiName, where, limit),
        planBuilder,
        fieldMapper,
        referenceLinker,
        insert: insertFn,
        generateId: () => crypto.randomUUID(),
        now: () => new Date().toISOString(),
        services: this.deps.services,
        // Grappe stays sequential unless `sandforge.grappe.enabled` is on AND
        // the template crosses the threshold — but adapter, config and callback
        // must all be present, or the Grappe page renders an empty shell.
        grappeAdapter: new SeedGrappeAdapter(() => crypto.randomUUID(), grappeConfig?.grappeSize),
        grappeConfig,
        onGrappeEvent: (event: GrappeEventEnvelope) => postGrappeEvent(this.deps, event),
        onProgress: (event: SeedProgressEvent) => {
          runProgress.base = event.processedRecords;
          runProgress.total = event.totalRecords;
          reportInsertProgress(0, event.totalRecords, `Insert ${event.objectApiName}`);
        },
        // The controller the registry aborts: the Seed page's Cancel and Live
        // Operations' both reach the run through it.
        signal: abortController.signal,
      };
      if (!this.deps.services) {
        throw new Error(
          'SeedOpsHandler: composition-root services not injected. Wire ExtensionHandlersDeps.services in extension.ts.',
        );
      }
      const orchestrator = this.deps.services.seedOrchestrator(seedDeps);

      const template = payload.template as unknown as import('@sandforge/shared').SeedTemplate;
      sendOperationProgress(
        this.deps,
        operationId,
        0,
        0,
        1,
        'Validating template and building plan',
      );
      let result: Awaited<ReturnType<typeof orchestrator.execute>>;
      try {
        result = await orchestrator.execute(template, payload.orgId, runId);
      } catch (err: unknown) {
        // What it inserted before it threw stays removable, the run ended failed.
        await kept
          ?.end({ status: 'failure', finishedAt: new Date().toISOString(), objectResults: [] })
          .catch(keptFailed);
        throw err;
      }
      // Kept whole before the lists are cut for the page, a stopped run's too:
      // what it wrote before the cancel can be taken back from its results,
      // or after a reload from the list of earlier seeds. A store that cannot
      // keep it is said, and the run ends as it did.
      await kept
        ?.end({
          finishedAt: new Date().toISOString(),
          status: result.status,
          ...(result.cancelled ? { cancelled: true } : {}),
          objectResults: result.objectResults,
        })
        .catch(keptFailed);
      if (!result.cancelled) {
        sendOperationProgress(this.deps, operationId, 100, 1, 1, 'Seed complete');
      }
      // What the orchestrator reports it wrote. A cast to an `insertedIds`
      // array no result ever carried reported every finished run as 0 records.
      const totalRecords = result.totalRecordsCreated;
      this.deps.infraServices?.performanceTracker?.update(operationId, totalRecords, 1);
      this.deps.infraServices?.performanceTracker?.complete(operationId);
      if (result.cancelled) {
        // Ended the way a cancelled backup ends: aborted in the registry —
        // already, when the cancel came through it; this lists a run stopped
        // any other way as aborted too — and posted as a completion that
        // says so. A stopped seed was posted with the status its objects came
        // to, so the recent operations and Home listed a run the user had
        // stopped as failed or succeeded, and Live Operations kept it running.
        this.registry?.abort(operationId);
        sendOperationCompleted(this.deps, operationId, { aborted: true, totalRecords });
        this.liveTracker?.cancel(operationId);
      } else {
        // The run's own status, the way the other write paths report theirs.
        // A template the validator refused, or one whose every record the org
        // turned down, ends here with a failure status, and was announced as
        // completed: Live Operations listed it done, "seed completed" popped
        // up and Home showed a success.
        sendOperationCompleted(this.deps, operationId, { status: result.status, totalRecords });
        if (result.status === 'failure') {
          this.liveTracker?.fail(operationId, seedFailureReason(result));
        } else {
          this.liveTracker?.complete(operationId);
        }
      }
      recordWriteRun(this.deps, {
        action: 'seed_execute',
        module: 'seed',
        operationId,
        orgId: payload.orgId,
        outcome: result.status,
        guard: guardDecision,
        objects: result.objectResults.map((object) => ({
          ...emptyCounts(object.objectApiName),
          created: object.recordsCreated,
          failed: object.recordsFailed,
        })),
        source,
      });

      const response = buildResponse(
        this.deps,
        msg,
        'seed:execute:response',
        capResultForBridge(result) as unknown as Record<string, unknown>,
      );
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
      // A failure status, not a bare resolve, so the registry marks the run
      // failed — see the method docstring for the contract. A cancelled run
      // is aborted there already.
      if (result.status === 'failure' && !result.cancelled) return { status: 'failure' };
    } catch (err: unknown) {
      this.deps.infraServices?.performanceTracker?.complete(operationId);
      this.liveTracker?.fail(operationId, extractErrorMessage(err));
      // What the run inserted before it threw is not counted here: it is
      // kept, for its removal, with the run's creations.
      recordWriteRun(this.deps, {
        action: 'seed_execute',
        module: 'seed',
        operationId,
        orgId: payload.orgId,
        outcome: 'failure',
        guard: guardDecision,
        source,
      });
      // Dual channel, single display (see handleExecute): seed:error settles
      // the in-flight webview mutation, operation:failed carries the
      // lifecycle. Both carry the offline retryHint on transport failures.
      const offlineHint = buildOfflineReplayHint(err, operationId, this.deps.log);
      sendHandlerError(this.deps, 'seed:execute', 'seed:error', msg, err, {
        retryable: true,
        extraPayload: offlineHint,
      });
      sendOperationFailed(this.deps, operationId, extractErrorMessage(err), true, {
        extraPayload: offlineHint,
        context: failure,
      });
      // Failure-status result (not a rejection, not a bare resolve) so the
      // BackgroundOperationRegistry marks the operation 'failed' — see the
      // method docstring for the contract.
      return { status: 'failure' };
    }
  }
}
