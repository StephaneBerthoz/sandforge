import type {
  ForgeSweepResult,
  ForgeTargetAutomation,
  GuardDecision,
  SeedRemovalResult,
  SeedRunRemovalInfo,
} from '@sandforge/shared';
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
  seedRemovalInfoPayloadSchema,
  seedRemovePayloadSchema,
  seedRemoveSweepPayloadSchema,
} from '../validatePayload.js';
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
import { forgeTargetTier } from '../../modules/forge/ForgeRunGate.js';
import {
  createdCount,
  syncRemovalPlan,
  type SyncRunKept,
} from '../../modules/sync/SyncRunCreations.js';
import { removeSyncRun } from '../../modules/sync/SyncRunRemoval.js';
import type { SeedRunCreations } from '../../modules/seed/SeedRunCreations.js';
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

/** Message types handled by SeedRemovalHandler. */
const SEED_REMOVAL_TYPES = new Set([
  'seed:removal:info',
  'seed:removal:list',
  'seed:remove',
  'seed:remove:sweep',
]);

/** How long the read of what the target's flows create may take, for a sweep: as Forge's. */
const SWEEP_AUTOMATION_TIMEOUT_MS = 60_000;

/** How long listing what a sweep would take may take: the automation read, then one read per object. */
const SWEEP_LIST_TIMEOUT_MS = 120_000;

/**
 * The removal of what a Seed run created, from the run's results or the list
 * of earlier seeds, and what the page reads before it asks for one. The
 * command line has had it since a run's summary could be taken back
 * (`sandforge-seed --remove`); the panel offered none, and a seed written into
 * an org from it stayed there.
 *
 * - `seed:removal:info` — what the run kept, what a removal would take, and
 *   why none can run when none can: read from what the extension kept,
 *   nothing asked of the org.
 * - `seed:removal:list` — the same for every run kept, newest first: the runs
 *   of earlier windows, which a reload left removable.
 * - `seed:remove:sweep` — what a sweep asked with the removal would take,
 *   read only, for the confirmation to list (`listSweep`).
 * - `seed:remove` — the removal itself, its sweep first when asked: the one
 *   the command line runs
 *   (`removeSyncRun`, Forge's), judged by Production Guard as the delete it
 *   is, at the tier Forge's, Frozen's and Sync's removals take the target for
 *   — a production org is refused, a Developer Edition is not — run on the
 *   registry and in Live Operations under the id of the request, where Cancel
 *   stops it between two calls to the org, and recorded in the audit trail
 *   whatever its outcome.
 */
export class SeedRemovalHandler implements DomainHandler {
  private creations?: SeedRunCreations;
  private registry?: BackgroundOperationRegistry;
  private liveTracker?: LiveOperationTracker;
  /** Reads what the target's flows create, for a sweep: Forge's reader. */
  private targetAutomation?: Pick<TargetAutomationReader, 'read'>;
  /** The runs being removed now: one removal at a time each. */
  private readonly removing = new Set<string>();

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {}

  /** Where the Seed runs keep what they created. */
  setRunCreations(store: SeedRunCreations): void {
    this.creations = store;
  }

  /**
   * What reads the target's automation — Forge's, which its sweep reads too:
   * the objects the target's flows create as a run's records are written,
   * which the sweep of a run's removal looks at.
   */
  setTargetAutomation(reader: Pick<TargetAutomationReader, 'read'>): void {
    this.targetAutomation = reader;
  }

  /** The registry a removal runs on, where Live Operations' Cancel reaches it. */
  setRegistry(registry: BackgroundOperationRegistry): void {
    this.registry = registry;
  }

  /** The Monitor's live operations, which list a removal while it runs. */
  setLiveOperationTracker(tracker: LiveOperationTracker): void {
    this.liveTracker = tracker;
  }

  async handle(msg: InboundRequest): Promise<boolean> {
    if (!SEED_REMOVAL_TYPES.has(msg.type)) return false;
    if (msg.type === 'seed:removal:info') await this.handleInfo(msg);
    else if (msg.type === 'seed:removal:list') await this.handleList(msg);
    else if (msg.type === 'seed:remove:sweep') await this.handleSweepList(msg);
    else await this.handleRemove(msg);
    return true;
  }

