import type { BaseMessage, SyncConfig, SyncExecutionResult } from '@sandforge/shared';
import {
  sanitizeSoqlObjectName,
  orgTypeToGuardTier,
  RobustnessConfigSchema,
} from '@sandforge/shared';
import type { RobustnessConfig } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler } from './HandlerTypes.js';
import {
  buildResponse,
  sendHandlerError,
  sendOperationStarted,
  sendOperationProgress,
  sendOperationCompleted,
  sendOperationFailed,
} from './HandlerTypes.js';
import { SyncConfigStore } from '../../modules/sync/SyncConfigStore.js';
import type { SyncExecutionLogger } from '../../modules/sync/SyncExecutionLogger.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { queryWithFieldsFallback, queryAll } from '../../core/common/soqlQueryHelper.js';
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
import { RetryableOperation } from '../../core/engine/RetryableOperation.js';
import { TimeoutManager } from '../../core/engine/TimeoutManager.js';
import { BulkApiExecutor } from '../../core/engine/BulkApiExecutor.js';
import { BulkApiManager } from '../../core/engine/BulkApiManager.js';
import { BulkJobProgressTracker } from '../../core/engine/BulkJobProgressTracker.js';
import type { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { BulkDataWriter } from '../../modules/sync/BulkDataWriter.js';

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
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: BaseMessage): Promise<boolean> {
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
  private async handleConfigSave(msg: BaseMessage): Promise<void> {
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
      sendHandlerError(this.deps, 'sync:config:save', 'sync:error', err);
    }
  }

  /** Load a sync configuration by ID. */
  private async handleConfigLoad(msg: BaseMessage): Promise<void> {
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
      sendHandlerError(this.deps, 'sync:config:load', 'sync:error', err);
    }
  }

  /** List all sync configurations (summary view). */
  private async handleConfigList(msg: BaseMessage): Promise<void> {
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
      sendHandlerError(this.deps, 'sync:config:list', 'sync:error', err);
    }
  }

  /** Delete a sync configuration by ID. */
  private async handleConfigDelete(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(syncConfigIdPayloadSchema, msg, 'sync:error', this.deps);
    if (!parsed) return;
    try {
      const success = this.syncConfigStore.delete(parsed.id);
      const response = buildResponse(this.deps, msg, 'sync:config:delete:response', { success });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'sync:config:delete', 'sync:error', err);
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

  private async handleDescribeGlobal(msg: BaseMessage): Promise<void> {
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
      sendHandlerError(this.deps, 'sync:describe-global', 'sync:error', err);
    }
  }

  private async handleDescribeFields(msg: BaseMessage): Promise<void> {
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
      sendHandlerError(this.deps, 'sync:describe-fields', 'sync:error', err);
    }
  }

  private async handleExecute(msg: BaseMessage): Promise<void> {
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
  async rerunFromSnapshot(msg: BaseMessage, snapshot: unknown): Promise<void> {
    this.deps.log(`[RX] sync:history:rerun id=${msg.id}`);
    const parsed = validatePayload(
      syncExecutePayloadSchema,
      { ...msg, payload: { config: snapshot } } as BaseMessage,
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
    const operationId = `sync:schedule:${crypto.randomUUID()}`;
    const msg: BaseMessage = { id: operationId, type: 'sync:execute', timestamp: Date.now() };

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
      const targetOrg = this.deps.orgManager.getOrg(filledConfig.targetOrgId);
      const guardRequest = {
        orgId: filledConfig.targetOrgId,
        orgTier: orgTypeToGuardTier(targetOrg?.orgType ?? ''),
        operation: 'upsert' as const,
        objectName: filledConfig.objects?.[0]?.objectApiName ?? 'SyncData',
        recordCount: 1,
        module: 'sync',
      };
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
    sendOperationStarted(
      this.deps,
      operationId,
      'sync',
      `Scheduled sync of ${filledConfig.objects?.length ?? 0} object(s)`,
    );

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
    msg: BaseMessage,
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
        const targetOrg = this.deps.orgManager.getOrg(config.targetOrgId);
        const guardRequest = {
          orgId: config.targetOrgId,
          orgTier: orgTypeToGuardTier(targetOrg?.orgType ?? ''),
          operation: 'upsert' as const,
          objectName: config.objects?.[0]?.objectApiName ?? 'SyncData',
          recordCount: 1,
          module: 'sync',
        };
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
          // (same dual-channel contract as the catch paths below).
          sendHandlerError(this.deps, 'sync:execute', 'sync:error', new Error(message));
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
      sendHandlerError(this.deps, 'sync:execute', 'sync:error', err);
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
    msg: BaseMessage,
    config: import('@sandforge/shared').SyncConfig,
    operationId: string,
    abortController: AbortController,
    triggeredBy: 'manual' | 'rerun' | 'schedule',
  ): Promise<SyncExecutionResult> {
    const robustnessConfig = this.getRobustnessConfig();
    let progressTracker: BulkJobProgressTracker | undefined;
    let unsubProgress: (() => void) | undefined;

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

      // Resolve dynamic query limits based on source org tier
      const syncSourceOrg = this.deps.orgManager.getOrg(config.sourceOrgId);
      const syncOrgTier = resolveOrgTier(
        syncSourceOrg?.orgType === 'Sandbox' || syncSourceOrg?.orgType === 'Scratch',
      );
      const syncQueryLimits = getQueryLimits(syncOrgTier);

      // Build robustness utilities
      const bulkExecutor = new BulkApiExecutor(robustnessConfig.bulk.threshold);
      // `sandforge.sync.maxConcurrentOps` (manifest default 3) bounds the
      // number of concurrent Bulk API jobs for sync operations.
      const maxConcurrentOps =
        this.deps.services?.getSandforgeSetting?.('sync.maxConcurrentOps', 3) ?? 3;
      const bulkManager = new BulkApiManager(maxConcurrentOps);
      progressTracker = new BulkJobProgressTracker(bulkManager);
      unsubProgress = progressTracker.onProgress((progress) => {
        this.deps.broker.postToWebview({
          id: crypto.randomUUID(),
          type: 'execution:progress',
          timestamp: Date.now(),
          payload: progress,
        } as unknown as import('@sandforge/shared').BaseMessage);
      });
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
          sendOperationProgress(
            this.deps,
            operationId,
            Math.round((processed / total) * 100),
            processed,
            total,
            label,
          );
        },
        log: (message) => this.deps.log(message),
      });

      // Build query functions with retry wrapping and dynamic limits
      const queryRetryOp = new RetryableOperation({ retryConfig: robustnessConfig.retry });
      const buildQueryFn =
        (conn: typeof sourceConn) =>
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
          soql += ` LIMIT ${syncQueryLimits.defaultQueryLimit}`;
          const retryResult = await queryRetryOp.execute(() =>
            queryWithFieldsFallback<Record<string, unknown>>(conn, safeObj, soql),
          );
          if (!retryResult.success) {
            throw retryResult.error ?? new Error('Query failed after retries');
          }
          checkApiLimits(conn.limitInfo, `sync:execute query ${safeObj}`);
          return retryResult.result ?? [];
        };

      // Lazy-import sync dependencies
      const { DataSync } = await import('../../modules/sync/DataSync.js');
      const { MetadataSync } = await import('../../modules/sync/MetadataSync.js');
      const { DeltaDetector } = await import('../../modules/sync/DeltaDetector.js');
      const { ConflictResolver } = await import('../../modules/sync/ConflictResolver.js');
      const { FieldMappingService } = await import('../../modules/sync/FieldMapping.js');
      const { TransformPipeline } = await import('../../modules/sync/TransformPipeline.js');
      const { MigrationScript } = await import('../../modules/sync/MigrationScript.js');
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
      const migrationScript = new MigrationScript({
        executeAnonymous: async (_orgId, script) => {
          const result = (await sourceConn.tooling.executeAnonymous(script)) as {
            compiled: boolean;
            success: boolean;
            compileProblem?: string;
            exceptionMessage?: string;
          };
          return {
            compiled: result.compiled,
            success: result.success,
            compileProblem: result.compileProblem,
            exceptionMessage: result.exceptionMessage,
          };
        },
      });
      const incrementalTracker = new IncrementalTracker();

      const syncDeps = {
        dataSync,
        metadataSync,
        deltaDetector,
        conflictResolver,
        fieldMapping,
        transformPipeline,
        migrationScript,
        incrementalTracker,
        querySource: buildQueryFn(sourceConn),
        queryTarget: buildQueryFn(targetConn),
        services: this.deps.services,
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
      // Dual channel, single display (see startExecution): operation:failed
      // carries the lifecycle, sync:error settles the in-flight mutation with
      // the real message. Scheduled runs have no listener — the extra message
      // is simply ignored.
      sendHandlerError(this.deps, 'sync:execute', 'sync:error', err);
      sendOperationFailed(this.deps, operationId, extractErrorMessage(err), true);
      // Failure-status result (instead of a rejection) so scheduled executions
      // can persist lastResult='failure' without an unhandled rejection in the
      // BackgroundOperationRegistry's monitored promise.
      return {
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
    } finally {
      progressTracker?.stopTracking(operationId);
      unsubProgress?.();
      progressTracker?.dispose();
      if (this.activeOperationIds.has(operationId)) {
        this.deps.infraServices?.performanceTracker?.complete(operationId);
        this.activeOperationIds.delete(operationId);
      }
    }
  }
}
