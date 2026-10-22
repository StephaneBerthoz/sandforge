import type {
  ForgeSweepResult,
  ForgeTargetAutomation,
  GuardDecision,
  SyncRemovalResult,
  SyncRunRemovalInfo,
} from '@sandforge/shared';
import { guardTierOf, sanitizeSoqlObjectName } from '@sandforge/shared';
import type { DomainHandler, HandlerDeps, InboundRequest } from './HandlerTypes.js';
import {
  ABORTED_BEFORE_START,
  GUARD_REFUSAL,
  PRODUCTION_GUARD_MISSING,
  buildResponse,
  sendHandlerError,
  sendOperationCompleted,
  sendOperationProgress,
  sendOperationStarted,
} from './HandlerTypes.js';
import {
  validatePayload,
  syncEarlierCopiesPayloadSchema,
  syncRemovalInfoPayloadSchema,
  syncRemovePayloadSchema,
  syncRemoveSweepPayloadSchema,
} from '../validatePayload.js';
import { idLists, isRecordId } from '../../modules/dataops/RecordRemoval.js';
import { earlierCopiesOf } from '../../modules/sync/syncEarlierCopies.js';
import type {
  BackgroundOperationRegistry,
  PendingStart,
} from '../../core/engine/BackgroundOperationRegistry.js';
import type { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import { consultProductionGuard } from '../../core/precheck/consultProductionGuard.js';
import type { ProductionGuard, SafetyTier } from '../../core/precheck/ProductionGuard.js';
import { TimeoutManager } from '../../core/engine/TimeoutManager.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { recordWriteRun } from '../../modules/audit/auditTrail.js';
import { removalOrg } from '../../modules/forge/ForgeRunRemoval.js';
import { removalAuditObjects, removalAuditOutcome } from '../../modules/forge/removalOutcome.js';
import { SyncConfigStore } from '../../modules/sync/SyncConfigStore.js';
import type { SyncHistoryStore } from '../../modules/sync/SyncHistoryStore.js';
import {
  createdCount,
  overwrittenCount,
  SYNC_FILE_OBJECTS,
  syncRemovalPlan,
  syncRestorePlan,
  type SyncRunCreations,
  type SyncRunKept,
} from '../../modules/sync/SyncRunCreations.js';
import { removeSyncRun } from '../../modules/sync/SyncRunRemoval.js';
import { withRestoreAudit, type BackupReader } from '../../modules/sync/SyncRunRestore.js';
import {
  answerJobsInFlight,
  jobAnsweredLines,
  type IngestJobReading,
} from '../../modules/sync/inFlightJob.js';
import { seedSweepInput } from '../../modules/seed/seedRunSweep.js';
import {
  listSweep,
  sweepAuditDetails,
  sweepAuditObjects,
  sweepFoundCount,
  sweepFoundObjects,
  sweepRunRecords,
  type SweepInput,
} from '../../modules/forge/ForgeRunSweep.js';
import type { TargetAutomationReader } from '../../modules/forge/TargetAutomationReader.js';

/** Message types handled by SyncRemovalHandler. */
const SYNC_REMOVAL_TYPES = new Set([
  'sync:removal:info',
  'sync:removal:list',
  'sync:remove',
  'sync:remove:sweep',
  'sync:earlier-copies',
]);

/** How long the read of what the target's flows create may take, for a sweep: as Forge's. */
const SWEEP_AUTOMATION_TIMEOUT_MS = 60_000;

/** How long listing what a sweep would take may take: the automation read, then one read per object. */
const SWEEP_LIST_TIMEOUT_MS = 120_000;

/** How long reading back the job a run left under way may take: two reads of the job. */
const JOB_READ_TIMEOUT_MS = 60_000;

/**
 * The removal of what a Sync run created, and what the page reads before it
 * asks for one.
 *
 * - `sync:removal:info` — what a run kept, what a removal would take, and why
 *   none can run when none can: read from what the run kept, nothing asked of
 *   the org but the Bulk API job a run whose window closed left under way,
 *   read back by its id (`withJobAnswered`).
 * - `sync:removal:list` — the runs whose creations are kept that no history
 *   entry holds: a run a closed window stopped before it ended, or one the
 *   history no longer lists. Removable all the same.
 * - `sync:remove:sweep` — what a sweep asked with the removal would take,
 *   read only, for the confirmation to list (`listSweep`).
 * - `sync:remove` — the removal itself, its sweep first when asked: Forge's,
 *   on what the run kept (see `SyncRunRemoval`), judged by Production Guard
 *   as the delete it is, at the tier Forge's and Frozen's removals take the
 *   target for — a production org is refused, a Developer Edition is not —
 *   run on the registry and in Live Operations under the id of the request,
 *   where Cancel stops it between two calls to the org, and recorded in the
 *   audit trail whatever its outcome.
 *
 * The sweep is Forge's (`sweepRunRecords`), which Seed's and Frozen's
 * removals make too: what the target's automation created during the run,
 * as the run's user, that the run did not write. A Sync of contacts into an
 * org whose flow opens a task on each new contact left those tasks behind
 * once the run was removed. The window is read back from the records the run
 * kept as created, as a Seed run's is: a run keeps its own clock's dates,
 * which a sweep never compares with the org's.
 */
export class SyncRemovalHandler implements DomainHandler {
  private creations?: SyncRunCreations;
  /** The DataOps backup store, where a run kept the values it wrote over. */
  private backups?: BackupReader;
  private registry?: BackgroundOperationRegistry;
  private liveTracker?: LiveOperationTracker;
  /** The runs being removed now: one removal at a time each. */
  private readonly removing = new Set<string>();
  private readonly configs: SyncConfigStore;
  /**
   * Reads what the target's flows create, for a sweep: a reader of the
   * handler's own, over its connections, loaded on its first read, as Seed's
   * removal reads it.
   */
  private targetAutomation: Pick<TargetAutomationReader, 'read'> = {
    read: async (orgId, objectApiNames) => (await this.ownReader()).read(orgId, objectApiNames),
  };
  /** The reader {@link targetAutomation} reads through, once loaded. */
  private reader?: Promise<TargetAutomationReader>;

  /**
   * @param deps - Injected handler dependencies.
   * @param history - The sync history: which runs it still lists.
   * @param isRunning - Whether a run is still writing, in this window.
   */
  constructor(
    private readonly deps: HandlerDeps,
    private readonly history: Pick<SyncHistoryStore, 'list'>,
    private readonly isRunning: (runId: string) => boolean,
  ) {
    this.configs = new SyncConfigStore(deps.configStore);
  }

  /** Where every run keeps what it created. */
  setRunCreations(store: SyncRunCreations): void {
    this.creations = store;
  }

  /** The DataOps backup store: a run's removal gives back from it what the run wrote over. */
  setBackupRecordStore(store: BackupReader): void {
    this.backups = store;
  }

  /** The registry a removal runs on, where Live Operations' Cancel reaches it. */
  setRegistry(registry: BackgroundOperationRegistry): void {
    this.registry = registry;
  }

  /** The Monitor's live operations, which list a removal while it runs. */
  setLiveOperationTracker(tracker: LiveOperationTracker): void {
    this.liveTracker = tracker;
  }

  /**
   * Another reader of the target's automation than the handler's own: the
   * objects the target's flows create as a run's records are written, which
   * the sweep of a run's removal looks at.
   */
  setTargetAutomation(reader: Pick<TargetAutomationReader, 'read'>): void {
    this.targetAutomation = reader;
  }

  /** The handler's own reader of the target's automation, as Forge reads it, off the activation path. */
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

  async handle(msg: InboundRequest): Promise<boolean> {
    if (!SYNC_REMOVAL_TYPES.has(msg.type)) return false;
    switch (msg.type) {
      case 'sync:removal:info':
        await this.handleInfo(msg);
        return true;
      case 'sync:removal:list':
        await this.handleList(msg);
        return true;
      case 'sync:remove':
        await this.handleRemove(msg);
        return true;
      case 'sync:remove:sweep':
        await this.handleSweepList(msg);
        return true;
      case 'sync:earlier-copies':
        await this.handleEarlierCopies(msg);
        return true;
      default:
        return false;
    }
  }

  /**
   * The tier a removal takes the target for: the one the run's writes, a
   * Forge removal and a Frozen removal take it for (`guardTierOf`). A
   * Developer Edition says IsSandbox false while it holds nobody's business;
   * Sync writes to one as to a sandbox, and refused its removal, the run's own
   * records would be left there with no way to take them back. A production
   * org of any other edition, or of an edition not known, stays production,
   * and the removal is refused with the guard's reason.
   */
  private tierOf(targetOrgId: string): SafetyTier {
    const org = this.deps.orgManager.getOrg(targetOrgId);
    return guardTierOf(org);
  }

  /** What a run kept, as the page reads it, and why no removal can run when none can. */
  private infoOf(run: SyncRunKept): SyncRunRemovalInfo {
    const plan = syncRemovalPlan(run);
    const left = plan.map(({ objectApiName, ids }) => ({ objectApiName, count: ids.length }));
    const back = syncRestorePlan(run);
    const overwritten = overwrittenCount(run);
    const info: SyncRunRemovalInfo = {
      runId: run.runId,
      configId: run.configId,
      configName: run.configName,
      sourceOrgId: run.sourceOrgId,
      targetOrgId: run.targetOrgId,
      startedAt: run.startedAt,
      ...(run.end ? { endedAt: run.end.at } : {}),
      ...(!run.end && run.inFlight
        ? { inFlight: { objectApiName: run.inFlight.objectApiName, rows: run.inFlight.rows } }
        : {}),
      created: createdCount(run),
      left,
      ...(overwritten > 0 ? { overwritten } : {}),
      ...(back.length > 0
        ? {
            putBack: back.map(({ objectApiName, ids }) => ({ objectApiName, count: ids.length })),
          }
        : {}),
      ...(run.removal?.undo ? { removed: run.removal.undo } : {}),
    };
    if (plan.length === 0 && back.length === 0) return info;
    const refusal = this.refusalOf(run, plan, back);
    return refusal ? { ...info, refusal } : info;
  }

  /**
   * What Production Guard judges a removal of the run as: the delete it is,
   * of what it takes and what it gives back, when it deletes; an update, of
   * what it gives back, when it only gives back what the run wrote over.
   */
  private guardRequestOf(
    run: SyncRunKept,
    plan: ReadonlyArray<{ objectApiName: string; ids: readonly string[] }>,
    back: ReadonlyArray<{ objectApiName: string; ids: readonly string[] }>,
  ): Parameters<ProductionGuard['check']>[0] {
    const count = (objects: typeof plan): number =>
      objects.reduce((sum, o) => sum + o.ids.length, 0);
    return {
      orgId: run.targetOrgId,
      orgTier: this.tierOf(run.targetOrgId),
      operation: plan.length > 0 ? 'delete' : 'update',
      objectName: [...new Set([...plan, ...back].map((o) => o.objectApiName))].join(', '),
      recordCount: count(plan) + count(back),
      module: 'sync',
    };
  }

  /**
   * Why a removal of the run cannot run now, before anything is asked of the
   * org: offered, it would only be refused.
   */
  private refusalOf(
    run: SyncRunKept,
    plan: ReadonlyArray<{ objectApiName: string; ids: readonly string[] }>,
    back: ReadonlyArray<{ objectApiName: string; ids: readonly string[] }>,
  ): SyncRunRemovalInfo['refusal'] {
    if (this.isRunning(run.runId)) {
      return { code: 'RUNNING', message: 'The run is still writing: remove it once it has ended.' };
    }
    if (!this.deps.orgManager.getOrg(run.targetOrgId)) {
      return {
        code: 'ORG_GONE',
        message:
          'The org the run wrote to is no longer connected: connect it again to remove the run.',
      };
    }
    const guard = this.deps.infraServices?.productionGuard;
    if (!guard) return { code: 'NO_GUARD', message: PRODUCTION_GUARD_MISSING.message };
    const check = guard.check(this.guardRequestOf(run, plan, back));
    return check.allowed
      ? undefined
      : { code: 'GUARD_BLOCKED', message: check.blockedReason ?? check.impactSummary };
  }

  /**
   * A run as it reads once the Bulk API jobs no line of its file answers are
   * answered: a run no window writes any more, ended or not, with a job the
   * org opened. The job ran on to its end on the org's side, and its records
   * were in the target with no line of them — a Sync of a few hundred
   * contacts whose window closed during its job listed none of them, and its
   * removal left them all; so did a run whose job failed while it was
   * polled, which ended in failure. Read back from each job by its id
   * (`answerJobsInFlight`), they go into the run's file, and the run is
   * listed and removed with them, as a Seed run is. A job still running, or
   * one the org cannot be asked about, leaves the run as it is, said in the
   * log, and is asked again next time. Nothing is asked of an org for any
   * other run.
   */
  private async withJobAnswered(run: SyncRunKept): Promise<SyncRunKept> {
    const store = this.creations;
    if (!store || (run.jobs ?? []).length === 0 || this.isRunning(run.runId)) return run;
    if (!this.deps.orgManager.getOrg(run.targetOrgId)) return run;
    const context = `sync:removal of ${run.runId}`;
    try {
      const answered = await new TimeoutManager(JOB_READ_TIMEOUT_MS).withTimeout(
        context,
        async () => {
          const conn = await getJsforceConnection(
            run.targetOrgId,
            this.deps.orgRegistry,
            this.deps.orgManager,
          );
          const org = removalOrg(conn, context);
          return answerJobsInFlight(store, run, conn as unknown as IngestJobReading, () =>
            org.serverTime(),
          );
        },
      );
      for (const line of jobAnsweredLines(context, answered)) this.deps.log(line);
      return answered.some((job) => job.answered) ? ((await store.get(run.runId)) ?? run) : run;
    } catch (err: unknown) {
      this.deps.log(
        `[WARN] ${context}: the job could not be read back: ${extractErrorMessage(err)}`,
      );
      return run;
    }
  }

  /** The run kept under `runId`, its job under way answered first: see {@link withJobAnswered}. */
  private async runOf(runId: string): Promise<SyncRunKept | undefined> {
    const run = await this.creations?.get(runId);
    return run ? this.withJobAnswered(run) : undefined;
  }

  private async handleInfo(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      syncRemovalInfoPayloadSchema,
      msg,
      'sync:remove:error',
      this.deps,
    );
    if (!parsed) return;
    try {
      const run = await this.runOf(parsed.runId);
      const response = buildResponse(this.deps, msg, 'sync:removal:info:response', {
        info: run ? (this.infoOf(run) as unknown as Record<string, unknown>) : null,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'sync:removal:info', 'sync:remove:error', msg, err);
    }
  }

  private async handleList(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    try {
      const listed = new Set(
        this.history
          .list()
          .flatMap((entry) => (entry.result.created?.runId ? [entry.result.created.runId] : [])),
      );
      const runs: SyncRunKept[] = [];
      for (const run of (await this.creations?.list()) ?? []) {
        // A run the history lists is not listed here: a job of it that no
        // line answers is read back when its removal is asked about (`runOf`).
        runs.push(listed.has(run.runId) ? run : await this.withJobAnswered(run));
      }
      // A run is kept from its first call that can create: one that created
      // nothing and ended has nothing to take back, and is not listed. One a
      // closed window stopped during a call is, even with nothing kept: the
      // rows of that call may be in the target.
      const unlisted = runs.filter(
        (run) =>
          !listed.has(run.runId) &&
          !this.isRunning(run.runId) &&
          (createdCount(run) > 0 ||
            overwrittenCount(run) > 0 ||
            (!run.end && run.inFlight !== undefined)),
      );
      const response = buildResponse(this.deps, msg, 'sync:removal:list:response', {
        runs: unlisted.map((run) => this.infoOf(run)) as unknown as Record<string, unknown>[],
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id} count=${unlisted.length}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'sync:removal:list', 'sync:remove:error', msg, err);
    }
  }

  /**
   * `sync:earlier-copies`: what the last run kept between two orgs created
   * of these objects that is still in the target (`syncEarlierCopies`), or
   * that a run of the saved configuration named leaves as it is. The target
   * is asked by the ids the run kept, nothing written.
   */
  private async handleEarlierCopies(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      syncEarlierCopiesPayloadSchema,
      msg,
      'sync:remove:error',
      this.deps,
    );
    if (!parsed) return;
    try {
      const creations = this.creations;
      const copies = await earlierCopiesOf(parsed, {
        runs: async () => (await creations?.list()) ?? [],
        isSaved: (configId) => this.configs.isSaved(configId),
        countInTarget: async (objectApiName, ids) => {
          const conn = await getJsforceConnection(
            parsed.targetOrgId,
            this.deps.orgRegistry,
            this.deps.orgManager,
          );
          const object = sanitizeSoqlObjectName(objectApiName);
          let held = 0;
          for (const list of idLists(ids.filter(isRecordId))) {
            held += (await conn.query(`SELECT COUNT() FROM ${object} WHERE Id IN (${list})`))
              .totalSize;
          }
          return held;
        },
      });
      const response = buildResponse(this.deps, msg, 'sync:earlier-copies:response', {
        copies: copies as unknown as Record<string, unknown>,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'sync:earlier-copies', 'sync:remove:error', msg, err);
    }
  }

  /**
   * What a sweep of a run is told: its window, read back from the records it
   * kept as created, in the org or its recycle bin (`seedSweepInput`, a Seed
   * run being kept as a Sync run is), from the run's first write to its last
   * — an update before its first creation or after its last is the run's
   * too, and what the target's automation did on it was left out; and what
   * the target's flows create on the objects whose records it created or
   * wrote over, read now. A run that created nothing is dated by its writes
   * alone, and its user read from the records it wrote over: read before a
   * removal puts their values back, which dates them anew.
   */
  private async sweepInputOf(
    conn: Parameters<typeof removalOrg>[0],
    run: SyncRunKept,
    context: string,
    signal?: AbortSignal,
  ): Promise<SweepInput> {
    const reader = this.targetAutomation;
    // The objects whose records it wrote over too: an update flow fires on them.
    const objects = [
      ...new Set(
        [...run.created, ...(run.overwritten ?? [])]
          .map((object) => object.objectApiName)
          .filter((name) => !SYNC_FILE_OBJECTS.includes(name)),
      ),
    ];
    let automation: ForgeTargetAutomation | { error: string };
    try {
      automation = await new TimeoutManager(SWEEP_AUTOMATION_TIMEOUT_MS).withTimeout(
        `${context} automation`,
        () => reader.read(run.targetOrgId, objects),
      );
    } catch (err: unknown) {
      automation = { error: extractErrorMessage(err) };
    }
    const org = removalOrg(conn, context);
    return seedSweepInput(
      org,
      run.created,
      automation,
      signal,
      run.firstWrittenAt !== undefined
        ? {
            at: run.firstWrittenAt,
            ...(run.lastWriteAt !== undefined ? { lastAt: run.lastWriteAt } : {}),
            serverTime: () => org.serverTime(),
          }
        : undefined,
      run.overwritten ?? [],
    );
  }

  /**
   * `sync:remove:sweep`: what a sweep asked with the removal of a run would
   * take, for the removal's confirmation to list before the user types the
   * org's name — per object, what the run's user created during the run that
   * the run did not write, a few of each by name, what could not be looked
   * at, and why a sweep would be refused. Read only.
   */
  private async handleSweepList(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      syncRemoveSweepPayloadSchema,
      msg,
      'sync:remove:sweep:error',
      this.deps,
    );
    if (!parsed) return;
    const refuse = (message: string, code: string): void =>
      sendHandlerError(
        this.deps,
        'sync:remove:sweep',
        'sync:remove:sweep:error',
        msg,
        new Error(message),
        { code },
      );
    try {
      const run = await this.runOf(parsed.runId);
      if (!run) {
        refuse('Nothing this run created is kept: there is nothing to sweep after.', 'NOT_KEPT');
        return;
      }
      if (!this.deps.orgManager.getOrg(run.targetOrgId)) {
        refuse(
          'The org the run wrote to is no longer connected: connect it again to remove the run.',
          'ORG_GONE',
        );
        return;
      }
      const listing = await new TimeoutManager(SWEEP_LIST_TIMEOUT_MS).withTimeout(
        'sync:remove:sweep',
        async () => {
          const conn = await getJsforceConnection(
            run.targetOrgId,
            this.deps.orgRegistry,
            this.deps.orgManager,
          );
          const input = await this.sweepInputOf(conn, run, 'sync:remove:sweep');
          return listSweep(removalOrg(conn, 'sync:remove:sweep'), input);
        },
      );
      this.deps.broker.postToWebview(
        buildResponse(this.deps, msg, 'sync:remove:sweep:response', {
          runId: run.runId,
          listing: listing as unknown as Record<string, unknown>,
        }),
      );
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'sync:remove:sweep', 'sync:remove:sweep:error', msg, err, {
        code: 'SWEEP_ERROR',
        retryable: true,
      });
    }
  }

  /**
   * The sweep of a run's removal: what the target's automation created
   * during the run, as its user, that the run did not write — Forge's sweep
   * (`sweepRunRecords`), judged by Production Guard as a delete before its
   * first one, recorded in the audit trail beside the removal as a
   * `cleanup_delete` with a `sweep` detail, whatever it ended on. It runs
   * before the run's records go, as a Seed run's does: a task the target's
   * automation hung under one of them would otherwise keep that record.
   */
  private async sweepBeforeRemoval(context: {
    conn: Parameters<typeof removalOrg>[0];
    run: SyncRunKept;
    /** What the sweep is told (`sweepInputOf`), read as the removal began, or why it could not be. */
    input: SweepInput | Error;
    includeChanged: boolean;
    signal: AbortSignal;
    guard: ProductionGuard;
    operationId: string;
  }): Promise<ForgeSweepResult> {
    const { conn, run, guard, input } = context;
    let guardDecision: GuardDecision | undefined;
    let result: ForgeSweepResult;
    try {
      if (input instanceof Error) throw input;
      result = await sweepRunRecords(removalOrg(conn, 'sync:remove sweep'), input, {
        includeChanged: context.includeChanged,
        removalSpans: run.removal?.removalSpans ?? [],
        approve: async (listing) => {
          const { check, decision } = await consultProductionGuard(guard, {
            orgId: run.targetOrgId,
            orgTier: this.tierOf(run.targetOrgId),
            operation: 'delete',
            objectName: sweepFoundObjects(listing).join(', '),
            recordCount: sweepFoundCount(listing),
            module: 'sync',
          });
          guardDecision = decision;
          if (decision === 'refused') {
            return `Operation blocked by Production Guard: ${check.blockedReason ?? check.impactSummary}`;
          }
          if (decision === 'declined') {
            return 'Operation cancelled by user (production confirmation declined).';
          }
          return undefined;
        },
      });
    } catch (err: unknown) {
      result = {
        status: 'failure',
        refusal: extractErrorMessage(err),
        objects: [],
        unread: [],
        handWork: [],
      };
    }
    const details = sweepAuditDetails(result, '');
    delete details.forgeId;
    recordWriteRun(this.deps, {
      action: 'cleanup_delete',
      module: 'sync',
      operationId: `${context.operationId}-sweep`,
      orgId: run.targetOrgId,
      outcome: result.status === 'refused' ? 'stopped' : result.status,
      ...(guardDecision ? { guard: guardDecision } : {}),
      ...(result.status === 'refused'
        ? { code: guardDecision ? 'GUARD_BLOCKED' : 'SWEEP_REFUSED' }
        : {}),
      objects: sweepAuditObjects(result),
      details: { ...details, runId: run.runId },
    });
    return result;
  }

  /** Answer a `sync:remove` that removes nothing, on its error channel. */
  private refuse(msg: InboundRequest, message: string, code: string, retryable = false): void {
    sendHandlerError(this.deps, 'sync:remove', 'sync:remove:error', msg, new Error(message), {
      code,
      ...(retryable ? { retryable } : {}),
    });
  }

  /** Record a removal that did not start, or failed, under the id of the request. */
  private recordNotRemoved(
    msg: InboundRequest,
    run: SyncRunKept,
    outcome: 'stopped' | 'failure',
    extra: { guard?: GuardDecision; code?: string } = {},
  ): void {
    recordWriteRun(this.deps, {
      action: 'cleanup_delete',
      module: 'sync',
      operationId: msg.id,
      orgId: run.targetOrgId,
      outcome,
      ...extra,
      details: { runId: run.runId },
    });
  }

  /**
   * `sync:remove`: refused before anything is read from the org when nothing
   * of the run is kept, the run is still writing, it left nothing to remove,
   * it is being removed now, or its org is gone; then Production Guard judges
   * the delete, and the removal runs.
   */
  private async handleRemove(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(syncRemovePayloadSchema, msg, 'sync:remove:error', this.deps);
    if (!parsed) return;
    const store = this.creations;
    if (!store) {
      this.refuse(
        msg,
        'What Sync runs created is not kept in this window yet.',
        'NOT_INITIALIZED',
        true,
      );
      return;
    }
    let run: SyncRunKept | undefined;
    try {
      run = await this.runOf(parsed.runId);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'sync:remove', 'sync:remove:error', msg, err, {
        code: 'REMOVE_ERROR',
        retryable: true,
      });
      return;
    }
    if (!run) {
      this.refuse(
        msg,
        'Nothing this run created is kept: it created nothing, or ran before runs kept what they created, or the record of it was dropped to make room.',
        'NOT_KEPT',
      );
      return;
    }
    if (this.isRunning(run.runId)) {
      this.refuse(msg, 'The run is still writing: remove it once it has ended.', 'RUNNING');
      return;
    }
    if (syncRemovalPlan(run).length === 0 && syncRestorePlan(run).length === 0) {
      const removedAt = run.removal?.undo?.removedAt ?? run.removal?.restoredAt;
      if (removedAt !== undefined) {
        this.refuse(
          msg,
          `What this run created was removed already, on ${removedAt}.`,
          'ALREADY_REMOVED',
        );
      } else {
        this.refuse(msg, 'This run created nothing to remove.', 'NOTHING_TO_REMOVE');
      }
      return;
    }
    if (!this.deps.orgManager.getOrg(run.targetOrgId)) {
      this.refuse(
        msg,
        'The org the run wrote to is no longer connected: connect it again to remove the run.',
        'ORG_GONE',
      );
      return;
    }
    if (this.removing.has(run.runId)) {
      this.refuse(msg, 'What this run created is being removed already.', 'DUPLICATE');
      return;
    }
    // Claimed before Production Guard is consulted: its confirmation waits on
    // a person, and a second click meanwhile would ask, and remove, twice.
    this.removing.add(run.runId);
    // Held as long, under the id the removal runs under: the card offers
    // Cancel as soon as it asks.
    const pending = this.registry?.holdUntilStart(msg.id);
    try {
      await this.removeRun(
        msg,
        store,
        run,
        { includeChanged: parsed.includeChanged === true, sweep: parsed.sweep === true },
        pending,
      );
    } finally {
      this.removing.delete(run.runId);
      pending?.release();
    }
  }

  /** The removal once the request names a run whose creations can be removed. */
  private async removeRun(
    msg: InboundRequest,
    store: SyncRunCreations,
    run: SyncRunKept,
    asked: { includeChanged: boolean; sweep: boolean },
    pending: PendingStart | undefined,
  ): Promise<void> {
    const { includeChanged } = asked;
    const plan = syncRemovalPlan(run);
    const back = syncRestorePlan(run);
    const total = plan.reduce((sum, object) => sum + object.ids.length, 0);
    const totalBack = back.reduce((sum, object) => sum + object.ids.length, 0);
    const orgId = run.targetOrgId;

    // Production Guard judges the delete before anything is read, as on every
    // write path; without it nothing is deleted.
    const guard = this.deps.infraServices?.productionGuard;
    if (!guard) {
      this.recordNotRemoved(msg, run, 'stopped', { code: PRODUCTION_GUARD_MISSING.code });
      this.refuse(msg, PRODUCTION_GUARD_MISSING.message, PRODUCTION_GUARD_MISSING.code);
      return;
    }
    const { check, decision } = await consultProductionGuard(
      guard,
      this.guardRequestOf(run, plan, back),
    );
    if (decision === 'refused' || decision === 'declined') {
      this.recordNotRemoved(msg, run, 'stopped', { guard: decision });
      if (decision === 'refused') {
        this.refuse(
          msg,
          `Operation blocked by Production Guard: ${check.blockedReason ?? check.impactSummary}`,
          GUARD_REFUSAL.blocked,
        );
      } else {
        this.refuse(
          msg,
          'Operation cancelled by user (production confirmation declined).',
          GUARD_REFUSAL.declined,
          true,
        );
      }
      return;
    }
    // The card's Cancel came while the guard asked: the removal does not start.
    if (pending?.signal.aborted) {
      this.recordNotRemoved(msg, run, 'stopped', { guard: decision, code: ABORTED_BEFORE_START });
      const result: SyncRemovalResult = {
        runId: run.runId,
        status: 'cancelled',
        includeChanged,
        objects: [],
        finishedAt: new Date().toISOString(),
      };
      this.deps.broker.postToWebview(
        buildResponse(this.deps, msg, 'sync:remove:response', {
          result: result as unknown as Record<string, unknown>,
          operationId: msg.id,
        }),
      );
      return;
    }

    const operationId = msg.id;
    const description =
      totalBack > 0
        ? `Removing ${total} record(s) and file(s) a Sync run created, and giving ${totalBack} ` +
          'record(s) it wrote over their values back'
        : `Removing ${total} record(s) and file(s) a Sync run created`;
    const abortController = new AbortController();
    let settle: (err?: unknown) => void = () => {};
    const tracked = new Promise<void>((resolve, reject) => {
      settle = (err) => (err === undefined ? resolve() : reject(err));
    });
    // The registry attaches its own handlers; this only prevents an unhandled
    // rejection when no registry has been injected.
    tracked.catch(() => {});
    sendOperationStarted(this.deps, operationId, 'sync', description);
    this.registry?.register(operationId, 'sync', description, tracked, abortController);
    this.liveTracker?.register(operationId, 'sync', description, total + totalBack);
    /** What the removal failed on, so the registry lists it as failed. */
    let runError: unknown;

    try {
      const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
      // What the sweep is told is read before the removal writes anything:
      // the records a run that created nothing wrote over tell the user it
      // wrote as, and once their values are put back they no longer do.
      const sweepInput = asked.sweep
        ? await this.sweepInputOf(conn, run, 'sync:remove sweep', abortController.signal).catch(
            (err: unknown) => new Error(extractErrorMessage(err)),
          )
        : undefined;
      // Made by the removal once it has read the run's records: a child the
      // sweep deletes under one of them restamps that record when a roll-up
      // counts it, which read afterwards was a change since the run.
      const sweepMade: { result?: ForgeSweepResult } = {};
      const sweepFirst = sweepInput
        ? async (): Promise<boolean> => {
            sweepMade.result = await this.sweepBeforeRemoval({
              conn,
              run,
              input: sweepInput,
              includeChanged,
              signal: abortController.signal,
              guard,
              operationId,
            });
            return sweepMade.result.objects.some((object) => object.deleted > 0);
          }
        : undefined;
      const { result: removed, notes } = await removeSyncRun({
        run,
        org: removalOrg(conn, 'sync:remove'),
        includeChanged,
        store,
        configs: this.configs,
        // What it took leaves the configuration's pairs, kept beside the runs.
        links: store.idMap(),
        // What the run wrote over gets back the values it kept of them.
        ...(this.backups ? { backups: this.backups } : {}),
        ...(sweepFirst ? { sweep: sweepFirst } : {}),
        signal: abortController.signal,
        onProgress: (settled, of, objectApiName) => {
          const percent = Math.min(100, Math.round((settled / Math.max(of, 1)) * 100));
          sendOperationProgress(this.deps, operationId, percent, settled, of, objectApiName);
          // A removal cancelled from Live Operations finishes its call to the
          // org; the registry has recorded the stop and hears no more of it.
          if (!abortController.signal.aborted) this.registry?.updateProgress(operationId, percent);
          this.liveTracker?.updateProgress(operationId, percent, settled, of, objectApiName);
        },
      });
      for (const note of notes) this.deps.log(`[WARN] sync:remove ${operationId}: ${note}`);
      const result: SyncRemovalResult = sweepMade.result
        ? { ...removed, sweep: sweepMade.result }
        : removed;

      recordWriteRun(this.deps, {
        action: 'cleanup_delete',
        module: 'sync',
        operationId,
        orgId,
        outcome: removalAuditOutcome(result),
        guard: decision,
        objects: withRestoreAudit(removalAuditObjects(result.objects), result.restored ?? []),
        ...(result.leftBy ? { leftBy: result.leftBy } : {}),
        details: { runId: run.runId },
      });

      const response = buildResponse(this.deps, msg, 'sync:remove:response', {
        result: result as unknown as Record<string, unknown>,
        operationId,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id} status=${result.status}`);
      if (result.status === 'cancelled' || result.sweep?.status === 'cancelled') {
        sendOperationCompleted(this.deps, operationId, { aborted: true });
        this.liveTracker?.cancel(operationId);
      } else {
        sendOperationCompleted(this.deps, operationId, { status: result.status });
        if (result.status === 'failure') {
          runError = new Error('Nothing this run created could be removed.');
          this.liveTracker?.fail(operationId, 'Nothing this run created could be removed.');
        } else {
          this.liveTracker?.complete(operationId);
        }
      }
    } catch (error: unknown) {
      runError = error;
      this.recordNotRemoved(msg, run, 'failure', { guard: decision });
      sendHandlerError(this.deps, 'sync:remove', 'sync:remove:error', msg, error, {
        code: 'REMOVE_ERROR',
        retryable: true,
      });
      sendOperationCompleted(this.deps, operationId, { status: 'failure' });
      this.liveTracker?.fail(operationId, extractErrorMessage(error));
    } finally {
      settle(runError);
    }
  }
}
