import type {
  CheckpointListEntry,
  CheckpointRefusal,
  CheckpointRefusalCode,
  CheckpointScopeMode,
  ForgeTargetAutomation,
  OrgCheckpoint,
  SalesforceOrg,
} from '@sandforge/shared';
import type { DomainHandler, HandlerDeps, InboundRequest } from './HandlerTypes.js';
import {
  buildResponse,
  sendHandlerError,
  sendOperationCompleted,
  sendOperationProgress,
  sendOperationStarted,
} from './HandlerTypes.js';
import { listLive } from './liveRun.js';
import {
  checkpointDeletePayloadSchema,
  checkpointIgnoreFieldsPayloadSchema,
  checkpointKeepPayloadSchema,
  checkpointListPayloadSchema,
  checkpointPreviewPayloadSchema,
  checkpointRenamePayloadSchema,
  checkpointScopePayloadSchema,
  checkpointTakePayloadSchema,
  validatePayload,
} from '../validatePayload.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { OrgConnectionError } from '../../core/connection/OrgConnectionError.js';
import { TimeoutManager } from '../../core/engine/TimeoutManager.js';
import type { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import type { DetectedSandboxRefresh } from '../../modules/monitor/SandboxRefreshDetector.js';
import type { TargetAutomationReader } from '../../modules/forge/TargetAutomationReader.js';
import type { SyncRunKept } from '../../modules/sync/SyncRunCreations.js';
import { THIS_HOST, writtenElsewhere, type RunWriterHost } from '../../modules/sync/runWriter.js';
import type {
  CheckpointStoreRefusal,
  OrgCheckpointStore,
  OrgLockHolder,
} from '../../modules/checkpoint/OrgCheckpointStore.js';
import type { TakeProgress, TakeRequest } from '../../modules/checkpoint/takeCheckpoint.js';

/** Message types handled by CheckpointHandler. */
const CHECKPOINT_TYPES = new Set([
  'checkpoint:list',
  'checkpoint:scope',
  'checkpoint:take',
  'checkpoint:preview',
  'checkpoint:delete',
  'checkpoint:keep',
  'checkpoint:rename',
  'checkpoint:ignore-fields',
]);

/** The module runs are listed under, in the registry and in Live Operations. */
const MODULE = 'checkpoint';

/** How long the read of what the org runs as a rewind writes may take: as a removal's. */
const AUTOMATION_TIMEOUT_MS = 60_000;

/** The code a take stopped by its user answers with, as the page words it. */
const CANCELLED = 'CANCELLED';

/** Refusals worth trying again once what refused them has passed: a run writing, the day's requests. */
const RETRYABLE_REFUSALS: ReadonlySet<CheckpointRefusalCode> = new Set([
  'RUN_WRITING',
  'API_BUDGET',
]);

/** Where a run's file names the org it writes to, as a checkpoint's org is compared with it. */
interface RunFiles {
  list(): Promise<SyncRunKept[]>;
}

/** What this window writes to orgs, as the handlers that write know it. */
export interface WindowWriters {
  /** Whether a Sync or a Seed run of this window, by its id, is still writing. */
  isRunning?: (runId: string) => boolean;
  /** Whether a Forge run of this window writes to the registered org. */
  forgeWritingTo?: (orgId: string) => boolean;
}

/** The modules a checkpoint's acts run through, loaded on the first request, off the activation path. */
async function loadCheckpointModules() {
  const [store, take, preview] = await Promise.all([
    import('../../modules/checkpoint/OrgCheckpointStore.js'),
    import('../../modules/checkpoint/takeCheckpoint.js'),
    import('../../modules/checkpoint/previewCheckpoint.js'),
  ]);
  return {
    openCheckpointStore: store.openCheckpointStore,
    defaultCheckpointStoreRoot: store.defaultCheckpointStoreRoot,
    scratchOrgExpired: store.scratchOrgExpired,
    CheckpointStoreError: store.CheckpointStoreError,
    takeCheckpoint: take.takeCheckpoint,
    scopeCheckpoint: take.scopeCheckpoint,
    takeOrgOf: take.takeOrgOf,
    CheckpointTakeStopped: take.CheckpointTakeStopped,
    previewCheckpoint: preview.previewCheckpoint,
  };
}

type CheckpointModules = Awaited<ReturnType<typeof loadCheckpointModules>>;

/** A refusal or a failure the error channel answers with. */
class Refused extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'Refused';
  }
}

