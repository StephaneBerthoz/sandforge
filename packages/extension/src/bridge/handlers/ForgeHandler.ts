import type {
  BaseMessage,
  ForgeConfig,
  ForgeExecutionResult,
  ForgeTemplate,
  ComplianceFrameworkType,
} from '@sandforge/shared';
import { forgeConfigSchema, forgeGraphSchema, forgeTemplateSchema } from '@sandforge/shared';
import { orgTypeToGuardTier } from '@sandforge/shared';
import { z } from 'zod';
import type { HandlerDeps, DomainHandler, InboundRequest } from './HandlerTypes.js';
import {
  buildResponse,
  sendHandlerError,
  sendOperationStarted,
  sendOperationCompleted,
} from './HandlerTypes.js';
import { validatePayload } from '../validatePayload.js';
import { logger } from '../../logger.js';
import { DmlOperationTracker } from '../../core/common/DmlOperationTracker.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { queryWithFieldsFallback } from '../../core/common/soqlQueryHelper.js';
import { sanitizeSoqlValue } from '../../core/common/soqlValidator.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { checkApiLimits } from '../../core/common/sforceLimitParser.js';
import { TimeoutManager, TimeoutError } from '../../core/engine/TimeoutManager.js';
import { SchemaCache } from '../../core/metadata/SchemaCache.js';
import type { ForgeOrchestrator } from '../../modules/forge/ForgeOrchestrator.js';
import type { ForgePlanGenerator } from '../../modules/forge/ForgePlanGenerator.js';
import type { ForgeComplianceService } from '../../modules/forge/ForgeComplianceService.js';
import type { ForgeMetadataDiff } from '../../modules/forge/ForgeMetadataDiff.js';
import type { ForgeTemplateStore } from '../../modules/forge/ForgeTemplateStore.js';
import type { ForgeHistoryStore } from '../../modules/forge/ForgeHistoryStore.js';
import { queryAllPages } from '../../modules/forge/queryAllPages.js';
import { RecordTypeMapper, type RecordTypeMapping } from '../../modules/sync/RecordTypeMapper.js';

/** Strict Salesforce record/org ID format. */
const SF_ID_RE = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/;
/** Permissive org-id schema (accepts UUIDs as well as 18-char SF IDs). */
const orgIdSchema = z.string().min(1).max(128);

/** Zod payload schemas for every webview→extension forge:* message. */
const previewPayloadSchema = z.object({
  recordId: z.string().regex(SF_ID_RE, 'Invalid Salesforce record ID'),
  orgId: orgIdSchema,
});
const discoverPayloadSchema = z.object({ config: forgeConfigSchema });
const executePayloadSchema = z.object({ graph: forgeGraphSchema, config: forgeConfigSchema });
const saveTemplatePayloadSchema = z.object({ template: forgeTemplateSchema });
const deleteTemplatePayloadSchema = z.object({ templateId: z.string().min(1).max(200) });
const planRequestPayloadSchema = z.object({ graph: forgeGraphSchema, config: forgeConfigSchema });
const complianceRequestPayloadSchema = z.object({
  framework: z.string().min(1).max(50),
  graph: forgeGraphSchema,
  config: forgeConfigSchema,
});
const metadataDiffRequestPayloadSchema = z.object({
  sourceOrgId: orgIdSchema,
  targetOrgId: orgIdSchema,
  // Tightened from .max(500) to .max(100). 100 SObjects per diff
  // is already past any realistic UI use case; 500 enabled API-limit DoS
  // (500 source describes + 500 target describes = 1000 calls per request).
  objectApiNames: z
    .array(
      z
        .string()
        .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
        .max(80),
    )
    .max(100),
});

/** Active record types of an org, with the object each belongs to. */
const RECORD_TYPES_SOQL =
  'SELECT Id, Name, DeveloperName, SobjectType FROM RecordType WHERE IsActive = true';

/** Shape of the rows {@link RECORD_TYPES_SOQL} returns, checked before mapping. */
const recordTypeRowsSchema = z.array(
  z.object({
    Id: z.string().min(1),
    Name: z.string(),
    DeveloperName: z.string().min(1),
    SobjectType: z.string().min(1),
  }),
);

/**
 * Throttle a function to at most one call per `delayMs`. Subsequent calls
 * coalesce — only the *latest* arguments are forwarded on the next tick.
 * Returned function exposes `.flush()` to emit the pending event immediately
 * (for terminal events that must not be dropped).
 */
function throttle<T extends (...args: never[]) => void>(
  fn: T,
  delayMs: number,
): T & { flush: () => void } {
  let lastEmit = 0;
  let pending: Parameters<T> | null = null;
  let timer: NodeJS.Timeout | null = null;
  const emit = (args: Parameters<T>): void => {
    fn(...args);
    lastEmit = Date.now();
    pending = null;
  };
  const wrapped = ((...args: Parameters<T>): void => {
    pending = args;
    const wait = delayMs - (Date.now() - lastEmit);
    if (wait <= 0) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      emit(args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        if (pending) emit(pending);
      }, wait);
    }
  }) as T & { flush: () => void };
  wrapped.flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending) emit(pending);
  };
  return wrapped;
}

