import type { GuardDecision, SyncRemovalResult, SyncRunRemovalInfo } from '@sandforge/shared';
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
} from '../validatePayload.js';
import { idLists, isRecordId } from '../../modules/dataops/RecordRemoval.js';
import { earlierCopiesOf } from '../../modules/sync/syncEarlierCopies.js';
import type {
  BackgroundOperationRegistry,
  PendingStart,
} from '../../core/engine/BackgroundOperationRegistry.js';
import type { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import { consultProductionGuard } from '../../core/precheck/consultProductionGuard.js';
import type { SafetyTier } from '../../core/precheck/ProductionGuard.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { recordWriteRun } from '../../modules/audit/auditTrail.js';
import { removalOrg } from '../../modules/forge/ForgeRunRemoval.js';
import { removalAuditObjects, removalAuditOutcome } from '../../modules/forge/removalOutcome.js';
import { SyncConfigStore } from '../../modules/sync/SyncConfigStore.js';
import type { SyncHistoryStore } from '../../modules/sync/SyncHistoryStore.js';
import {
  createdCount,
  syncRemovalPlan,
  type SyncRunCreations,
  type SyncRunKept,
} from '../../modules/sync/SyncRunCreations.js';
import { removeSyncRun } from '../../modules/sync/SyncRunRemoval.js';

/** Message types handled by SyncRemovalHandler. */
const SYNC_REMOVAL_TYPES = new Set([
  'sync:removal:info',
  'sync:removal:list',
  'sync:remove',
  'sync:earlier-copies',
]);

/**
 * The removal of what a Sync run created, and what the page reads before it
 * asks for one.
 *
 * - `sync:removal:info` — what a run kept, what a removal would take, and why
 *   none can run when none can: read from what the run kept, nothing asked of
 *   the org.
 * - `sync:removal:list` — the runs whose creations are kept that no history
 *   entry holds: a run a closed window stopped before it ended, or one the
 *   history no longer lists. Removable all the same.
 * - `sync:remove` — the removal itself: Forge's, on what the run kept (see
 *   `SyncRunRemoval`), judged by Production Guard as the delete it is, at the
 *   tier Forge's and Frozen's removals take the target for — a production org
 *   is refused, a Developer Edition is not — run on the registry and in Live
 *   Operations under the id of the request, where Cancel stops it between two
 *   calls to the org, and recorded in the audit trail whatever its outcome.
 */
export class SyncRemovalHandler implements DomainHandler {
  private creations?: SyncRunCreations;
  private registry?: BackgroundOperationRegistry;
  private liveTracker?: LiveOperationTracker;
  /** The runs being removed now: one removal at a time each. */
  private readonly removing = new Set<string>();
  private readonly configs: SyncConfigStore;

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

  /** The registry a removal runs on, where Live Operations' Cancel reaches it. */
  setRegistry(registry: BackgroundOperationRegistry): void {
    this.registry = registry;
  }

  /** The Monitor's live operations, which list a removal while it runs. */
  setLiveOperationTracker(tracker: LiveOperationTracker): void {
    this.liveTracker = tracker;
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
    const info: SyncRunRemovalInfo = {
      runId: run.runId,
      configId: run.configId,
      configName: run.configName,
      sourceOrgId: run.sourceOrgId,
      targetOrgId: run.targetOrgId,
      startedAt: run.startedAt,
      ...(run.end ? { endedAt: run.end.at } : {}),
      created: createdCount(run),
      left,
      ...(run.removal?.undo ? { removed: run.removal.undo } : {}),
    };
    if (plan.length === 0) return info;
    const refusal = this.refusalOf(
      run,
      plan.reduce((sum, o) => sum + o.ids.length, 0),
      plan,
    );
    return refusal ? { ...info, refusal } : info;
  }

  /**
   * Why a removal of the run cannot run now, before anything is asked of the
   * org: offered, it would only be refused.
   */
  private refusalOf(
    run: SyncRunKept,
    total: number,
    plan: ReadonlyArray<{ objectApiName: string }>,
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
    const check = guard.check({
      orgId: run.targetOrgId,
      orgTier: this.tierOf(run.targetOrgId),
      operation: 'delete',
      objectName: plan.map((o) => o.objectApiName).join(', '),
      recordCount: total,
      module: 'sync',
    });
    return check.allowed
      ? undefined
      : { code: 'GUARD_BLOCKED', message: check.blockedReason ?? check.impactSummary };
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
      const run = await this.creations?.get(parsed.runId);
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
      const runs = (await this.creations?.list()) ?? [];
      const unlisted = runs.filter((run) => !listed.has(run.runId) && !this.isRunning(run.runId));
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
      run = await store.get(parsed.runId);
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
    // Held as long, under the id the removal runs under: the card offers
    // Cancel as soon as it asks.
    const pending = this.registry?.holdUntilStart(msg.id);
    try {
      await this.removeRun(msg, store, run, parsed.includeChanged === true, pending);
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
    includeChanged: boolean,
    pending: PendingStart | undefined,
  ): Promise<void> {
    const plan = syncRemovalPlan(run);
    const total = plan.reduce((sum, object) => sum + object.ids.length, 0);
    const orgId = run.targetOrgId;

    // Production Guard judges the delete before anything is read, as on every
    // write path; without it nothing is deleted.
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
      module: 'sync',
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
    const description = `Removing ${total} record(s) and file(s) a Sync run created`;
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
    this.liveTracker?.register(operationId, 'sync', description, total);
    /** What the removal failed on, so the registry lists it as failed. */
    let runError: unknown;

    try {
      const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
      const { result, notes } = await removeSyncRun({
        run,
        org: removalOrg(conn, 'sync:remove'),
        includeChanged,
        store,
        configs: this.configs,
        // What it took leaves the configuration's pairs, kept beside the runs.
        links: store.idMap(),
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

      recordWriteRun(this.deps, {
        action: 'cleanup_delete',
        module: 'sync',
        operationId,
        orgId,
        outcome: removalAuditOutcome(result),
        guard: decision,
        objects: removalAuditObjects(result.objects),
        ...(result.leftBy ? { leftBy: result.leftBy } : {}),
        details: { runId: run.runId },
      });

      const response = buildResponse(this.deps, msg, 'sync:remove:response', {
        result: result as unknown as Record<string, unknown>,
        operationId,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id} status=${result.status}`);
      if (result.status === 'cancelled') {
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