  /** The tier a removal takes the target for: a Forge removal's (`forgeTargetTier`). */
  private tierOf(targetOrgId: string): SafetyTier {
    const org = this.deps.orgManager.getOrg(targetOrgId);
    return forgeTargetTier(org?.orgType ?? '', org?.metadata?.edition);
  }

  /** What a run kept, as the page reads it, and why no removal can run when none can. */
  private infoOf(run: SyncRunKept): SeedRunRemovalInfo {
    const plan = syncRemovalPlan(run);
    const info: SeedRunRemovalInfo = {
      runId: run.runId,
      targetOrgId: run.targetOrgId,
      startedAt: run.startedAt,
      endedAt: run.end?.at ?? run.startedAt,
      created: createdCount(run),
      left: plan.map(({ objectApiName, ids }) => ({ objectApiName, count: ids.length })),
      ...(run.removal?.undo ? { removed: run.removal.undo } : {}),
    };
    if (plan.length === 0) return info;
    const refusal = this.refusalOf(run, plan);
    return refusal ? { ...info, refusal } : info;
  }

  /** Why a removal of the run cannot run now, before anything is asked of the org. */
  private refusalOf(
    run: SyncRunKept,
    plan: ReadonlyArray<{ objectApiName: string; ids: readonly string[] }>,
  ): SeedRunRemovalInfo['refusal'] {
    if (!this.deps.orgManager.getOrg(run.targetOrgId)) {
      return {
        code: 'ORG_GONE',
        message:
          'The org the run wrote to is no longer connected: connect it again to remove the run.',
      };
    }
    const guard = this.deps.infraServices?.productionGuard;
    if (!guard) return { code: 'NO_GUARD', message: PRODUCTION_GUARD_MISSING.message };
    const check = guard.check({
      orgId: run.targetOrgId,
      orgTier: this.tierOf(run.targetOrgId),
      operation: 'delete',
      objectName: plan.map((o) => o.objectApiName).join(', '),
      recordCount: plan.reduce((sum, o) => sum + o.ids.length, 0),
      module: 'seed',
    });
    return check.allowed
      ? undefined
      : { code: 'GUARD_BLOCKED', message: check.blockedReason ?? check.impactSummary };
  }

  private async handleInfo(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      seedRemovalInfoPayloadSchema,
      msg,
      'seed:remove:error',
      this.deps,
    );
    if (!parsed) return;
    try {
      const run = await this.creations?.get(parsed.runId);
      const response = buildResponse(this.deps, msg, 'seed:removal:info:response', {
        info: run ? (this.infoOf(run) as unknown as Record<string, unknown>) : null,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'seed:removal:info', 'seed:remove:error', msg, err);
    }
  }

  /**
   * `seed:removal:list`: every run kept, newest first, as `seed:removal:info`
   * reads one — the history of the seeds a reload left removable, and of those
   * removed already.
   */
  private async handleList(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    try {
      const runs = (await this.creations?.list()) ?? [];
      const response = buildResponse(this.deps, msg, 'seed:removal:list:response', {
        runs: runs.map((run) => this.infoOf(run)) as unknown as Record<string, unknown>[],
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id} runs=${runs.length}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'seed:removal:list', 'seed:remove:error', msg, err);
    }
  }

  /**
   * What a sweep of a run is told: the run's records read back from the org
   * for its window, and what the target's flows create, read now.
   */
  private async sweepInputOf(
    conn: Parameters<typeof removalOrg>[0],
    run: SyncRunKept,
    context: string,
    signal?: AbortSignal,
  ): Promise<SweepInput> {
    const reader = this.targetAutomation;
    let automation: ForgeTargetAutomation | { error: string };
    if (!reader) {
      automation = { error: 'Target automation reader not configured' };
    } else {
      try {
        automation = await new TimeoutManager(SWEEP_AUTOMATION_TIMEOUT_MS).withTimeout(
          `${context} automation`,
          () =>
            reader.read(
              run.targetOrgId,
              run.created.map((object) => object.objectApiName),
            ),
        );
      } catch (err: unknown) {
        automation = { error: extractErrorMessage(err) };
      }
    }
    return seedSweepInput(removalOrg(conn, context), run.created, automation, signal);
  }

