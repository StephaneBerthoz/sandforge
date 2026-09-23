import type {
  AuditOutcome,
  CloneExecutionResult,
  CloneObjectResult,
  ClonePreviewResult,
} from '@sandforge/shared';
import { orgTypeToGuardTier } from '@sandforge/shared';
import type {
  HandlerDeps,
  DomainHandler,
  InboundRequest,
  OperationFailureContext,
} from './HandlerTypes.js';
import type { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import {
  buildResponse,
  sendHandlerError,
  sendOperationStarted,
  sendOperationProgress,
  sendOperationCompleted,
  sendOperationFailed,
  objectsFailureContext,
  robustnessConfigOf,
  bulkManagerOf,
  PRODUCTION_GUARD_MISSING,
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
import { isUncopyableObject } from '@sandforge/shared';
import {
  carriesRecordType,
  findUnavailableRecordTypes,
  parseRecordTypeInfos,
  recordTypeBlockedMessage,
  type RecordTypeAvailability,
} from '../../core/metadata/recordTypeAvailability.js';
import { consultProductionGuard } from '../../core/precheck/consultProductionGuard.js';
import { emptyCounts, recordWriteRun } from '../../modules/audit/auditTrail.js';
import type { WriteRun } from '../../modules/audit/auditTrail.js';

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
 * Message the production guard refusal is thrown with. Matched in the `catch`
 * to tell that refusal apart from a failure the org returned: both arrive
 * there, and only the code tells the webview which sentence to show.
 */
const GUARD_BLOCKED_PREFIX = 'Operation blocked by Production Guard: ';

/**
 * Failure codes `operation:failed` carries for a clone run.
 *
 * The English `error` text stays what it was — the logs and the fix-suggestion
 * table read it — and the code is what the webview translates.
 */
const CLONE_FAILURE_CODES = {
  confirmationDeclined: 'PRODUCTION_CONFIRMATION_DECLINED',
  guardBlocked: 'PRODUCTION_GUARD_BLOCKED',
  failed: 'CLONE_FAILED',
} as const;

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
  private registry?: BackgroundOperationRegistry;

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {}

  /**
   * Inject the shared registry so this module's runs are cancellable.
   * Called from ExtensionHandlers, same as SeedOpsHandler.
   */
  setRegistry(registry: BackgroundOperationRegistry): void {
    this.registry = registry;
  }

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: InboundRequest): Promise<boolean> {
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

  /** List cloneable objects on the source org. */
  private async handleDescribeSource(msg: InboundRequest): Promise<void> {
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
        // `createable` says the API accepts an insert, not that a copy can make
        // one: a user costs a licence and a unique username, a record type is
        // metadata. Offering one sends the user into a run that cannot finish.
        .filter((s: { name: string }) => !isUncopyableObject(s.name))
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
      sendHandlerError(this.deps, 'seed:clone:describe-source', 'seed:clone:error', msg, err);
    }
  }

  /** Preview a clone: per-object counts, bounded samples, relationships, insert order. */
  private async handlePreview(msg: InboundRequest): Promise<void> {
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
      sendHandlerError(this.deps, 'seed:clone:preview', 'seed:clone:error', msg, err);
    }
  }

  /**
   * Execute the clone: fetch source records in topological order, remap in-set
   * references to the new target IDs, and write via BulkDataWriter (insert by
   * default, upsert when the payload opts in with an external Id field).
   */
  private async handleExecute(msg: InboundRequest): Promise<void> {
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
    const failure: OperationFailureContext = {
      module: 'seed',
      operation: msg.type,
      ...objectsFailureContext(parsed.objects.map((o) => ({ objectApiName: o.objectApiName }))),
    };

    // The signal handed to BulkDataWriter used to come from a throwaway
    // `new AbortController()` that nothing kept a reference to, so it could
    // never fire and this operation was never registered — `execution:abort`
    // reported "Operation not found" and the run carried on to completion.
    const abortController = new AbortController();
    let settle: (err?: unknown) => void = () => {};
    const tracked = new Promise<void>((resolve, reject) => {
      settle = (err) => (err === undefined ? resolve() : reject(err));
    });
    // The registry attaches its own handlers; this one only stops an
    // unhandled rejection when no registry has been injected.
    tracked.catch(() => {});
    this.registry?.register(
      operationId,
      'clone',
      `Clone ${parsed.objects.length} object(s)`,
      tracked,
      abortController,
    );

    /** The run as the audit trail records it, once it ends. */
    const run: WriteRun = {
      action: 'seed_clone',
      module: 'seed',
      operationId,
      orgId: parsed.targetOrgId,
      outcome: 'failure',
      source: { origin: 'org', orgId: parsed.sourceOrgId },
    };
    /**
     * True from the moment the clone is announced until its end is recorded:
     * a failure before it wrote nothing, and a run is recorded once.
     */
    let unrecorded = false;
    /** Per object, what the clone did — kept outside the run, so a failure can say it. */
    const objectResults: CloneObjectResult[] = [];
    /** Whether the clone writes by upsert, as the write below decides it. */
    const upserts = Boolean(parsed.upsert && parsed.externalIdField);

    try {
      // Production guard check on target org (mirror SyncOpsHandler), and no
      // clone without it.
      const guard = this.deps.infraServices?.productionGuard;
      if (!guard) {
        recordWriteRun(this.deps, {
          ...run,
          outcome: 'stopped',
          source: undefined,
          code: PRODUCTION_GUARD_MISSING.code,
        });
        sendOperationFailed(this.deps, operationId, PRODUCTION_GUARD_MISSING.message, false, {
          context: failure,
          extraPayload: { code: PRODUCTION_GUARD_MISSING.code },
        });
        // Registered already, like a declined run: settled, or it stays listed.
        settle(new Error(PRODUCTION_GUARD_MISSING.message));
        return;
      }
      const targetOrg = this.deps.orgManager.getOrg(parsed.targetOrgId);
      const guardRequest = {
        orgId: parsed.targetOrgId,
        orgTier: orgTypeToGuardTier(targetOrg?.orgType ?? ''),
        operation: (parsed.upsert ? 'upsert' : 'insert') as 'upsert' | 'insert',
        // Every object the run will write, not just the first one: a
        // production confirmation naming one object hid the rest of them.
        objectName: parsed.objects.map((o) => o.objectApiName).join(', ') || 'CloneData',
        // The source records are queried further down, so nothing here can
        // count them yet.
        recordCount: 'unknown' as const,
        module: 'clone',
      };
      const { check, decision } = await consultProductionGuard(guard, guardRequest);
      run.guard = decision;
      if (decision === 'refused' || decision === 'declined') {
        recordWriteRun(this.deps, { ...run, outcome: 'stopped', source: undefined });
      }
      if (decision === 'refused') {
        throw new Error(`${GUARD_BLOCKED_PREFIX}${check.blockedReason ?? check.impactSummary}`);
      }
      if (decision === 'declined') {
        const declined = 'Operation cancelled by user (production confirmation declined).';
        sendOperationFailed(this.deps, operationId, declined, false, {
          context: failure,
          extraPayload: { code: CLONE_FAILURE_CODES.confirmationDeclined },
        });
        // Registered before the question was asked: left unsettled, the
        // clone stayed listed as running for the rest of the session.
        settle(new Error(declined));
        return;
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
      unrecorded = true;

      const robustnessConfig = robustnessConfigOf(this.deps);
      const defaultBatchSize =
        this.deps.services?.getSandforgeSetting?.('seed.defaultBatchSize', 200) ?? 200;
      failure.batchSize = defaultBatchSize;
      /**
       * What the target describe says about each object beyond its fields:
       * the key prefix a duplicate's id must carry before the clone links to
       * it, and the record types the running user may use. Filled by the
       * describe below, which the run makes anyway.
       */
      const targetObjects = new Map<
        string,
        { keyPrefix: string | null; recordTypes: RecordTypeAvailability[] }
      >();
      const writer = new BulkDataWriter({
        keyPrefixOf: (objectName) => targetObjects.get(objectName)?.keyPrefix,
        connection: targetConn,
        bulkExecutor: new BulkApiExecutor(robustnessConfig.bulk.threshold),
        bulkManager: bulkManagerOf(this.deps),
        retryConfig: robustnessConfig.retry,
        signal: abortController.signal,
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
        targetObjects.set(name, {
          keyPrefix: describe.keyPrefix ?? null,
          recordTypes: parseRecordTypeInfos(describe.recordTypeInfos),
        });
      }
      const insertOrder = linker.resolveInsertOrder(
        objectNames,
        linker.buildEdgesFromDescribe(objectNames, describeMap),
      );
      const configsByName = new Map(parsed.objects.map((o) => [o.objectApiName, o]));

      /** sourceId -> targetId across all objects inserted so far. */
      const globalIdMap = new Map<string, string>();
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

        // A clone copies `RecordTypeId` as it read it, and a type closed to
        // the running user in the target refuses every record carrying it with
        // an INVALID_CROSS_REFERENCE_KEY that names the id and not the reason.
        // A clone leaves a reference it cannot resolve for Salesforce to
        // refuse rather than change it, so there is no default to fall back
        // on: the object is held back whole, before any of it is written, with
        // what to change in the target.
        const heldBack = findUnavailableRecordTypes(
          objectApiName,
          writeRecords,
          targetObjects.get(objectApiName)?.recordTypes ?? [],
        );
        if (heldBack.length > 0) {
          objectLevelFailures++;
          objectResults.push({
            objectApiName,
            sourceCount: sourceRecords.length,
            insertedCount: 0,
            failedCount: sourceRecords.length,
            idMappings: [],
            // Keyed on the first record of each type: the error table needs a
            // distinct row key, and the message counts the rest.
            errors: heldBack.map((use) => {
              const first = sourceRecords.find((_, i) => carriesRecordType(writeRecords[i], [use]));
              return {
                sourceId: typeof first?.['Id'] === 'string' ? first['Id'] : use.recordTypeId,
                message: recordTypeBlockedMessage(use),
              };
            }),
          });
          continue;
        }

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
          linkedCount: 0,
          idMappings: [],
          errors: [],
        };
        outcomes.forEach((outcome, i) => {
          const sourceId =
            typeof sourceRecords[i]?.['Id'] === 'string' ? sourceRecords[i]['Id'] : '';
          if (outcome.success) {
            objectResult.insertedCount++;
            if (sourceId && outcome.id) {
              globalIdMap.set(sourceId, outcome.id);
              objectResult.idMappings.push({ sourceId, targetId: outcome.id });
            }
          } else if (outcome.existingId) {
            // Refused because the target holds it, and named: the children
            // link to that record, which the clone never writes to.
            objectResult.linkedCount = (objectResult.linkedCount ?? 0) + 1;
            if (sourceId) {
              globalIdMap.set(sourceId, outcome.existingId);
              objectResult.idMappings.push({ sourceId, targetId: outcome.existingId });
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
      const totalLinked = objectResults.reduce((sum, r) => sum + (r.linkedCount ?? 0), 0);
      const totalFailed = objectResults.reduce((sum, r) => sum + r.failedCount, 0);
      const result: CloneExecutionResult = {
        status:
          totalFailed === 0 && objectLevelFailures === 0
            ? 'success'
            : totalInserted + totalLinked > 0
              ? 'partial'
              : 'failure',
        objectResults,
        totalSourceRecords,
        totalInserted,
        totalLinked,
        totalFailed,
        durationMs: Date.now() - startedAt,
      };
      unrecorded = false;
      recordWriteRun(this.deps, cloneRun(run, result.status, objectResults, upserts));

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
      settle();
    } catch (err: unknown) {
      if (unrecorded) {
        recordWriteRun(this.deps, cloneRun(run, 'failure', objectResults, upserts));
      }
      // Single failure emission: `operation:failed` only (same convention as
      // seed:execute / sync:execute — the webview consumes that channel).
      const message = extractErrorMessage(err);
      this.deps.log(`[ERR] seed:clone:execute: ${message}`);
      sendOperationFailed(this.deps, operationId, message, true, {
        context: failure,
        extraPayload: {
          code: message.startsWith(GUARD_BLOCKED_PREFIX)
            ? CLONE_FAILURE_CODES.guardBlocked
            : CLONE_FAILURE_CODES.failed,
        },
      });
      settle(err);
    }
  }
}

/**
 * A clone as the audit trail records it: per object, what it wrote and what the
 * org refused, and — from its own source→target mappings, linked records
 * included — how many records it gave a counterpart in the target.
 *
 * @param upserted - Whether the rows went in by upsert, which says it wrote a
 *   row but not whether it created it.
 */
function cloneRun(
  run: WriteRun,
  outcome: AuditOutcome,
  objectResults: readonly CloneObjectResult[],
  upserted: boolean,
): WriteRun {
  return {
    ...run,
    outcome,
    objects: objectResults.map((result) => ({
      ...emptyCounts(result.objectApiName),
      ...(upserted ? { upserted: result.insertedCount } : { created: result.insertedCount }),
      failed: result.failedCount,
    })),
    carried: Object.fromEntries(
      objectResults.map((result) => [result.objectApiName, result.idMappings.length]),
    ),
  };
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