/** Whether two Organization Ids name one org: the 15-character id and its 18-character form alike. */
function sameOrganization(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.length >= 15 && a.slice(0, 15) === b.slice(0, 15);
}

/** An Organization Id, in its 15- or 18-character form. */
const ORGANIZATION_ID = /^00D[0-9A-Za-z]{12}(?:[0-9A-Za-z]{3})?$/;

/** How the user knows an org: its alias, else its username. */
function nameOf(org: Pick<SalesforceOrg, 'alias' | 'username'>): string {
  return org.alias || org.username;
}

/** Why the store's folder cannot be used, as a person reads it. */
function storeRefusalWords(refusal: CheckpointStoreRefusal): string {
  const why =
    refusal.reason === 'notAFolder'
      ? 'it is a file, not a folder'
      : refusal.reason === 'otherOwner'
        ? 'another user of this machine owns it, and could read and replace the checkpoints in it'
        : `it could not be made${refusal.detail !== undefined ? ` (${refusal.detail})` : ''}`;
  return `The checkpoints cannot be kept in ${refusal.path}: ${why}.`;
}

/** The process a lock holder names, as a refusal says it. */
function holderWords(holder: OrgLockHolder): string {
  const what =
    holder.operation === 'take'
      ? 'a checkpoint is being taken'
      : holder.operation === 'rewind'
        ? 'a rewind is writing'
        : holder.operation === 'undo'
          ? 'an undo is writing'
          : 'SandForge is deleting checkpoints';
  return `${what} (process ${holder.pid} on ${holder.host})`;
}

/**
 * The checkpoints of the Checkpoints page: taking one, what a take would
 * hold, the list, the preview of a rewind, and what a checkpoint is called,
 * how long it is kept and which fields it compares.
 *
 * - `checkpoint:list` — the checkpoints kept on this machine, of one org or
 *   of all, read from the store alone, never from the org. An org's are those
 *   of every Organization Id its registered entry was: a sandbox refreshed
 *   since lists those of the org before, which can only be deleted.
 * - `checkpoint:scope` — what a take would hold and cost, read from the org's
 *   describes and counts, nothing kept (`scopeCheckpoint`).
 * - `checkpoint:take` — the take (`takeCheckpoint`), under the id of its
 *   request: listed in the registry and in Live Operations, whose Cancel and
 *   the page's Stop, `execution:abort` with that id, stop it between two
 *   reads, and held under that id from the request on, so a Stop sent while
 *   the org is still being reached is taken too. A stopped take keeps
 *   nothing and answers `CANCELLED`. A take kept answers with the requests
 *   it sent the org, phase by phase, beside what it estimated.
 * - `checkpoint:preview` — what a rewind would do, read from the org, nothing
 *   written (`previewCheckpoint`).
 * - `checkpoint:delete`, `checkpoint:keep`, `checkpoint:rename`,
 *   `checkpoint:ignore-fields` — changes to the checkpoints on this machine;
 *   the org is not touched.
 *
 * Every refusal a guard or a gate gives goes out as it gave it, its code and
 * its words, on `checkpoint:error`: a production org is refused by the
 * checkpoint's own guard, which nothing lifts, and this handler asks no
 * other. The org's lock is the store's, one per org on this machine, taken by
 * the take for its own length and by nothing else here.
 */
export class CheckpointHandler implements DomainHandler {
  private loaded?: Promise<CheckpointModules>;
  private store?: Promise<OrgCheckpointStore | CheckpointStoreRefusal>;
  private liveTracker?: LiveOperationTracker;
  private syncRuns?: RunFiles;
  private seedRuns?: RunFiles;
  /**
   * Reads what the org runs as a rewind writes: a reader of the handler's
   * own, over its connections, loaded on its first read.
   */
  private targetAutomation: Pick<TargetAutomationReader, 'read'> = {
    read: async (orgId, objectApiNames, options) =>
      (await this.ownReader()).read(orgId, objectApiNames, options),
  };
  private reader?: Promise<TargetAutomationReader>;

  /**
   * @param deps - Injected handler dependencies.
   * @param writers - What this window writes to orgs, which refuses a take.
   * @param self - This window's process, as a run's file names the process
   *   writing it.
   */
  constructor(
    private readonly deps: HandlerDeps,
    private readonly writers: WindowWriters = {},
    private readonly self: RunWriterHost = THIS_HOST,
  ) {}

