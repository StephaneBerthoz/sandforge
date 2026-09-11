import type { SyncConfig, SyncExecutionResult, SyncOperation } from '@sandforge/shared';
import {
  sanitizeSoqlObjectName,
  orgTypeToGuardTier,
  RobustnessConfigSchema,
} from '@sandforge/shared';
import type { RobustnessConfig } from '@sandforge/shared';
import type {
  HandlerDeps,
  DomainHandler,
  GrappeEventEnvelope,
  InboundRequest,
} from './HandlerTypes.js';
import {
  buildResponse,
  sendHandlerError,
  sendNotification,
  sendOperationStarted,
  sendOperationProgress,
  sendOperationCompleted,
  sendOperationFailed,
  postGrappeEvent,
  readGrappeConfig,
  syntheticRequest,
} from './HandlerTypes.js';
import { SyncConfigStore } from '../../modules/sync/SyncConfigStore.js';
import type { SyncExecutionLogger } from '../../modules/sync/SyncExecutionLogger.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { queryWithFieldsFallback, queryAll } from '../../core/common/soqlQueryHelper.js';
import {
  queryAllPages,
  FORGE_QUERY_MAX_RECORDS,
  FORGE_QUERY_MAX_PAGES,
} from '../../modules/forge/queryAllPages.js';
import { DmlOperationTracker } from '../../core/common/DmlOperationTracker.js';
import {
  validatePayload,
  syncExecutePayloadSchema,
  syncConfigSavePayloadSchema,
  syncConfigIdPayloadSchema,
  syncDescribeGlobalPayloadSchema,
  syncDescribeFieldsPayloadSchema,
} from '../validatePayload.js';
import { checkApiLimits } from '../../core/common/sforceLimitParser.js';
import { resolveOrgTier, getQueryLimits } from '../../core/common/queryLimits.js';
import { isNetworkError } from '../../core/common/isNetworkError.js';
import { RetryableOperation } from '../../core/engine/RetryableOperation.js';
import { TimeoutManager } from '../../core/engine/TimeoutManager.js';
import { BulkApiExecutor } from '../../core/engine/BulkApiExecutor.js';
import { BulkApiManager } from '../../core/engine/BulkApiManager.js';
import type { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import type { OperationRequest } from '../../core/precheck/ProductionGuard.js';
import { BulkDataWriter } from '../../modules/sync/BulkDataWriter.js';
import type { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';

/** Message types handled by SyncOpsHandler. */
const SYNC_TYPES = new Set([
  'sync:execute',
  'sync:describe-global',
  'sync:describe-fields',
  'sync:config:save',
  'sync:config:load',
  'sync:config:list',
  'sync:config:delete',
]);

/**
 * Severity ranking used to collapse a multi-object sync into the single
 * operation the Production Guard judges. Highest wins, so one `delete` object
 * makes the whole run destructive in the guard's eyes.
 */
const SYNC_OPERATION_SEVERITY: Record<SyncOperation, number> = {
  insert: 0,
  update: 1,
  upsert: 2,
  delete: 3,
};

/**
 * Domain handler for sync-related webview-to-extension messages.
 *
 * Routes sync:* message types to schema description and data synchronization
 * operations between Salesforce orgs, with production guard checks,
 * performance tracking, retry, timeout, bulk API, and field type validation.
 * Record writes are delegated to {@link BulkDataWriter}; this handler only
 * orchestrates message handling, guards, and progress channels.
 */
export class SyncOpsHandler implements DomainHandler {
  /**
   * Set of active operation IDs being tracked.
   * Used to ensure cleanup happens exactly once in all code paths.
   */
  private readonly activeOperationIds = new Set<string>();

  /** Tracks DML operations to prevent duplicate submissions. */
  private readonly dmlTracker = new DmlOperationTracker();

  /** Persistence facade for sync configurations. */
  private readonly syncConfigStore: SyncConfigStore;

  /** Background operation registry for detached execution. */
  private registry?: BackgroundOperationRegistry;

  /**
   * Execution-history logger. Injected by ExtensionHandlers so every completed
   * sync lands in SyncHistoryStore (powers the sync:history:* read surface).
   */
  private historyLogger?: SyncExecutionLogger;

  /** Live operation tracker feeding the Monitor "live operations" panel. */
  private liveTracker?: LiveOperationTracker;

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {
    this.syncConfigStore = new SyncConfigStore(deps.configStore);
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
   * Inject the sync execution-history logger.
   *
   * @param logger - The shared SyncExecutionLogger instance.
   */
  setHistoryLogger(logger: SyncExecutionLogger): void {
    this.historyLogger = logger;
  }

  /**
   * Inject the live operation tracker so sync executions show up in the
   * Monitor "live operations" panel. Called from ExtensionHandlers.
   *
   * @param tracker - The shared LiveOperationTracker instance.
   */
  setLiveOperationTracker(tracker: LiveOperationTracker): void {
    this.liveTracker = tracker;
  }

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: InboundRequest): Promise<boolean> {
    if (!SYNC_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'sync:describe-global':
        await this.handleDescribeGlobal(msg);
        return true;
      case 'sync:describe-fields':
        await this.handleDescribeFields(msg);
        return true;
      case 'sync:execute':
        await this.handleExecute(msg);
        return true;
      case 'sync:config:save':
        await this.handleConfigSave(msg);
        return true;
      case 'sync:config:load':
        await this.handleConfigLoad(msg);
        return true;
      case 'sync:config:list':
        await this.handleConfigList(msg);
        return true;
      case 'sync:config:delete':
        await this.handleConfigDelete(msg);
        return true;
      default:
        return false;
    }
  }

  /** Save a sync configuration. */
  private async handleConfigSave(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(syncConfigSavePayloadSchema, msg, 'sync:error', this.deps);
    if (!parsed) return;
    try {
      const config = parsed.config as unknown as SyncConfig;
      this.syncConfigStore.save(config);
      const response = buildResponse(this.deps, msg, 'sync:config:save:response', {
        success: true,
        id: config.id,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'sync:config:save', 'sync:error', msg, err);
    }
  }

  /** Load a sync configuration by ID. */
  private async handleConfigLoad(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(syncConfigIdPayloadSchema, msg, 'sync:error', this.deps);
    if (!parsed) return;
    try {
      const config = this.syncConfigStore.load(parsed.id);
      const response = buildResponse(this.deps, msg, 'sync:config:load:response', {
        config: (config as unknown as Record<string, unknown>) ?? null,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'sync:config:load', 'sync:error', msg, err);
    }
  }

  /** List all sync configurations (summary view). */
  private async handleConfigList(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    try {
      const configs = this.syncConfigStore.list();
      const summaries = configs.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        updatedAt: c.updatedAt,
      }));
      const response = buildResponse(this.deps, msg, 'sync:config:list:response', {
        configs: summaries,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'sync:config:list', 'sync:error', msg, err);
    }
  }

  /** Delete a sync configuration by ID. */
  private async handleConfigDelete(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(syncConfigIdPayloadSchema, msg, 'sync:error', this.deps);
    if (!parsed) return;
    try {
      const success = this.syncConfigStore.delete(parsed.id);
      const response = buildResponse(this.deps, msg, 'sync:config:delete:response', { success });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'sync:config:delete', 'sync:error', msg, err);
    }
  }

  /**
   * Load and validate robustness configuration from ConfigStore.
   * Falls back to schema defaults when no config is stored.
   */
  private getRobustnessConfig(): RobustnessConfig {
    const raw = this.deps.configStore.get<Partial<RobustnessConfig>>('robustness:config');
    return RobustnessConfigSchema.parse(raw ?? {});
  }

  /**
   * Build the Production Guard request describing a sync run on its target org.
   *
   * The guard judges one operation on one object, while a sync config carries
   * one operation per object — both are collapsed conservatively:
   * - `operation`: the most destructive operation configured (see
   *   {@link SYNC_OPERATION_SEVERITY}). This used to be hard-coded to
   *   `'upsert'`, which presented a delete-mode sync as a write and let it
   *   straight past the rule that blocks destructive operations on production.
   * - `objectName`: every object in the config, not just the first — the audit
   *   entry and the confirmation prompt must name what is actually touched.
   * - `recordCount`: 0. The source rows are only queried later, inside the
   *   orchestrator, so no count is known at gate time; 0 reports "unknown"
   *   (same convention as ForgeHandler's `graph.totalRecords ?? 0`) instead of
   *   the previous hard-coded 1, which claimed a volume nobody had measured.
   *
   * @param config - The sync config about to be executed.
   * @returns The guard request for its target org.
   */
  private buildGuardRequest(config: SyncConfig): OperationRequest {
    const targetOrg = this.deps.orgManager.getOrg(config.targetOrgId);
    const objects = config.objects ?? [];
    let operation: SyncOperation = 'insert';
    for (const object of objects) {
      if (SYNC_OPERATION_SEVERITY[object.operation] > SYNC_OPERATION_SEVERITY[operation]) {
        operation = object.operation;
      }
    }
    const objectNames = objects.map((o) => o.objectApiName);
    return {
      orgId: config.targetOrgId,
      orgTier: orgTypeToGuardTier(targetOrg?.orgType ?? ''),
      operation,
      objectName: objectNames.length > 0 ? objectNames.join(', ') : 'SyncData',
      recordCount: 0,
      module: 'sync',
    };
  }

  private async handleDescribeGlobal(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(syncDescribeGlobalPayloadSchema, msg, 'sync:error', this.deps);
    if (!parsed) return;
    const config = this.getRobustnessConfig();

    try {
      const conn = await getJsforceConnection(
        parsed.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );

      const timeout = new TimeoutManager(config.timeouts.describeGlobal);
      const result = await timeout.withTimeout('describe-global', () => conn.describeGlobal());
      checkApiLimits(conn.limitInfo, 'sync:describe-global');

      const objects = result.sobjects
        .filter((s: { createable: boolean; queryable: boolean }) => s.createable && s.queryable)
        .map((s: { name: string }) => s.name);

      const response = buildResponse(this.deps, msg, 'sync:describe-global:response', { objects });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'sync:describe-global', 'sync:error', msg, err);
    }
  }

  private async handleDescribeFields(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(syncDescribeFieldsPayloadSchema, msg, 'sync:error', this.deps);
    if (!parsed) return;
    const payload = parsed;
    const config = this.getRobustnessConfig();

    try {
      const sourceConn = await getJsforceConnection(
        payload.sourceOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const targetConn = await getJsforceConnection(
        payload.targetOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );

      const timeout = new TimeoutManager(config.timeouts.describe);
      const [sourceDesc, targetDesc] = await Promise.all([
        timeout.withTimeout('describe-source', () => sourceConn.describe(payload.objectApiName)),
        timeout.withTimeout('describe-target', () => targetConn.describe(payload.objectApiName)),
      ]);
      checkApiLimits(sourceConn.limitInfo, `sync:describe-fields source ${payload.objectApiName}`);
      checkApiLimits(targetConn.limitInfo, `sync:describe-fields target ${payload.objectApiName}`);

      const mapFields = (
        fields: Array<{ name: string; label: string; type: string; createable: boolean }>,
      ) =>
        fields
          .filter((f) => f.createable)
          .map((f) => ({ apiName: f.name, label: f.label, type: f.type }));

      const response = buildResponse(this.deps, msg, 'sync:describe-fields:response', {
        objectApiName: payload.objectApiName,
        sourceFields: mapFields(
          sourceDesc.fields as Array<{
            name: string;
            label: string;
            type: string;
            createable: boolean;
          }>,
        ),
        targetFields: mapFields(
          targetDesc.fields as Array<{
            name: string;
            label: string;
            type: string;
            createable: boolean;
          }>,
        ),
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'sync:describe-fields', 'sync:error', msg, err);
    }
  }

  private async handleExecute(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(syncExecutePayloadSchema, msg, 'sync:error', this.deps);
    if (!parsed) return;
    await this.startExecution(msg, parsed.config, 'manual');
  }

  /**
   * Re-run a sync from a persisted history config snapshot (`sync:history:rerun`).
   *
   * The snapshot was produced by a previously validated config, but it
   * round-trips through ConfigStore and the webview, so it is re-validated
   * here before execution (defense-in-depth). Validation failures are
   * reported on the `sync:history:error` channel the history store consumes.
   *
   * @param msg - The triggering `sync:history:rerun` message (correlation id source).
   * @param snapshot - The raw config snapshot loaded from SyncHistoryStore.
   */
  async rerunFromSnapshot(msg: InboundRequest, snapshot: unknown): Promise<void> {
    this.deps.log(`[RX] sync:history:rerun id=${msg.id}`);
    const parsed = validatePayload(
      syncExecutePayloadSchema,
      { ...msg, payload: { config: snapshot } },
      'sync:history:error',
      this.deps,
    );
    if (!parsed) return;
    await this.startExecution(msg, parsed.config, 'rerun');
  }

  /**
   * Execute a sync config on behalf of the sync schedule executor
   * (`sync:schedule:*` tick loop, wired via ExtensionHandlers.startSyncScheduler).
   *
   * Unlike the fire-and-forget message path (`sync:execute`), this awaits the
   * full execution and resolves with the orchestrator result so
   * SyncScheduleExecutor can persist `lastRunAt`/`lastResult`. Lifecycle
   * events still flow on the usual `operation:*` channels and the run lands
   * in sync history with `triggeredBy: 'schedule'`.
   *
   * The config round-trips through ConfigStore, so it is re-validated here
   * before execution (same defense-in-depth rule as rerunFromSnapshot) — an
   * invalid config rejects the returned promise instead of posting to an
   * error channel nobody is listening on at tick time.
   *
   * @param config - The schedule's persisted sync config.
   * @returns The orchestrator result (status 'failure' on execution error).
   */
  async executeScheduled(config: SyncConfig): Promise<SyncExecutionResult> {
    const parsed = syncExecutePayloadSchema.safeParse({ config });
    if (!parsed.success) {
      throw new Error(
        `Scheduled sync config failed validation: ${parsed.error.issues
          .map((i) => i.message)
          .join('; ')}`,
      );
    }
    // No webview request waits on a scheduled run: its origin is a listed
    // synthetic request, whose id doubles as the operationId on operation:*.
    const msg = syntheticRequest('sync:schedule', crypto.randomUUID(), 'sync:execute');
    const operationId = msg.id;

    // Fill per-object batch sizes from the `sandforge.sync.defaultBatchSize`
    // setting when the stored config omitted them (same rule as startExecution).
    const defaultBatchSize =
      this.deps.services?.getSandforgeSetting?.('sync.defaultBatchSize', 200) ?? 200;
    const filledConfig = {
      ...parsed.data.config,
      objects: parsed.data.config.objects.map((o) => ({
        ...o,
        batchSize: o.batchSize ?? defaultBatchSize,
      })),
    } as unknown as SyncConfig;

    // Production guard on target org — same policy as manual runs. A blocked
    // or declined run rejects so the scheduler marks the schedule as failed.
    if (this.deps.infraServices?.productionGuard) {
      const guard = this.deps.infraServices.productionGuard;
      const guardRequest = this.buildGuardRequest(filledConfig);
      const check = guard.check(guardRequest);
      guard.logOperation(guardRequest, check);
      if (!check.allowed) {
        throw new Error(
          `Operation blocked by Production Guard: ${check.blockedReason ?? check.impactSummary}`,
        );
      }
      const confirmed = await guard.confirmIfNeeded(check);
      if (!confirmed) {
        throw new Error('Scheduled sync cancelled (production confirmation declined).');
      }
    }

    this.dmlTracker.register(operationId, 'sync', 'upsert', filledConfig.objects?.length ?? 0);
    this.activeOperationIds.add(operationId);
    this.deps.infraServices?.performanceTracker?.start(operationId, 'sync');
    const scheduledDescription = `Scheduled sync of ${filledConfig.objects?.length ?? 0} object(s)`;
    sendOperationStarted(this.deps, operationId, 'sync', scheduledDescription);
    // Feed the Monitor "live operations" panel (total unknown until queries run).
    this.liveTracker?.register(operationId, 'sync', scheduledDescription);

    const abortController = new AbortController();
    // executeSync never rejects (it reports on operation:failed and converts
    // the outcome to a failure-status result), so no try/catch is needed here.
    return this.executeSync(msg, filledConfig, operationId, abortController, 'schedule');
  }

  /**
   * Shared execution entry point for `sync:execute` and `sync:history:rerun`:
   * fills per-object batch sizes, runs the production guard, registers the
   * operation, and dispatches the detached execution.
   *
   * @param msg - Triggering bridge message (correlation + operation id source).
   * @param rawConfig - Payload-validated sync config (webview or history snapshot).
   * @param triggeredBy - Origin marker persisted in the execution history entry.
   */
  private async startExecution(
    msg: InboundRequest,
    rawConfig: unknown,
    triggeredBy: 'manual' | 'rerun',
  ): Promise<void> {
    // Build a deterministic ID from the message ID to detect genuine duplicates
    const operationId = msg.id;

    try {
      // Fill per-object batch sizes from the `sandforge.sync.defaultBatchSize`
      // setting when the webview omitted them.
      const defaultBatchSize =
        this.deps.services?.getSandforgeSetting?.('sync.defaultBatchSize', 200) ?? 200;
      const parsedConfig = rawConfig as { objects: Array<{ batchSize?: number }> };
      const config = {
        ...parsedConfig,
        objects: parsedConfig.objects.map((o) => ({
          ...o,
          batchSize: o.batchSize ?? defaultBatchSize,
        })),
      } as unknown as import('@sandforge/shared').SyncConfig;

      // Production guard check on target org
      if (this.deps.infraServices?.productionGuard) {
        const guard = this.deps.infraServices.productionGuard;
        const guardRequest = this.buildGuardRequest(config);
        const check = guard.check(guardRequest);
        guard.logOperation(guardRequest, check);
        if (!check.allowed) {
          throw new Error(
            `Operation blocked by Production Guard: ${check.blockedReason ?? check.impactSummary}`,
          );
        }
        // `safety.requireProdConfirmation`: explicit user consent before
        // writing to a production org.
        const confirmed = await guard.confirmIfNeeded(check);
        if (!confirmed) {
          const message = 'Operation cancelled by user (production confirmation declined).';
          // Settle the in-flight useBridgeMutation listener on sync:error
          // (same dual-channel contract as the catch paths below). Stable
          // code, same as seed's decline path — this prose is SandForge's own,
          // not a pass-through Salesforce error.
          sendHandlerError(this.deps, 'sync:execute', 'sync:error', msg, new Error(message), {
            code: 'PROD_CONFIRMATION_DECLINED',
          });
          sendOperationFailed(this.deps, operationId, message, false);
          return;
        }
      }

      // Check for duplicate operation
      if (this.dmlTracker.isDuplicate(operationId)) {
        this.deps.log(`[WARN] Duplicate sync operation detected: ${operationId}`);
        sendHandlerError(
          this.deps,
          'sync:execute',
          'sync:error',
          msg,
          new Error(`Duplicate operation: ${operationId}`),
        );
        sendOperationFailed(this.deps, operationId, `Duplicate operation: ${operationId}`, false);
        return;
      }
      this.dmlTracker.register(operationId, 'sync', 'upsert', config.objects?.length ?? 0);

      // Start performance tracking and register the operation ID
      this.activeOperationIds.add(operationId);
      this.deps.infraServices?.performanceTracker?.start(operationId, 'sync');

      const description = `Sync ${config.objects?.length ?? 0} object(s)`;
      sendOperationStarted(this.deps, operationId, 'sync', description);
      // Feed the Monitor "live operations" panel (total unknown until queries run).
      this.liveTracker?.register(operationId, 'sync', description);

      // Create AbortController for this operation
      const abortController = new AbortController();

      // Build the execution promise (runs detached in the background)
      const executionPromise = this.executeSync(
        msg,
        config,
        operationId,
        abortController,
        triggeredBy,
      );

      // Register with BackgroundOperationRegistry if available
      if (this.registry) {
        this.registry.register(operationId, 'sync', description, executionPromise, abortController);
      } else {
        // Fallback: await directly when no registry is available
        await executionPromise;
      }

      // Return immediately -- execution continues in background
    } catch (err: unknown) {
      this.dmlTracker.markFailed(operationId);
      // Dual channel, single display: `operation:failed` carries the lifecycle
      // (webview clears global loading + auto AI-resolver); `sync:error` is the
      // `<domain>:error` channel useBridgeMutation listens on — it settles the
      // in-flight mutation with the real message. The webview surfaces the
      // error from sync:error only, so the user sees it exactly once.
      sendHandlerError(this.deps, 'sync:execute', 'sync:error', msg, err);
      sendOperationFailed(this.deps, operationId, extractErrorMessage(err), true);
    }
  }

  /**
   * Execute sync operation in the background.
   * Extracted from handleExecute to allow detached execution via BackgroundOperationRegistry.
   *
   * Resolves with the orchestrator result so scheduled executions
   * (`executeScheduled`) can persist lastRunAt/lastResult; failures are
   * reported on `operation:failed` and converted to a failure-status result
   * rather than a rejection, keeping the registry's monitored promise clean.
   */
  private async executeSync(
    msg: InboundRequest,
    config: import('@sandforge/shared').SyncConfig,
    operationId: string,
    abortController: AbortController,
    triggeredBy: 'manual' | 'rerun' | 'schedule',
  ): Promise<SyncExecutionResult> {
    const robustnessConfig = this.getRobustnessConfig();

    try {
      const sourceConn = await getJsforceConnection(
        config.sourceOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const targetConn = await getJsforceConnection(
        config.targetOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );

      /**
       * Query limits, resolved PER ORG.
       *
       * This used to resolve the tier from the source alone and hand the same
       * closure to both reads. Harmless while every read carried a LIMIT; the
       * moment the cap became conditional it inverted the protection it exists
       * for — on a sandbox -> production sync the source is a sandbox, so the
       * production TARGET was read with no cap at all, against the very org
       * whose API budget the cap protects.
       */
      const limitsFor = (
        orgId: string,
      ): { tier: ReturnType<typeof resolveOrgTier>; limits: ReturnType<typeof getQueryLimits> } => {
        const org = this.deps.orgManager.getOrg(orgId);
        const tier = resolveOrgTier(org?.orgType === 'Sandbox' || org?.orgType === 'Scratch');
        return { tier, limits: getQueryLimits(tier) };
      };

      // Build robustness utilities
      const bulkExecutor = new BulkApiExecutor(robustnessConfig.bulk.threshold);
      // `sandforge.sync.maxConcurrentOps` (manifest default 3) bounds the
      // number of concurrent Bulk API jobs for sync operations.
      const maxConcurrentOps =
        this.deps.services?.getSandforgeSetting?.('sync.maxConcurrentOps', 3) ?? 3;
      const bulkManager = new BulkApiManager(maxConcurrentOps);
      // Build the record writer: mutualizes insert/upsert/update/delete across
      // the streaming, Bulk API, and REST batch paths (see BulkDataWriter).
      const writer = new BulkDataWriter({
        connection: targetConn,
        bulkExecutor,
        bulkManager,
        retryConfig: robustnessConfig.retry,
        describeTimeoutMs: robustnessConfig.timeouts.describe,
        signal: abortController.signal,
        onProgress: (processed, total, label) => {
          const pct = Math.round((processed / total) * 100);
          sendOperationProgress(this.deps, operationId, pct, processed, total, label);
          this.liveTracker?.updateProgress(operationId, pct, processed, total, label);
        },
        log: (message) => this.deps.log(message),
      });

      // Build query functions with retry wrapping and dynamic limits
      const queryRetryOp = new RetryableOperation({ retryConfig: robustnessConfig.retry });
      const buildQueryFn =
        (conn: typeof sourceConn, orgId: string) =>
        async (
          _orgId: string,
          objectConfig: import('@sandforge/shared').SyncObjectConfig,
        ): Promise<Record<string, unknown>[]> => {
          const safeObj = sanitizeSoqlObjectName(objectConfig.objectApiName);
          let soql = `SELECT FIELDS(ALL) FROM ${safeObj}`;
          if (objectConfig.where) {
            // Defense-in-depth: reject WHERE clauses containing dangerous subquery patterns
            const upperWhere = objectConfig.where.toUpperCase();
            if (
              /\bSELECT\b/.test(upperWhere) ||
              /\bINSERT\b/.test(upperWhere) ||
              /\bUPDATE\b/.test(upperWhere) ||
              /\bDELETE\b/.test(upperWhere)
            ) {
              throw new Error(
                'WHERE clause contains forbidden keyword (SELECT/INSERT/UPDATE/DELETE). Subqueries are not allowed.',
              );
            }
            soql += ` WHERE ${objectConfig.where}`;
          }
          // This query used to end in a bare
          // `LIMIT ${syncQueryLimits.defaultQueryLimit}` and read the first
          // page only — 2 000 rows from a sandbox source, 500 from a
          // production one. On the 100 000-record orgs this product targets
          // that copies 2 % of the object and reports a completed sync.
          //
          // Two changes, and only these two:
          //  - the read follows the cursor to the end (`queryAllPages`, the
          //    same bounded helper Forge uses);
          //  - when a bound cuts the read short the user is told, on the
          //    notification channel and in the log. A bounded sync is a
          //    legitimate outcome; a silently partial one is the defect.
          //
          // The production cap stays. `queryLimits` keeps a production source
          // conservative on purpose — a sandbox refresh must not spend a
          // business org's daily API budget — so a production-tier run is
          // still capped server-side at `defaultQueryLimit` and now announces
          // the cut instead of hiding it. Sandbox and scratch sources, where
          // the 100 000-row clone actually happens, read every page up to
          // FORGE_QUERY_MAX_RECORDS / FORGE_QUERY_MAX_PAGES.
          const { tier, limits } = limitsFor(orgId);
          if (tier === 'production') {
            soql += ` LIMIT ${limits.defaultQueryLimit}`;
          }
          let boundCutTheRead = false;
          const retryResult = await queryRetryOp.execute(async () => {
            try {
              const paged = await queryAllPages<Record<string, unknown>>(
                {
                  // jsforce hands back a thenable `Query`, not a Promise.
                  query: async (q) => conn.query<Record<string, unknown>>(q),
                  queryMore: async (url) => conn.queryMore<Record<string, unknown>>(url),
                },
                soql,
              );
              boundCutTheRead = paged.truncated;
              return paged.records;
            } catch {
              // The org rejects the `FIELDS()` syntax: fall back to the
              // explicit field list built from `describe()`. That path
              // paginates internally and rethrows anything that is not a
              // FIELDS() problem, so a real failure still surfaces.
              const records = await queryWithFieldsFallback<Record<string, unknown>>(
                conn,
                safeObj,
                soql,
              );
              boundCutTheRead = records.length >= FORGE_QUERY_MAX_RECORDS;
              return records;
            }
          });
          if (!retryResult.success) {
            throw retryResult.error ?? new Error('Query failed after retries');
          }
          checkApiLimits(conn.limitInfo, `sync:execute query ${safeObj}`);
          const records = retryResult.result ?? [];
          const tierCapReached =
            tier === 'production' && records.length >= limits.defaultQueryLimit;
          if (boundCutTheRead || tierCapReached) {
            const bound = tierCapReached
              ? `${limits.defaultQueryLimit} records (production-tier query cap)`
              : `${FORGE_QUERY_MAX_RECORDS} records / ${FORGE_QUERY_MAX_PAGES} pages`;
            // The same closure reads both orgs, and a short read means
            // different things on each: on the source it means part of the
            // object is not copied, on the target it means delta detection and
            // conflict resolution ran against part of the destination — which
            // can make an update look like an insert. Saying "the sync copies
            // this subset" on the target read would be the wrong warning.
            const side = orgId === config.sourceOrgId ? 'source' : 'target';
            const consequence =
              side === 'source'
                ? 'this sync copies a subset, not the whole object'
                : 'delta detection ran against a subset of the destination';
            this.deps.log(
              `[WARN] sync:execute ${safeObj} (${side}): read stopped at ${records.length} ` +
                `record(s) — bound: ${bound}. ${consequence}.`,
            );
            sendNotification(
              this.deps,
              'warning',
              'Sync',
              `${safeObj}: only ${records.length} record(s) were read from the ${side} ` +
                `(bound: ${bound}) — ${consequence}. ` +
                `Narrow it with a WHERE filter, or split the run.`,
            );
          }
          return records;
        };

      // Lazy-import sync dependencies
      const { DataSync } = await import('../../modules/sync/DataSync.js');
      const { MetadataSync } = await import('../../modules/sync/MetadataSync.js');
      const { DeltaDetector } = await import('../../modules/sync/DeltaDetector.js');
      const { ConflictResolver } = await import('../../modules/sync/ConflictResolver.js');
      const { FieldMappingService } = await import('../../modules/sync/FieldMapping.js');
      const { TransformPipeline } = await import('../../modules/sync/TransformPipeline.js');
      const { IncrementalTracker } = await import('../../modules/sync/IncrementalTracker.js');

      const dataSync = new DataSync({
        upsert: (objectName, externalIdField, records, batchSize) =>
          writer.upsert(objectName, externalIdField, records, batchSize),
        insert: (objectName, records, batchSize) => writer.insert(objectName, records, batchSize),
        update: (objectName, records, batchSize) => writer.update(objectName, records, batchSize),
        delete: (objectName, recordIds, batchSize) =>
          writer.delete(objectName, recordIds, batchSize),
      });
      const metadataSync = new MetadataSync({
        fetchMetadata: async () => [],
        deployMetadata: async () => [],
      });
      const deltaDetector = new DeltaDetector({
        query: async (_orgId, soql) => {
          const retryResult = await queryRetryOp.execute(() =>
            queryAll<Record<string, unknown>>(sourceConn, soql),
          );
          if (!retryResult.success) {
            throw retryResult.error ?? new Error('Delta query failed after retries');
          }
          return (retryResult.result ?? []) as Array<{ Id: string; [key: string]: unknown }>;
        },
      });
      const conflictResolver = new ConflictResolver();
      const fieldMapping = new FieldMappingService();
      const transformPipeline = new TransformPipeline();
      const incrementalTracker = new IncrementalTracker();

      const syncDeps = {
        dataSync,
        metadataSync,
        deltaDetector,
        conflictResolver,
        fieldMapping,
        transformPipeline,
        incrementalTracker,
        querySource: buildQueryFn(sourceConn, config.sourceOrgId),
        queryTarget: buildQueryFn(targetConn, config.targetOrgId),
        services: this.deps.services,
        // Same contract as seed: without BOTH the config and the callback the
        // `grappe:*` channels never fire and the Grappe page stays blank.
        grappeConfig: readGrappeConfig(this.deps.services),
        onGrappeEvent: (event: GrappeEventEnvelope) => postGrappeEvent(this.deps, event),
      };
      if (!this.deps.services) {
        throw new Error(
          'SyncOpsHandler: composition-root services not injected. Wire ExtensionHandlersDeps.services in extension.ts.',
        );
      }
      const orchestrator = this.deps.services.syncOrchestrator(syncDeps);

      sendOperationProgress(this.deps, operationId, 10, 0, 1, 'Initializing sync');
      const result = await orchestrator.execute(config);
      sendOperationProgress(this.deps, operationId, 100, 1, 1, 'Sync complete');
      sendOperationCompleted(this.deps, operationId, {
        status: (result as { status?: string }).status ?? 'completed',
      });
      this.liveTracker?.complete(operationId);
      this.dmlTracker.markCompleted(operationId);
      checkApiLimits(sourceConn.limitInfo, 'sync:execute completion (source)');
      checkApiLimits(targetConn.limitInfo, 'sync:execute completion (target)');

      // Persist the execution in the sync history (powers sync:history:*).
      // A logging failure must never fail the sync itself — log and move on.
      try {
        this.historyLogger?.logExecution(config, result, triggeredBy);
      } catch (historyErr: unknown) {
        this.deps.log(`[WARN] sync history logging failed: ${extractErrorMessage(historyErr)}`);
      }

      const response = buildResponse(
        this.deps,
        msg,
        'sync:execute:response',
        result as unknown as Record<string, unknown>,
      );
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
      return result;
    } catch (err: unknown) {
      this.dmlTracker.markFailed(operationId);
      this.liveTracker?.fail(operationId, extractErrorMessage(err));
      // Transport-level failure: the org was unreachable — queue the config so
      // OfflineManager replays it when connectivity returns.
      // Guard on `triggeredBy`: a replay (`rerun`) that fails again is NOT
      // re-queued. Without this the drain loop is infinite — each failed replay
      // re-enqueues while the probe still reports 'online', the debounced drain
      // replays it a second later, and every cycle fires operationQueued +
      // operationExecuted notifications. One replay attempt, then the failure
      // surfaces through the normal operation:failed channel and that's it.
      if (
        isNetworkError(err) &&
        triggeredBy !== 'rerun' &&
        this.deps.infraServices?.offlineManager
      ) {
        const queued = this.deps.infraServices.offlineManager.enqueue({
          id: operationId,
          type: 'sync',
          orgId: config.targetOrgId,
          payload: { config: config as unknown as Record<string, unknown> },
        });
        if (queued) {
          this.deps.log(`[OFFLINE] sync queued for replay on reconnect: ${operationId}`);
        }
      } else if (isNetworkError(err) && triggeredBy === 'rerun') {
        this.deps.log(
          `[OFFLINE] sync replay failed again — not re-queued (replay outcomes surface via operation:failed): ${operationId}`,
        );
      }
      // Dual channel, single display (see startExecution): operation:failed
      // carries the lifecycle, sync:error settles the in-flight mutation with
      // the real message. Scheduled runs have no listener — the extra message
      // is simply ignored.
      sendHandlerError(this.deps, 'sync:execute', 'sync:error', msg, err);
      sendOperationFailed(this.deps, operationId, extractErrorMessage(err), true);
      // Failure-status result (instead of a rejection) so scheduled executions
      // can persist lastResult='failure' without an unhandled rejection in the
      // BackgroundOperationRegistry's monitored promise.
      const failureResult: SyncExecutionResult = {
        configId: config.id,
        operationId,
        status: 'failure',
        objectResults: [],
        totalProcessed: 0,
        totalSuccess: 0,
        totalFailed: 0,
        totalSkipped: 0,
        duration: 0,
        timestamp: new Date().toISOString(),
      };

      // Persist the failed execution too (same contract as the success path
      // above). A run that threw is precisely the one the user needs in the
      // history panel — it is what `sync:history:rerun` replays — and logging
      // only successes left history and re-run dead for every failed run.
      // A logging failure must never mask the sync's own error.
      try {
        this.historyLogger?.logExecution(config, failureResult, triggeredBy);
      } catch (historyErr: unknown) {
        this.deps.log(`[WARN] sync history logging failed: ${extractErrorMessage(historyErr)}`);
      }

      return failureResult;
    } finally {
      if (this.activeOperationIds.has(operationId)) {
        this.deps.infraServices?.performanceTracker?.complete(operationId);
        this.activeOperationIds.delete(operationId);
      }
    }
  }
}
