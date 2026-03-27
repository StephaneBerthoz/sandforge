import type { BaseMessage, SyncConfig } from '@sandforge/shared';
import { sanitizeSoqlObjectName, orgTypeToGuardTier, RobustnessConfigSchema } from '@sandforge/shared';
import type { RobustnessConfig } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler } from './HandlerTypes.js';
import {
  buildResponse, sendHandlerError, sendOperationStarted, sendOperationProgress,
  sendOperationCompleted, sendOperationFailed,
} from './HandlerTypes.js';
import { SyncConfigStore } from '../../modules/sync/SyncConfigStore.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { queryWithFieldsFallback, queryAll } from '../../core/common/soqlQueryHelper.js';
import { DmlOperationTracker } from '../../core/common/DmlOperationTracker.js';
import { checkApiLimits } from '../../core/common/sforceLimitParser.js';
import { resolveOrgTier, getQueryLimits } from '../../core/common/queryLimits.js';
import { RetryableOperation } from '../../core/engine/RetryableOperation.js';
import { TimeoutManager } from '../../core/engine/TimeoutManager.js';
import { BulkApiExecutor } from '../../core/engine/BulkApiExecutor.js';
import type { BulkApiConnection, BulkApiExecutorDeps } from '../../core/engine/BulkApiExecutor.js';
import { BulkApiManager } from '../../core/engine/BulkApiManager.js';
import { BulkJobProgressTracker } from '../../core/engine/BulkJobProgressTracker.js';
import { FieldTypeValidator } from '../../modules/sync/FieldTypeValidator.js';
import type { FieldDescriptor } from '../../modules/sync/FieldTypeValidator.js';

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
 * Convert a describe field result to a FieldDescriptor for FieldTypeValidator.
 * Maps the jsforce describe shape to the validator's input type.
 */
function toValidatorField(f: { name: string; type: string; length: number }): FieldDescriptor {
  return { apiName: f.name, type: f.type, maxLength: f.length || undefined };
}