/**
 * Local alias for the shared payload validator (bridge/validatePayload.ts).
 * Kept as a one-line wrapper so the call sites below stay readable.
 */
function parsePayload<T>(
  schema: z.ZodSchema<T>,
  msg: InboundRequest,
  responseType: string,
  deps: HandlerDeps,
): T | null {
  return validatePayload(schema, msg, responseType, deps);
}

/** Optional v2 services injected alongside the ForgeOrchestrator. */
export interface ForgeServices {
  /** Optional plan generator for wave-based planning. */
  planGenerator?: ForgePlanGenerator;
  /** Optional compliance service for PII reports. */
  complianceService?: ForgeComplianceService;
  /** Optional metadata diff service for schema comparison. */
  metadataDiff?: ForgeMetadataDiff;
  /**
   * Workspace-file template store. Present only when a folder is open — a
   * folderless window has no `.sandforge/` to write into and falls back to
   * ConfigStore.
   */
  templateStore?: ForgeTemplateStore;
  /** @deprecated History is now persisted via ConfigStore. Accepted for backward compatibility. */
  historyStore?: ForgeHistoryStore;
}

/** Message types handled by ForgeHandler. */
const FORGE_TYPES = new Set([
  'forge:preview',
  'forge:discover',
  'forge:execute',
  'forge:pause',
  'forge:resume',
  'forge:abort',
  'forge:templates:list',
  'forge:templates:save',
  'forge:templates:delete',
  'forge:history:list',
  'forge:plan:request',
  'forge:compliance:request',
  'forge:metadata-diff:request',
]);

/** Timeout for plan generation in milliseconds. */
const PLAN_TIMEOUT_MS = 30_000;

/** Timeout for compliance report generation in milliseconds. */
const COMPLIANCE_TIMEOUT_MS = 30_000;

/** Timeout for metadata diff comparison in milliseconds. */
const METADATA_DIFF_TIMEOUT_MS = 60_000;

/** Timeout for reading both orgs' record types before a run, in milliseconds. */
const RECORD_TYPES_TIMEOUT_MS = 30_000;

/** ConfigStore key for persisted forge templates. */
const TEMPLATES_KEY = 'forge:templates';

/** ConfigStore key for persisted forge execution history. */
const HISTORY_KEY = 'forge:history';

/** ConfigStore category for all forge data. */
const FORGE_CATEGORY = 'forge';

/**
 * Drop the org pair from a config so it can be stored as a replay recipe.
 *
 * Copy-then-delete rather than rest destructuring: the repo's
 * `no-unused-vars` rule flags the two discarded bindings. Spreading keeps
 * every other field, including ones added to ForgeConfig later — an explicit
 * field list would silently stop persisting them.
 */
function stripOrgIds(config: ForgeConfig): Omit<ForgeConfig, 'sourceOrgId' | 'targetOrgId'> {
  const copy: Partial<ForgeConfig> = { ...config };
  delete copy.sourceOrgId;
  delete copy.targetOrgId;
  return copy as Omit<ForgeConfig, 'sourceOrgId' | 'targetOrgId'>;
}

/**
 * Domain handler for forge-related webview-to-extension messages.
 *
 * Routes forge:* message types to the ForgeOrchestrator and manages
 * templates, execution history, and abort/pause/resume lifecycle.
 * Templates and history are persisted to ConfigStore (survive extension reload).
 */
export class ForgeHandler implements DomainHandler {
  private discoverAbortController: AbortController | null = null;
  private abortController: AbortController | null = null;
  private orchestrator?: ForgeOrchestrator;
  private planGenerator?: ForgePlanGenerator;
  private complianceService?: ForgeComplianceService;
  private metadataDiff?: ForgeMetadataDiff;
  /**
   * Workspace-file template store, present only when a folder is open.
   *
   * Templates live in `.sandforge/forge-templates.json` so a recipe can be
   * committed and shared. ConfigStore (VSCode globalState) stays the fallback
   * for a folderless window, and holds any templates saved before this.
   */
  private templateStore?: ForgeTemplateStore;

  /**
   * Per-org `describeGlobal` result, keyed by org id.
   *
   * The preview path only needs the key-prefix -> {name,label} table, but
   * `conn.describeGlobal()` re-downloads 1-2 MB of JSON on every call. The
   * webview fires a preview on each corrected record id the user pastes, so
   * a handful of typos used to cost as many full downloads.
   *
   * Same mechanism, keys and TTL as the caches in
   * `composition/forgeComposition.ts` and `FrozenDatasetHandler` — org id as
   * the key means switching org can never read another org's schema, and the
   * 5-minute TTL bounds how stale a freshly deployed SObject can be.
   */
  private readonly describeGlobalCache = new SchemaCache<
    Array<{ name: string; label: string; keyPrefix: string | null }>
  >({
    defaultTtl: 5 * 60_000,
    maxSize: 16,
    maxSizeBytes: 50 * 1024 * 1024,
  });

