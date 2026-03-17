import type { BaseMessage } from '@sandforge/shared';
import { sanitizeSoqlObjectName, orgTypeToGuardTier } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler } from './HandlerTypes.js';
import {
  buildResponse, sendHandlerError, sendOperationStarted, sendOperationProgress,
  sendOperationCompleted, sendOperationFailed,
} from './HandlerTypes.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { queryWithFieldsFallback, queryAll } from '../../core/common/soqlQueryHelper.js';
import { DmlOperationTracker } from '../../core/common/DmlOperationTracker.js';
import { checkApiLimits } from '../../core/common/sforceLimitParser.js';
import { resolveOrgTier, getQueryLimits } from '../../core/common/queryLimits.js';

/** Message types handled by SyncOpsHandler. */
const SYNC_TYPES = new Set([
  'sync:execute',
  'sync:describe-global',
  'sync:describe-fields',
]);

/**
 * Domain handler for sync-related webview-to-extension messages.
 *
 * Routes sync:* message types to schema description and data synchronization
 * operations between Salesforce orgs, with production guard checks
 * and performance tracking.
 */
export class SyncOpsHandler implements DomainHandler {
  /**
   * Set of active operation IDs being tracked.
   * Used to ensure cleanup happens exactly once in all code paths.
   */
  private readonly activeOperationIds = new Set<string>();

  /** Tracks DML operations to prevent duplicate submissions. */
  private readonly dmlTracker = new DmlOperationTracker();

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {}

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
      default:
        return false;
    }
  }

  private async handleDescribeGlobal(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const payload = (msg as BaseMessage & { payload: { orgId: string } }).payload;

    try {
      const conn = await getJsforceConnection(payload.orgId, this.deps.orgRegistry, this.deps.orgManager);
      const result = await conn.describeGlobal();
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

    try {
      const sourceConn = await getJsforceConnection(payload.sourceOrgId, this.deps.orgRegistry, this.deps.orgManager);
      const targetConn = await getJsforceConnection(payload.targetOrgId, this.deps.orgRegistry, this.deps.orgManager);

      const [sourceDesc, targetDesc] = await Promise.all([
        sourceConn.describe(payload.objectApiName),
        targetConn.describe(payload.objectApiName),
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

      // Build jsforce CRUD functions for target org
      type JsforceResult = { success: boolean; id?: string; errors?: Array<{ message: string }> };

      const insertFn = async (objectName: string, records: Record<string, unknown>[], batchSize: number) => {
        const outcomes: Array<{ id?: string; success: boolean; errors: string[] }> = [];
        for (let i = 0; i < records.length; i += batchSize) {
          const batch = records.slice(i, i + batchSize);
          const results = await targetConn.sobject(objectName).create(batch) as JsforceResult[];
          for (const r of results) {
            outcomes.push({ id: r.id, success: r.success, errors: r.success ? [] : [r.errors?.[0]?.message ?? 'Unknown error'] });
          }
        }
        return outcomes;
      };

      const upsertFn = async (objectName: string, externalIdField: string, records: Record<string, unknown>[], batchSize: number) => {
        const outcomes: Array<{ id?: string; success: boolean; errors: string[] }> = [];
        for (let i = 0; i < records.length; i += batchSize) {
          const batch = records.slice(i, i + batchSize);
          const results = await targetConn.sobject(objectName).upsert(batch, externalIdField) as unknown as JsforceResult[];
          for (const r of (Array.isArray(results) ? results : [results])) {
            outcomes.push({ id: r.id, success: r.success, errors: r.success ? [] : [r.errors?.[0]?.message ?? 'Unknown error'] });
          }
        }
        return outcomes;
      };

      const updateFn = async (objectName: string, records: Record<string, unknown>[], batchSize: number) => {
        const outcomes: Array<{ id?: string; success: boolean; errors: string[] }> = [];
        for (let i = 0; i < records.length; i += batchSize) {
          const batch = records.slice(i, i + batchSize);
          const results = await targetConn.sobject(objectName).update(batch as Array<Record<string, unknown> & { Id: string }>) as unknown as JsforceResult[];
          for (const r of (Array.isArray(results) ? results : [results])) {
            outcomes.push({ id: r.id, success: r.success, errors: r.success ? [] : [r.errors?.[0]?.message ?? 'Unknown error'] });
          }
        }
        return outcomes;
      };

      const deleteFn = async (objectName: string, recordIds: string[], batchSize: number) => {
        const outcomes: Array<{ id?: string; success: boolean; errors: string[] }> = [];
        for (let i = 0; i < recordIds.length; i += batchSize) {
          const batch = recordIds.slice(i, i + batchSize);
          const results = await targetConn.sobject(objectName).destroy(batch) as unknown as JsforceResult[];
          for (const r of (Array.isArray(results) ? results : [results])) {
            outcomes.push({ id: r.id, success: r.success, errors: r.success ? [] : [r.errors?.[0]?.message ?? 'Unknown error'] });
          }
        }
        return outcomes;
      };

      // Build query functions with dynamic limits
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
        const records = await queryWithFieldsFallback<Record<string, unknown>>(conn, safeObj, soql);
        checkApiLimits(conn.limitInfo, `sync:execute query ${safeObj}`);
        return records;
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
          const records = await queryAll<Record<string, unknown>>(sourceConn, soql);
          return records as Array<{ Id: string; [key: string]: unknown }>;
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
      if (this.activeOperationIds.has(operationId)) {
        this.deps.infraServices?.performanceTracker?.complete(operationId);
        this.activeOperationIds.delete(operationId);
      }
    }
  }
}