  /** The Monitor's live operations, which list a take while it runs. */
  setLiveOperationTracker(tracker: LiveOperationTracker): void {
    this.liveTracker = tracker;
  }

  /** Where Sync or Seed runs keep their files: a run one of them writes to an org refuses a take of it. */
  setRunFiles(kind: 'sync' | 'seed', files: RunFiles): void {
    if (kind === 'sync') this.syncRuns = files;
    else this.seedRuns = files;
  }

  /** The store the checkpoints are kept in, in place of the one `SANDFORGE_JOURNAL_DIR` or the home names. */
  setStore(store: OrgCheckpointStore): void {
    this.store = Promise.resolve(store);
  }

  /** Another reader of what the org runs than the handler's own. */
  setTargetAutomation(reader: Pick<TargetAutomationReader, 'read'>): void {
    this.targetAutomation = reader;
  }

  async handle(msg: InboundRequest): Promise<boolean> {
    if (!CHECKPOINT_TYPES.has(msg.type)) return false;
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    switch (msg.type) {
      case 'checkpoint:list':
        await this.handleList(msg);
        return true;
      case 'checkpoint:scope':
        await this.handleScope(msg);
        return true;
      case 'checkpoint:take':
        await this.handleTake(msg);
        return true;
      case 'checkpoint:preview':
        await this.handlePreview(msg);
        return true;
      case 'checkpoint:delete':
        await this.handleDelete(msg);
        return true;
      case 'checkpoint:keep':
        await this.handleKeep(msg);
        return true;
      case 'checkpoint:rename':
        await this.handleRename(msg);
        return true;
      case 'checkpoint:ignore-fields':
        await this.handleIgnoreFields(msg);
        return true;
      default:
        return false;
    }
  }

  /**
   * Delete the checkpoints, and the journals of their rewinds, whose day has
   * passed, each named in the log: run as the first panel opens, as each
   * command line verb runs it as it starts.
   */
  async sweep(): Promise<void> {
    try {
      const store = await this.openedStore();
      const swept = await store.sweep();
      for (const gone of swept.checkpoints) {
        this.deps.log(
          `[INFO] Removed checkpoint '${gone.name}' of ${gone.alias ?? gone.organizationId}, taken ` +
            `${gone.takenAt}: kept until ${gone.expiresAt}` +
            (gone.undoUntil !== undefined
              ? `; the undo of its last rewind, open until ${gone.undoUntil}, went with it`
              : ''),
        );
      }
      for (const gone of swept.journals) {
        this.deps.log(
          `[INFO] Removed the journal of rewind ${gone.rewindId} of checkpoint '${gone.name}': ` +
            `it could be undone until ${gone.undoUntil}`,
        );
      }
      for (const org of swept.skipped) {
        this.deps.log(`[INFO] Checkpoints of ${org} not swept: a take, a rewind or an undo runs`);
      }
    } catch (err: unknown) {
      this.deps.log(`[WARN] Expired checkpoints were not removed: ${extractErrorMessage(err)}`);
    }
  }

  /**
   * How many checkpoints this machine keeps of the org a sandbox was before
   * the refresh `refresh` reports: they can only be deleted now.
   */
  async keptBefore(refresh: DetectedSandboxRefresh): Promise<number> {
    const before =
      refresh.previousOrganizationId ?? this.deps.sandboxRefreshes?.organizationIdOf(refresh.orgId);
    if (before === undefined || !ORGANIZATION_ID.test(before)) return 0;
    const store = await this.openedStore();
    return (await store.list({ organizationId: before })).length;
  }

  // ─── What every request goes through ───────────────────────────────────────

  private modules(): Promise<CheckpointModules> {
    this.loaded ??= loadCheckpointModules();
    return this.loaded;
  }

  /** The store, opened once: the one `SANDFORGE_JOURNAL_DIR` names, or `.sandforge` in the home. */
  private async openedStore(): Promise<OrgCheckpointStore> {
    this.store ??= this.modules().then((m) => {
      const opened = m.openCheckpointStore({ root: m.defaultCheckpointStoreRoot() });
      return 'store' in opened ? opened.store : opened.refusal;
    });
    const store = await this.store;
    if ('reason' in store) {
      // Asked again next time: the folder may be put right meanwhile.
      this.store = undefined;
      throw new Refused('STORE_REFUSED', storeRefusalWords(store));
    }
    return store;
  }

