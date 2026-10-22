import type { CsvValidationResult } from '@sandforge/shared';
import { guardTierOf } from '@sandforge/shared';
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
  robustnessConfigOf,
  bulkManagerOf,
  PRODUCTION_GUARD_MISSING,
  GUARD_REFUSAL,
  guardBlockedError,
  guardRefusalCode,
} from './HandlerTypes.js';
import { validatePayload, seedCsvPayloadSchema } from '../validatePayload.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import {
  API_BUDGET_EXCEEDED,
  apiBudgetCheckOf,
  apiBudgetRefusal,
  readApiBudget,
  runRequestsEstimate,
} from '../../modules/forge/ForgeRunGate.js';
import { checkApiLimits } from '../../core/common/sforceLimitParser.js';
import { CsvValidator } from '../../modules/seed/CsvValidator.js';
import type { DescribeField } from '../../modules/seed/describeField.js';
import { BulkDataWriter } from '../../modules/sync/BulkDataWriter.js';
import { WriteCancelledError } from '../../modules/sync/WriteCancelledError.js';
import { BulkApiExecutor } from '../../core/engine/BulkApiExecutor.js';
import { consultProductionGuard } from '../../core/precheck/consultProductionGuard.js';
import { emptyCounts, recordWriteRun } from '../../modules/audit/auditTrail.js';
import type { WriteRun } from '../../modules/audit/auditTrail.js';
import type { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import type { SeedRunCreations, SeedRunRecorder } from '../../modules/seed/SeedRunCreations.js';
import { seedWriterCalls } from '../../modules/seed/seedRunCalls.js';

/** Message types handled by SeedCsvHandler. */
const SEED_CSV_TYPES = new Set(['seed:csv:validate', 'seed:csv:execute']);

/** Max error strings returned in the execute response (bounds postMessage size). */
const MAX_RESPONSE_ERRORS = 100;

/** Why an import the cancel stopped before its first row was stopped, as the audit trail records it. */
const IMPORT_CANCELLED = 'IMPORT_CANCELLED';

/** Shape of the `seed:csv:execute:response` payload (see useCsvImport.CsvExecutionResult). */
interface CsvExecutionResultPayload {
  insertedCount: number;
  failedCount: number;
  errors: string[];
  /** Set when a cancel stopped the import before its rows were written. */
  cancelled?: boolean;
  /**
   * The id what the import created is kept under, for its removal from the
   * results or Earlier seeds (`seed:remove`): set when it created a record.
   */
  runId?: string;
}

/**
 * Domain handler for the CSV import wizard (`seed:csv:*`).
 *
 * The webview pre-parses the file with PapaParse and posts typed rows, so the
 * extension validates against the live describe metadata (CsvValidator) and
 * writes through BulkDataWriter (REST batches / Bulk API with retry):
 *   seed:csv:validate -> seed:csv:validate:response (CsvValidationResult)
 *   seed:csv:execute  -> seed:csv:execute:response  { insertedCount, failedCount, errors, runId? }
 * Validation failures are reported on `seed:csv:error`; execute failures on
 * `operation:failed` (same convention as seed:execute / sync:execute).
 *
 * What an import creates is kept as a seed's is (`SeedRunCreations`), as each
 * call goes and answers, under the request's id: the response names it, and
 * the import is taken back from its results or from Earlier seeds by the
 * removal a seed takes (`seed:remove`).
 */
export class SeedCsvHandler implements DomainHandler {
  /** @param deps - Injected handler dependencies. */
  private registry?: BackgroundOperationRegistry;
  /** What the Monitor's Live Operations panel lists, with a Cancel for each run. */
  private liveTracker?: LiveOperationTracker;

  constructor(private readonly deps: HandlerDeps) {}

  /**
   * Inject the shared registry so CSV imports are cancellable.
   * Called from ExtensionHandlers, same as SeedOpsHandler.
   */
  setRegistry(registry: BackgroundOperationRegistry): void {
    this.registry = registry;
  }

  /** Inject the tracker the Monitor's Live Operations panel lists. */
  setLiveOperationTracker(tracker: LiveOperationTracker): void {
    this.liveTracker = tracker;
  }

  /** Where what each import creates is kept, as a seed's is: see `SeedRunCreations`. */
  private runCreations?: SeedRunCreations;

  /** The imports this window is writing now, by the id what they create is kept under. */
  private readonly runningRuns = new Set<string>();

  /**
   * Where each import keeps what it creates, as it writes it, for its removal
   * from the results or Earlier seeds: what an import wrote could not be
   * taken back from SandForge.
   */
  setRunCreations(store: SeedRunCreations): void {
    this.runCreations = store;
  }

  /** Whether the import kept under `runId` is still writing, in this window. */
  isRunning(runId: string): boolean {
    return this.runningRuns.has(runId);
  }

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: InboundRequest): Promise<boolean> {
    if (!SEED_CSV_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'seed:csv:validate':
        await this.handleValidate(msg);
        return true;
      case 'seed:csv:execute':
        await this.handleExecute(msg);
        return true;
      default:
        return false;
    }
  }

  /**
   * Note how an import ended with what it created, and let it be removed: the
   * calls kept what each created as it answered. A store that cannot keep it
   * all is said, and the import ends as it did.
   *
   * @returns Whether all of it was kept.
   */
  private async endKept(
    kept: SeedRunRecorder | undefined,
    operationId: string,
    ending: { status: 'success' | 'partial' | 'failure'; cancelled: boolean },
  ): Promise<boolean> {
    if (!kept) return false;
    try {
      await kept.end({
        finishedAt: new Date().toISOString(),
        status: ending.status,
        ...(ending.cancelled ? { cancelled: true } : {}),
        objectResults: [],
      });
      return true;
    } catch (err: unknown) {
      this.deps.log(
        `[WARN] seed:csv:execute ${operationId}: what the import created could not all be kept, ` +
          `so removing it may leave some of it in the org: ${extractErrorMessage(err)}`,
      );
      return false;
    } finally {
      this.runningRuns.delete(operationId);
    }
  }

  /** Validate mapped CSV rows against the target object's live describe metadata. */
  private async handleValidate(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(seedCsvPayloadSchema, msg, 'seed:csv:error', this.deps);
    if (!parsed) return;

    try {
      const conn = await getJsforceConnection(
        parsed.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const describe = await conn.describe(parsed.objectApiName);
      checkApiLimits(conn.limitInfo, `seed:csv:validate describe ${parsed.objectApiName}`);

      const validator = new CsvValidator();
      const result: CsvValidationResult = validator.validate(
        parsed.records,
        parsed.columnMappings,
        describe.fields as unknown as DescribeField[],
        parsed.externalIdField,
      );

      const response = buildResponse(
        this.deps,
        msg,
        'seed:csv:validate:response',
        result as unknown as Record<string, unknown>,
      );
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id} valid=${result.valid}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'seed:csv:validate', 'seed:csv:error', msg, err);
    }
  }

  /** Import mapped CSV rows into the target org via BulkDataWriter. */
  private async handleExecute(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(seedCsvPayloadSchema, msg, 'seed:csv:error', this.deps);
    if (!parsed) return;
    const operationId = msg.id;
    const failure: OperationFailureContext = {
      module: 'seed',
      operation: msg.type,
      objectName: parsed.objectApiName,
    };

    // A throwaway `new AbortController()` was handed to BulkDataWriter, so its
    // signal could never fire and the import was never registered —
    // execution:abort answered "Operation not found" and the load ran on.
    const abortController = new AbortController();
    let settle: (err?: unknown) => void = () => {};
    const tracked = new Promise<void>((resolve, reject) => {
      settle = (err) => (err === undefined ? resolve() : reject(err));
    });
    // The registry attaches its own handlers; this only prevents an unhandled
    // rejection when no registry has been injected.
    tracked.catch(() => {});
    this.registry?.register(operationId, 'csv', 'CSV import', tracked, abortController);

    /** The run as the audit trail records it, once it ends. */
    const run: WriteRun = {
      action: 'seed_csv_import',
      module: 'seed',
      operationId,
      orgId: parsed.orgId,
      outcome: 'failure',
      source: { origin: 'csv' },
    };
    /**
     * True from the moment the import is announced until its end is recorded:
     * a failure before it wrote nothing, and a run is recorded once.
     */
    let unrecorded = false;
    /** What keeps what the import creates, from its first write until it ended. */
    let kept: SeedRunRecorder | undefined;
    /** Records the import created, as its calls answered: an upsert's rows the org created. */
    let created = 0;

    try {
      // Production guard check on target org (mirror SyncOpsHandler), and no
      // import without it.
      const guard = this.deps.infraServices?.productionGuard;
      if (!guard) {
        recordWriteRun(this.deps, {
          ...run,
          outcome: 'stopped',
          source: undefined,
          code: PRODUCTION_GUARD_MISSING.code,
        });
        // On seed:csv:error too, which the page's request waits on: sent
        // `operation:failed` alone, the page waited out its two minutes.
        sendHandlerError(
          this.deps,
          'seed:csv:execute',
          'seed:csv:error',
          msg,
          new Error(PRODUCTION_GUARD_MISSING.message),
          { code: PRODUCTION_GUARD_MISSING.code, retryable: false },
        );
        sendOperationFailed(this.deps, operationId, PRODUCTION_GUARD_MISSING.message, false, {
          context: failure,
          extraPayload: { code: PRODUCTION_GUARD_MISSING.code },
        });
        // Registered already, like a declined run: settled, or it stays listed.
        settle(new Error(PRODUCTION_GUARD_MISSING.message));
        return;
      }
      const targetOrg = this.deps.orgManager.getOrg(parsed.orgId);
      const guardRequest = {
        orgId: parsed.orgId,
        orgTier: guardTierOf(targetOrg),
        operation: (parsed.externalIdField ? 'upsert' : 'insert') as 'upsert' | 'insert',
        objectName: parsed.objectApiName,
        recordCount: parsed.records.length,
        module: 'seed',
      };
      const { check, decision } = await consultProductionGuard(guard, guardRequest);
      run.guard = decision;
      if (decision === 'refused' || decision === 'declined') {
        recordWriteRun(this.deps, { ...run, outcome: 'stopped', source: undefined });
      }
      if (decision === 'refused') {
        throw guardBlockedError(check.blockedReason ?? check.impactSummary);
      }
      if (decision === 'declined') {
        const declined = 'Operation cancelled by user (production confirmation declined).';
        // On seed:csv:error too, which the page's request waits on, with the
        // code every write path declines with.
        sendHandlerError(
          this.deps,
          'seed:csv:execute',
          'seed:csv:error',
          msg,
          new Error(declined),
          {
            code: GUARD_REFUSAL.declined,
          },
        );
        sendOperationFailed(this.deps, operationId, declined, false, { context: failure });
        // Registered before the question was asked: left unsettled, the
        // import stayed listed as running for the rest of the session.
        settle(new Error(declined));
        return;
      }

      const conn = await getJsforceConnection(
        parsed.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );

      // The import's Bulk API jobs against the daily API requests the org has
      // left, before anything is written: an import into an org whose
      // integrations had used the day's requests stopped part way through.
      // An org that would not say is said in the log, and holds nothing back.
      const budget = await readApiBudget(conn).catch((err: unknown) => ({
        unread: extractErrorMessage(err),
      }));
      const api = apiBudgetCheckOf(
        runRequestsEstimate([{ rows: parsed.records.length, bulk: true }]),
        budget,
      );
      if (api.verdict === 'unread') {
        this.deps.log(
          `[WARN] seed:csv:execute ${operationId}: the daily API requests the org has left ` +
            `could not be read (${api.unread})`,
        );
      }
      const overBudget = apiBudgetRefusal(
        api,
        targetOrg?.alias || targetOrg?.username || parsed.orgId,
      );
      if (overBudget) {
        recordWriteRun(this.deps, {
          ...run,
          outcome: 'stopped',
          source: undefined,
          code: API_BUDGET_EXCEEDED,
        });
        sendHandlerError(
          this.deps,
          'seed:csv:execute',
          'seed:csv:error',
          msg,
          new Error(overBudget),
          { code: API_BUDGET_EXCEEDED, retryable: false },
        );
        sendOperationFailed(this.deps, operationId, overBudget, false, {
          context: failure,
          authored: true,
          extraPayload: { code: API_BUDGET_EXCEEDED },
        });
        settle(new Error(overBudget));
        return;
      }

      sendOperationStarted(
        this.deps,
        operationId,
        'seed',
        `CSV import ${parsed.records.length} record(s) into ${parsed.objectApiName}`,
      );
      // Listed in Live Operations while it runs, where Cancel reaches the
      // registry's controller above, as a Sync or a Seed run is.
      this.liveTracker?.register(
        operationId,
        'csv',
        `CSV import ${parsed.records.length} record(s) into ${parsed.objectApiName}`,
        parsed.records.length,
      );
      unrecorded = true;

      const robustnessConfig = robustnessConfigOf(this.deps);
      const defaultBatchSize =
        this.deps.services?.getSandforgeSetting?.('seed.defaultBatchSize', 200) ?? 200;
      failure.batchSize = defaultBatchSize;
      // What the import creates, kept as each call goes and answers, under
      // the request's id, as a seed's is: it is listed in Earlier seeds and
      // taken back from there or from its results, also after a reload or a
      // window closed under it. The import said, before it wrote, that what
      // it wrote could not be removed.
      kept = this.runCreations?.recorder({
        runId: operationId,
        targetOrgId: parsed.orgId,
        startedAt: new Date().toISOString(),
        origin: 'csv',
      });
      if (kept) this.runningRuns.add(operationId);
      const writer = new BulkDataWriter({
        connection: conn,
        bulkExecutor: new BulkApiExecutor(robustnessConfig.bulk.threshold),
        bulkManager: bulkManagerOf(this.deps),
        retryConfig: robustnessConfig.retry,
        signal: abortController.signal,
        onProgress: (processed, total, label) => {
          const percent = total > 0 ? Math.round((processed / total) * 100) : 0;
          sendOperationProgress(this.deps, operationId, percent, processed, total, label);
          this.liveTracker?.updateProgress(operationId, percent, processed, total, label);
        },
        log: (message) => this.deps.log(message),
        ...(kept
          ? {
              calls: seedWriterCalls(kept, (count) => {
                created += count;
              }),
            }
          : {}),
      });

      const writeRecords = parsed.records.map((row) =>
        buildSalesforceRecord(row, parsed.columnMappings),
      );

      /*
       * Whether the cancel stopped the import before all its rows were
       * written: before the write, by aborting a Bulk API upload while its job
       * was still open, or between two REST batches, after the rows those
       * wrote. Only an upload of more than ten thousand rows looked at it, and
       * reported a stopped import as one that wrote nothing and refused nothing.
       */
      let cancelled = abortController.signal.aborted;
      let outcomes: Awaited<ReturnType<BulkDataWriter['insert']>> = [];
      if (!cancelled) {
        try {
          outcomes = parsed.externalIdField
            ? await writer.upsert(
                parsed.objectApiName,
                parsed.externalIdField,
                writeRecords,
                defaultBatchSize,
              )
            : await writer.insert(parsed.objectApiName, writeRecords, defaultBatchSize);
        } catch (writeErr: unknown) {
          // The rows written before the cancel stay in the org, and are
          // counted. Any other error is the import's failure.
          if (!(writeErr instanceof WriteCancelledError)) throw writeErr;
          cancelled = true;
          outcomes = writeErr.written;
        }
      }

      const errors: string[] = [];
      let insertedCount = 0;
      for (const outcome of outcomes) {
        if (outcome.success) {
          insertedCount++;
        } else if (errors.length < MAX_RESPONSE_ERRORS) {
          errors.push(outcome.errors[0] ?? 'Unknown insert error');
        }
      }
      const failedCount = outcomes.length - insertedCount;
      const reached = failedCount === 0 ? 'success' : insertedCount > 0 ? 'partial' : 'failure';
      /** Why the import ended failed — it wrote no row — or nothing when it did not. */
      const importFailed =
        !cancelled && reached === 'failure'
          ? (errors[0] ?? 'No row could be imported.')
          : undefined;
      unrecorded = false;
      if (cancelled && outcomes.length === 0) {
        // Stopped before its first row, which went nowhere and was refused
        // nowhere: recorded as a run a check of its own stopped before it
        // started, under the code that names why, as a Frozen load or a Forge
        // run is. Read as partial, an import that wrote nothing said it had
        // put part of its rows in the org.
        recordWriteRun(this.deps, {
          ...run,
          outcome: 'stopped',
          source: undefined,
          code: IMPORT_CANCELLED,
        });
      } else {
        recordWriteRun(this.deps, {
          ...run,
          // Stopped by the user once it wrote or had a row refused: cancelled,
          // as a Sync run the user stopped is. It read partial, as an import
          // the org refused part of does.
          outcome: cancelled ? 'cancelled' : reached,
          objects: [
            {
              ...emptyCounts(parsed.objectApiName),
              // An upsert says it wrote the row, not whether it created it.
              ...(parsed.externalIdField
                ? { upserted: insertedCount }
                : { created: insertedCount }),
              failed: failedCount,
            },
          ],
        });
      }

      // Kept whole before the page is answered, a stopped import's too: what
      // it wrote can be taken back from its results, or from Earlier seeds.
      const keptAll = await this.endKept(kept, operationId, {
        status: cancelled && reached === 'success' ? 'partial' : reached,
        cancelled,
      });
      kept = undefined;
      const payload: CsvExecutionResultPayload = {
        insertedCount,
        failedCount,
        errors,
        ...(cancelled ? { cancelled: true } : {}),
        ...(keptAll && created > 0 ? { runId: operationId } : {}),
      };
      if (cancelled) {
        // Ended the way a cancelled Sync or Seed ends: aborted in the registry
        // — already, when the cancel came through it — and posted as a
        // completion that says so.
        this.registry?.abort(operationId);
        sendOperationCompleted(this.deps, operationId, {
          aborted: true,
          insertedCount,
          failedCount,
        });
        this.liveTracker?.cancel(operationId);
      } else {
        // With its status, as every write run posts it: without one, an
        // import that wrote no row read as succeeded in the recent operations.
        sendOperationCompleted(this.deps, operationId, {
          status: reached,
          insertedCount,
          failedCount,
        });
        if (importFailed !== undefined) {
          this.liveTracker?.fail(operationId, importFailed);
        } else {
          this.liveTracker?.complete(operationId);
        }
      }
      const response = buildResponse(
        this.deps,
        msg,
        'seed:csv:execute:response',
        payload as unknown as Record<string, unknown>,
      );
      this.deps.broker.postToWebview(response);
      this.deps.log(
        `[TX] ${response.type} id=${response.id} inserted=${insertedCount} failed=${failedCount}`,
      );
      // In the registry as everywhere else: resolved, an import that wrote no
      // row was listed completed and announced as such.
      settle(importFailed === undefined ? undefined : new Error(importFailed));
    } catch (err: unknown) {
      if (unrecorded) recordWriteRun(this.deps, run);
      // What it created before it failed stays removable, the import ended failed.
      await this.endKept(kept, operationId, { status: 'failure', cancelled: false });
      // Dual channel, as seed:execute and sync:execute fail: `operation:failed`
      // carries the lifecycle, and seed:csv:error settles the page's request,
      // which waits on it — it was sent `operation:failed` alone, and the page
      // waited out its two minutes on an import Production Guard had refused.
      sendHandlerError(this.deps, 'seed:csv:execute', 'seed:csv:error', msg, err, {
        code: guardRefusalCode(err),
        retryable: true,
      });
      sendOperationFailed(this.deps, operationId, extractErrorMessage(err), true, {
        context: failure,
      });
      // Nothing when the import was stopped before it was listed.
      this.liveTracker?.fail(operationId, extractErrorMessage(err));
      settle(err);
    }
  }
}

/**
 * Build a Salesforce record from a CSV row using the column mappings.
 * Unmapped columns (empty `sfFieldApiName`) and empty cells are skipped so
 * Salesforce defaults/required-field validation apply. Cell values are
 * coerced by {@link coerceCellValue} ('true'/'false'/'null'/numeric strings)
 * so REST writes get proper JSON primitives.
 */
function buildSalesforceRecord(
  row: Record<string, string>,
  columnMappings: Array<{ csvHeader: string; sfFieldApiName: string }>,
): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const mapping of columnMappings) {
    if (!mapping.sfFieldApiName) continue;
    const value = row[mapping.csvHeader];
    if (value === undefined || value === '') continue;
    record[mapping.sfFieldApiName] = coerceCellValue(value);
  }
  return record;
}

/** Coerce a CSV cell string to a JSON primitive. */
function coerceCellValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  const num = Number(value);
  if (!Number.isNaN(num) && value.trim() !== '') return num;
  return value;
}