  /** Tracks DML operations to prevent duplicate forge executions. */
  private readonly dmlTracker = new DmlOperationTracker();

  /**
   * Cooldown after a run that actually wrote records, keyed by the
   * content-derived operation id -> epoch ms of that run's completion.
   *
   * Only a run that created something arms it: a failed clone, or one that
   * wrote nothing, must be retryable immediately.
   */
  private readonly lastWriteAt = new Map<string, number>();

  /**
   * How long an identical, already-executed forge run is refused.
   *
   * The guard exists to swallow an accidental double submit, not to lock a
   * recipe out: the tracker's 1h TTL used to do exactly that, and it applied
   * to failed runs too — a clone that died on the first object could not be
   * retried for a full hour.
   */
  private static readonly DUPLICATE_COOLDOWN_MS = 60_000;

  /** Maximum number of history entries to retain. */
  private static readonly MAX_HISTORY = 20;

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {}

  /**
   * Inject forge orchestrator and optional v2 services.
   *
   * @param orchestrator - The ForgeOrchestrator instance.
   * @param services - Optional additional Forge v2 services.
   */
  setForgeOrchestrator(orchestrator: ForgeOrchestrator, services?: ForgeServices): void {
    this.orchestrator = orchestrator;
    if (services) {
      this.planGenerator = services.planGenerator;
      this.complianceService = services.complianceService;
      this.metadataDiff = services.metadataDiff;
      // Composition has always built and passed this store; the assignment was
      // simply missing, so every saved recipe went to globalState instead of
      // `.sandforge/forge-templates.json` and could not be committed or shared.
      this.templateStore = services.templateStore;
    }
  }

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: InboundRequest): Promise<boolean> {
    if (!FORGE_TYPES.has(msg.type)) return false;

    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);

    switch (msg.type) {
      case 'forge:preview':
        await this.handleForgePreview(msg);
        return true;
      case 'forge:discover':
        await this.handleDiscover(msg);
        return true;
      case 'forge:execute':
        await this.handleExecute(msg);
        return true;
      case 'forge:pause':
        this.handlePause(msg);
        return true;
      case 'forge:resume':
        this.handleResume(msg);
        return true;
      case 'forge:abort':
        this.handleAbort(msg);
        return true;
      case 'forge:templates:list':
        await this.handleTemplatesList(msg);
        return true;
      case 'forge:templates:save':
        await this.handleSaveTemplate(msg);
        return true;
      case 'forge:templates:delete':
        await this.handleDeleteTemplate(msg);
        return true;
      case 'forge:history:list':
        this.handleHistoryList(msg);
        return true;
      case 'forge:plan:request':
        await this.handlePlanRequest(msg);
        return true;
      case 'forge:compliance:request':
        await this.handleComplianceRequest(msg);
        return true;
      case 'forge:metadata-diff:request':
        await this.handleMetadataDiffRequest(msg);
        return true;
      default:
        return false;
    }
  }

  /** Load templates from ConfigStore. */
  private async loadTemplates(): Promise<ForgeTemplate[]> {
    const legacy = this.deps.configStore.get<ForgeTemplate[]>(TEMPLATES_KEY) ?? [];
    if (!this.templateStore) return legacy;

    const fromFile = await this.templateStore.list();
    if (fromFile.length > 0) return fromFile;

    // One-shot migration: templates saved before recipes became portable live
    // in globalState. Move them into the workspace file the first time it is
    // read empty, so nobody loses a recipe to the change.
    if (legacy.length > 0) {
      await this.saveTemplates(legacy);
      logger.info(`Migrated ${legacy.length} forge template(s) into .sandforge/`);
      return legacy;
    }
    return [];
  }

  /**
   * Persist templates.
   *
   * Writes to the workspace file when a folder is open so the recipe can be
   * committed and shared; ConfigStore is the fallback for a folderless window.
   * The ConfigStore copy is kept in sync either way — it is what a window
   * without a workspace will read.
   */
  private async saveTemplates(templates: ForgeTemplate[]): Promise<void> {
    this.deps.configStore.set(TEMPLATES_KEY, templates, FORGE_CATEGORY);
    if (!this.templateStore) return;
    const existing = await this.templateStore.list();
    for (const stale of existing.filter((t) => !templates.some((n) => n.id === t.id))) {
      await this.templateStore.delete(stale.id);
    }
    for (const template of templates) {
      await this.templateStore.save(template);
    }
  }

  /** Load execution history from ConfigStore. */
  private loadHistory(): ForgeExecutionResult[] {
    return this.deps.configStore.get<ForgeExecutionResult[]>(HISTORY_KEY) ?? [];
  }

  /** Save execution history to ConfigStore. */
  private saveHistory(history: ForgeExecutionResult[]): void {
    this.deps.configStore.set(HISTORY_KEY, history, FORGE_CATEGORY);
  }

  /**
   * Start the duplicate cooldown for a run that wrote records, dropping the
   * stamps that already expired so the map stays bounded.
   */
  private noteForgeWrite(forgeOpId: string): void {
    const now = Date.now();
    for (const [id, at] of this.lastWriteAt) {
      if (now - at >= ForgeHandler.DUPLICATE_COOLDOWN_MS) {
        this.lastWriteAt.delete(id);
      }
    }
    this.lastWriteAt.set(forgeOpId, now);
  }

  /** Preview a single record by ID (resolve object type, fetch standard fields). */
  private async handleForgePreview(msg: InboundRequest): Promise<void> {
    const parsed = parsePayload(previewPayloadSchema, msg, 'forge:preview:error', this.deps);
    if (!parsed) return;
    const { recordId, orgId } = parsed;

    try {
      const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);

      // Resolve object type from record ID key prefix. The prefix table is
      // org-wide and identical for every preview, so it is cached per org
      // — without the cache each pasted record id re-downloaded the whole
      // describeGlobal payload.
      const keyPrefix = recordId.substring(0, 3);
      let sobjects = this.describeGlobalCache.get(orgId);
      if (!sobjects) {
        const globalDesc = await conn.describeGlobal();
        checkApiLimits(conn.limitInfo, 'forge:preview describeGlobal');
        sobjects = globalDesc.sobjects.map((s) => ({
          name: s.name,
          label: s.label,
          keyPrefix: s.keyPrefix ?? null,
        }));
        this.describeGlobalCache.set(orgId, sobjects);
      }
      const sobjectInfo = sobjects.find((s) => s.keyPrefix === keyPrefix);

      if (!sobjectInfo) {
        const errResponse = buildResponse(this.deps, msg, 'forge:preview:error', {
          message: `Unknown object for key prefix "${keyPrefix}"`,
        });
        this.deps.broker.postToWebview(errResponse);
        return;
      }

      // Query the record with standard fields (with fallback for orgs not supporting FIELDS() syntax)
      const records = await queryWithFieldsFallback<Record<string, unknown>>(
        conn,
        sobjectInfo.name,
        `SELECT FIELDS(STANDARD) FROM ${sobjectInfo.name} WHERE Id = '${sanitizeSoqlValue(recordId)}' LIMIT 1`,
      );
      checkApiLimits(conn.limitInfo, `forge:preview query ${sobjectInfo.name}`);

      if (!records || records.length === 0) {
        const errResponse = buildResponse(this.deps, msg, 'forge:preview:error', {
          message: `Record not found: ${recordId}`,
        });
        this.deps.broker.postToWebview(errResponse);
        return;
      }

      const record = records[0];
      const skipKeys = new Set(['attributes', 'Id']);
      const fields = Object.entries(record)
        .filter(([key]) => !skipKeys.has(key))
        .filter(([, value]) => value != null && String(value) !== '')
        .slice(0, 8)
        .map(([key, value]) => ({ name: key, value: String(value) }));

      // Describe the object for total field count
      const objectDesc = await conn.describe(sobjectInfo.name);
      checkApiLimits(conn.limitInfo, `forge:preview describe ${sobjectInfo.name}`);
      const totalFieldCount = objectDesc.fields.length;

      // Count records in the object
      let estimatedRecordCount = 0;
      try {
        const countResult = await conn.query(`SELECT COUNT() FROM ${sobjectInfo.name}`);
        estimatedRecordCount = countResult.totalSize;
      } catch {
        // Some objects may not support COUNT() -- fall back to 0
      }

      // Compute estimated size using the same heuristic as GraphDiscoveryService
      const estimatedSize = estimatedRecordCount * 0.001; // MB_PER_RECORD

      const response = buildResponse(this.deps, msg, 'forge:preview:response', {
        objectApiName: sobjectInfo.name,
        objectLabel: sobjectInfo.label,
        recordId,
        fields,
        estimatedRecordCount,
        totalFieldCount,
        estimatedSize,
      });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'forge:preview', 'forge:preview:error', msg, err, {
        code: 'PREVIEW_ERROR',
      });
    }
  }

  private async handleDiscover(msg: InboundRequest): Promise<void> {
    if (!this.orchestrator) {
      sendHandlerError(
        this.deps,
        'forge:discover',
        'forge:discover:error',
        msg,
        new Error('Forge module is not initialized'),
        { code: 'NOT_INITIALIZED' },
      );
      return;
    }

    const parsed = parsePayload(discoverPayloadSchema, msg, 'forge:discover:error', this.deps);
    if (!parsed) return;
    const { config } = parsed;
    // A discovery still running belongs to a screen the user has left (Back,
    // then Discover again). Overwriting its controller without aborting it
    // left that BFS running beside the new one with nothing able to stop it.
    this.discoverAbortController?.abort();
    const controller = new AbortController();
    this.discoverAbortController = controller;
    const operationId = `forge-discover-${this.deps.nextId()}`;
    sendOperationStarted(this.deps, operationId, 'forge', 'Discovering object graph');

    // Throttle progress events to ~10/s. Without this, big graphs flood
    // the webview with hundreds of postMessages, each carrying a JSON
    // payload that vscode has to serialize. Terminal events are emitted
    // immediately; mid-stream events are coalesced. Hoisted out of try
    // so the catch path can flush pending events too.
    const throttledProgress = throttle((event: Record<string, unknown>) => {
      const progressMsg = buildResponse(this.deps, msg, 'forge:discover:progress', event);
      this.deps.broker.postToWebview(progressMsg);
    }, 100);

    try {
      logger.info('Forge discover started');
      const graph = await this.orchestrator.discover(config, {
        signal: controller.signal,
        onProgress: (event) => {
          throttledProgress(event as unknown as Record<string, unknown>);
        },
      });
      throttledProgress.flush();
      if (controller.signal.aborted) {
        // Cancelled from the wizard or replaced by a newer discovery. The BFS
        // hands back the partial graph it had reached; answering with it would
        // land that truncated graph in whichever discovery screen is open now.
        sendOperationCompleted(this.deps, operationId, { aborted: true });
        return;
      }
      const response = buildResponse(this.deps, msg, 'forge:discover:response', { graph });
      this.deps.broker.postToWebview(response);
      sendOperationCompleted(this.deps, operationId, { nodeCount: graph.nodes?.length ?? 0 });
    } catch (error: unknown) {
      // Flush any pending throttled progress event so the UI gets
      // the latest queue state before the error response arrives. Without
      // this, an abort mid-BFS leaves the wizard frozen on stale counts.
      throttledProgress.flush();
      // A cancelled or replaced walk can still throw on its way out. Its error
      // would stop the spinner of the discovery screen open now, whose own walk
      // is still running.
      if (controller.signal.aborted) {
        sendOperationCompleted(this.deps, operationId, { aborted: true });
        return;
      }
      // Single error channel: `forge:discover:error` is what the webview
      // consumes (ForgeDiscovery clears loading + surfaces the message).
      // `operation:failed` is intentionally NOT emitted here — every
      // `operation:failed` also triggers an error resolution
      // (`sendOperationFailed`), so emitting one alongside the domain error
      // would make each forge failure pay for a parasitic duplicate.
      sendHandlerError(this.deps, 'forge:discover', 'forge:discover:error', msg, error, {
        code: 'DISCOVER_ERROR',
        retryable: true,
      });
    } finally {
      // Only release the controller this call owns: a superseded discovery
      // settles after its replacement started, and nulling the field then cut
      // the live one off from forge:abort.
      if (this.discoverAbortController === controller) {
        this.discoverAbortController = null;
      }
    }
  }

  private async handleExecute(msg: InboundRequest): Promise<void> {
    if (!this.orchestrator) {
      sendHandlerError(
        this.deps,
        'forge:execute',
        'forge:execute:error',
        msg,
        new Error('Forge module is not initialized'),
        { code: 'NOT_INITIALIZED' },
      );
      return;
    }

    const parsed = parsePayload(executePayloadSchema, msg, 'forge:execute:error', this.deps);
    if (!parsed) return;
    const { graph, config } = parsed;

    // Production guard check on the target org — same policy as sync/seed
    // runs (guard instance from backgroundComposition via infraServices).
    // Covers every write path below: BatchWriter insert/upsert, orphan-parent
    // expansion inserts and the pass-2 cycle-FK updates all flow through
    // orchestrator.execute, which runs only after this gate.
    if (this.deps.infraServices?.productionGuard) {
      const guard = this.deps.infraServices.productionGuard;
      const targetOrg = this.deps.orgManager.getOrg(config.targetOrgId);
      const guardRequest = {
        orgId: config.targetOrgId,
        orgTier: orgTypeToGuardTier(targetOrg?.orgType ?? ''),
        operation: 'insert' as const,
        objectName: graph.nodes?.[0]?.objectApiName ?? 'ForgeData',
        recordCount: graph.totalRecords ?? 0,
        module: 'forge',
      };
      const check = guard.check(guardRequest);
      guard.logOperation(guardRequest, check);
      if (!check.allowed) {
        // Single error channel (see handleDiscover): forge:execute:error
        // only — no duplicate operation:failed / parasitic error resolution.
        sendHandlerError(
          this.deps,
          'forge:execute',
          'forge:execute:error',
          msg,
          new Error(
            `Operation blocked by Production Guard: ${check.blockedReason ?? check.impactSummary}`,
          ),
          { code: 'GUARD_BLOCKED' },
        );
        return;
      }
      // `safety.requireProdConfirmation`: explicit user consent before
      // writing to a production org.
      const confirmed = await guard.confirmIfNeeded(check);
      if (!confirmed) {
        sendHandlerError(
          this.deps,
          'forge:execute',
          'forge:execute:error',
          msg,
          new Error('Operation cancelled by user (production confirmation declined).'),
          { code: 'GUARD_DECLINED', retryable: true },
        );
        return;
      }
    }

    // Build a deterministic ID from payload content to detect genuine duplicates
    const configKey = `${config.sourceOrgId}:${config.targetOrgId}:${config.recordId ?? ''}`;
    const objectKeys = graph.nodes?.map((n) => n.objectApiName).join(',') ?? '';
    const forgeOpId = `forge:${configKey}:${objectKeys}:${graph.totalRecords ?? 0}`;

    // Refuse the payload only while an identical run is still in flight, or
    // during a short cooldown after one that actually wrote records. Anything
    // else — a failed run, a run that created nothing — is retryable at once.
    const tracked = this.dmlTracker.isDuplicate(forgeOpId)
      ? this.dmlTracker.get(forgeOpId)
      : undefined;
    const lastWrite = this.lastWriteAt.get(forgeOpId);
    const inCooldown =
      lastWrite !== undefined && Date.now() - lastWrite < ForgeHandler.DUPLICATE_COOLDOWN_MS;
    if (tracked?.status === 'pending' || inCooldown) {
      logger.warn('Duplicate forge execution detected', { operationId: forgeOpId });
      sendHandlerError(
        this.deps,
        'forge:execute',
        'forge:execute:error',
        msg,
        new Error(`Duplicate forge operation: ${forgeOpId}`),
        { code: 'DUPLICATE' },
      );
      return;
    }

    const totalRecords = graph.totalRecords ?? 0;
    if (tracked) {
      // A previous attempt with this exact payload reached a terminal state.
      // `register()` throws on an id it already knows and the tracker exposes
      // no release call, so re-arm the entry in place — including its
      // registration stamp, which anchors the TTL to this attempt.
      tracked.status = 'pending';
      tracked.recordCount = totalRecords;
      tracked.registeredAt = new Date().toISOString();
    } else {
      this.dmlTracker.register(forgeOpId, 'forge', 'upsert', totalRecords);
    }

    const runController = new AbortController();
    this.abortController = runController;
    const operationId = `forge-execute-${this.deps.nextId()}`;
    sendOperationStarted(this.deps, operationId, 'forge', 'Executing forge operation');

    // Throttle execute progress events to ~10/s. With Bulk API 2.0 batches
    // of 200 records, a 50K-record clone fires ~250 events; spamming each
    // through postMessage adds tens of MB of redundant traffic.
    const throttledExecProgress = throttle((event: Record<string, unknown>) => {
      const progressMsg = buildResponse(this.deps, msg, 'forge:progress', event);
      this.deps.broker.postToWebview(progressMsg);
    }, 100);
    const unsubProgress = this.orchestrator.on('forge:progress', (event) => {
      // Always pass through terminal/error states so the UI can finalize.
      const status = (event as { status?: string }).status;
      if (status === 'done' || status === 'error') {
        throttledExecProgress.flush();
        const progressMsg = buildResponse(
          this.deps,
          msg,
          'forge:progress',
          event as unknown as Record<string, unknown>,
        );
        this.deps.broker.postToWebview(progressMsg);
        return;
      }
      throttledExecProgress(event as unknown as Record<string, unknown>);
    });

    try {
      logger.info('Forge execute started');
      // RecordType Ids differ between orgs. Without this table every cloned
      // record kept the source org's RecordTypeId, which the target rejects.
      const recordTypeMappings = await this.loadRecordTypeMappings(config, runController.signal);
      // An Abort that lands during that lookup reaches an executor that has not
      // started yet, and execute() clears its abort flag on entry — the run
      // would go ahead and write. Honour it here instead.
      if (runController.signal.aborted) {
        throw new Error('Forge execution was aborted before it started. Nothing was written.');
      }
      const result = await this.orchestrator.execute(graph, config, { recordTypeMappings });

      // Arm the duplicate cooldown only when the run wrote something: a
      // failure, or a run that remapped no record at all, leaves the recipe
      // immediately re-runnable.
      if (result.status !== 'failure' && result.idRemapCount > 0) {
        this.noteForgeWrite(forgeOpId);
      }

      // Persist to history via ConfigStore, carrying the config that produced
      // the run. Without it a history entry is inspectable but not repeatable
      // — there is nothing to rebuild a `forge:execute` from. Org ids are
      // stripped (same shape as ForgeTemplate.config): a re-run re-picks
      // source and target instead of replaying yesterday's org pair.
      const entry: ForgeExecutionResult = { ...result, config: stripOrgIds(config) };
      const history = [entry, ...this.loadHistory()].slice(0, ForgeHandler.MAX_HISTORY);
      this.saveHistory(history);

      const response = buildResponse(this.deps, msg, 'forge:execute:response', {
        result,
        operationId,
      });
      this.deps.broker.postToWebview(response);
      this.dmlTracker.markCompleted(forgeOpId);
      sendOperationCompleted(this.deps, operationId, { status: result.status });
    } catch (error: unknown) {
      this.dmlTracker.markFailed(forgeOpId);
      // A failed run wrote nothing worth protecting — clear any cooldown so
      // the user can fix the cause and re-run immediately.
      this.lastWriteAt.delete(forgeOpId);
      // Single error channel (see handleDiscover): `forge:execute:error`
      // only — no duplicate `operation:failed` / parasitic error resolution.
      sendHandlerError(this.deps, 'forge:execute', 'forge:execute:error', msg, error, {
        code: 'EXECUTE_ERROR',
        retryable: true,
      });
    } finally {
      // Unsubscribe BEFORE flushing so the flush's terminal event
      // doesn't trigger any progress listeners that we're about to remove.
      // Then flush so the last queued progress event reaches the webview
      // before this handler returns.
      unsubProgress();
      throttledExecProgress.flush();
      this.abortController = null;
    }
  }

  private handlePause(_msg: BaseMessage): void {
    this.orchestrator?.pause();
    logger.info('Forge paused');
  }

  private handleResume(_msg: BaseMessage): void {
    this.orchestrator?.resume();
    logger.info('Forge resumed');
  }

  private handleAbort(_msg: BaseMessage): void {
    // Signal abort, then null the refs so a stale post-abort signal
    // can't leak between sequential operations (e.g. abort during discover
    // followed by an immediate execute). The handler functions reset the
    // refs on entry, but defensive nulling here closes the race window.
    this.discoverAbortController?.abort();
    this.discoverAbortController = null;
    this.abortController?.abort();
    this.abortController = null;
    this.orchestrator?.abort();
    logger.info('Forge aborted');
  }

  /**
   * Build the source -> target RecordType table the executor translates
   * `RecordTypeId` with, the way the command-line clone does: active record
   * types of both orgs, matched by object and DeveloperName.
   *
   * A failure here does not stop the run. It is logged, and the clone proceeds
   * as it did before the table existed — records keep the source Id — rather
   * than refusing a clone whose objects may carry no record type at all. The
   * lookup is bounded: a hung org falls back the same way after
   * {@link RECORD_TYPES_TIMEOUT_MS}, and an Abort returns at once so the
   * caller can refuse the run without waiting for the org to answer.
   */
  private async loadRecordTypeMappings(
    config: ForgeConfig,
    signal: AbortSignal,
  ): Promise<RecordTypeMapping[] | undefined> {
    let onAbort: () => void = () => {};
    const aborted = new Promise<undefined>((resolve) => {
      onAbort = () => resolve(undefined);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const lookup = new TimeoutManager(RECORD_TYPES_TIMEOUT_MS).withTimeout(
        'forge:record-types',
        () => this.readRecordTypeMappings(config),
      );
      return await Promise.race([lookup, aborted]);
    } catch (err: unknown) {
      logger.warn(
        `[forge] Record types could not be read from both orgs (${extractErrorMessage(err)}); ` +
          `cloned records keep their source RecordTypeId.`,
      );
      return undefined;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  private async readRecordTypeMappings(config: ForgeConfig): Promise<RecordTypeMapping[]> {
    const [sourceTypes, targetTypes] = await Promise.all(
      [config.sourceOrgId, config.targetOrgId].map(async (orgId) => {
        const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
        const { records } = await queryAllPages<Record<string, unknown>>(
          {
            query: async (q) => conn.query<Record<string, unknown>>(q),
            queryMore: async (url) => conn.queryMore<Record<string, unknown>>(url),
          },
          RECORD_TYPES_SOQL,
        );
        return recordTypeRowsSchema.parse(records).map((r) => ({
          id: r.Id,
          name: r.Name,
          developerName: r.DeveloperName,
          sobjectType: r.SobjectType,
        }));
      }),
    );
    return new RecordTypeMapper().buildMapping(sourceTypes, targetTypes);
  }

  private async handleTemplatesList(msg: InboundRequest): Promise<void> {
    const templates = await this.loadTemplates();
    const response = buildResponse(this.deps, msg, 'forge:templates:list:response', { templates });
    this.deps.broker.postToWebview(response);
  }

  private async handleSaveTemplate(msg: InboundRequest): Promise<void> {
    const parsed = parsePayload(
      saveTemplatePayloadSchema,
      msg,
      'forge:templates:save:error',
      this.deps,
    );
    if (!parsed) return;
    const { template } = parsed;
    const templates = [
      template,
      ...(await this.loadTemplates()).filter((t) => t.id !== template.id),
    ];
    await this.saveTemplates(templates);
    const response = buildResponse(this.deps, msg, 'forge:templates:save:response', {
      success: true,
    });
    this.deps.broker.postToWebview(response);
  }

  private async handleDeleteTemplate(msg: InboundRequest): Promise<void> {
    const parsed = parsePayload(
      deleteTemplatePayloadSchema,
      msg,
      'forge:templates:delete:error',
      this.deps,
    );
    if (!parsed) return;
    const { templateId } = parsed;
    const templates = (await this.loadTemplates()).filter((t) => t.id !== templateId);
    await this.saveTemplates(templates);
    const response = buildResponse(this.deps, msg, 'forge:templates:delete:response', {
      success: true,
    });
    this.deps.broker.postToWebview(response);
  }

  private handleHistoryList(msg: InboundRequest): void {
    const history = this.loadHistory();
    const response = buildResponse(this.deps, msg, 'forge:history:list:response', { history });
    this.deps.broker.postToWebview(response);
  }

  /** Generate a forge execution plan from a graph. */
  private async handlePlanRequest(msg: InboundRequest): Promise<void> {
    if (!this.planGenerator) {
      sendHandlerError(
        this.deps,
        'forge:plan',
        'forge:plan:error',
        msg,
        new Error('Plan generator not configured'),
        { code: 'NOT_INITIALIZED' },
      );
      return;
    }
    const parsed = parsePayload(planRequestPayloadSchema, msg, 'forge:plan:error', this.deps);
    if (!parsed) return;
    const { graph } = parsed;
    const operationId = `forge-plan-${this.deps.nextId()}`;
    sendOperationStarted(this.deps, operationId, 'forge', 'Generating execution plan');
    try {
      logger.info('Forge plan generation started');
      const plan = await new TimeoutManager(PLAN_TIMEOUT_MS).withTimeout('forge:plan', () =>
        Promise.resolve(this.planGenerator!.generate(graph)),
      );
      const response = buildResponse(this.deps, msg, 'forge:plan:response', { plan });
      this.deps.broker.postToWebview(response);
      sendOperationCompleted(this.deps, operationId, { waveCount: plan.waves?.length ?? 0 });
    } catch (error: unknown) {
      const isTimeout = error instanceof TimeoutError;
      // Single error channel (see handleDiscover): no duplicate operation:failed.
      sendHandlerError(this.deps, 'forge:plan', 'forge:plan:error', msg, error, {
        code: isTimeout ? 'TIMEOUT' : 'PLAN_ERROR',
        retryable: isTimeout,
      });
    }
  }

  /** Generate a compliance report for a graph and framework. */
  private async handleComplianceRequest(msg: InboundRequest): Promise<void> {
    if (!this.complianceService) {
      sendHandlerError(
        this.deps,
        'forge:compliance',
        'forge:compliance:error',
        msg,
        new Error('Compliance service not configured'),
        { code: 'NOT_INITIALIZED' },
      );
      return;
    }
    const parsed = parsePayload(
      complianceRequestPayloadSchema,
      msg,
      'forge:compliance:error',
      this.deps,
    );
    if (!parsed) return;
    const { framework, graph, config } = parsed;
    const operationId = `forge-compliance-${this.deps.nextId()}`;
    sendOperationStarted(this.deps, operationId, 'forge', 'Generating compliance report');
    try {
      logger.info('Forge compliance report generation started');
      const report = await new TimeoutManager(COMPLIANCE_TIMEOUT_MS).withTimeout(
        'forge:compliance',
        () =>
          Promise.resolve(
            this.complianceService!.generate(
              framework as ComplianceFrameworkType,
              graph,
              config.sourceOrgId,
              config.targetOrgId,
            ),
          ),
      );
      const response = buildResponse(this.deps, msg, 'forge:compliance:response', { report });
      this.deps.broker.postToWebview(response);
      sendOperationCompleted(this.deps, operationId, { framework });
    } catch (error: unknown) {
      const isTimeout = error instanceof TimeoutError;
      // Single error channel (see handleDiscover): no duplicate operation:failed.
      sendHandlerError(this.deps, 'forge:compliance', 'forge:compliance:error', msg, error, {
        code: isTimeout ? 'TIMEOUT' : 'COMPLIANCE_ERROR',
        retryable: isTimeout,
      });
    }
  }

  /** Compare metadata schemas between source and target orgs. */
  private async handleMetadataDiffRequest(msg: InboundRequest): Promise<void> {
    if (!this.metadataDiff) {
      sendHandlerError(
        this.deps,
        'forge:metadata-diff',
        'forge:metadata-diff:error',
        msg,
        new Error('Metadata diff service not configured'),
        { code: 'NOT_INITIALIZED' },
      );
      return;
    }
    const parsed = parsePayload(
      metadataDiffRequestPayloadSchema,
      msg,
      'forge:metadata-diff:error',
      this.deps,
    );
    if (!parsed) return;
    const { sourceOrgId, targetOrgId, objectApiNames } = parsed;
    const operationId = `forge-metadata-diff-${this.deps.nextId()}`;
    sendOperationStarted(this.deps, operationId, 'forge', 'Comparing metadata schemas');
    try {
      logger.info('Forge metadata diff started');
      const diffs = await new TimeoutManager(METADATA_DIFF_TIMEOUT_MS).withTimeout(
        'forge:metadata-diff',
        () => this.metadataDiff!.compare(sourceOrgId, targetOrgId, objectApiNames),
      );
      const response = buildResponse(this.deps, msg, 'forge:metadata-diff:response', { diffs });
      this.deps.broker.postToWebview(response);
      sendOperationCompleted(this.deps, operationId, { objectCount: objectApiNames.length });
    } catch (error: unknown) {
      const isTimeout = error instanceof TimeoutError;
      // Single error channel (see handleDiscover): no duplicate operation:failed.
      sendHandlerError(this.deps, 'forge:metadata-diff', 'forge:metadata-diff:error', msg, error, {
        code: isTimeout ? 'TIMEOUT' : 'METADATA_DIFF_ERROR',
        retryable: isTimeout,
      });
    }
  }
}