  /** Answer `msg` on its response channel. */
  private respond(msg: InboundRequest, type: string, payload: Record<string, unknown>): void {
    const response = buildResponse(this.deps, msg, type, payload);
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ${response.type} id=${response.id}`);
  }

  /** Answer `msg` with a failure: a refusal under its code, anything else under `code`. */
  private fail(msg: InboundRequest, err: unknown, code: string, retryable = true): void {
    if (err instanceof Refused) {
      sendHandlerError(this.deps, msg.type, 'checkpoint:error', msg, err, {
        code: err.code,
        retryable: err.retryable,
      });
      return;
    }
    sendHandlerError(this.deps, msg.type, 'checkpoint:error', msg, err, { code, retryable });
  }

  /** A guard's or a gate's refusal, as it gave it. */
  private refusalOf(refusal: CheckpointRefusal): Refused {
    return new Refused(refusal.code, refusal.message, RETRYABLE_REFUSALS.has(refusal.code));
  }

  /** The registered org, or a refusal naming it. */
  private registeredOrg(orgId: string): SalesforceOrg {
    const org = this.deps.orgManager.getOrg(orgId);
    if (!org) {
      throw new Refused(
        'ORG_NOT_FOUND',
        'SandForge has no connected org of this id: connect it first.',
      );
    }
    return org;
  }

  /** The org's connection; an expired scratch org refused as the checkpoint's guards word it. */
  private async connect(org: SalesforceOrg) {
    try {
      return await getJsforceConnection(org.id, this.deps.orgRegistry, this.deps.orgManager);
    } catch (err: unknown) {
      if (err instanceof OrgConnectionError && err.code === 'SCRATCH_ORG_EXPIRED') {
        throw new Refused(
          'SCRATCH_EXPIRED',
          `${nameOf(org)} is a scratch org that has expired: its checkpoints can only be deleted.`,
        );
      }
      throw err;
    }
  }

  /**
   * What a take of the registered org is asked, beside what it is called and
   * kept: its scope, the objects left out of it and the limit of its records,
   * which the command line names (`--exclude-object`, `--max-total`).
   */
  private takeRequestOf(
    org: SalesforceOrg,
    scope: {
      mode: CheckpointScopeMode;
      objects?: readonly string[];
      excluded?: readonly string[];
      maxTotal?: number;
    },
  ): TakeRequest {
    const expires = org.metadata?.expirationDate;
    const { mode, objects, excluded, maxTotal } = scope;
    return {
      orgId: org.id,
      orgName: nameOf(org),
      ...(org.alias ? { alias: org.alias } : {}),
      username: org.username,
      instanceUrl: org.instanceUrl,
      registered: org,
      ...(org.orgType === 'Scratch' && expires !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(expires)
        ? { scratchExpiresAt: expires }
        : {}),
      mode,
      ...(objects !== undefined ? { objects } : {}),
      ...(excluded !== undefined ? { excluded } : {}),
      ...(maxTotal !== undefined ? { maxTotal } : {}),
    };
  }

  /**
   * Whether a run of this machine writes to the registered org `orgId`, the
   * Organization Id `organizationId`: a Forge run of this window, or a Sync or
   * Seed run — a CSV import's and a clone's among them — whose file has no end,
   * still written by this window or by another process alive. Said as a
   * refusal says it, `then` the act to do once it has ended; nothing when none
   * does. A run on another machine, or of another user of this one, is not
   * seen.
   */
  private runWriting(
    orgId: string,
    orgName: string,
    then: string,
    done: string,
  ): (organizationId: string) => Promise<string | undefined> {
    const words = `A SandForge run is writing to ${orgName}: ${then} once it has ended. ${done}`;
    return async (organizationId) => {
      if (this.writers.forgeWritingTo?.(orgId) === true) return words;
      for (const files of [this.syncRuns, this.seedRuns]) {
        if (!files) continue;
        for (const run of await files.list()) {
          if (run.end !== undefined || !this.writesTo(run, orgId, organizationId)) continue;
          if (this.writers.isRunning?.(run.runId) === true || writtenElsewhere(run, this.self)) {
            return words;
          }
        }
      }
      return undefined;
    };
  }

  /** Whether a run's file names the org: by its registered id, or by its Organization Id. */
  private writesTo(run: SyncRunKept, orgId: string, organizationId: string): boolean {
    return (
      run.targetOrgId === orgId ||
      sameOrganization(run.targetOrganizationId, organizationId) ||
      sameOrganization(this.deps.orgManager.getOrg(run.targetOrgId)?.orgId, organizationId)
    );
  }

  /**
   * When the sandbox an Organization Id was is known to have been refreshed:
   * a refresh of a registered sandbox that names it as the org before, or one
   * only its production org reported, of the org it answered as last.
   */
  private refreshedAt(organizationId: string): string | undefined {
    const detector = this.deps.sandboxRefreshes;
    if (!detector) return undefined;
    for (const org of this.deps.orgManager.getAllOrgs()) {
      for (const refresh of detector.refreshesOf(org.id)) {
        const before =
          refresh.previousOrganizationId ??
          (refresh.organizationId === undefined ? detector.organizationIdOf(org.id) : undefined);
        if (sameOrganization(before, organizationId)) return refresh.detectedAt;
      }
    }
    return undefined;
  }

  /**
   * The Organization Ids a registered org was: the one it was registered
   * with, the one it answered as last, and the ones before its refreshes.
   */
  private organizationIdsOf(orgId: string): string[] {
    const detector = this.deps.sandboxRefreshes;
    const candidates = [
      this.deps.orgManager.getOrg(orgId)?.orgId,
      detector?.organizationIdOf(orgId),
      ...(detector?.refreshesOf(orgId).map((refresh) => refresh.previousOrganizationId) ?? []),
    ];
    const ids: string[] = [];
    for (const id of candidates) {
      if (id === undefined || !ORGANIZATION_ID.test(id)) continue;
      if (!ids.some((known) => sameOrganization(known, id))) ids.push(id);
    }
    return ids;
  }

  /**
   * The registered org a checkpoint is of: the one registered with its
   * Organization Id, its alias first, or the one that answered as it last.
   */
  private orgOfCheckpoint(checkpoint: OrgCheckpoint): SalesforceOrg | undefined {
    const organizationId = checkpoint.org.organizationId;
    const orgs = this.deps.orgManager.getAllOrgs();
    const registered = orgs.filter((org) => sameOrganization(org.orgId, organizationId));
    const named = registered.find((org) => org.alias === checkpoint.org.alias) ?? registered[0];
    if (named) return named;
    const detector = this.deps.sandboxRefreshes;
    return orgs.find((org) => sameOrganization(detector?.organizationIdOf(org.id), organizationId));
  }

  /** A kept checkpoint that parses, or a refusal naming why it cannot be used. */
  private async checkpointOf(store: OrgCheckpointStore, checkpointId: string) {
    const read = await store.read(checkpointId);
    if (read === undefined) {
      throw new Refused(
        'NOT_FOUND',
        `No checkpoint ${checkpointId} is kept on this machine.`,
        false,
      );
    }
    if (read.checkpoint === undefined) {
      throw new Refused(
        'DAMAGED',
        `The file of checkpoint ${checkpointId} cannot be read: it can only be deleted.`,
      );
    }
    return { folder: read.folder, checkpoint: read.checkpoint };
  }

  // ─── The requests ──────────────────────────────────────────────────────────

  private async handleList(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(checkpointListPayloadSchema, msg, 'checkpoint:error', this.deps);
    if (parsed === null) return;
    try {
      const store = await this.openedStore();
      const refreshedAt = (organizationId: string): string | undefined =>
        this.refreshedAt(organizationId);
      let checkpoints: CheckpointListEntry[];
      if (parsed?.orgId === undefined) {
        checkpoints = await store.list({ refreshedAt });
      } else {
        const lists = await Promise.all(
          this.organizationIdsOf(parsed.orgId).map((organizationId) =>
            store.list({ organizationId, refreshedAt }),
          ),
        );
        // Ids are named by when the take began: newest first, across the orgs it was.
        checkpoints = lists
          .flat()
          .sort((a, b) =>
            a.checkpointId < b.checkpointId ? 1 : a.checkpointId > b.checkpointId ? -1 : 0,
          );
      }
      this.respond(msg, 'checkpoint:list:response', { checkpoints });
    } catch (err: unknown) {
      this.fail(msg, err, 'LIST_ERROR');
    }
  }

  private async handleScope(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(
      checkpointScopePayloadSchema,
      msg,
      'checkpoint:error',
      this.deps,
    );
    if (!parsed) return;
    try {
      const org = this.registeredOrg(parsed.orgId);
      const m = await this.modules();
      const store = await this.openedStore();
      const conn = await this.connect(org);
      const scope = await m.scopeCheckpoint(
        {
          org: m.takeOrgOf(conn),
          store,
          handler: this.deps,
          runWriting: this.runWriting(
            org.id,
            nameOf(org),
            'take the checkpoint',
            'No record was read.',
          ),
        },
        this.takeRequestOf(org, parsed),
      );
      this.respond(msg, 'checkpoint:scope:response', {
        orgId: parsed.orgId,
        mode: scope.mode,
        objects: scope.objects,
        leftOut: scope.leftOut,
        estimate: scope.estimate,
        ...(scope.refusal ? { refusal: scope.refusal } : {}),
      });
    } catch (err: unknown) {
      this.fail(msg, err, 'SCOPE_ERROR');
    }
  }

  /** The take: see the class's comment. */
  private async handleTake(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(checkpointTakePayloadSchema, msg, 'checkpoint:error', this.deps);
    if (!parsed) return;
    const operationId = msg.id;
    const registry = this.deps.infraServices?.backgroundRegistry;
    // Held from the request on: the page offers Stop as soon as it asks.
    const pending = registry?.holdUntilStart(operationId);
    try {
      const org = this.registeredOrg(parsed.orgId);
      const m = await this.modules();
      const store = await this.openedStore();
      const conn = await this.connect(org);
      if (pending?.signal.aborted) {
        throw new Refused(CANCELLED, new m.CheckpointTakeStopped().message, true);
      }
      await this.take(msg, m, store, conn, org, parsed);
    } catch (err: unknown) {
      this.fail(msg, err, 'TAKE_ERROR');
    } finally {
      pending?.release();
    }
  }

  /** The take once the org is reached, run on the registry and in Live Operations. */
  private async take(
    msg: InboundRequest,
    m: CheckpointModules,
    store: OrgCheckpointStore,
    conn: Awaited<ReturnType<CheckpointHandler['connect']>>,
    org: SalesforceOrg,
    asked: {
      name: string;
      mode: CheckpointScopeMode;
      objects?: string[];
      excluded?: string[];
      maxTotal?: number;
      keepDays: number;
      ignoredFields?: string[];
    },
  ): Promise<void> {
    const operationId = msg.id;
    const orgName = nameOf(org);
    const description = `Taking a checkpoint of ${orgName}`;
    const registry = this.deps.infraServices?.backgroundRegistry;
    const stop = new AbortController();
    let settle: (err?: unknown) => void = () => {};
    const tracked = new Promise<void>((resolve, reject) => {
      settle = (err) => (err === undefined ? resolve() : reject(err));
    });
    // The registry attaches its own handlers; this keeps a host with none from
    // an unhandled rejection.
    tracked.catch(() => {});
    sendOperationStarted(this.deps, operationId, MODULE, description);
    registry?.register(operationId, MODULE, description, tracked, stop);
    const live = listLive(this.liveTracker, operationId, MODULE, description);
    const onProgress = (progress: TakeProgress): void => {
      const { percentage, processedObjects, totalObjects, step } = progress;
      sendOperationProgress(
        this.deps,
        operationId,
        percentage,
        processedObjects,
        totalObjects,
        step,
      );
      // A take stopped from Live Operations ends its read; the registry has
      // recorded the stop and hears no more of it.
      if (!stop.signal.aborted) registry?.updateProgress(operationId, percentage);
      live.progress(percentage, processedObjects, totalObjects, step);
    };
    try {
      const outcome = await m.takeCheckpoint(
        {
          org: m.takeOrgOf(conn),
          store,
          handler: this.deps,
          signal: stop.signal,
          onProgress,
          runWriting: this.runWriting(
            org.id,
            orgName,
            'take the checkpoint',
            'No record was read.',
          ),
        },
        {
          ...this.takeRequestOf(org, asked),
          name: asked.name,
          keepDays: asked.keepDays,
          ...(asked.ignoredFields ? { ignoredFields: asked.ignoredFields } : {}),
        },
      );
      if (!outcome.taken) {
        sendOperationCompleted(this.deps, operationId, {
          status: 'refused',
          code: outcome.refusal.code,
        });
        live.fail(outcome.refusal.message);
        settle(new Error(outcome.refusal.message));
        throw this.refusalOf(outcome.refusal);
      }
      for (const { objectApiName, reason } of outcome.notChecked) {
        this.deps.log(
          `[WARN] checkpoint:take ${operationId}: what moved in ${objectApiName} while it was ` +
            `read was not checked: ${reason}`,
        );
      }
      const { checkpoint } = outcome;
      this.respond(msg, 'checkpoint:take:response', {
        checkpoint,
        operationId,
        ...(outcome.requests ? { requests: outcome.requests } : {}),
        estimate: outcome.estimate,
      });
      sendOperationCompleted(this.deps, operationId, {
        status: 'success',
        objects: checkpoint.objects.length,
        records: checkpoint.objects.reduce((total, object) => total + object.records, 0),
      });
      live.complete();
      settle();
    } catch (err: unknown) {
      if (err instanceof Refused) throw err;
      if (err instanceof m.CheckpointTakeStopped) {
        // Aborted in the registry already when the stop came through it.
        registry?.abort(operationId);
        sendOperationCompleted(this.deps, operationId, { aborted: true });
        live.cancel();
        settle();
        throw new Refused(CANCELLED, err.message, true);
      }
      sendOperationCompleted(this.deps, operationId, { status: 'failure' });
      live.fail(extractErrorMessage(err));
      settle(err);
      throw err;
    }
  }

  private async handlePreview(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(
      checkpointPreviewPayloadSchema,
      msg,
      'checkpoint:error',
      this.deps,
    );
    if (!parsed) return;
    try {
      const m = await this.modules();
      const store = await this.openedStore();
      const { folder, checkpoint } = await this.checkpointOf(store, parsed.checkpointId);
      const kept = checkpoint.org.alias ?? checkpoint.org.username;
      if (checkpoint.status !== 'ready') {
        throw new Refused(
          checkpoint.status === 'taking' ? 'TAKING' : 'FAILED',
          checkpoint.status === 'taking'
            ? `The checkpoint '${checkpoint.name}' is being taken, or its take never ended: it can be previewed once taken, or deleted.`
            : `The take of checkpoint '${checkpoint.name}' failed: it can only be deleted.`,
        );
      }
      const refreshed = this.refreshedAt(checkpoint.org.organizationId);
      if (refreshed !== undefined) {
        throw new Refused(
          'OTHER_ORG',
          `This sandbox was refreshed on ${refreshed.slice(0, 10)}: ${kept} is another org now, ` +
            'and this checkpoint is of the org before it. It can only be deleted.',
        );
      }
      if (m.scratchOrgExpired(checkpoint.org, Date.now())) {
        throw new Refused(
          'SCRATCH_EXPIRED',
          `${kept} is a scratch org that has expired: its checkpoints can only be deleted.`,
        );
      }
      const org = this.orgOfCheckpoint(checkpoint);
      if (!org) {
        throw new Refused(
          'ORG_NOT_FOUND',
          `${kept} is not connected in SandForge: connect it to preview the checkpoint '${checkpoint.name}'.`,
        );
      }
      const conn = await this.connect(org);
      const outcome = await m.previewCheckpoint(
        {
          org: m.takeOrgOf(conn),
          store,
          readAutomation: (objects) => this.readAutomation(org.id, objects),
          runWriting: this.runWriting(
            org.id,
            nameOf(org),
            'rewind',
            'No record would be read or written.',
          ),
        },
        {
          checkpoint,
          folder,
          orgName: nameOf(org),
          registered: org,
          username: org.username,
        },
      );
      if (!outcome.previewed) throw this.refusalOf(outcome.refusal);
      this.respond(msg, 'checkpoint:preview:response', {
        diff: outcome.diff,
        ...(outcome.automation ? { automation: outcome.automation } : {}),
        estimate: outcome.estimate,
        ...(outcome.refusal ? { refusal: outcome.refusal } : {}),
      });
    } catch (err: unknown) {
      this.fail(msg, err, 'PREVIEW_ERROR');
    }
  }

  /** What the org runs as a rewind writes records of `objects`, undeletes included. */
  private readAutomation(
    orgId: string,
    objects: readonly string[],
  ): Promise<ForgeTargetAutomation> {
    const reader = this.targetAutomation;
    return new TimeoutManager(AUTOMATION_TIMEOUT_MS).withTimeout(
      'checkpoint:preview automation',
      () => reader.read(orgId, objects, { undeletes: true }),
    );
  }

  /** The handler's own reader of what the org runs, as Forge reads it, off the activation path. */
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

  private async handleDelete(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(
      checkpointDeletePayloadSchema,
      msg,
      'checkpoint:error',
      this.deps,
    );
    if (!parsed) return;
    try {
      const store = await this.openedStore();
      const deleted: string[] = [];
      const busy: OrgLockHolder[] = [];
      for (const checkpointId of parsed.checkpointIds) {
        const outcome = await store.delete(checkpointId);
        if (outcome.outcome === 'deleted') deleted.push(checkpointId);
        else if (outcome.outcome === 'busy') busy.push(outcome.holder);
      }
      for (const holder of busy) {
        this.deps.log(`[WARN] checkpoint:delete: kept while ${holderWords(holder)}`);
      }
      if (deleted.length === 0 && busy.length > 0) {
        throw new Refused(
          'RUN_WRITING',
          `The checkpoint was not deleted: ${holderWords(busy[0])}. Delete it once that has ended.`,
          true,
        );
      }
      this.respond(msg, 'checkpoint:delete:response', { deleted });
    } catch (err: unknown) {
      this.fail(msg, err, 'DELETE_ERROR');
    }
  }

  private async handleKeep(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(checkpointKeepPayloadSchema, msg, 'checkpoint:error', this.deps);
    if (!parsed) return;
    await this.change(msg, parsed.checkpointId, 'keep', (store) =>
      store.keep(parsed.checkpointId, parsed.keep),
    );
  }

  private async handleRename(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(
      checkpointRenamePayloadSchema,
      msg,
      'checkpoint:error',
      this.deps,
    );
    if (!parsed) return;
    await this.change(msg, parsed.checkpointId, 'rename', (store) =>
      store.update(parsed.checkpointId, (checkpoint) => ({ ...checkpoint, name: parsed.name })),
    );
  }

  private async handleIgnoreFields(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(
      checkpointIgnoreFieldsPayloadSchema,
      msg,
      'checkpoint:error',
      this.deps,
    );
    if (!parsed) return;
    await this.change(msg, parsed.checkpointId, 'ignore-fields', (store) =>
      store.update(parsed.checkpointId, (checkpoint) => ({
        ...checkpoint,
        ignoredFields: parsed.fields,
      })),
    );
  }

  /**
   * Change a kept checkpoint's file, and answer with it as it is now. Refused
   * while a take, a rewind or an undo of its org works on it, in this window
   * or in another process: the rewind writes the same file as it ends, and
   * one of the two writes would be lost.
   */
  private async change(
    msg: InboundRequest,
    checkpointId: string,
    what: 'keep' | 'rename' | 'ignore-fields',
    change: (store: OrgCheckpointStore) => Promise<OrgCheckpoint>,
  ): Promise<void> {
    try {
      const m = await this.modules();
      const store = await this.openedStore();
      const { folder } = await this.checkpointOf(store, checkpointId);
      const holder = store.heldBy(folder.organizationId);
      if (
        holder !== undefined &&
        (holder.checkpointId === undefined || holder.checkpointId === checkpointId)
      ) {
        throw new Refused(
          'RUN_WRITING',
          `The checkpoint was not changed: ${holderWords(holder)}. Change it once that has ended.`,
          true,
        );
      }
      let checkpoint: OrgCheckpoint;
      try {
        checkpoint = await change(store);
      } catch (err: unknown) {
        if (err instanceof m.CheckpointStoreError) {
          throw new Refused(
            err.code === 'notFound' ? 'NOT_FOUND' : err.code === 'damaged' ? 'DAMAGED' : 'INVALID',
            err.message,
          );
        }
        throw err;
      }
      this.respond(msg, `checkpoint:${what}:response`, { checkpoint });
    } catch (err: unknown) {
      this.fail(msg, err, 'CHANGE_ERROR');
    }
  }
}
