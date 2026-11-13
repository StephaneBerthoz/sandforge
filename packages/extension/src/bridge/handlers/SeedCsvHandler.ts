import type { CsvValidationResult, RunCheckpointInfo, RunCheckpointTaken } from '@sandforge/shared';
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
  checkpointPartOf,
  checkpointScopeStop,
  confirmationApiOf,
  confirmationStorageOf,
  countedStorageBytes,
  deliverabilityPartOf,
  readApiBudget,
  readDataStorage,
  storageCheckOf,
  type ApiBudget,
  type DataStorage,
} from '../../modules/forge/ForgeRunGate.js';
import { importRequestsEstimate, importRunReads } from '../../modules/seed/seedStorage.js';
import { duplicateRulesOf } from '../../modules/seed/seedDuplicateRules.js';
import {
  NO_APEX_IN_PRODUCTION,
  readEmailDeliverability,
  runEmailsOf,
} from '../../modules/forge/targetDeliverability.js';
import { RUN_CANCELLED } from '../../modules/forge/forgeAudit.js';
import { BEFORE_RUN_DELETED_WORDS } from '../../modules/checkpoint/beforeRunCheckpoint.js';
import type { BeforeRunCheckpoints } from '../../modules/checkpoint/beforeRunCheckpoint.js';
import type { TargetAutomationReader } from '../../modules/forge/TargetAutomationReader.js';
import { TimeoutManager } from '../../core/engine/TimeoutManager.js';
import { PIPELINE_SEED_REFUSAL } from './seedPipeline.js';
import {
  SEED_WRITE_DECLINED,
  SeedCheckpointStopped,
  emailsAuditDetails,
  scopeSeedCheckpoint,
  seedImportRunning,
  seedImportWrites,
  settleSeedCheckpoint,
  takeSeedCheckpoint,
  type SeedCheckpointPlanned,
} from './SeedOpsHandler.js';
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
import { keepRunUser } from '../../modules/sync/runUser.js';
import { seedWriterCalls } from '../../modules/seed/seedRunCalls.js';

/** Message types handled by SeedCsvHandler. */
const SEED_CSV_TYPES = new Set(['seed:csv:validate', 'seed:csv:execute']);

/** Max error strings returned in the execute response (bounds postMessage size). */
const MAX_RESPONSE_ERRORS = 100;

/** Why an import the cancel stopped before its first row was stopped, as the audit trail records it. */
const IMPORT_CANCELLED = 'IMPORT_CANCELLED';