  /**
   * `seed:remove:sweep`: what a sweep asked with the removal of a run would
   * take, for the removal's confirmation to list before the user types the
   * org's name — per object, what the run's user created during the run that
   * the run did not write, a few of each by name, what could not be looked
   * at, and why a sweep would be refused. Read only.
   */
  private async handleSweepList(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      seedRemoveSweepPayloadSchema,
      msg,
      'seed:remove:sweep:error',
      this.deps,
    );
    if (!parsed) return;
    const refuse = (message: string, code: string): void =>
      sendHandlerError(
        this.deps,
        'seed:remove:sweep',
        'seed:remove:sweep:error',
        msg,
        new Error(message),
        { code },
      );
    try {
      const run = await this.creations?.get(parsed.runId);
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
        'seed:remove:sweep',
        async () => {
          const conn = await getJsforceConnection(
            run.targetOrgId,
            this.deps.orgRegistry,
            this.deps.orgManager,
          );
          const input = await this.sweepInputOf(conn, run, 'seed:remove:sweep');
          return listSweep(removalOrg(conn, 'seed:remove:sweep'), input);
        },
      );
      this.deps.broker.postToWebview(
        buildResponse(this.deps, msg, 'seed:remove:sweep:response', {
          runId: run.runId,
          listing: listing as unknown as Record<string, unknown>,
        }),
      );
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'seed:remove:sweep', 'seed:remove:sweep:error', msg, err, {
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
   * before the run's records go, as a Frozen load's does: a task the target's
   * automation hung under one of them would otherwise keep that record.
   */
  private async sweepBeforeRemoval(context: {
    conn: Parameters<typeof removalOrg>[0];
    run: SyncRunKept;
    includeChanged: boolean;
    signal: AbortSignal;
    guard: ProductionGuard;
    operationId: string;
  }): Promise<ForgeSweepResult> {
    const { conn, run, guard } = context;
    let guardDecision: GuardDecision | undefined;
    let result: ForgeSweepResult;
    try {
      const input = await this.sweepInputOf(conn, run, 'seed:remove sweep', context.signal);
      result = await sweepRunRecords(removalOrg(conn, 'seed:remove sweep'), input, {
        includeChanged: context.includeChanged,
        removalSpans: run.removal?.removalSpans ?? [],
        approve: async (listing) => {
          const { check, decision } = await consultProductionGuard(guard, {
            orgId: run.targetOrgId,
            orgTier: this.tierOf(run.targetOrgId),
            operation: 'delete',
            objectName: sweepFoundObjects(listing).join(', '),
            recordCount: sweepFoundCount(listing),
            module: 'seed',
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
      module: 'seed',
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

  /** Answer a `seed:remove` that removes nothing, on its error channel. */
  private refuse(msg: InboundRequest, message: string, code: string, retryable = false): void {
    sendHandlerError(this.deps, 'seed:remove', 'seed:remove:error', msg, new Error(message), {
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
      module: 'seed',
      operationId: msg.id,
      orgId: run.targetOrgId,
      outcome,
      ...extra,
      details: { runId: run.runId },
    });
  }

  /**
   * `seed:remove`: refused before anything is read from the org when nothing
   * of the run is kept, it left nothing to remove, it is being removed now,
   * or its org is gone; then Production Guard judges the delete, and the
   * removal runs.
   */
  private async handleRemove(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(seedRemovePayloadSchema, msg, 'seed:remove:error', this.deps);
    if (!parsed) return;
    const store = this.creations;
    const run = await store?.get(parsed.runId);
    if (!store || !run) {
      this.refuse(
        msg,
        'Nothing this run created is kept: it created nothing, or was dropped to make room ' +
          'for newer seeds.',
        'NOT_KEPT',
      );
      return;
    }
    if (syncRemovalPlan(run).length === 0) {
      if (run.removal?.undo) {
        this.refuse(
          msg,
          `What this run created was removed already, on ${run.removal.undo.removedAt}.`,
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

  /** The removal once the request names a run whose records can be removed. */
  private async removeRun(
    msg: InboundRequest,
    store: SeedRunCreations,
    run: SyncRunKept,
    asked: { includeChanged: boolean; sweep: boolean },
    pending: PendingStart | undefined,
  ): Promise<void> {
    const { includeChanged } = asked;
    const plan = syncRemovalPlan(run);
    const total = plan.reduce((sum, object) => sum + object.ids.length, 0);
    const orgId = run.targetOrgId;

    const guard = this.deps.infraServices?.productionGuard;
    if (!guard) {
      this.recordNotRemoved(msg, run, 'stopped', { code: PRODUCTION_GUARD_MISSING.code });
      this.refuse(msg, PRODUCTION_GUARD_MISSING.message, PRODUCTION_GUARD_MISSING.code);
      return;
    }
    const { check, decision } = await consultProductionGuard(guard, {
      orgId,
      orgTier: this.tierOf(orgId),
      operation: 'delete',
      objectName: plan.map((o) => o.objectApiName).join(', '),
      recordCount: total,
      module: 'seed',
    });
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
      const result: SeedRemovalResult = {
        runId: run.runId,
        status: 'cancelled',
        includeChanged,
        objects: [],
        finishedAt: new Date().toISOString(),
      };
      this.deps.broker.postToWebview(
        buildResponse(this.deps, msg, 'seed:remove:response', {
          result: result as unknown as Record<string, unknown>,
          operationId: msg.id,
        }),
      );
      return;
    }

    const operationId = msg.id;
    const description = `Removing ${total} record(s) a Seed run created`;
    const abortController = new AbortController();
    let settle: (err?: unknown) => void = () => {};
    const tracked = new Promise<void>((resolve, reject) => {
      settle = (err) => (err === undefined ? resolve() : reject(err));
    });
    // The registry attaches its own handlers; this only prevents an unhandled
    // rejection when no registry has been injected.
    tracked.catch(() => {});
    sendOperationStarted(this.deps, operationId, 'seed', description);
    this.registry?.register(operationId, 'seed', description, tracked, abortController);
    this.liveTracker?.register(operationId, 'seed', description, total);
    /** What the removal failed on, so the registry lists it as failed. */
    let runError: unknown;

    try {
      const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
      // Made by the removal once it has read the run's records: a child the
      // sweep deletes under one of them restamps that record when a roll-up
      // counts it, which read afterwards was a change since the run.
      const sweepMade: { result?: ForgeSweepResult } = {};
      const sweepFirst = asked.sweep
        ? async (): Promise<boolean> => {
            sweepMade.result = await this.sweepBeforeRemoval({
              conn,
              run,
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
        org: removalOrg(conn, 'seed:remove'),
        includeChanged,
        store,
        ...(sweepFirst ? { sweep: sweepFirst } : {}),
        signal: abortController.signal,
        onProgress: (settled, of, objectApiName) => {
          const percent = Math.min(100, Math.round((settled / Math.max(of, 1)) * 100));
          sendOperationProgress(this.deps, operationId, percent, settled, of, objectApiName);
          if (!abortController.signal.aborted) this.registry?.updateProgress(operationId, percent);
          this.liveTracker?.updateProgress(operationId, percent, settled, of, objectApiName);
        },
      });
      for (const note of notes) this.deps.log(`[WARN] seed:remove ${operationId}: ${note}`);
      const result: SeedRemovalResult = {
        runId: removed.runId,
        status: removed.status,
        includeChanged: removed.includeChanged,
        objects: removed.objects,
        finishedAt: removed.finishedAt,
        ...(removed.leftBy ? { leftBy: removed.leftBy } : {}),
        ...(sweepMade.result ? { sweep: sweepMade.result } : {}),
      };

      recordWriteRun(this.deps, {
        action: 'cleanup_delete',
        module: 'seed',
        operationId,
        orgId,
        outcome: removalAuditOutcome(result),
        guard: decision,
        objects: removalAuditObjects(result.objects),
        ...(result.leftBy ? { leftBy: result.leftBy } : {}),
        details: { runId: run.runId },
      });

      const response = buildResponse(this.deps, msg, 'seed:remove:response', {
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
      sendHandlerError(this.deps, 'seed:remove', 'seed:remove:error', msg, error, {
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
