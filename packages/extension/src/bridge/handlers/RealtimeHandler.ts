import type {
  BaseMessage,
  ConflictStrategy,
  GuardDecision,
  RealTimeSyncMetrics,
} from '@sandforge/shared';
import { orgTypeToGuardTier } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler, InboundRequest } from './HandlerTypes.js';
import {
  buildResponse,
  bulkManagerOf,
  PRODUCTION_GUARD_MISSING,
  productionGuardMissingError,
  robustnessConfigOf,
  sendHandlerError,
  sendNotification,
} from './HandlerTypes.js';
import {
  validatePayload,
  realtimeObjectsPayloadSchema,
  realtimeResolveConflictPayloadSchema,
  realtimeStartPayloadSchema,
  realtimeStopPayloadSchema,
} from '../validatePayload.js';
import {
  connectionAnnouncing,
  getJsforceConnection,
} from '../../core/connection/ConnectionHelper.js';
import { consultProductionGuard } from '../../core/precheck/consultProductionGuard.js';
import { recordWriteRun } from '../../modules/audit/auditTrail.js';
import { describeCached } from '../../core/connection/describeCache.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { BulkApiExecutor } from '../../core/engine/BulkApiExecutor.js';
import { queryAllPages } from '../../modules/forge/queryAllPages.js';
import { BulkDataWriter } from '../../modules/sync/BulkDataWriter.js';
import { DataSync } from '../../modules/sync/DataSync.js';
import { SyncConfigStore } from '../../modules/sync/SyncConfigStore.js';
import { targetWriteFieldsOf } from '../../modules/sync/targetWriteFields.js';
import { applyPlanFor } from '../../modules/realtime/applyPlan.js';
import { REALTIME_CLIENT_ID } from '../../modules/realtime/changeEvent.js';
import { fayeTransport, type CometdTransport } from '../../modules/realtime/cometdTransport.js';
import {
  CHANNEL_MEMBERS_QUERY,
  channelMembersOf,
  publishingObjects,
} from '../../modules/realtime/publishingObjects.js';
import {
  OwnWriteLedger,
  RealtimeApplier,
  type OrgReader,
  type TargetWrite,
} from '../../modules/realtime/RealtimeApplier.js';
import {
  RealtimeSession,
  type FeedEvent,
  type SessionSnapshot,
} from '../../modules/realtime/RealtimeSession.js';
import { ReplayStore } from '../../modules/realtime/ReplayStore.js';
import type { HeldChange } from '../../modules/realtime/RealtimeApplier.js';
import type { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';

/** Message types handled by RealtimeHandler. */
const REALTIME_TYPES = new Set([
  'realtime:start',
  'realtime:stop',
  'realtime:status',
  'realtime:metrics',
  'realtime:objects',
  'realtime:resolve-conflict',
]);

/** What a session needs of the orgs. Replaced in tests. */
export interface RealtimeOrgAccess {
  /** A CometD connection to an org, with credentials fresh enough to use. */
  openTransport(orgId: string): Promise<CometdTransport>;
  /** Reads an org. */
  reader(orgId: string): OrgReader;
  /**
   * Sync's write path into an org, each write announced as SandForge's
   * real-time client, cancelled with the session.
   */
  writer(orgId: string, signal: AbortSignal): TargetWrite;
  /** A Tooling API query on an org, every record of it. */
  tooling(orgId: string, soql: string): Promise<Record<string, unknown>[]>;
}

/** The orgs as the extension reaches them: through the pooled, validated connections. */
function liveOrgAccess(deps: HandlerDeps): RealtimeOrgAccess {
  const connect = (orgId: string) => getJsforceConnection(orgId, deps.orgRegistry, deps.orgManager);
  const robustness = robustnessConfigOf(deps);
  return {
    async openTransport(orgId) {
      const { streaming } = await connect(orgId);
      return fayeTransport({
        createClient(extensions) {
          const client = streaming.createClient(extensions);
          return {
            subscribe: (channel, onMessage) => client.subscribe(channel, onMessage),
            // Faye's client has `disconnect`; the typing jsforce ships for it
            // leaves the method out.
            disconnect: () => (client as unknown as { disconnect?: () => void }).disconnect?.(),
          };
        },
      });
    },
    reader(orgId) {
      return {
        async query(soql, options) {
          const conn = await connect(orgId);
          const scanAll = options?.includeDeleted === true;
          const { records } = await queryAllPages<Record<string, unknown>>(
            {
              query: async (q) => conn.query<Record<string, unknown>>(q, { scanAll }),
              queryMore: async (url) => conn.queryMore<Record<string, unknown>>(url),
            },
            soql,
          );
          return records;
        },
        async describe(objectApiName) {
          const conn = await connect(orgId);
          const described = await describeCached(orgId, objectApiName, () =>
            conn.describe(objectApiName),
          );
          return { fields: described.fields };
        },
      };
    },
    writer(orgId, signal) {
      return async (config, records) => {
        const pooled = await connect(orgId);
        // The same session, announcing itself: the org writes the client id
        // into every change event these writes cause (`changeOrigin`), which is
        // how a session knows its own writes when they come back.
        const connection = await connectionAnnouncing(pooled, REALTIME_CLIENT_ID);
        const writer = new BulkDataWriter({
          connection,
          bulkExecutor: new BulkApiExecutor(robustness.bulk.threshold),
          bulkManager: bulkManagerOf(deps),
          retryConfig: robustness.retry,
          signal,
          onProgress: () => {},
          log: (message) => deps.log(message),
        });
        const dataSync = new DataSync({
          upsert: (objectName, externalIdField, rows, batchSize) =>
            writer.upsert(objectName, externalIdField, rows, batchSize),
          insert: (objectName, rows, batchSize) => writer.insert(objectName, rows, batchSize),
          update: (objectName, rows, batchSize) => writer.update(objectName, rows, batchSize),
          delete: (objectName, ids, batchSize) => writer.delete(objectName, ids, batchSize),
          describeTargetFields: async (objectApiName) =>
            targetWriteFieldsOf(
              await describeCached(orgId, objectApiName, () => pooled.describe(objectApiName)),
            ),
        });
        return dataSync.write(config, records);
      };
    },
    async tooling(orgId, soql) {
      const conn = await connect(orgId);
      const { records } = await queryAllPages<Record<string, unknown>>(
        {
          query: async (q) => conn.tooling.query<Record<string, unknown>>(q),
          queryMore: async (url) => conn.tooling.queryMore<Record<string, unknown>>(url),
        },
        soql,
      );
      return records;
    },
  };
}

/** The session of the window, with what cancels it and what reports its end. */
interface RunningSession {
  session: RealtimeSession;
  abort: AbortController;
  /** The request that started it, whose id the audit trail records it under. */
  operationId: string;
  sourceOrgId: string;
  targetOrgId: string;
  /** The guard's decision on its writes; absent for a session that only watches. */
  guard?: GuardDecision;
  /** Settles the operation the registry lists: with an error when the session failed. */
  finish: (error?: string) => void;
  /** Stops listening for a cancel, once the session has ended another way. */
  detach: () => void;
}

/**
 * Domain handler for real-time replication (`realtime:*`).
 *
 * One session at a time, living in the extension host: it outlives the panel,
 * and a panel that opens again learns it from `realtime:status`. What the
 * session receives, writes, holds or refuses is pushed as it happens.
 */
export class RealtimeHandler implements DomainHandler {
  private current: RunningSession | undefined;
  private lastMetrics: RealTimeSyncMetrics | null = null;
  private registry: BackgroundOperationRegistry | undefined;
  private readonly syncConfigs: SyncConfigStore;
  private readonly access: RealtimeOrgAccess;

  /**
   * @param deps - Handler dependencies.
   * @param access - How the orgs are reached; the live connections by default.
   */
  constructor(
    private readonly deps: HandlerDeps,
    access?: RealtimeOrgAccess,
  ) {
    this.syncConfigs = new SyncConfigStore(deps.configStore);
    this.access = access ?? liveOrgAccess(deps);
  }

  /** @inheritdoc */
  async handle(msg: InboundRequest): Promise<boolean> {
    if (!REALTIME_TYPES.has(msg.type)) return false;
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    switch (msg.type) {
      case 'realtime:objects':
        await this.handleObjects(msg);
        return true;
      case 'realtime:start':
        await this.handleStart(msg);
        return true;
      case 'realtime:stop':
        await this.handleStop(msg);
        return true;
      case 'realtime:status':
        this.post(buildResponse(this.deps, msg, 'realtime:status:response', this.statusPayload()));
        return true;
      case 'realtime:metrics':
        this.post(
          buildResponse(this.deps, msg, 'realtime:metrics:response', {
            metrics: this.current?.session.metrics() ?? this.lastMetrics,
          }),
        );
        return true;
      case 'realtime:resolve-conflict':
        await this.handleResolve(msg);
        return true;
      default:
        return false;
    }
  }

  /**
   * List running sessions with the other background operations, so Live
   * Operations shows one and its Cancel stops it.
   *
   * @param registry - The shared BackgroundOperationRegistry instance.
   */
  setRegistry(registry: BackgroundOperationRegistry): void {
    this.registry = registry;
  }

  /** Stop the running session, as the extension deactivates. */
  async dispose(): Promise<void> {
    await this.stopCurrent();
  }

  /**
   * Forget where the channels of an org were read to: after a sandbox refresh
   * it is another org, and its replay ids count from somewhere else.
   *
   * @param orgId - The registered org.
   */
  forgetOrg(orgId: string): void {
    new ReplayStore(this.deps.configStore, orgId).forget();
  }

  private post(message: BaseMessage): void {
    this.deps.broker.postToWebview(message);
    this.deps.log(`[TX] ${message.type} id=${message.id}`);
  }

  /** The changes a flush processed, pushed as they are: no request asks for them. */
  private pushEvents(events: FeedEvent[]): void {
    const message: BaseMessage & { payload: { events: FeedEvent[] } } = {
      id: this.deps.nextId(),
      type: 'realtime:events-batch',
      timestamp: Date.now(),
      payload: { events },
    };
    this.deps.broker.postToWebview(message);
  }

  /** A change held for a decision, for the Conflicts tab. */
  private pushConflict(change: HeldChange): void {
    const message: BaseMessage & { payload: Record<string, unknown> } = {
      id: this.deps.nextId(),
      type: 'realtime:conflict',
      timestamp: Date.now(),
      payload: {
        replayId: change.replayId,
        objectApiName: change.objectApiName,
        recordIds: [change.recordId],
        changeType: change.changeType,
        sourceValues: Object.fromEntries(
          Object.entries(change.record).filter(([field]) => field in change.targetValues),
        ),
        targetValues: change.targetValues,
        targetLastModified: change.targetLastModified,
      },
    };
    this.deps.broker.postToWebview(message);
  }

  /**
   * A session that changed state on its own — its connection lost, back, or
   * given up on — tells the page on the channel the page reads status from.
   * Nothing asked, so nothing is correlated.
   */
  private pushStatus(snapshot: SessionSnapshot): void {
    const message: BaseMessage & { payload: SessionSnapshot } = {
      id: this.deps.nextId(),
      type: 'realtime:status:response',
      timestamp: Date.now(),
      payload: snapshot,
    };
    this.deps.broker.postToWebview(message);
  }

  /** A session that stopped because its operation was cancelled, which no request asked. */
  private pushStopped(sessionId: string, reason: string): void {
    const message: BaseMessage & {
      payload: { sessionId: string; reason: string; success: boolean };
    } = {
      id: this.deps.nextId(),
      type: 'realtime:stopped',
      timestamp: Date.now(),
      payload: { sessionId, reason, success: true },
    };
    this.deps.broker.postToWebview(message);
  }

  private statusPayload(): Record<string, unknown> {
    if (!this.current) return { status: 'disconnected', watchedObjects: [] };
    return { ...this.current.session.snapshot() };
  }

  /**
   * Stop the current session, if one runs: finish its batch, close its
   * subscription, and settle the operation the registry lists.
   *
   * @returns The stopped session's id, or `undefined` when none ran.
   */
  private async stopCurrent(): Promise<string | undefined> {
    const current = this.current;
    if (!current) return undefined;
    this.current = undefined;
    current.detach();
    const dropped = await current.session.stop();
    this.lastMetrics = current.session.metrics();
    current.finish();
    if (current.guard) {
      // A session that wrote is one run of the trail, recorded when it ends.
      const { eventsApplied, eventsFailed } = this.lastMetrics;
      recordWriteRun(this.deps, {
        action: 'realtime_sync',
        module: 'sync',
        operationId: current.operationId,
        orgId: current.targetOrgId,
        outcome: eventsFailed === 0 ? 'success' : eventsApplied > 0 ? 'partial' : 'failure',
        guard: current.guard,
        source: { origin: 'org', orgId: current.sourceOrgId },
      });
    }
    if (dropped > 0) {
      sendNotification(
        this.deps,
        'warning',
        'Real-time sync',
        `${dropped} change(s) held for a decision were not applied: the session that held them ` +
          'has stopped.',
      );
    }
    return current.session.sessionId;
  }

  private async handleObjects(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(realtimeObjectsPayloadSchema, msg, 'realtime:error', this.deps);
    if (!parsed) return;
    try {
      const rows = await this.access.tooling(parsed.sourceOrgId, CHANNEL_MEMBERS_QUERY);
      const target = this.access.reader(parsed.targetOrgId);
      const objects = await publishingObjects(
        channelMembersOf(rows),
        (objectApiName) => target.describe(objectApiName),
        this.syncConfigs.list(),
        parsed,
        (message) => this.deps.log(message),
      );
      this.post(buildResponse(this.deps, msg, 'realtime:objects:response', { objects }));
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'realtime:objects', 'realtime:error', msg, err);
    }
  }

  private async handleStart(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(realtimeStartPayloadSchema, msg, 'realtime:error', this.deps);
    if (!parsed) return;
    const refuse = (error: string): void => {
      this.post(
        buildResponse(this.deps, msg, 'realtime:started', {
          success: false,
          watchedObjects: [],
          refused: [],
          notes: [],
          error,
        }),
      );
    };

    if (this.current?.session.running) {
      refuse(
        `A real-time session is already running (${this.current.session.sessionId}). Stop it ` +
          'before starting another.',
      );
      return;
    }

    try {
      const plans = parsed.apply.map((apply) =>
        applyPlanFor(apply, (configId) => this.syncConfigs.load(configId), parsed),
      );

      const decision =
        plans.length > 0
          ? await this.passesProductionGuard(msg, parsed.targetOrgId, plans)
          : undefined;
      if (plans.length > 0 && !decision) {
        refuse(
          'The target org is protected by the Production Guard, which did not allow the writes.',
        );
        return;
      }

      const abort = new AbortController();
      const ownWrites = new OwnWriteLedger();
      const source = this.access.reader(parsed.sourceOrgId);
      const target = this.access.reader(parsed.targetOrgId);
      const write = this.access.writer(parsed.targetOrgId, abort.signal);
      const appliers = new Map(
        plans.map((plan) => [
          plan.objectApiName,
          new RealtimeApplier(plan, {
            source,
            target,
            write,
            conflictStrategy: parsed.conflictStrategy as ConflictStrategy,
            ownWrites,
          }),
        ]),
      );

      let finish: (error?: string) => void = () => {};
      const ended = new Promise<void>((resolve, reject) => {
        finish = (error) => (error ? reject(new Error(error)) : resolve());
      });
      // Settled for the operation registry, the only one waiting on it; a
      // session that fails before being listed there must not leave a
      // rejection nobody handles.
      ended.catch(() => undefined);
      const session: RealtimeSession = new RealtimeSession(
        {
          sessionId: crypto.randomUUID(),
          watchedObjects: parsed.watchedObjects,
          appliers,
          flushIntervalMs: parsed.flushIntervalMs,
          maxBatchSize: parsed.maxBatchSize,
        },
        {
          openTransport: () => this.access.openTransport(parsed.sourceOrgId),
          replayStore: new ReplayStore(this.deps.configStore, parsed.sourceOrgId),
          sink: {
            events: (batch) => this.pushEvents(batch),
            conflict: (change) => this.pushConflict(change),
            status: (snapshot) => {
              this.pushStatus(snapshot);
              // A session that gave up reconnecting ends its operation failed.
              if (snapshot.status === 'error') finish(snapshot.error);
            },
          },
          log: (message) => this.deps.log(message),
        },
      );
      const current: RunningSession = {
        session,
        abort,
        operationId: msg.id,
        sourceOrgId: parsed.sourceOrgId,
        targetOrgId: parsed.targetOrgId,
        guard: decision,
        finish: (error) => finish(error),
        detach: () => {},
      };
      this.current = current;
      this.lastMetrics = null;
      const outcome = await session.start();
      const snapshot = session.snapshot();
      if (outcome.subscribed.length > 0) {
        this.registry?.register(
          session.sessionId,
          'sync',
          `Real-time sync of ${outcome.subscribed.length} object(s)`,
          ended,
          abort,
        );
        const onCancel = (): void => {
          if (this.current?.session !== session) return;
          void this.stopCurrent().then((sessionId) => {
            if (sessionId) this.pushStopped(sessionId, 'cancelled');
          });
        };
        abort.signal.addEventListener('abort', onCancel, { once: true });
        current.detach = () => abort.signal.removeEventListener('abort', onCancel);
      } else {
        finish();
      }
      this.post(
        buildResponse(this.deps, msg, 'realtime:started', {
          success: outcome.subscribed.length > 0,
          sessionId: session.sessionId,
          watchedObjects: outcome.subscribed,
          refused: outcome.refused,
          notes: outcome.notes,
          ...(snapshot.error ? { error: snapshot.error } : {}),
        }),
      );
    } catch (err: unknown) {
      refuse(extractErrorMessage(err));
    }
  }

  /**
   * The Production Guard's word on a session that writes: deletes make it
   * destructive, and the volume is unknown until changes arrive. Consulted as
   * every write path consults it; a session it stopped is recorded in the
   * audit trail with the decision that stopped it.
   *
   * @returns The decision when the session may write, or `undefined` when it
   *   may not.
   * @throws When no guard is wired: a write path never runs without one.
   */
  private async passesProductionGuard(
    msg: InboundRequest,
    targetOrgId: string,
    plans: ReadonlyArray<{ objectApiName: string; applyDeletes: boolean }>,
  ): Promise<GuardDecision | undefined> {
    const guard = this.deps.infraServices?.productionGuard;
    if (!guard) {
      recordWriteRun(this.deps, {
        action: 'realtime_sync',
        module: 'sync',
        operationId: msg.id,
        orgId: targetOrgId,
        outcome: 'stopped',
        code: PRODUCTION_GUARD_MISSING.code,
      });
      throw productionGuardMissingError();
    }
    const request = {
      orgId: targetOrgId,
      orgTier: orgTypeToGuardTier(this.deps.orgManager.getOrg(targetOrgId)?.orgType ?? ''),
      operation: plans.some((p) => p.applyDeletes) ? ('delete' as const) : ('upsert' as const),
      objectName: plans.map((p) => p.objectApiName).join(', '),
      recordCount: 'unknown' as const,
      module: 'sync',
    };
    const { decision } = await consultProductionGuard(guard, request);
    if (decision === 'refused' || decision === 'declined') {
      recordWriteRun(this.deps, {
        action: 'realtime_sync',
        module: 'sync',
        operationId: msg.id,
        orgId: targetOrgId,
        outcome: 'stopped',
        guard: decision,
      });
      return undefined;
    }
    return decision;
  }

  private async handleStop(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(realtimeStopPayloadSchema, msg, 'realtime:error', this.deps);
    if (!parsed) return;
    const current = this.current;
    if (!current || (parsed.sessionId !== '' && parsed.sessionId !== current.session.sessionId)) {
      // Nothing of that name runs: say what does.
      this.post(buildResponse(this.deps, msg, 'realtime:status:response', this.statusPayload()));
      return;
    }
    const sessionId = await this.stopCurrent();
    this.post(
      buildResponse(this.deps, msg, 'realtime:stopped', {
        sessionId: sessionId ?? current.session.sessionId,
        reason: 'stopped',
        success: true,
      }),
    );
  }

  private async handleResolve(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(
      realtimeResolveConflictPayloadSchema,
      msg,
      'realtime:error',
      this.deps,
    );
    if (!parsed) return;
    const result = this.current
      ? await this.current.session.resolveConflict(
          parsed.conflictId,
          parsed.resolution,
          parsed.fieldResolutions &&
            Object.fromEntries(
              Object.entries(parsed.fieldResolutions).map(([field, choice]) => [
                field,
                { value: choice.value, source: choice.source },
              ]),
            ),
        )
      : {
          success: false,
          resolvedValues: {},
          error: 'No real-time session is running: the change it held was dropped when it stopped.',
        };
    if (!result.success) {
      // The Conflicts tab marks a decision taken as soon as it is sent; this is
      // where the user learns it did not reach the target.
      sendNotification(
        this.deps,
        'warning',
        'Real-time sync',
        `The decision on ${parsed.conflictId} was not applied: ${result.error ?? 'refused'}`,
      );
    }
    this.post(
      buildResponse(this.deps, msg, 'realtime:conflict-resolved', {
        conflictId: parsed.conflictId,
        resolution: parsed.resolution,
        success: result.success,
        resolvedValues: result.resolvedValues,
        ...(result.error ? { error: result.error } : {}),
      }),
    );
  }
}
