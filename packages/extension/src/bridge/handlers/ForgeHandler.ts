import type { BaseMessage, ForgeExecutionResult, ForgeTemplate, ComplianceFrameworkType } from '@sandforge/shared';
import { forgeConfigSchema, forgeGraphSchema, forgeTemplateSchema } from '@sandforge/shared';
import { z } from 'zod';
import type { HandlerDeps, DomainHandler } from './HandlerTypes.js';
import { buildResponse, sendHandlerError, sendOperationStarted, sendOperationCompleted, sendOperationFailed } from './HandlerTypes.js';
import { logger } from '../../logger.js';
import { DmlOperationTracker } from '../../core/common/DmlOperationTracker.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { queryWithFieldsFallback } from '../../core/common/soqlQueryHelper.js';
import { sanitizeSoqlValue } from '../../core/common/soqlValidator.js';
import { checkApiLimits } from '../../core/common/sforceLimitParser.js';
import { TimeoutManager, TimeoutError } from '../../core/engine/TimeoutManager.js';
import type { ForgeOrchestrator } from '../../modules/forge/ForgeOrchestrator.js';
import type { ForgePlanGenerator } from '../../modules/forge/ForgePlanGenerator.js';
import type { ForgeComplianceService } from '../../modules/forge/ForgeComplianceService.js';
import type { ForgeMetadataDiff } from '../../modules/forge/ForgeMetadataDiff.js';
import type { ForgeTemplateStore } from '../../modules/forge/ForgeTemplateStore.js';
import type { ForgeHistoryStore } from '../../modules/forge/ForgeHistoryStore.js';

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
  // RT-005: tightened from .max(500) to .max(100). 100 SObjects per diff
  // is already past any realistic UI use case; 500 enabled API-limit DoS
  // (500 source describes + 500 target describes = 1000 calls per request).
  objectApiNames: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/).max(80)).max(100),
});
const targetPreflightPayloadSchema = z.object({
  targetOrgId: orgIdSchema,
  // Reuse SObject regex; cap matches metadataDiff bound (100 objects per
  // request → 100 SELECT COUNT() round-trips, manageable in <30 s).
  objectApiNames: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/).max(80)).max(100),
});

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
 * Validate a webview message payload against a zod schema. Returns parsed
 * data on success; on failure, posts a handler error and returns null so
 * the caller can early-return. Defense-in-depth against compromised webview.
 */
function parsePayload<T>(
  schema: z.ZodSchema<T>,
  msg: BaseMessage,
  responseType: string,
  deps: HandlerDeps,
): T | null {
  const payload = (msg as { payload?: unknown }).payload;
  const result = schema.safeParse(payload);
  if (!result.success) {
    const summary = result.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    sendHandlerError(deps, msg.type, responseType, new Error(`Invalid payload — ${summary}`), 'INVALID_PAYLOAD');
    return null;
  }
  return result.data;
}

/** Optional v2 services injected alongside the ForgeOrchestrator. */
export interface ForgeServices {
  /** Optional plan generator for wave-based planning. */
  planGenerator?: ForgePlanGenerator;
  /** Optional compliance service for PII reports. */
  complianceService?: ForgeComplianceService;
  /** Optional metadata diff service for schema comparison. */
  metadataDiff?: ForgeMetadataDiff;
  /** @deprecated Templates are now persisted via ConfigStore. Accepted for backward compatibility. */
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
  'forge:target-preflight:request',
]);

/** Timeout for plan generation in milliseconds. */
const PLAN_TIMEOUT_MS = 30_000;

/** Timeout for compliance report generation in milliseconds. */
const COMPLIANCE_TIMEOUT_MS = 30_000;

/** Timeout for metadata diff comparison in milliseconds. */
const METADATA_DIFF_TIMEOUT_MS = 60_000;

/** Timeout for the target preflight (per-object COUNT) in milliseconds. */
const TARGET_PREFLIGHT_TIMEOUT_MS = 30_000;

/** ConfigStore key for persisted forge templates. */
const TEMPLATES_KEY = 'forge:templates';

