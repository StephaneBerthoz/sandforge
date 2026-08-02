import type {
  BaseMessage,
  CloneExecutionResult,
  CloneObjectResult,
  ClonePreviewResult,
  RobustnessConfig,
} from '@sandforge/shared';
import { orgTypeToGuardTier, RobustnessConfigSchema } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler } from './HandlerTypes.js';
import {
  buildResponse,
  sendHandlerError,
  sendOperationStarted,
  sendOperationProgress,
  sendOperationCompleted,
  sendOperationFailed,
} from './HandlerTypes.js';
import {
  validatePayload,
  seedCloneDescribeSourcePayloadSchema,
  seedCloneExecutePayloadSchema,
} from '../validatePayload.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { checkApiLimits } from '../../core/common/sforceLimitParser.js';
import { CloneRecordFetcher } from '../../modules/seed/CloneRecordFetcher.js';
import { CloneReferenceLinker } from '../../modules/seed/CloneReferenceLinker.js';
import type { DescribeSObjectResultLike } from '../../modules/seed/CloneReferenceLinker.js';
import { BulkDataWriter } from '../../modules/sync/BulkDataWriter.js';
import { BulkApiExecutor } from '../../core/engine/BulkApiExecutor.js';
import { BulkApiManager } from '../../core/engine/BulkApiManager.js';

/** Message types handled by SeedCloneHandler. */
const SEED_CLONE_TYPES = new Set([
  'seed:clone:describe-source',
  'seed:clone:preview',
  'seed:clone:execute',
]);

/** Sample size fetched per object for the clone preview. */
const PREVIEW_SAMPLE_SIZE = 5;

/** Max fields kept per sample record in the preview payload (bounds postMessage size). */
const PREVIEW_SAMPLE_MAX_FIELDS = 10;

/**
 * Sentinel used for `recordCount` in describe-source responses: counting every
 * object on the source org would cost one COUNT() round-trip per SObject
 * (hundreds of API calls), and the current webview does not display the value.
 */
const RECORD_COUNT_NOT_COMPUTED = -1;

/**
 * Domain handler for the record-clone wizard (`seed:clone:*`).
 *
 * Wires the Clone pipeline modules (CloneRecordFetcher, CloneReferenceLinker,
 * BulkDataWriter) to the exact channels consumed by `useClone`:
 *   seed:clone:describe-source -> seed:clone:describe-source:response { objects }
 *   seed:clone:preview         -> seed:clone:preview:response         (ClonePreviewResult)
 *   seed:clone:execute         -> seed:clone:execute:response         (CloneExecutionResult)
 * The execute flow inserts parents before children (topological order) and
 * remaps in-set reference fields to the newly created target IDs. Query
 * failures are reported on `seed:clone:error`; execute failures on
 * `operation:failed` (same convention as seed:execute / sync:execute).
 */