/** How long the read of what the target runs on the object imported may take, as a seed's may. */
const AUTOMATION_TIMEOUT_MS = 60_000;

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
  /**
   * The checkpoint of the object it writes, when it was asked to take one
   * before its first write (`checkpointFirst`): taken, or deleted as it wrote
   * nothing. Absent when it was not asked.
   */
  checkpoint?: RunCheckpointInfo;
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
   * The checkpoints of this window, which an import asked to take one of the
   * object it writes before its first write (Checkpoint first) takes it
   * through, as a seed does. Unset, such an import is refused, nothing written.
   */
  setBeforeRunCheckpoints(checkpoints: BeforeRunCheckpoints): void {
    this.beforeRunCheckpoints = checkpoints;
  }

  /** See {@link setBeforeRunCheckpoints}. */
  private beforeRunCheckpoints?: BeforeRunCheckpoints;

  /**
   * Reads what the target runs as the import's records go in, for the scope
   * of the checkpoint it takes first: a reader of the handler's own, over its
   * connections, loaded on its first read, as the clone's.
   */
  private targetAutomation: Pick<TargetAutomationReader, 'read'> = {
    read: async (orgId, objectApiNames) => (await this.ownReader()).read(orgId, objectApiNames),
  };

  /** The reader {@link targetAutomation} reads through, once loaded. */
  private reader?: Promise<TargetAutomationReader>;

  /** Another reader of what the target runs than the handler's own. */
  setTargetAutomation(reader: Pick<TargetAutomationReader, 'read'>): void {
    this.targetAutomation = reader;
  }

  /** The handler's own reader of the org's automation, as Forge reads it. */
  private ownReader(): Promise<TargetAutomationReader> {
    this.reader ??= import('../../modules/forge/TargetAutomationReader.js').then(
      ({ TargetAutomationReader, targetAutomationQueries }) =>
        new TargetAutomationReader(
          targetAutomationQueries((orgId) =>
            getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager),
          ),
        ),
    );
    return this.reader;
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

  /**
   * An import stopped for its checkpoint once it was announced, before its
   * first row: recorded as stopped under its code, the take's own beside it,
   * and said on both channels; its Stop while the take read ends it as an
   * import cancelled before its first row ends.
   */
  private stoppedForCheckpoint(
    msg: InboundRequest,
    run: WriteRun,
    err: SeedCheckpointStopped,
    failure: OperationFailureContext,
  ): void {
    const { operationId } = run;
    if (err.code === RUN_CANCELLED) {
      recordWriteRun(this.deps, {
        ...run,
        outcome: 'stopped',
        source: undefined,
        code: IMPORT_CANCELLED,
      });
      this.registry?.abort(operationId);
      sendOperationCompleted(this.deps, operationId, {
        aborted: true,
        insertedCount: 0,
        failedCount: 0,
      });
      this.liveTracker?.cancel(operationId);
      const answered: CsvExecutionResultPayload = {
        insertedCount: 0,
        failedCount: 0,
        errors: [],
        cancelled: true,
      };
      this.deps.broker.postToWebview(
        buildResponse(
          this.deps,
          msg,
          'seed:csv:execute:response',
          answered as unknown as Record<string, unknown>,
        ),
      );
      return;
    }
    const takeRefusal = err.refusal?.code;
    const beside: Record<string, string> =
      takeRefusal !== undefined ? { checkpointRefusal: takeRefusal } : {};
    recordWriteRun(this.deps, {
      ...run,
      outcome: 'stopped',
      source: undefined,
      code: err.code,
      ...(takeRefusal !== undefined ? { details: beside } : {}),
    });
    sendHandlerError(this.deps, 'seed:csv:execute', 'seed:csv:error', msg, err, {
      code: err.code,
      retryable: false,
      ...(takeRefusal !== undefined ? { extraPayload: beside } : {}),
    });
    sendOperationFailed(this.deps, operationId, err.message, false, {
      context: failure,
      authored: true,
      extraPayload: { code: err.code, ...beside },
    });
    this.liveTracker?.fail(operationId, err.message);
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
    /** The checkpoint the import took first, until it is settled. */
    let taken: RunCheckpointTaken | undefined;
    /** Whether the import sent a row to the org: its checkpoint is kept once it did. */
    let wrote = false;

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
        const declined = 'Operation cancelled by user (confirmation declined).';
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
      const targetName = targetOrg?.alias || targetOrg?.username || parsed.orgId;
      /** Refuse the import before it is announced, nothing written, under its code. */
      const refuse = (code: string, message: string, checkpointRefusal?: string): void => {
        const beside: Record<string, string> =
          checkpointRefusal !== undefined ? { checkpointRefusal } : {};
        recordWriteRun(this.deps, {
          ...run,
          outcome: 'stopped',
          source: undefined,
          code,
          ...(checkpointRefusal !== undefined ? { details: beside } : {}),
        });
        sendHandlerError(this.deps, 'seed:csv:execute', 'seed:csv:error', msg, new Error(message), {
          code,
          retryable: false,
          ...(checkpointRefusal !== undefined ? { extraPayload: beside } : {}),
        });
        sendOperationFailed(this.deps, operationId, message, false, {
          context: failure,
          authored: true,
          extraPayload: { code, ...beside },
        });
        settle(new Error(message));
      };

      // What the target's automation does as the rows go in, read once for
      // the emails and the checkpoint alike: no record read, nothing kept.
      const reader = this.targetAutomation;
      const writes = seedImportWrites([parsed.objectApiName], Boolean(parsed.externalIdField));
      const read = await new TimeoutManager(AUTOMATION_TIMEOUT_MS)
        .withTimeout('csv automation', () => reader.read(parsed.orgId, [parsed.objectApiName]))
        .catch((err: unknown) => ({ unread: extractErrorMessage(err) }));
      if (typeof read.unread === 'string') {
        this.deps.log(
          `[WARN] seed:csv:execute ${operationId}: what the org runs on ` +
            `${parsed.objectApiName} could not be read (${read.unread}): it is asked about its ` +
            'emails, and a checkpoint holds the object alone',
        );
      }
      // Whether the target delivers the emails of what runs as the rows go
      // in, read only when something may send one, and asked with the
      // import's one question. No Apex runs in a production org. The file's
      // rows go in as they are: their addresses are not put under `.invalid`.
      const emailsOfRun = await runEmailsOf({
        read,
        writes,
        readDeliverability: () =>
          guardTierOf(targetOrg) === 'production'
            ? Promise.resolve(NO_APEX_IN_PRODUCTION)
            : readEmailDeliverability(conn),
        accepted: false,
        target: targetName,
        run: 'seed',
        keepsAddresses: true,
      });
      const emailsAsked = emailsOfRun.gate.verdict === 'asks';

      // The checkpoint asked first, scoped from the object the import writes
      // and what that automation creates. Refused, or unread, the import is
      // refused before anything is asked or written.
      let checkpoint: SeedCheckpointPlanned | undefined;
      if (parsed.checkpointFirst !== undefined) {
        try {
          checkpoint = await scopeSeedCheckpoint(this.beforeRunCheckpoints, {
            module: 'seed',
            orgId: parsed.orgId,
            operationId,
            written: [parsed.objectApiName],
            running: seedImportRunning(read, writes),
            request: parsed.checkpointFirst,
          });
        } catch (err: unknown) {
          if (!(err instanceof SeedCheckpointStopped)) throw err;
          refuse(err.code, err.message);
          return;
        }
        const stop = checkpointScopeStop(checkpoint.planned);
        if (stop) {
          refuse(stop.code, stop.message, stop.refusal.code);
          return;
        }
      }

      // The import's Bulk API jobs against the daily API requests the org has
      // left, before anything is written: an import into an org whose
      // integrations had used the day's requests stopped part way through.
      // An org that would not say is said in the log, and holds nothing back.
      // With a checkpoint asked, its requests among them, and the storage
      // read from the same answer, for its question to say; so for the
      // question about the emails.
      const limits: DataStorage | { unread: string } | undefined =
        checkpoint || emailsAsked
          ? await readDataStorage(conn).catch((err: unknown) => ({
              unread: extractErrorMessage(err),
            }))
          : undefined;
      const budget: ApiBudget | { unread: string } | undefined =
        limits !== undefined && !('unread' in limits)
          ? limits.dailyApiRequests
          : await readApiBudget(conn).catch((err: unknown) => ({
              unread: extractErrorMessage(err),
            }));
      // The rows priced as the writer sends them: past the Bulk API
      // threshold one job, and every row again by REST when a duplicate rule
      // watches the object, or may — the writer sends what a rule refused in
      // the job again so —, as the automation read above found the rules;
      // and what the run reads of the org as it writes them.
      const api = apiBudgetCheckOf(
        {
          run:
            importRequestsEstimate(
              [{ objectApiName: parsed.objectApiName, rows: parsed.records.length }],
              {
                threshold: robustnessConfigOf(this.deps).bulk.threshold,
                perCall: this.deps.services?.getSandforgeSetting?.('seed.defaultBatchSize', 200),
                duplicateRules: duplicateRulesOf(read),
              },
            ) + importRunReads(),
          ...checkpointPartOf(checkpoint?.planned),
          ...deliverabilityPartOf(emailsOfRun.ofRun),
        },
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

      // A checkpoint asked first is asked about before anything is taken or
      // written, its cost that of the target's whole tables: declined, or
      // with nobody to answer for it, the import writes nothing. So are the
      // emails of a target that delivers them all or would not say: going on
      // is the accord to send them.
      let emailsAccepted = false;
      if (checkpoint || emailsAsked) {
        const rows = parsed.records.length;
        const answer = await guard.confirmRun({
          stage: 'write',
          module: 'seed',
          org: targetName,
          orgTier: guardTierOf(targetOrg),
          objects: [{ objectApiName: parsed.objectApiName, rows }],
          total: rows,
          storage: confirmationStorageOf(
            storageCheckOf(
              { storageBytes: countedStorageBytes(parsed.objectApiName, { rows }) },
              limits ?? { unread: 'not read' },
            ),
          ),
          ...confirmationApiOf(api),
          ...(checkpoint ? { checkpoint: checkpoint.planned } : {}),
          ...emailsOfRun.gate.confirmation,
        });
        if (answer !== 'confirmed') {
          const stop = emailsOfRun.gate.stop;
          if (answer !== 'declined' && !checkpoint && stop) refuse(stop.code, stop.message);
          else {
            refuse(
              answer === 'declined' ? SEED_WRITE_DECLINED : PIPELINE_SEED_REFUSAL.unanswered,
              answer === 'declined'
                ? 'The import was cancelled before it wrote anything. Nothing was written.'
                : `The import needed an answer before it wrote — the checkpoint it takes first ` +
                    `reads whole tables of ${targetName} — and there was no one to ask. Nothing ` +
                    'was written.',
            );
          }
          return;
        }
        emailsAccepted = emailsAsked;
      }
      run.details = emailsAuditDetails({ read: emailsOfRun, accepted: emailsAccepted }).details;

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

      // The checkpoint, taken once the question was answered, as close to the
      // first row as it can be, under the import's Cancel: refused, failed or
      // stopped, the import writes nothing.
      if (checkpoint) {
        try {
          taken = await takeSeedCheckpoint(
            this.beforeRunCheckpoints,
            checkpoint,
            operationId,
            abortController.signal,
            (percent, processed, total, label) => {
              sendOperationProgress(this.deps, operationId, percent, processed, total, label);
              this.liveTracker?.updateProgress(operationId, percent, processed, total, label);
            },
          );
        } catch (err: unknown) {
          if (!(err instanceof SeedCheckpointStopped)) throw err;
          this.stoppedForCheckpoint(msg, run, err, failure);
          settle(err.code === RUN_CANCELLED ? undefined : err);
          return;
        }
      }
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
      // The checkpoint it took is named in its file, with its first line, and
      // the user it writes as is asked of the org, waited for by nothing.
      if (taken) kept?.checkpoint?.(taken);
      keepRunUser(kept, () => conn.identity(), `seed:csv:execute ${operationId}`);
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
        if (writeRecords.length > 0) wrote = true;
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
      // The checkpoint taken first, kept once a row went, deleted when none did.
      const checkpointInfo = await settleSeedCheckpoint(
        this.beforeRunCheckpoints,
        taken,
        wrote,
        this.deps.log,
        `seed:csv:execute ${operationId}`,
      );
      taken = undefined;
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
          ...(checkpointInfo?.state === 'taken'
            ? { checkpointId: checkpointInfo.checkpointId }
            : {}),
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
        ...(checkpointInfo ? { checkpoint: checkpointInfo } : {}),
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
        } else if (reached === 'partial') {
          this.liveTracker?.partial(operationId);
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
      // The checkpoint taken first, kept once a row went, deleted when none did.
      const settled = await settleSeedCheckpoint(
        this.beforeRunCheckpoints,
        taken,
        wrote,
        this.deps.log,
        `seed:csv:execute ${operationId}`,
      );
      if (unrecorded) {
        recordWriteRun(this.deps, {
          ...run,
          ...(settled?.state === 'taken' ? { checkpointId: settled.checkpointId } : {}),
        });
      }
      // What it created before it failed stays removable, the import ended failed.
      await this.endKept(kept, operationId, { status: 'failure', cancelled: false });
      const failed =
        settled?.state === 'deleted'
          ? `${extractErrorMessage(err)} ${BEFORE_RUN_DELETED_WORDS}`
          : extractErrorMessage(err);
      // Dual channel, as seed:execute and sync:execute fail: `operation:failed`
      // carries the lifecycle, and seed:csv:error settles the page's request,
      // which waits on it — it was sent `operation:failed` alone, and the page
      // waited out its two minutes on an import Production Guard had refused.
      // The page says what became of the checkpoint itself, in its language.
      sendHandlerError(this.deps, 'seed:csv:execute', 'seed:csv:error', msg, err, {
        code: guardRefusalCode(err),
        retryable: true,
        ...(settled ? { extraPayload: { checkpoint: settled } } : {}),
      });
      sendOperationFailed(this.deps, operationId, failed, true, {
        context: failure,
      });
      // Nothing when the import was stopped before it was listed.
      this.liveTracker?.fail(operationId, failed);
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