/**
 * Domain handler for sync-related webview-to-extension messages.
 *
 * Routes sync:* message types to schema description and data synchronization
 * operations between Salesforce orgs, with production guard checks,
 * performance tracking, retry, timeout, bulk API, and field type validation.
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

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {
    this.syncConfigStore = new SyncConfigStore(deps.configStore);
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
    try {
      const payload = (msg as BaseMessage & { payload: { config: Record<string, unknown> } }).payload;
      const config = payload.config as unknown as SyncConfig;
      this.syncConfigStore.save(config);
      const response = buildResponse(this.deps, msg, 'sync:config:save:response', { success: true, id: config.id });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'sync:config:save', 'sync:error', err);
    }
  }

  /** Load a sync configuration by ID. */
  private async handleConfigLoad(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    try {
      const payload = (msg as BaseMessage & { payload: { id: string } }).payload;
      const config = this.syncConfigStore.load(payload.id);
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
      const response = buildResponse(this.deps, msg, 'sync:config:list:response', { configs: summaries });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'sync:config:list', 'sync:error', err);
    }
  }

  /** Delete a sync configuration by ID. */
  private async handleConfigDelete(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    try {
      const payload = (msg as BaseMessage & { payload: { id: string } }).payload;
      const success = this.syncConfigStore.delete(payload.id);
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
    const payload = (msg as BaseMessage & { payload: { orgId: string } }).payload;
    const config = this.getRobustnessConfig();

    try {
      const conn = await getJsforceConnection(payload.orgId, this.deps.orgRegistry, this.deps.orgManager);

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
    const payload = (msg as BaseMessage & { payload: { sourceOrgId: string; targetOrgId: string; objectApiName: string } }).payload;
    const config = this.getRobustnessConfig();

    try {
      const sourceConn = await getJsforceConnection(payload.sourceOrgId, this.deps.orgRegistry, this.deps.orgManager);
      const targetConn = await getJsforceConnection(payload.targetOrgId, this.deps.orgRegistry, this.deps.orgManager);

      const timeout = new TimeoutManager(config.timeouts.describe);
      const [sourceDesc, targetDesc] = await Promise.all([
        timeout.withTimeout('describe-source', () => sourceConn.describe(payload.objectApiName)),
        timeout.withTimeout('describe-target', () => targetConn.describe(payload.objectApiName)),
      ]);
      checkApiLimits(sourceConn.limitInfo, `sync:describe-fields source ${payload.objectApiName}`);
      checkApiLimits(targetConn.limitInfo, `sync:describe-fields target ${payload.objectApiName}`);

      const mapFields = (fields: Array<{ name: string; label: string; type: string; createable: boolean }>) =>
        fields
          .filter((f) => f.createable)
          .map((f) => ({ apiName: f.name, label: f.label, type: f.type }));

      const response = buildResponse(this.deps, msg, 'sync:describe-fields:response', {
        objectApiName: payload.objectApiName,
        sourceFields: mapFields(sourceDesc.fields as Array<{ name: string; label: string; type: string; createable: boolean }>),
        targetFields: mapFields(targetDesc.fields as Array<{ name: string; label: string; type: string; createable: boolean }>),
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'sync:describe-fields', 'sync:error', err);
    }
  }

  private async handleExecute(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (msg as BaseMessage & { payload: { config: Record<string, unknown> } }).payload;
    // Build a deterministic ID from the message ID to detect genuine duplicates
    const operationId = msg.id;
    const robustnessConfig = this.getRobustnessConfig();
    let progressTracker: BulkJobProgressTracker | undefined;
    let unsubProgress: (() => void) | undefined;

    try {
      const config = payload.config as unknown as import('@sandforge/shared').SyncConfig;

      // Production guard check on target org
      if (this.deps.infraServices?.productionGuard) {
        const targetOrg = this.deps.orgManager.getOrg(config.targetOrgId);
        const check = this.deps.infraServices.productionGuard.check({
          orgId: config.targetOrgId,
          orgTier: orgTypeToGuardTier(targetOrg?.orgType ?? ''),
          operation: 'upsert',
          objectName: config.objects?.[0]?.objectApiName ?? 'SyncData',
          recordCount: 1,
          module: 'sync',
        });
        if (!check.allowed) {
          throw new Error(`Operation blocked by Production Guard: ${check.blockedReason ?? check.impactSummary}`);
        }
      }

      // Check for duplicate operation
      if (this.dmlTracker.isDuplicate(operationId)) {
        this.deps.log(`[WARN] Duplicate sync operation detected: ${operationId}`);
        sendOperationFailed(this.deps, operationId, `Duplicate operation: ${operationId}`, false);
        return;
      }
      this.dmlTracker.register(operationId, 'sync', 'upsert', config.objects?.length ?? 0);

      // Start performance tracking and register the operation ID
      this.activeOperationIds.add(operationId);
      this.deps.infraServices?.performanceTracker?.start(operationId, 'sync');

      sendOperationStarted(this.deps, operationId, 'sync', `Sync ${config.objects?.length ?? 0} object(s)`);
      const sourceConn = await getJsforceConnection(config.sourceOrgId, this.deps.orgRegistry, this.deps.orgManager);
      const targetConn = await getJsforceConnection(config.targetOrgId, this.deps.orgRegistry, this.deps.orgManager);

      // Resolve dynamic query limits based on source org tier
      const syncSourceOrg = this.deps.orgManager.getOrg(config.sourceOrgId);
      const syncOrgTier = resolveOrgTier(syncSourceOrg?.orgType === 'Sandbox' || syncSourceOrg?.orgType === 'Scratch');
      const syncQueryLimits = getQueryLimits(syncOrgTier);

      // Build robustness utilities
      const bulkExecutor = new BulkApiExecutor(robustnessConfig.bulk.threshold);
      const bulkManager = new BulkApiManager(robustnessConfig.bulk.maxConcurrentJobs);
      progressTracker = new BulkJobProgressTracker(bulkManager);
      unsubProgress = progressTracker.onProgress((progress) => {
        this.deps.broker.postToWebview({
          id: crypto.randomUUID(),
          type: 'execution:progress',
          timestamp: Date.now(),
          payload: progress,
        } as unknown as import('@sandforge/shared').BaseMessage);
      });
      const retryOp = new RetryableOperation({
        retryConfig: robustnessConfig.retry,
        onRetry: (attempt, classified, delay) => {
          this.deps.log(`[RETRY] sync attempt=${attempt} code=${classified.originalError.statusCode} delay=${delay}ms`);
        },
      });
      const handlerDeps = this.deps;
      const fieldValidator = new FieldTypeValidator();

      // Build jsforce CRUD functions for target org with retry + bulk
      type JsforceResult = { success: boolean; id?: string; errors?: Array<{ message: string }> };

      const insertFn = async (objectName: string, records: Record<string, unknown>[], batchSize: number) => {
        if (bulkExecutor.shouldUseBulkApi(records.length)) {
          const bulkDeps: BulkApiExecutorDeps = {
            connection: targetConn as unknown as BulkApiConnection,
            bulkManager,
            onProgress: (processed, total) => {
              sendOperationProgress(handlerDeps, operationId, Math.round((processed / total) * 100), processed, total, `Bulk insert ${objectName}`);
            },
          };
          const bulkResult = await bulkExecutor.executeBulk(bulkDeps, objectName, 'insert', records);
          return Array.from({ length: bulkResult.totalRecords }, (_, i) => ({
            id: i < bulkResult.successCount ? `bulk-${i}` : undefined,
            success: i < bulkResult.successCount,
            errors: i >= bulkResult.successCount ? [bulkResult.failures.find((f) => f.recordIndex === i)?.error ?? 'Bulk error'] : [] as string[],
          }));
        }

        const outcomes: Array<{ id?: string; success: boolean; errors: string[] }> = [];
        for (let i = 0; i < records.length; i += batchSize) {
          const batch = records.slice(i, i + batchSize);
          const retryResult = await retryOp.execute(async () => {
            return targetConn.sobject(objectName).create(batch) as Promise<JsforceResult[]>;
          });
          if (retryResult.success && retryResult.result) {
            for (const r of retryResult.result) {
              outcomes.push({ id: r.id, success: r.success, errors: r.success ? [] : [r.errors?.[0]?.message ?? 'Unknown error'] });
            }
          } else {
            outcomes.push(...batch.map(() => ({ success: false as const, errors: [retryResult.error?.message ?? 'Insert failed after retries'] })));
          }
        }
        return outcomes;
      };

      const upsertFn = async (objectName: string, externalIdField: string, records: Record<string, unknown>[], batchSize: number) => {
        if (bulkExecutor.shouldUseBulkApi(records.length)) {
          const bulkDeps: BulkApiExecutorDeps = {
            connection: targetConn as unknown as BulkApiConnection,
            bulkManager,
            onProgress: (processed, total) => {
              sendOperationProgress(handlerDeps, operationId, Math.round((processed / total) * 100), processed, total, `Bulk upsert ${objectName}`);
            },
          };
          const bulkResult = await bulkExecutor.executeBulk(bulkDeps, objectName, 'upsert', records, externalIdField);
          return Array.from({ length: bulkResult.totalRecords }, (_, i) => ({
            id: i < bulkResult.successCount ? `bulk-${i}` : undefined,
            success: i < bulkResult.successCount,
            errors: i >= bulkResult.successCount ? [bulkResult.failures.find((f) => f.recordIndex === i)?.error ?? 'Bulk error'] : [] as string[],
          }));
        }

        // Validate field types before upsert
        const targetTimeout = new TimeoutManager(robustnessConfig.timeouts.describe);
        const targetDesc = await targetTimeout.withTimeout(`describe-${objectName}`, () => targetConn.describe(objectName));
        const targetFields = (targetDesc.fields as Array<{ name: string; type: string; length: number; createable: boolean }>)
          .filter((f) => f.createable)
          .map(toValidatorField);
        const sourceFields = records.length > 0
          ? Object.keys(records[0]).map((k) => ({ apiName: k, type: 'string' }))
          : [];
        const fieldMapping: Record<string, string> = {};
        for (const sf of sourceFields) {
          const matched = targetFields.find((tf) => tf.apiName === sf.apiName);
          if (matched) {
            fieldMapping[sf.apiName] = matched.apiName;
          }
        }
        const validation = fieldValidator.validateMapping(sourceFields, targetFields, fieldMapping);
        if (!validation.valid) {
          this.deps.log(`[WARN] Field type validation failed for upsert on ${objectName}: ${validation.errors.length} error(s)`);
        }

        const outcomes: Array<{ id?: string; success: boolean; errors: string[] }> = [];
        for (let i = 0; i < records.length; i += batchSize) {
          const batch = records.slice(i, i + batchSize);
          const retryResult = await retryOp.execute(async () => {
            return targetConn.sobject(objectName).upsert(batch, externalIdField) as unknown as Promise<JsforceResult[]>;
          });
          if (retryResult.success && retryResult.result) {
            for (const r of (Array.isArray(retryResult.result) ? retryResult.result : [retryResult.result])) {
              outcomes.push({ id: r.id, success: r.success, errors: r.success ? [] : [r.errors?.[0]?.message ?? 'Unknown error'] });
            }
          } else {
            outcomes.push(...batch.map(() => ({ success: false as const, errors: [retryResult.error?.message ?? 'Upsert failed after retries'] })));
          }
        }
        return outcomes;
      };

      const updateFn = async (objectName: string, records: Record<string, unknown>[], batchSize: number) => {
        if (bulkExecutor.shouldUseBulkApi(records.length)) {
          const bulkDeps: BulkApiExecutorDeps = {
            connection: targetConn as unknown as BulkApiConnection,
            bulkManager,
            onProgress: (processed, total) => {
              sendOperationProgress(handlerDeps, operationId, Math.round((processed / total) * 100), processed, total, `Bulk update ${objectName}`);
            },
          };
          const bulkResult = await bulkExecutor.executeBulk(bulkDeps, objectName, 'update', records);
          return Array.from({ length: bulkResult.totalRecords }, (_, i) => ({
            id: i < bulkResult.successCount ? `bulk-${i}` : undefined,
            success: i < bulkResult.successCount,
            errors: i >= bulkResult.successCount ? [bulkResult.failures.find((f) => f.recordIndex === i)?.error ?? 'Bulk error'] : [] as string[],
          }));
        }

        const outcomes: Array<{ id?: string; success: boolean; errors: string[] }> = [];
        for (let i = 0; i < records.length; i += batchSize) {
          const batch = records.slice(i, i + batchSize);
          const retryResult = await retryOp.execute(async () => {
            return targetConn.sobject(objectName).update(batch as Array<Record<string, unknown> & { Id: string }>) as unknown as Promise<JsforceResult[]>;
          });
          if (retryResult.success && retryResult.result) {
            for (const r of (Array.isArray(retryResult.result) ? retryResult.result : [retryResult.result])) {
              outcomes.push({ id: r.id, success: r.success, errors: r.success ? [] : [r.errors?.[0]?.message ?? 'Unknown error'] });
            }
          } else {
            outcomes.push(...batch.map(() => ({ success: false as const, errors: [retryResult.error?.message ?? 'Update failed after retries'] })));
          }
        }
        return outcomes;
      };

      const deleteFn = async (objectName: string, recordIds: string[], batchSize: number) => {
        if (bulkExecutor.shouldUseBulkApi(recordIds.length)) {
          const bulkRecords = recordIds.map((id) => ({ Id: id }));
          const bulkDeps: BulkApiExecutorDeps = {
            connection: targetConn as unknown as BulkApiConnection,
            bulkManager,
            onProgress: (processed, total) => {
              sendOperationProgress(handlerDeps, operationId, Math.round((processed / total) * 100), processed, total, `Bulk delete ${objectName}`);
            },
          };
          const bulkResult = await bulkExecutor.executeBulk(bulkDeps, objectName, 'delete', bulkRecords);
          return Array.from({ length: bulkResult.totalRecords }, (_, i) => ({
            id: i < bulkResult.successCount ? `bulk-${i}` : undefined,
            success: i < bulkResult.successCount,
            errors: i >= bulkResult.successCount ? [bulkResult.failures.find((f) => f.recordIndex === i)?.error ?? 'Bulk error'] : [] as string[],
          }));
        }

        const outcomes: Array<{ id?: string; success: boolean; errors: string[] }> = [];
        for (let i = 0; i < recordIds.length; i += batchSize) {
          const batch = recordIds.slice(i, i + batchSize);
          const retryResult = await retryOp.execute(async () => {
            return targetConn.sobject(objectName).destroy(batch) as unknown as Promise<JsforceResult[]>;
          });
          if (retryResult.success && retryResult.result) {
            for (const r of (Array.isArray(retryResult.result) ? retryResult.result : [retryResult.result])) {
              outcomes.push({ id: r.id, success: r.success, errors: r.success ? [] : [r.errors?.[0]?.message ?? 'Unknown error'] });
            }
          } else {
            outcomes.push(...batch.map(() => ({ success: false as const, errors: [retryResult.error?.message ?? 'Delete failed after retries'] })));
          }
        }
        return outcomes;
      };

      // Build query functions with retry wrapping and dynamic limits
      const queryRetryOp = new RetryableOperation({ retryConfig: robustnessConfig.retry });
      const buildQueryFn = (conn: typeof sourceConn) => async (
        _orgId: string,
        objectConfig: import('@sandforge/shared').SyncObjectConfig,
      ): Promise<Record<string, unknown>[]> => {
        const safeObj = sanitizeSoqlObjectName(objectConfig.objectApiName);
        let soql = `SELECT FIELDS(ALL) FROM ${safeObj}`;
        if (objectConfig.where) {
          // Defense-in-depth: reject WHERE clauses containing dangerous subquery patterns
          const upperWhere = objectConfig.where.toUpperCase();
          if (/\bSELECT\b/.test(upperWhere) || /\bINSERT\b/.test(upperWhere) || /\bUPDATE\b/.test(upperWhere) || /\bDELETE\b/.test(upperWhere)) {
            throw new Error('WHERE clause contains forbidden keyword (SELECT/INSERT/UPDATE/DELETE). Subqueries are not allowed.');
          }
          soql += ` WHERE ${objectConfig.where}`;
        }
        soql += ` LIMIT ${syncQueryLimits.defaultQueryLimit}`;
        const retryResult = await queryRetryOp.execute(() => queryWithFieldsFallback<Record<string, unknown>>(conn, safeObj, soql));
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
      const { SyncOrchestrator } = await import('../../modules/sync/SyncOrchestrator.js');

      const dataSync = new DataSync({ upsert: upsertFn, insert: insertFn, update: updateFn, delete: deleteFn });
      const metadataSync = new MetadataSync({
        fetchMetadata: async () => [],
        deployMetadata: async () => [],
      });
      const deltaDetector = new DeltaDetector({
        query: async (_orgId, soql) => {
          const retryResult = await queryRetryOp.execute(() => queryAll<Record<string, unknown>>(sourceConn, soql));
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
          const result = await sourceConn.tooling.executeAnonymous(script) as { compiled: boolean; success: boolean; compileProblem?: string; exceptionMessage?: string };
          return { compiled: result.compiled, success: result.success, compileProblem: result.compileProblem, exceptionMessage: result.exceptionMessage };
        },
      });
      const incrementalTracker = new IncrementalTracker();

      const orchestrator = new SyncOrchestrator({
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
      });

      sendOperationProgress(this.deps, operationId, 10, 0, 1, 'Initializing sync');
      const result = await orchestrator.execute(config);
      sendOperationProgress(this.deps, operationId, 100, 1, 1, 'Sync complete');
      sendOperationCompleted(this.deps, operationId, { status: (result as { status?: string }).status ?? 'completed' });
      this.dmlTracker.markCompleted(operationId);
      checkApiLimits(sourceConn.limitInfo, 'sync:execute completion (source)');
      checkApiLimits(targetConn.limitInfo, 'sync:execute completion (target)');

      const response = buildResponse(this.deps, msg, 'sync:execute:response', result as unknown as Record<string, unknown>);
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      this.dmlTracker.markFailed(operationId);
      sendOperationFailed(this.deps, operationId, extractErrorMessage(err), true);
      sendHandlerError(this.deps, 'sync:execute', 'sync:error', err);
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
