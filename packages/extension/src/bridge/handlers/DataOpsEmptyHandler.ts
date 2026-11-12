import type {
  AuditObjectCounts,
  AuditOutcome,
  DataOpsEmptyPreviewKept,
  DataOpsEmptyRefusal,
  DataOpsEmptyRunResult,
  DataOpsEmptyUndoResult,
  GuardDecision,
  MutedAutomation,
} from '@sandforge/shared';
import { auditMutedOf, guardTierOf } from '@sandforge/shared';
import * as z from 'zod';
import type { Connection } from 'jsforce';

import type { DomainHandler, HandlerDeps, InboundRequest } from './HandlerTypes.js';
import {
  buildResponse,
  PRODUCTION_GUARD_MISSING,
  sendHandlerError,
  sendOperationCompleted,
  sendOperationProgress,
  sendOperationStarted,
} from './HandlerTypes.js';
import { listLive } from './liveRun.js';
import {
  dataOpsEmptyCancelPayloadSchema,
  dataOpsEmptyPreviewPayloadSchema,
  dataOpsEmptyRunPayloadSchema,
  dataOpsEmptyScopePayloadSchema,
  dataOpsEmptyUndoPayloadSchema,
  validatePayload,
} from '../validatePayload.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { consultProductionGuard } from '../../core/precheck/consultProductionGuard.js';
import { TimeoutManager } from '../../core/engine/TimeoutManager.js';
import { emptyCounts, recordWriteRun } from '../../modules/audit/auditTrail.js';
import type { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import type { TargetAutomationReader } from '../../modules/forge/TargetAutomationReader.js';
import type { MuteLeaseOptions } from '../../modules/forge/AutomationMuteLease.js';
import type { BeforeRunCheckpoints } from '../../modules/checkpoint/beforeRunCheckpoint.js';
import {
  defaultCheckpointStoreRoot,
  openCheckpointStore,
  type OrgLockOutcome,
} from '../../modules/checkpoint/OrgCheckpointStore.js';
import { globalObjectSchema } from '../../modules/checkpoint/checkpointScope.js';
import { dataOpsAutomationOrgOf, dataOpsVoiceOf } from '../../modules/dataops/dataOpsAutomation.js';
import {
  previewEmptyAct,
  runEmptyAct,
  undoEmptyAct,
  type EmptyActContext,
  type EmptyKeptPreview,
} from '../../modules/dataops/empty/emptyAct.js';
import { guardEmpty } from '../../modules/dataops/empty/emptyGuard.js';
import { defaultEmptyRoot, EmptyJournalStore } from '../../modules/dataops/empty/emptyJournal.js';
import { emptyOrgOf, type EmptyOrg } from '../../modules/dataops/empty/emptyOrg.js';
import { emptyScopeOf } from '../../modules/dataops/empty/emptyScope.js';

/** How long the read of what the org runs may take: Seed's, Forge's and a cleanup's bound. */
const AUTOMATION_TIMEOUT_MS = 60_000;

/** Previews kept for a run to act on: the last few of the window. */
const PREVIEWS_KEPT = 20;

/** How long a preview is acted on: past it, the run asks for a fresh one. */
const PREVIEW_KEPT_MS = 60 * 60_000;

/** The module the audit trail, the registry and Live Operations name it by. */
const MODULE = 'dataops';

/** Message types handled by DataOpsEmptyHandler. */
const EMPTY_TYPES = new Set([
  'dataops:empty:scope',
  'dataops:empty:preview',
  'dataops:empty:run',
  'dataops:empty:cancel',
  'dataops:empty:undo',
]);

/** What else of this machine writes to an org, as a refusal names it; nothing when none does. */
export type EmptyRunWriting = (
  orgId: string,
  orgName: string,
  operationId: string,
) => (organizationId: string) => Promise<string | undefined>;

/** The stores an emptying keeps its journals in, and takes the org's lock from. */
export interface EmptyStores {
  journals: EmptyJournalStore;
  lock: (organizationId: string) => OrgLockOutcome;
}

/** A refusal said on the error channel, under its code, every other one beside it. */
class EmptyRefused extends Error {
  constructor(
    readonly refusal: DataOpsEmptyRefusal,
    readonly alsoRefused: readonly DataOpsEmptyRefusal[] = [],
    readonly mutedAutomation?: MutedAutomation,
  ) {
    super(refusal.message);
    this.name = 'EmptyRefused';
  }
}

/** The audit trail's counts of a run's passes. */
function runAuditObjects(result: DataOpsEmptyRunResult): AuditObjectCounts[] {
  return result.passes
    .filter((pass) => pass.deleted + pass.refused + (pass.notReached ?? 0) > 0)
    .map((pass) => ({
      ...emptyCounts(pass.objectApiName),
      deleted: pass.deleted,
      failed: pass.refused,
      ...((pass.notReached ?? 0) > 0 ? { notSent: pass.notReached } : {}),
    }));
}

/** The audit trail's counts of an undo: what came back counted as created, as a restore's. */
function undoAuditObjects(result: DataOpsEmptyUndoResult): AuditObjectCounts[] {
  return result.objects
    .filter(
      (object) => object.undeleted + object.notInBin + object.othersDeletion + object.refused > 0,
    )
    .map((object) => ({
      ...emptyCounts(object.objectApiName),
      created: object.undeleted,
      failed: object.notInBin + object.othersDeletion + object.refused,
      ...((object.notReached ?? 0) > 0 ? { notSent: object.notReached } : {}),
    }));
}

/** A dry run as the page reads it: what the run acts on beside it stays in the window. */
function keptForPage(kept: EmptyKeptPreview): DataOpsEmptyPreviewKept {
  return {
    previewId: kept.previewId,
    readAt: kept.readAt,
    orgName: kept.orgName,
    tier: kept.tier,
    preview: kept.preview,
    access: kept.access,
    hardDelete: kept.hardDelete,
    peopleActive: kept.peopleActive,
    ...(kept.checkpoint ? { checkpoint: kept.checkpoint } : {}),
    ...(kept.openRun ? { openRun: kept.openRun } : {}),
  };
}

/** An act's end, as the audit trail records it. */
function auditOutcomeOf(status: DataOpsEmptyRunResult['status']): AuditOutcome {
  return status;
}

/**
 * Emptying objects, or the whole org, from DataOps Cleanup: the scope, the
 * dry run, the run, a stop, and the undo (`emptyAct.ts`).
 *
 * The dry run is kept in the window under its id for the run to act on, an
 * hour at most: a run is never sent on a preview the page did not show. A
 * run and an undo are listed in the registry and in Live Operations, whose
 * Cancel — and `dataops:empty:cancel` — stops them before their next call or
 * job, and recorded in the audit trail as `cleanup_delete`, their details
 * saying an emptying (`empty`) and which act. A refusal comes on
 * `dataops:error` under its code, every other one beside it (`alsoRefused`).
 */
export class DataOpsEmptyHandler implements DomainHandler {
  private liveTracker?: LiveOperationTracker;
  private readonly previews = new Map<
    string,
    { orgId: string; kept: EmptyKeptPreview; at: number }
  >();
  /** The acts under way, by their operation id: what a cancel stops. */
  private readonly running = new Map<string, AbortController>();
  private targetAutomation?: Pick<TargetAutomationReader, 'read'>;
  private reader?: Promise<TargetAutomationReader>;
  private muteLeases: MuteLeaseOptions = {};
  private checkpoints?: Pick<BeforeRunCheckpoints, 'scope' | 'take' | 'settle'>;
  private runWriting?: EmptyRunWriting;
  private stores?: EmptyStores;
  private orgOf: (conn: Connection, orgId: string) => EmptyOrg = (conn, orgId) =>
    emptyOrgOf(conn, orgId, 'dataops:empty');

  constructor(private readonly deps: HandlerDeps) {}

  /** Inject the tracker the Monitor's Live Operations lists runs from. */
  setLiveOperationTracker(tracker: LiveOperationTracker): void {
    this.liveTracker = tracker;
  }

  /** Another reader of what the org runs than the handler's own. */
  setTargetAutomation(reader: Pick<TargetAutomationReader, 'read'>): void {
    this.targetAutomation = reader;
  }

  /** Where and how a run that mutes keeps its lease, in place of the home directory's. */
  setMuteLeases(options: MuteLeaseOptions): void {
    this.muteLeases = options;
  }

  /** The window's checkpoints before a run: what Checkpoint first takes. */
  setBeforeRunCheckpoints(
    checkpoints: Pick<BeforeRunCheckpoints, 'scope' | 'take' | 'settle'>,
  ): void {
    this.checkpoints = checkpoints;
  }

  /** What else of this machine writes to an org, as the checkpoints read it. */
  setRunWriting(runWriting: EmptyRunWriting): void {
    this.runWriting = runWriting;
  }

  /** Where the journals are kept and the lock is taken, in place of the home directory's. */
  setStores(stores: EmptyStores): void {
    this.stores = stores;
  }

  /** The org an emptying reads and deletes through, in place of jsforce's: what a test holds. */
  setOrgOf(orgOf: (conn: Connection, orgId: string) => EmptyOrg): void {
    this.orgOf = orgOf;
  }

  async handle(msg: InboundRequest): Promise<boolean> {
    if (!EMPTY_TYPES.has(msg.type)) return false;
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    switch (msg.type) {
      case 'dataops:empty:scope':
        await this.handleScope(msg);
        return true;
      case 'dataops:empty:preview':
        await this.handlePreview(msg);
        return true;
      case 'dataops:empty:run':
        await this.handleRun(msg);
        return true;
      case 'dataops:empty:cancel':
        this.handleCancel(msg);
        return true;
      default:
        await this.handleUndo(msg);
        return true;
    }
  }

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

  private ownStores(): EmptyStores {
    if (this.stores) return this.stores;
    const opened = openCheckpointStore({ root: defaultCheckpointStoreRoot() });
    if ('refusal' in opened) {
      throw new EmptyRefused({
        code: 'RUN_WRITING',
        message: `The lock of the org cannot be kept in ${opened.refusal.path}. Nothing was read or deleted.`,
      });
    }
    const store = opened.store;
    this.stores = {
      journals: new EmptyJournalStore(defaultEmptyRoot()),
      lock: (organizationId) => store.lock(organizationId, 'empty'),
    };
    return this.stores;
  }

  /** What an act works with, for the registered org `orgId`. */
  private async contextOf(
    orgId: string,
    operationId: string,
    asked: { fromPage?: boolean },
    signal?: AbortSignal,
    onProgress?: (percentage: number, step: string) => void,
  ): Promise<EmptyActContext> {
    const registered = this.deps.orgManager.getOrg(orgId);
    const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
    const orgName = registered?.alias || registered?.username || orgId;
    const stores = this.ownStores();
    const reader = (): Promise<Pick<TargetAutomationReader, 'read'>> =>
      this.targetAutomation ? Promise.resolve(this.targetAutomation) : this.ownReader();
    const voice = dataOpsVoiceOf(asked);
    const writing = this.runWriting?.(orgId, orgName, operationId);
    return {
      org: this.orgOf(conn, orgId),
      orgId,
      orgName,
      username: registered?.username ?? orgName,
      registered,
      store: stores.journals,
      lock: stores.lock,
      ...(writing ? { runWriting: writing } : {}),
      automation: dataOpsAutomationOrgOf(
        conn,
        async (names) => {
          const read = await reader();
          return new TimeoutManager(AUTOMATION_TIMEOUT_MS).withTimeout('dataops automation', () =>
            read.read(orgId, names, { undeletes: true }),
          );
        },
        // Never production: the guard refused it before anything is read.
        false,
      ),
      muteLeases: this.muteLeases,
      ...(voice ? { voice } : {}),
      ...(this.checkpoints ? { checkpoints: this.checkpoints } : {}),
      askGuard: async (question) => {
        const guard = this.deps.infraServices?.productionGuard;
        if (!guard) return { decision: 'refused', reason: PRODUCTION_GUARD_MISSING.message };
        const { check, decision } = await consultProductionGuard(guard, {
          orgId,
          orgTier: guardTierOf(registered),
          operation: question.operation,
          objectName: question.objectNames.join(', '),
          recordCount: question.recordCount,
          module: MODULE,
        });
        return {
          decision,
          ...(decision === 'refused' ? { reason: check.blockedReason ?? check.impactSummary } : {}),
        };
      },
      operationId,
      tool: 'panel',
      ...(signal ? { signal } : {}),
      ...(onProgress ? { onProgress } : {}),
    };
  }

  /** Answer a refusal, or a failure, on the error channel. */
  private fail(msg: InboundRequest, err: unknown, code: string): void {
    if (err instanceof EmptyRefused) {
      sendHandlerError(this.deps, msg.type, 'dataops:error', msg, err, {
        code: err.refusal.code,
        retryable: false,
        ...(err.alsoRefused.length > 0 || err.mutedAutomation
          ? {
              extraPayload: {
                ...(err.alsoRefused.length > 0 ? { alsoRefused: [...err.alsoRefused] } : {}),
                ...(err.mutedAutomation ? { mutedAutomation: err.mutedAutomation } : {}),
              },
            }
          : {}),
      });
      return;
    }
    sendHandlerError(this.deps, msg.type, 'dataops:error', msg, err, { code });
  }

  private respond(msg: InboundRequest, type: string, payload: Record<string, unknown>): void {
    const response = buildResponse(this.deps, msg, type, payload);
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ${response.type} id=${response.id}`);
  }

  /** `dataops:empty:scope`: the global describe alone, no record counted. */
  private async handleScope(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(dataOpsEmptyScopePayloadSchema, msg, 'dataops:error', this.deps);
    if (!parsed) return;
    try {
      const { orgId, ...request } = parsed;
      const context = await this.contextOf(orgId, msg.id, {});
      const guard = await guardEmpty(
        { query: (soql: string) => context.org.query(soql) } as unknown as Pick<
          Connection,
          'query'
        >,
        { orgName: context.orgName, registered: context.registered, mode: request.mode },
      );
      if (!guard.allowed) throw new EmptyRefused(guard.refusal);
      const global = z
        .object({ sobjects: z.array(globalObjectSchema) })
        .loose()
        .parse(await context.org.describeGlobal()).sobjects;
      const scope = emptyScopeOf(global, await context.org.toolingObjects(), request);
      this.respond(msg, 'dataops:empty:scope:response', {
        mode: scope.mode,
        objects: scope.objects,
        leftOut: scope.leftOut,
        candidates: scope.worked,
      });
    } catch (err: unknown) {
      this.fail(msg, err, 'EMPTY_SCOPE_ERROR');
    }
  }

  /** Keep `kept` for a run to act on, the oldest let go past {@link PREVIEWS_KEPT}. */
  private keep(orgId: string, kept: EmptyKeptPreview): void {
    this.previews.set(kept.previewId, { orgId, kept, at: Date.now() });
    while (this.previews.size > PREVIEWS_KEPT) {
      const oldest = this.previews.keys().next().value;
      if (oldest === undefined) break;
      this.previews.delete(oldest);
    }
  }

  /** `dataops:empty:preview`: the dry run, kept for the run. Stoppable by its id. */
  private async handlePreview(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(
      dataOpsEmptyPreviewPayloadSchema,
      msg,
      'dataops:error',
      this.deps,
    );
    if (!parsed) return;
    const stop = new AbortController();
    this.running.set(msg.id, stop);
    try {
      const context = await this.contextOf(parsed.orgId, msg.id, parsed, stop.signal);
      const answer = await previewEmptyAct(context, {
        request: parsed.request,
        deleteMode: parsed.deleteMode,
        accord: parsed,
        ...(parsed.acceptNoUndo !== undefined ? { acceptNoUndo: parsed.acceptNoUndo } : {}),
        ...(parsed.checkpointFirst !== undefined
          ? { checkpointFirst: parsed.checkpointFirst }
          : {}),
      });
      if (!answer.previewed) throw new EmptyRefused(answer.refusal);
      this.keep(parsed.orgId, answer.kept);
      this.respond(msg, 'dataops:empty:preview:response', {
        ...keptForPage(answer.kept),
        automation: answer.automation,
        refusals: answer.refusals,
      });
    } catch (err: unknown) {
      this.fail(msg, err, 'EMPTY_PREVIEW_ERROR');
    } finally {
      // The preview reads, and the window lists no write for it.
      this.running.delete(msg.id);
    }
  }

  /** `dataops:empty:cancel`: stop the act under that id before its next call or job. */
  private handleCancel(msg: InboundRequest): void {
    const parsed = validatePayload(
      dataOpsEmptyCancelPayloadSchema,
      msg,
      'dataops:error',
      this.deps,
    );
    if (!parsed) return;
    const stop = this.running.get(parsed.operationId);
    if (stop) {
      this.deps.infraServices?.backgroundRegistry?.abort(parsed.operationId);
      stop.abort();
    }
    this.respond(msg, 'dataops:empty:cancel:response', {
      operationId: parsed.operationId,
      cancelled: stop !== undefined,
    });
  }

  /**
   * An act that writes, under the id of its request: listed in the registry
   * and in Live Operations, its progress on that id, recorded in the audit
   * trail, and answered with its result — or with the refusal it met.
   */
  private async writeAct<T extends { status: DataOpsEmptyRunResult['status'] }>(
    msg: InboundRequest,
    orgId: string,
    description: string,
    act: (context: EmptyActContext) => Promise<
      | { ran: true; result: T; guard?: GuardDecision }
      | {
          ran: false;
          refusal: DataOpsEmptyRefusal;
          alsoRefused?: DataOpsEmptyRefusal[];
          guard?: GuardDecision;
          mutedAutomation?: MutedAutomation;
        }
    >,
    audit: (
      outcome: AuditOutcome,
      extra: { result?: T; code?: string; guard?: GuardDecision },
    ) => void,
    respond: (result: T) => void,
    asked: { fromPage?: boolean },
  ): Promise<void> {
    const operationId = msg.id;
    const registry = this.deps.infraServices?.backgroundRegistry;
    const stop = new AbortController();
    this.running.set(operationId, stop);
    let settle: (err?: unknown) => void = () => {};
    const tracked = new Promise<void>((resolve, reject) => {
      settle = (err) => (err === undefined ? resolve() : reject(err));
    });
    tracked.catch(() => {});
    sendOperationStarted(this.deps, operationId, MODULE, description);
    registry?.register(operationId, MODULE, description, tracked, stop);
    const live = listLive(this.liveTracker, operationId, MODULE, description);
    const onProgress = (percentage: number, step: string): void => {
      sendOperationProgress(this.deps, operationId, percentage, 0, 0, step);
      if (!stop.signal.aborted) registry?.updateProgress(operationId, percentage);
      live.progress(percentage, 0, 0, step);
    };
    try {
      const context = await this.contextOf(orgId, operationId, asked, stop.signal, onProgress);
      const answer = await act(context);
      if (!answer.ran) {
        audit('stopped', {
          code: answer.refusal.code,
          ...(answer.guard ? { guard: answer.guard } : {}),
        });
        sendOperationCompleted(this.deps, operationId, {
          status: 'refused',
          code: answer.refusal.code,
        });
        live.fail(answer.refusal.message);
        settle(new Error(answer.refusal.message));
        throw new EmptyRefused(answer.refusal, answer.alsoRefused ?? [], answer.mutedAutomation);
      }
      const { result } = answer;
      audit(auditOutcomeOf(result.status), {
        result,
        ...(answer.guard ? { guard: answer.guard } : {}),
      });
      respond(result);
      if (result.status === 'cancelled') {
        registry?.abort(operationId);
        sendOperationCompleted(this.deps, operationId, { aborted: true });
        live.cancel();
        settle();
      } else if (result.status === 'failure') {
        const why = 'Nothing the emptying set out to do went through: its result says why.';
        sendOperationCompleted(this.deps, operationId, { status: result.status });
        live.fail(why);
        settle(new Error(why));
      } else {
        sendOperationCompleted(this.deps, operationId, { status: result.status });
        if (result.status === 'success') live.complete();
        else live.partial();
        settle();
      }
    } catch (err: unknown) {
      if (!(err instanceof EmptyRefused)) {
        audit('failure', {});
        sendOperationCompleted(this.deps, operationId, { status: 'failure' });
        live.fail(err instanceof Error ? err.message : String(err));
        settle(err);
      }
      throw err;
    } finally {
      this.running.delete(operationId);
    }
  }

  /** `dataops:empty:run`: empty as the preview said, or take up the org's last emptying. */
  private async handleRun(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(dataOpsEmptyRunPayloadSchema, msg, 'dataops:error', this.deps);
    if (!parsed) return;
    try {
      let confirmed: EmptyKeptPreview | undefined;
      if (parsed.previewId !== undefined) {
        const kept = this.previews.get(parsed.previewId);
        if (!kept || kept.orgId !== parsed.orgId || Date.now() - kept.at > PREVIEW_KEPT_MS) {
          throw new EmptyRefused({
            code: 'PREVIEW_GONE',
            message:
              'The preview this emptying was confirmed on is no longer kept in this window: ' +
              'preview it again, then empty. Nothing was read or deleted.',
          });
        }
        confirmed = kept.kept;
      }
      const details = (
        result?: DataOpsEmptyRunResult,
      ): Record<string, string | number | boolean> => ({
        empty: 'run',
        ...(confirmed
          ? { mode: confirmed.preview.mode, deleteMode: confirmed.preview.deleteMode }
          : {}),
        ...(parsed.resumeRunId !== undefined ? { resumes: parsed.resumeRunId } : {}),
        ...(result
          ? {
              runId: result.runId,
              hard: result.hard,
              gone: result.totals.gone,
              ...(result.status === 'cancelled' ? { cancelled: true } : {}),
            }
          : {}),
      });
      await this.writeAct<DataOpsEmptyRunResult>(
        msg,
        parsed.orgId,
        parsed.resumeRunId !== undefined
          ? `Taking up the emptying ${parsed.resumeRunId}`
          : `Emptying ${confirmed?.preview.total.objects ?? 0} object(s) of ${confirmed?.orgName ?? parsed.orgId}`,
        (context) =>
          runEmptyAct(context, {
            ...(confirmed ? { confirmed } : {}),
            ...(parsed.resumeRunId !== undefined ? { resumeRunId: parsed.resumeRunId } : {}),
            accord: parsed,
            ...(parsed.acceptNoUndo !== undefined ? { acceptNoUndo: parsed.acceptNoUndo } : {}),
            ...(parsed.checkpointFirst !== undefined
              ? { checkpointFirst: parsed.checkpointFirst }
              : {}),
          }),
        (outcome, extra) =>
          recordWriteRun(this.deps, {
            action: 'cleanup_delete',
            module: MODULE,
            operationId: msg.id,
            orgId: parsed.orgId,
            outcome,
            ...(extra.guard ? { guard: extra.guard } : {}),
            ...(extra.code !== undefined ? { code: extra.code } : {}),
            ...(extra.result ? { objects: runAuditObjects(extra.result) } : {}),
            ...(extra.result?.mutedAutomation
              ? { muted: auditMutedOf(extra.result.mutedAutomation) }
              : {}),
            ...(extra.result?.checkpoint?.state === 'taken'
              ? { checkpointId: extra.result.checkpoint.checkpointId }
              : {}),
            details: details(extra.result),
          }),
        (result) => {
          // A preview acted on is not acted on twice.
          if (parsed.previewId !== undefined) this.previews.delete(parsed.previewId);
          this.respond(msg, 'dataops:empty:run:response', { operationId: msg.id, result });
        },
        parsed,
      );
    } catch (err: unknown) {
      this.fail(msg, err, 'EMPTY_RUN_ERROR');
    }
  }

  /** `dataops:empty:undo`: bring back what the org's last emptying deleted. */
  private async handleUndo(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(dataOpsEmptyUndoPayloadSchema, msg, 'dataops:error', this.deps);
    if (!parsed) return;
    try {
      await this.writeAct<DataOpsEmptyUndoResult>(
        msg,
        parsed.orgId,
        `Undoing the emptying ${parsed.runId}`,
        (context) => undoEmptyAct(context, { runId: parsed.runId, accord: parsed }),
        (outcome, extra) =>
          recordWriteRun(this.deps, {
            action: 'cleanup_delete',
            module: MODULE,
            operationId: msg.id,
            orgId: parsed.orgId,
            outcome,
            ...(extra.code !== undefined ? { code: extra.code } : {}),
            ...(extra.result ? { objects: undoAuditObjects(extra.result) } : {}),
            ...(extra.result?.mutedAutomation
              ? { muted: auditMutedOf(extra.result.mutedAutomation) }
              : {}),
            details: { empty: 'undo', runId: parsed.runId },
          }),
        (result) =>
          this.respond(msg, 'dataops:empty:undo:response', { operationId: msg.id, result }),
        parsed,
      );
    } catch (err: unknown) {
      this.fail(msg, err, 'EMPTY_UNDO_ERROR');
    }
  }
}