/** ConfigStore key for persisted forge execution history. */
const HISTORY_KEY = 'forge:history';

/** ConfigStore category for all forge data. */
const FORGE_CATEGORY = 'forge';

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

  /** Tracks DML operations to prevent duplicate forge executions. */
  private readonly dmlTracker = new DmlOperationTracker();

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
  setForgeOrchestrator(
    orchestrator: ForgeOrchestrator,
    services?: ForgeServices,
  ): void {
    this.orchestrator = orchestrator;
    if (services) {
      this.planGenerator = services.planGenerator;
      this.complianceService = services.complianceService;
      this.metadataDiff = services.metadataDiff;
    }
  }

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: BaseMessage): Promise<boolean> {
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
        this.handleTemplatesList(msg);
        return true;
      case 'forge:templates:save':
        this.handleSaveTemplate(msg);
        return true;
      case 'forge:templates:delete':
        this.handleDeleteTemplate(msg);
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
      case 'forge:target-preflight:request':
        await this.handleTargetPreflightRequest(msg);
        return true;
      default:
        return false;
    }
  }

  /** Load templates from ConfigStore. */
  private loadTemplates(): ForgeTemplate[] {
    return this.deps.configStore.get<ForgeTemplate[]>(TEMPLATES_KEY) ?? [];
  }

  /** Save templates to ConfigStore. */
  private saveTemplates(templates: ForgeTemplate[]): void {
    this.deps.configStore.set(TEMPLATES_KEY, templates, FORGE_CATEGORY);
  }

  /** Load execution history from ConfigStore. */
  private loadHistory(): ForgeExecutionResult[] {
    return this.deps.configStore.get<ForgeExecutionResult[]>(HISTORY_KEY) ?? [];
  }

  /** Save execution history to ConfigStore. */
  private saveHistory(history: ForgeExecutionResult[]): void {
    this.deps.configStore.set(HISTORY_KEY, history, FORGE_CATEGORY);
  }

  /** Preview a single record by ID (resolve object type, fetch standard fields). */
  private async handleForgePreview(msg: BaseMessage): Promise<void> {
    const parsed = parsePayload(previewPayloadSchema, msg, 'forge:preview:error', this.deps);
    if (!parsed) return;
    const { recordId, orgId } = parsed;

    try {

      const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);

      // Resolve object type from record ID key prefix
      const keyPrefix = recordId.substring(0, 3);
      const globalDesc = await conn.describeGlobal();
      checkApiLimits(conn.limitInfo, 'forge:preview describeGlobal');
      const sobjectInfo = globalDesc.sobjects.find(
        (s) => s.keyPrefix === keyPrefix,
      );

      if (!sobjectInfo) {
        const errResponse = buildResponse(this.deps, msg, 'forge:preview:error', {
          message: `Unknown object for key prefix "${keyPrefix}"`,
        });
        this.deps.broker.postToWebview(errResponse);
        return;
      }

      // Query the record with standard fields (with fallback for orgs not supporting FIELDS() syntax)
      const records = await queryWithFieldsFallback<Record<string, unknown>>(
        conn, sobjectInfo.name,
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
      sendHandlerError(this.deps, 'forge:preview', 'forge:preview:error', err, 'PREVIEW_ERROR');
    }
  }

  private async handleDiscover(msg: BaseMessage): Promise<void> {
    if (!this.orchestrator) {
      sendHandlerError(this.deps, 'forge:discover', 'forge:discover:error', new Error('Forge module is not initialized'), 'NOT_INITIALIZED');
      return;
    }

    const parsed = parsePayload(discoverPayloadSchema, msg, 'forge:discover:error', this.deps);
    if (!parsed) return;
    const { config } = parsed;
    this.discoverAbortController = new AbortController();
    const operationId = `forge-discover-${this.deps.nextId()}`;
    sendOperationStarted(this.deps, operationId, 'forge', 'Discovering object graph');

    // Throttle progress events to ~10/s. Without this, big graphs flood
    // the webview with hundreds of postMessages, each carrying a JSON
    // payload that vscode has to serialize. Terminal events are emitted
    // immediately; mid-stream events are coalesced. Hoisted out of try
    // so the catch path can flush pending events too (PERF-004).
    const throttledProgress = throttle((event: Record<string, unknown>) => {
      const progressMsg = buildResponse(this.deps, msg, 'forge:discover:progress', event);
      this.deps.broker.postToWebview(progressMsg);
    }, 100);

    try {
      logger.info('Forge discover started');
      const graph = await this.orchestrator.discover(config, {
        signal: this.discoverAbortController.signal,
        onProgress: (event) => {
          throttledProgress(event as unknown as Record<string, unknown>);
        },
      });
      throttledProgress.flush();
      const response = buildResponse(this.deps, msg, 'forge:discover:response', { graph });
      this.deps.broker.postToWebview(response);
      sendOperationCompleted(this.deps, operationId, { nodeCount: graph.nodes?.length ?? 0 });
    } catch (error: unknown) {
      // PERF-004: flush any pending throttled progress event so the UI gets
      // the latest queue state before the error response arrives. Without
      // this, an abort mid-BFS leaves the wizard frozen on stale counts.
      throttledProgress.flush();
      sendHandlerError(this.deps, 'forge:discover', 'forge:discover:error', error, 'DISCOVER_ERROR', true);
      sendOperationFailed(this.deps, operationId, String(error), true);
    } finally {
      this.discoverAbortController = null;
    }
  }

  private async handleExecute(msg: BaseMessage): Promise<void> {
    if (!this.orchestrator) {
      sendHandlerError(this.deps, 'forge:execute', 'forge:execute:error', new Error('Forge module is not initialized'), 'NOT_INITIALIZED');
      return;
    }

    const parsed = parsePayload(executePayloadSchema, msg, 'forge:execute:error', this.deps);
    if (!parsed) return;
    const { graph, config } = parsed;

    // Build a deterministic ID from payload content to detect genuine duplicates
    const configKey = `${config.sourceOrgId}:${config.targetOrgId}:${config.recordId ?? ''}`;
    const objectKeys = graph.nodes?.map((n) => n.objectApiName).join(',') ?? '';
    const forgeOpId = `forge:${configKey}:${objectKeys}:${graph.totalRecords ?? 0}`;

    if (this.dmlTracker.isDuplicate(forgeOpId)) {
      logger.warn('Duplicate forge execution detected', { operationId: forgeOpId });
      sendHandlerError(this.deps, 'forge:execute', 'forge:execute:error', new Error(`Duplicate forge operation: ${forgeOpId}`), 'DUPLICATE');
      return;
    }

    const totalRecords = graph.totalRecords ?? 0;
    this.dmlTracker.register(forgeOpId, 'forge', 'upsert', totalRecords);

    this.abortController = new AbortController();
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
        const progressMsg = buildResponse(this.deps, msg, 'forge:progress', event as unknown as Record<string, unknown>);
        this.deps.broker.postToWebview(progressMsg);
        return;
      }
      throttledExecProgress(event as unknown as Record<string, unknown>);
    });

    try {
      logger.info('Forge execute started');
      const result = await this.orchestrator.execute(graph, config);

      // Persist to history via ConfigStore
      const history = [result, ...this.loadHistory()].slice(0, ForgeHandler.MAX_HISTORY);
      this.saveHistory(history);

      const response = buildResponse(this.deps, msg, 'forge:execute:response', { result, operationId });
      this.deps.broker.postToWebview(response);
      this.dmlTracker.markCompleted(forgeOpId);
      sendOperationCompleted(this.deps, operationId, { status: result.status });
    } catch (error: unknown) {
      this.dmlTracker.markFailed(forgeOpId);
      sendHandlerError(this.deps, 'forge:execute', 'forge:execute:error', error, 'EXECUTE_ERROR', true);
      sendOperationFailed(this.deps, operationId, String(error), true);
    } finally {
      // CR-012: unsubscribe BEFORE flushing so the flush's terminal event
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
    // CR-010: signal abort, then null the refs so a stale post-abort signal
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

  private handleTemplatesList(msg: BaseMessage): void {
    const templates = this.loadTemplates();
    const response = buildResponse(this.deps, msg, 'forge:templates:list:response', { templates });
    this.deps.broker.postToWebview(response);
  }

  private handleSaveTemplate(msg: BaseMessage): void {
    const parsed = parsePayload(saveTemplatePayloadSchema, msg, 'forge:templates:save:error', this.deps);
    if (!parsed) return;
    const { template } = parsed;
    const templates = [template, ...this.loadTemplates().filter((t) => t.id !== template.id)];
    this.saveTemplates(templates);
    const response = buildResponse(this.deps, msg, 'forge:templates:save:response', { success: true });
    this.deps.broker.postToWebview(response);
  }

  private handleDeleteTemplate(msg: BaseMessage): void {
    const parsed = parsePayload(deleteTemplatePayloadSchema, msg, 'forge:templates:delete:error', this.deps);
    if (!parsed) return;
    const { templateId } = parsed;
    const templates = this.loadTemplates().filter((t) => t.id !== templateId);
    this.saveTemplates(templates);
    const response = buildResponse(this.deps, msg, 'forge:templates:delete:response', { success: true });
    this.deps.broker.postToWebview(response);
  }

  private handleHistoryList(msg: BaseMessage): void {
    const history = this.loadHistory();
    const response = buildResponse(this.deps, msg, 'forge:history:list:response', { history });
    this.deps.broker.postToWebview(response);
  }

  /** Generate a forge execution plan from a graph. */
  private async handlePlanRequest(msg: BaseMessage): Promise<void> {
    if (!this.planGenerator) {
      sendHandlerError(this.deps, 'forge:plan', 'forge:plan:error', new Error('Plan generator not configured'), 'NOT_INITIALIZED');
      return;
    }
    const parsed = parsePayload(planRequestPayloadSchema, msg, 'forge:plan:error', this.deps);
    if (!parsed) return;
    const { graph } = parsed;
    const operationId = `forge-plan-${this.deps.nextId()}`;
    sendOperationStarted(this.deps, operationId, 'forge', 'Generating execution plan');
    try {
      logger.info('Forge plan generation started');
      const plan = await new TimeoutManager(PLAN_TIMEOUT_MS).withTimeout(
        'forge:plan',
        () => Promise.resolve(this.planGenerator!.generate(graph)),
      );
      const response = buildResponse(this.deps, msg, 'forge:plan:response', { plan });
      this.deps.broker.postToWebview(response);
      sendOperationCompleted(this.deps, operationId, { waveCount: plan.waves?.length ?? 0 });
    } catch (error: unknown) {
      const isTimeout = error instanceof TimeoutError;
      sendHandlerError(
        this.deps, 'forge:plan', 'forge:plan:error', error,
        isTimeout ? 'TIMEOUT' : 'PLAN_ERROR',
        isTimeout,
      );
      sendOperationFailed(this.deps, operationId, String(error), isTimeout);
    }
  }

  /** Generate a compliance report for a graph and framework. */
  private async handleComplianceRequest(msg: BaseMessage): Promise<void> {
    if (!this.complianceService) {
      sendHandlerError(this.deps, 'forge:compliance', 'forge:compliance:error', new Error('Compliance service not configured'), 'NOT_INITIALIZED');
      return;
    }
    const parsed = parsePayload(complianceRequestPayloadSchema, msg, 'forge:compliance:error', this.deps);
    if (!parsed) return;
    const { framework, graph, config } = parsed;
    const operationId = `forge-compliance-${this.deps.nextId()}`;
    sendOperationStarted(this.deps, operationId, 'forge', 'Generating compliance report');
    try {
      logger.info('Forge compliance report generation started');
      const report = await new TimeoutManager(COMPLIANCE_TIMEOUT_MS).withTimeout(
        'forge:compliance',
        () => Promise.resolve(this.complianceService!.generate(
          framework as ComplianceFrameworkType,
          graph,
          config.sourceOrgId,
          config.targetOrgId,
        )),
      );
      const response = buildResponse(this.deps, msg, 'forge:compliance:response', { report });
      this.deps.broker.postToWebview(response);
      sendOperationCompleted(this.deps, operationId, { framework });
    } catch (error: unknown) {
      const isTimeout = error instanceof TimeoutError;
      sendHandlerError(
        this.deps, 'forge:compliance', 'forge:compliance:error', error,
        isTimeout ? 'TIMEOUT' : 'COMPLIANCE_ERROR',
        isTimeout,
      );
      sendOperationFailed(this.deps, operationId, String(error), isTimeout);
    }
  }

  /**
   * Pre-execute target preflight: count existing rows in the target org
   * for each of the supplied object API names. Lets the wizard surface
   * "X records already in target" before the user pulls the trigger.
   *
   * Bounded: max 100 objects per request (Zod), 30 s timeout. Failed
   * counts (FLS, non-queryable, etc.) come back as `existing: -1` rather
   * than failing the whole batch.
   */
  private async handleTargetPreflightRequest(msg: BaseMessage): Promise<void> {
    const parsed = parsePayload(targetPreflightPayloadSchema, msg, 'forge:target-preflight:error', this.deps);
    if (!parsed) return;
    const { targetOrgId, objectApiNames } = parsed;
    const operationId = `forge-target-preflight-${this.deps.nextId()}`;
    sendOperationStarted(this.deps, operationId, 'forge', 'Counting existing rows on target');
    try {
      logger.info('Forge target preflight started', { count: objectApiNames.length });
      const conn = await getJsforceConnection(targetOrgId, this.deps.orgRegistry, this.deps.orgManager);
      const counts = await new TimeoutManager(TARGET_PREFLIGHT_TIMEOUT_MS).withTimeout(
        'forge:target-preflight',
        async () => {
          const out: Array<{ objectApiName: string; existing: number }> = [];
          // Run sequentially — parallel COUNT() bursts trip rate limits on
          // big orgs and the 30 s timeout already bounds wall-time.
          for (const name of objectApiNames) {
            try {
              const r = await conn.query(`SELECT COUNT() FROM ${name}`);
              checkApiLimits(conn.limitInfo, `forge:target-preflight ${name}`);
              out.push({ objectApiName: name, existing: r.totalSize });
            } catch {
              // Sentinel -1 keeps the per-object failure visible in the UI
              // without aborting the whole preflight.
              out.push({ objectApiName: name, existing: -1 });
            }
          }
          return out;
        },
      );
      const response = buildResponse(this.deps, msg, 'forge:target-preflight:response', { counts });
      this.deps.broker.postToWebview(response);
      sendOperationCompleted(this.deps, operationId, { objectCount: counts.length });
    } catch (error: unknown) {
      const isTimeout = error instanceof TimeoutError;
      sendHandlerError(
        this.deps, 'forge:target-preflight', 'forge:target-preflight:error', error,
        isTimeout ? 'TIMEOUT' : 'PREFLIGHT_ERROR',
        isTimeout,
      );
      sendOperationFailed(this.deps, operationId, String(error), isTimeout);
    }
  }

  /** Compare metadata schemas between source and target orgs. */
  private async handleMetadataDiffRequest(msg: BaseMessage): Promise<void> {
    if (!this.metadataDiff) {
      sendHandlerError(this.deps, 'forge:metadata-diff', 'forge:metadata-diff:error', new Error('Metadata diff service not configured'), 'NOT_INITIALIZED');
      return;
    }
    const parsed = parsePayload(metadataDiffRequestPayloadSchema, msg, 'forge:metadata-diff:error', this.deps);
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
      sendHandlerError(
        this.deps, 'forge:metadata-diff', 'forge:metadata-diff:error', error,
        isTimeout ? 'TIMEOUT' : 'METADATA_DIFF_ERROR',
        isTimeout,
      );
      sendOperationFailed(this.deps, operationId, String(error), isTimeout);
    }
  }
}