export class SeedCloneHandler implements DomainHandler {
  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {}

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: BaseMessage): Promise<boolean> {
    if (!SEED_CLONE_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'seed:clone:describe-source':
        await this.handleDescribeSource(msg);
        return true;
      case 'seed:clone:preview':
        await this.handlePreview(msg);
        return true;
      case 'seed:clone:execute':
        await this.handleExecute(msg);
        return true;
      default:
        return false;
    }
  }

  /** Load robustness configuration (retry/timeout/bulk thresholds) from ConfigStore. */
  private getRobustnessConfig(): RobustnessConfig {
    const raw = this.deps.configStore.get<Partial<RobustnessConfig>>('robustness:config');
    return RobustnessConfigSchema.parse(raw ?? {});
  }

  /** List cloneable objects on the source org. */
  private async handleDescribeSource(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      seedCloneDescribeSourcePayloadSchema,
      msg,
      'seed:clone:error',
      this.deps,
    );
    if (!parsed) return;

    try {
      const conn = await getJsforceConnection(
        parsed.sourceOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const result = await conn.describeGlobal();
      checkApiLimits(conn.limitInfo, 'seed:clone:describe-source');

      const objects = result.sobjects
        .filter((s: { createable: boolean; queryable: boolean }) => s.createable && s.queryable)
        .map((s: { name: string; label: string }) => ({
          apiName: s.name,
          label: s.label,
          recordCount: RECORD_COUNT_NOT_COMPUTED,
        }));

      const response = buildResponse(this.deps, msg, 'seed:clone:describe-source:response', {
        objects,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id} count=${objects.length}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'seed:clone:describe-source', 'seed:clone:error', err);
    }
  }

  /** Preview a clone: per-object counts, bounded samples, relationships, insert order. */
  private async handlePreview(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      seedCloneExecutePayloadSchema,
      msg,
      'seed:clone:error',
      this.deps,
    );
    if (!parsed) return;

    try {
      const conn = await getJsforceConnection(
        parsed.sourceOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const fetcher = new CloneRecordFetcher({ log: this.deps.log });
      const linker = new CloneReferenceLinker();
      const objectNames = parsed.objects.map((o) => o.objectApiName);
      const objectSet = new Set(objectNames);

      const describeMap = new Map<string, DescribeSObjectResultLike>();
      const previewObjects: ClonePreviewResult['objects'] = [];

      for (const objectConfig of parsed.objects) {
        const describe = await conn.describe(objectConfig.objectApiName);
        checkApiLimits(conn.limitInfo, `seed:clone:preview describe ${objectConfig.objectApiName}`);
        describeMap.set(objectConfig.objectApiName, describe as DescribeSObjectResultLike);

        const [recordCount, sampleRecords] = await Promise.all([
          fetcher.countRecords(conn, objectConfig.objectApiName, objectConfig.whereClause),
          fetcher.fetchSample(
            conn,
            objectConfig.objectApiName,
            PREVIEW_SAMPLE_SIZE,
            objectConfig.whereClause,
          ),
        ]);

        const relationships: Array<{ field: string; referenceTo: string }> = [];
        for (const field of describe.fields) {
          if (field.type !== 'reference') continue;
          const target = (field.referenceTo ?? []).find((r) => objectSet.has(r));
          if (target) {
            relationships.push({ field: field.name, referenceTo: target });
          }
        }

        previewObjects.push({
          objectApiName: objectConfig.objectApiName,
          recordCount,
          sampleRecords: sampleRecords.map((r) => trimSampleRecord(r, PREVIEW_SAMPLE_MAX_FIELDS)),
          relationships,
        });
      }

      const edges = linker.buildEdgesFromDescribe(objectNames, describeMap);
      const insertOrder = linker.resolveInsertOrder(objectNames, edges);

      const payload: ClonePreviewResult = { objects: previewObjects, insertOrder };
      const response = buildResponse(
        this.deps,
        msg,
        'seed:clone:preview:response',
        payload as unknown as Record<string, unknown>,
      );
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'seed:clone:preview', 'seed:clone:error', err);
    }
  }

  /**
   * Execute the clone: fetch source records in topological order, remap in-set
   * references to the new target IDs, and write via BulkDataWriter (insert by
   * default, upsert when the payload opts in with an external Id field).
   */
  private async handleExecute(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      seedCloneExecutePayloadSchema,
      msg,
      'seed:clone:error',
      this.deps,
    );
    if (!parsed) return;
    const operationId = msg.id;
    const startedAt = Date.now();

    try {
      // Production guard check on target org (mirror SyncOpsHandler).
      if (this.deps.infraServices?.productionGuard) {
        const guard = this.deps.infraServices.productionGuard;
        const targetOrg = this.deps.orgManager.getOrg(parsed.targetOrgId);
        const guardRequest = {
          orgId: parsed.targetOrgId,
          orgTier: orgTypeToGuardTier(targetOrg?.orgType ?? ''),
          operation: (parsed.upsert ? 'upsert' : 'insert') as 'upsert' | 'insert',
          objectName: parsed.objects[0]?.objectApiName ?? 'CloneData',
          recordCount: 1,
          module: 'clone',
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
          sendOperationFailed(
            this.deps,
            operationId,
            'Operation cancelled by user (production confirmation declined).',
            false,
          );
          return;
        }
      }

      const sourceConn = await getJsforceConnection(
        parsed.sourceOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const targetConn = await getJsforceConnection(
        parsed.targetOrgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );

      sendOperationStarted(
        this.deps,
        operationId,
        'clone',
        `Clone ${parsed.objects.length} object(s)`,
      );

      const robustnessConfig = this.getRobustnessConfig();
      const defaultBatchSize =
        this.deps.services?.getSandforgeSetting?.('seed.defaultBatchSize', 200) ?? 200;
      const writer = new BulkDataWriter({
        connection: targetConn,
        bulkExecutor: new BulkApiExecutor(robustnessConfig.bulk.threshold),
        bulkManager: new BulkApiManager(robustnessConfig.bulk.maxConcurrentJobs),
        retryConfig: robustnessConfig.retry,
        describeTimeoutMs: robustnessConfig.timeouts.describe,
        signal: new AbortController().signal,
        onProgress: (processed, total, label) => {
          sendOperationProgress(
            this.deps,
            operationId,
            total > 0 ? Math.round((processed / total) * 100) : 0,
            processed,
            total,
            label,
          );
        },
        log: (message) => this.deps.log(message),
      });

      const fetcher = new CloneRecordFetcher({ log: this.deps.log });
      const linker = new CloneReferenceLinker();
      const objectNames = parsed.objects.map((o) => o.objectApiName);
      const objectSet = new Set(objectNames);

      // Describe every object once: drives both reference remapping and the
      // topological insert order.
      const describeMap = new Map<string, DescribeSObjectResultLike>();
      for (const name of objectNames) {
        const describe = await targetConn.describe(name);
        checkApiLimits(targetConn.limitInfo, `seed:clone:execute describe ${name}`);
        describeMap.set(name, describe as DescribeSObjectResultLike);
      }
      const insertOrder = linker.resolveInsertOrder(
        objectNames,
        linker.buildEdgesFromDescribe(objectNames, describeMap),
      );
      const configsByName = new Map(parsed.objects.map((o) => [o.objectApiName, o]));

      /** sourceId -> targetId across all objects inserted so far. */
      const globalIdMap = new Map<string, string>();
      const objectResults: CloneObjectResult[] = [];
      let objectLevelFailures = 0;

      for (let index = 0; index < insertOrder.length; index++) {
        const objectApiName = insertOrder[index];
        const objectConfig = configsByName.get(objectApiName)!;
        sendOperationProgress(
          this.deps,
          operationId,
          Math.round((index / insertOrder.length) * 100),
          index,
          insertOrder.length,
          `Cloning ${objectApiName}`,
        );

        let sourceRecords: Record<string, unknown>[];
        try {
          sourceRecords = await fetcher.fetchRecords(
            sourceConn,
            objectApiName,
            objectConfig.whereClause,
          );
        } catch (fetchErr: unknown) {
          objectLevelFailures++;
          objectResults.push({
            objectApiName,
            sourceCount: 0,
            insertedCount: 0,
            failedCount: 0,
            idMappings: [],
            errors: [{ sourceId: '', message: extractErrorMessage(fetchErr) }],
          });
          continue;
        }

        const writeRecords = sourceRecords.map((record) =>
          prepareRecordForWrite(record, describeMap.get(objectApiName), objectSet, globalIdMap),
        );

        const outcomes =
          parsed.upsert && parsed.externalIdField
            ? await writer.upsert(
                objectApiName,
                parsed.externalIdField,
                writeRecords,
                defaultBatchSize,
              )
            : await writer.insert(objectApiName, writeRecords, defaultBatchSize);

        const objectResult: CloneObjectResult = {
          objectApiName,
          sourceCount: sourceRecords.length,
          insertedCount: 0,
          failedCount: 0,
          idMappings: [],
          errors: [],
        };
        outcomes.forEach((outcome, i) => {
          const sourceId = typeof sourceRecords[i]?.['Id'] === 'string' ? sourceRecords[i]['Id'] : '';
          if (outcome.success) {
            objectResult.insertedCount++;
            if (sourceId && outcome.id) {
              globalIdMap.set(sourceId, outcome.id);
              objectResult.idMappings.push({ sourceId, targetId: outcome.id });
            }
          } else {
            objectResult.failedCount++;
            objectResult.errors.push({
              sourceId,
              message: outcome.errors[0] ?? 'Unknown insert error',
            });
          }
        });
        objectResults.push(objectResult);
      }

      const totalSourceRecords = objectResults.reduce((sum, r) => sum + r.sourceCount, 0);
      const totalInserted = objectResults.reduce((sum, r) => sum + r.insertedCount, 0);
      const totalFailed = objectResults.reduce((sum, r) => sum + r.failedCount, 0);
      const result: CloneExecutionResult = {
        status:
          totalFailed === 0 && objectLevelFailures === 0
            ? 'success'
            : totalInserted > 0
              ? 'partial'
              : 'failure',
        objectResults,
        totalSourceRecords,
        totalInserted,
        totalFailed,
        durationMs: Date.now() - startedAt,
      };

      sendOperationCompleted(this.deps, operationId, {
        status: result.status,
        totalInserted,
        totalFailed,
      });
      const response = buildResponse(
        this.deps,
        msg,
        'seed:clone:execute:response',
        result as unknown as Record<string, unknown>,
      );
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id} status=${result.status}`);
    } catch (err: unknown) {
      // Single failure emission: `operation:failed` only (same convention as
      // seed:execute / sync:execute — the webview consumes that channel).
      this.deps.log(`[ERR] seed:clone:execute: ${extractErrorMessage(err)}`);
      sendOperationFailed(this.deps, operationId, extractErrorMessage(err), true);
    }
  }
}

/** Keep only the first `maxFields` non-null fields of a sample record. */
function trimSampleRecord(
  record: Record<string, unknown>,
  maxFields: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (Object.keys(out).length >= maxFields) break;
    if (value === null || value === undefined || value === '') continue;
    out[key] = value;
  }
  return out;
}

/**
 * Build the record to write on the target org: drops the source `Id` (insert
 * path forbids it) and remaps in-set reference fields through the running
 * sourceId -> targetId map. References to source records that were not cloned
 * (out of set, or parent failed) are left untouched — Salesforce rejects them
 * with an explicit per-record error, which is surfaced in the object result.
 */
function prepareRecordForWrite(
  record: Record<string, unknown>,
  describe: DescribeSObjectResultLike | undefined,
  objectSet: Set<string>,
  idMap: Map<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'Id') continue;
    out[key] = value;
  }
  if (!describe) return out;
  for (const field of describe.fields) {
    if (field.type !== 'reference') continue;
    if (!(field.referenceTo ?? []).some((r) => objectSet.has(r))) continue;
    const value = out[field.name];
    if (typeof value === 'string' && idMap.has(value)) {
      out[field.name] = idMap.get(value);
    }
  }
  return out;
}
