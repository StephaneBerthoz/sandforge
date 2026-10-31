import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, rename, rm, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import type {
  AuditOutcome,
  CheckpointArchiveHeader,
  CheckpointArchiveSummary,
  CheckpointCustomSettings,
  CheckpointEstimate,
  CheckpointListEntry,
  CheckpointMovedWhileTaken,
  CheckpointRefusal,
  CheckpointRefusalCode,
  CheckpointRewindListed,
  CheckpointScopeMode,
  CheckpointTakeRequests,
  ForgeTargetAutomation,
  ISODateString,
  OrgCheckpoint,
  PipelineCheckpointStepConfig,
  PipelineRewindStepConfig,
  RewindDiff,
  RewindResult,
  RewindStatus,
  SalesforceOrg,
  TriggerType,
} from '@sandforge/shared';
import {
  auditMutedOf,
  isDevelopmentOrg,
  pipelineCheckpointStepConfigSchema,
  pipelineRewindStepConfigSchema,
  rewindGrantDigest,
} from '@sandforge/shared';
import type {
  CheckpointFileDialogs,
  DomainHandler,
  HandlerDeps,
  InboundRequest,
} from './HandlerTypes.js';
import {
  buildResponse,
  sendHandlerError,
  sendOperationCompleted,
  sendOperationProgress,
  sendOperationStarted,
  undeletableAsker,
} from './HandlerTypes.js';
import { listLive } from './liveRun.js';
import {
  checkpointDeletePayloadSchema,
  checkpointExportPayloadSchema,
  checkpointIgnoreFieldsPayloadSchema,
  checkpointImportPayloadSchema,
  checkpointKeepPayloadSchema,
  checkpointListPayloadSchema,
  checkpointPlanSelectionPayloadSchema,
  checkpointPreviewPayloadSchema,
  checkpointRenamePayloadSchema,
  checkpointRewindPayloadSchema,
  checkpointRewindsPayloadSchema,
  checkpointScopePayloadSchema,
  checkpointTakePayloadSchema,
  checkpointUndoPayloadSchema,
  validatePayload,
} from '../validatePayload.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { OrgConnectionError } from '../../core/connection/OrgConnectionError.js';
import { TimeoutManager } from '../../core/engine/TimeoutManager.js';
import { ABORTED_BEFORE_START, recordWriteRun } from '../../modules/audit/auditTrail.js';
import { StepCancelledError } from '../../modules/automation/StepExecutor.js';
import { removalAuditObjects } from '../../modules/forge/removalOutcome.js';
import { withRestoreAudit } from '../../modules/sync/SyncRunRestore.js';
import type { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import type { DetectedSandboxRefresh } from '../../modules/monitor/SandboxRefreshDetector.js';
import type { TargetAutomationReader } from '../../modules/forge/TargetAutomationReader.js';
import {
  muteForRun,
  muteOrgOf,
  type MuteLeaseOptions,
} from '../../modules/forge/AutomationMuteLease.js';
import type { MuteOfWrites } from '../../modules/checkpoint/rewindOrg.js';
import type { Connection } from 'jsforce';
import type { SyncRunKept } from '../../modules/sync/SyncRunCreations.js';
import { THIS_HOST, writtenElsewhere, type RunWriterHost } from '../../modules/sync/runWriter.js';
import type {
  CheckpointFolder,
  CheckpointStoreRefusal,
  OrgCheckpointStore,
  OrgLockHolder,
} from '../../modules/checkpoint/OrgCheckpointStore.js';
import type { TakeProgress, TakeRequest } from '../../modules/checkpoint/takeCheckpoint.js';
import type { ArchiveRead } from '../../modules/checkpoint/checkpointArchive.js';

/** Message types handled by CheckpointHandler. */
const CHECKPOINT_TYPES = new Set([
  'checkpoint:list',
  'checkpoint:scope',
  'checkpoint:take',
  'checkpoint:preview',
  'checkpoint:plan-selection',
  'checkpoint:rewind',
  'checkpoint:undo',
  'checkpoint:delete',
  'checkpoint:keep',
  'checkpoint:rename',
  'checkpoint:ignore-fields',
  'checkpoint:rewinds',
  'checkpoint:export',
  'checkpoint:import-read',
  'checkpoint:import',
]);

/** The module runs are listed under, in the registry and in Live Operations. */
const MODULE = 'checkpoint';

/**
 * The files the page's Import… read that a token still names: the newest
 * ones, as many as a person reads before importing one.
 */
const IMPORT_FILES_KEPT = 8;

/** How long the read of what the org runs as a rewind writes may take: as a removal's. */
const AUTOMATION_TIMEOUT_MS = 60_000;

/** The code a take, a rewind or an undo stopped before it wrote answers with, as the page words it. */
const CANCELLED = 'CANCELLED';

/** How a rewind or an undo that ran is recorded in the audit trail: an unstable one did part of its work. */
const AUDIT_OUTCOMES: Readonly<Record<RewindStatus, AuditOutcome>> = {
  success: 'success',
  partial: 'partial',
  unstable: 'partial',
  failure: 'failure',
  cancelled: 'cancelled',
};

/** What is done to a checkpoint, as the refusal of one whose take never ended words it. */
const ACT_WORDS: Readonly<Record<'preview' | 'rewind' | 'undo' | 'export', string>> = {
  preview: 'previewed',
  rewind: 'rewound to',
  undo: 'used',
  export: 'exported',
};

/** How a rewind or an undo that reached the org ended: what it did, or the refusal it met before writing. */
type WriteOutcome =
  | { done: true; result: RewindResult; notes: string[] }
  | { done: false; refusal: CheckpointRefusal };

/** Refusals worth trying again once what refused them has passed: a run writing, the day's requests. */
const RETRYABLE_REFUSALS: ReadonlySet<CheckpointRefusalCode> = new Set([
  'RUN_WRITING',
  'API_BUDGET',
  'EMAILS',
]);

/** An org's latest checkpoint that can be rewound to, as the side bar's line names it. */
export type LatestUsableCheckpoint = Pick<OrgCheckpoint, 'checkpointId' | 'name' | 'takenAt'>;

/** Where a run's file names the org it writes to, as a checkpoint's org is compared with it. */
interface RunFiles {
  list(): Promise<SyncRunKept[]>;
}

/** What this window writes to orgs, as the handlers that write know it. */
export interface WindowWriters {
  /** Whether a Sync or a Seed run of this window, by its id, is still writing. */
  isRunning?: (runId: string) => boolean;
  /**
   * Whether a run of this window that names no org in a file writes to the
   * registered org: a Forge clone, a Frozen load or its removal, a DataOps
   * restore, masking run or erasure, an Autopilot run, a Real-Time session.
   */
  writingTo?: (orgId: string) => boolean;
}

/** A refusal of an export or an import, by its code, in the words a person reads. */
export interface CheckpointTransferRefusal {
  code: string;
  message: string;
}

/** An export of a kept checkpoint, as the host asks it. */
export interface CheckpointExportRequest {
  checkpointId: string;
  /** Where the file goes: the host's save dialog chose it, or the command line named it; never a page. */
  out: string;
  /** The key to encrypt under, as SandForge shows one: a CI step's. A new one is drawn without it. */
  key?: Buffer;
  /** This SandForge's version, which the file names. */
  sandforgeVersion: string;
}

/** How an export ended. */
export type CheckpointExportAnswer =
  | {
      exported: true;
      checkpoint: OrgCheckpoint;
      header: CheckpointArchiveHeader;
      /** Bytes of the file written, and its sha256, hex. */
      bytes: number;
      sha256: string;
      /** The key drawn for it, as a person is shown it, once: absent when one was given. */
      key?: string;
    }
  | { exported: false; refusal: CheckpointTransferRefusal };

/** A `.sfcheckpoint` file the registered org would import, as the host names it. */
export interface CheckpointImportFile {
  orgId: string;
  /** The file: the host's open dialog chose it, or the command line named it; never a page. */
  file: string;
}

/** What a file holds, and whether the org lets it be imported, asked before any key. */
export type CheckpointImportCheck =
  | { allowed: true; header: CheckpointArchiveHeader }
  | { allowed: false; header?: CheckpointArchiveHeader; refusal: CheckpointTransferRefusal };

/** How an import ended. */
export type CheckpointImportAnswer =
  | {
      imported: true;
      /** `alreadyKept`: the same checkpoint was kept here already, and is left as it is. */
      outcome: 'imported' | 'alreadyKept';
      checkpoint: OrgCheckpoint;
      /** What the person is told once it is kept: the lock is per machine, Undo stays with it. */
      warnings: string[];
    }
  | { imported: false; header?: CheckpointArchiveHeader; refusal: CheckpointTransferRefusal };

// ─── A pipeline's Checkpoint and Rewind steps ────────────────────────────────

/** A pipeline's step, as what it runs is listed in Live Operations and recorded in the audit trail. */
export interface PipelineStepOrigin {
  /** The pipeline's name. */
  pipeline: string;
  /** The step's name. */
  step: string;
  /** The type of the trigger that started the pipeline's run. */
  trigger: TriggerType;
}

/** What a pipeline's Checkpoint step asks for. */
export interface CheckpointPipelineTakeRequest {
  /** Its configuration as saved: read again here by `pipelineCheckpointStepConfigSchema`. */
  config: PipelineCheckpointStepConfig;
  origin: PipelineStepOrigin;
}

/** The checkpoint a pipeline's Checkpoint step took. */
export interface CheckpointPipelineTakeOutcome {
  /** The id its take went under, in Live Operations. */
  operationId: string;
  checkpointId: string;
  name: string;
  /** Records it holds, all objects together. */
  records: number;
  objects: number;
  /** Bytes it takes on this machine. */
  bytes: number;
  movedWhileTaken: CheckpointMovedWhileTaken;
}

/**
 * The confirmation of a pipeline's Rewind step, as the Automation side read
 * it from this machine and found it given for the configuration the step
 * runs: the fields the rewind is bound to.
 */
export interface VerifiedRewindGrant {
  /** The Organization Id of the org it was given for. */
  organizationId: string;
  checkpointId: string;
  /** `rewindGrantDigest` of the configuration it was given for. */
  digest: string;
  /** When it was given: recorded with the rewind in the audit trail. */
  grantedAt: ISODateString;
}

/** What a pipeline's Rewind step asks for. */
export interface CheckpointPipelineRewindRequest {
  /** Its configuration as saved: read again here by `pipelineRewindStepConfigSchema`. */
  config: PipelineRewindStepConfig;
  grant: VerifiedRewindGrant;
  origin: PipelineStepOrigin;
}

/** How a pipeline's rewind ended, once it ran. */
export interface CheckpointPipelineRewindOutcome {
  /** The id it went under, in Live Operations and in the audit trail. */
  operationId: string;
  checkpointId: string;
  /**
   * Its result, whole: `cancelled` for one a Stop ended once it had written,
   * with what it wrote, which its journal keeps and Undo takes back.
   */
  result: RewindResult;
  /** What could not be read, kept or said, in plain words: in the log too. */
  notes: string[];
  /** What the step's own preview said it would cost, before it wrote. */
  estimate: CheckpointEstimate;
}

/**
 * Why a pipeline's Checkpoint or Rewind step did not go through: a refusal
 * before it wrote, its code and its words, or — `UNDELETABLE_UNATTENDED` — a
 * rewind that ran and was left untouched where nobody could be asked, with
 * its result.
 */
export class CheckpointStepRefused extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly result?: RewindResult,
  ) {
    super(message);
    this.name = 'CheckpointStepRefused';
  }
}

/** What a rewind's audit entry says of the pipeline step that ran it, beside what it did. */
interface PipelineRewindAudit {
  origin: PipelineStepOrigin;
  /** When the step's confirmation was given. */
  grantedAt: ISODateString;
}

/** Whose request an act answers, under which id: a page's, or a pipeline's step. */
interface ActAt {
  operationId: string;
  /** Answers the page that asked; nothing waits on a pipeline's step but what the act returns. */
  respond?: (type: string, payload: Record<string, unknown>) => void;
  /** The pipeline step that runs it, recorded with it in the audit trail. */
  pipeline?: PipelineRewindAudit;
}

/** What a take kept, as its answer says it. */
interface TakeKept {
  checkpoint: OrgCheckpoint;
  requests?: CheckpointTakeRequests;
  estimate: CheckpointEstimate;
}

/** What a take is asked, beside the org: the page's request, or a Checkpoint step's configuration. */
interface TakeAsked {
  /** What it is called; with neither this nor {@link nameWithDate}, the date and time of T0. */
  name?: string;
  /** What it is called, each `{date}` put in the place of T0: a Checkpoint step's name. */
  nameWithDate?: string;
  mode: CheckpointScopeMode;
  objects?: string[];
  excluded?: string[];
  customSettings?: CheckpointCustomSettings;
  maxTotal?: number;
  keepDays: number;
  ignoredFields?: string[];
}

/** Whether a rewind wrote anything to the org, as its result counts it. */
function wroteAny(result: RewindResult): boolean {
  return (
    result.deleted.some((object) => object.deleted > 0) ||
    result.restored.some((object) => object.restored + (object.restoredWithout ?? 0) > 0) ||
    result.undeleted.some((object) => object.undeleted > 0) ||
    (result.recreated ?? []).some((object) => object.created > 0)
  );
}

/** The modules a checkpoint's acts run through, loaded on the first request, off the activation path. */
async function loadCheckpointModules() {
  const [store, take, preview, rewind, undo, guard, archive, plan, bounds] = await Promise.all([
    import('../../modules/checkpoint/OrgCheckpointStore.js'),
    import('../../modules/checkpoint/takeCheckpoint.js'),
    import('../../modules/checkpoint/previewCheckpoint.js'),
    import('../../modules/checkpoint/rewindOrg.js'),
    import('../../modules/checkpoint/undoCheckpoint.js'),
    import('../../modules/checkpoint/checkpointGuard.js'),
    import('../../modules/checkpoint/checkpointArchive.js'),
    import('../../modules/checkpoint/rewindPlan.js'),
    import('../../modules/checkpoint/rewindBounds.js'),
  ]);
  return {
    planSelection: plan.planSelection,
    snapshotRowsOf: plan.snapshotRowsOf,
    rewindWriters: plan.rewindWriters,
    boundsRefusal: bounds.boundsRefusal,
    selectionDiff: bounds.selectionDiff,
    notConfirmedRefusal: bounds.notConfirmedRefusal,
    undeletableUnattendedRefusal: bounds.undeletableUnattendedRefusal,
    REWIND_STEP_WORDS: bounds.REWIND_STEP_WORDS,
    guardCheckpoint: guard.guardCheckpoint,
    newArchiveKey: archive.newArchiveKey,
    archiveKeyText: archive.archiveKeyText,
    parseArchiveKey: archive.parseArchiveKey,
    ARCHIVE_EXTENSION: archive.ARCHIVE_EXTENSION,
    exportCheckpointArchive: archive.exportCheckpointArchive,
    CheckpointExportError: archive.CheckpointExportError,
    readArchiveHeader: archive.readArchiveHeader,
    importCheckpointArchive: archive.importCheckpointArchive,
    DEFAULT_KEEP_DAYS: store.DEFAULT_KEEP_DAYS,
    openCheckpointStore: store.openCheckpointStore,
    defaultCheckpointStoreRoot: store.defaultCheckpointStoreRoot,
    scratchOrgExpired: store.scratchOrgExpired,
    previewDirOf: store.previewDirOf,
    CheckpointStoreError: store.CheckpointStoreError,
    takeCheckpoint: take.takeCheckpoint,
    scopeCheckpoint: take.scopeCheckpoint,
    takeOrgOf: take.takeOrgOf,
    CheckpointTakeStopped: take.CheckpointTakeStopped,
    previewCheckpoint: preview.previewCheckpoint,
    rewindOrg: rewind.rewindOrg,
    rewindOrgOf: rewind.rewindOrgOf,
    RewindStopped: rewind.RewindStopped,
    undoCheckpoint: undo.undoCheckpoint,
    UndoStopped: undo.UndoStopped,
  };
}

type CheckpointModules = Awaited<ReturnType<typeof loadCheckpointModules>>;

/** A refusal or a failure the error channel answers with. */
class Refused extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    /** What a rewind did before it was refused, when it ran: one nobody could be asked about. */
    readonly result?: RewindResult,
  ) {
    super(message);
    this.name = 'Refused';
  }
}

/**
 * What a pipeline's step is told of a refusal or a stop: a stop as the step's
 * cancellation, a refusal with its code and words, anything else as it was.
 */
function stepErrorOf(err: unknown): unknown {
  if (err instanceof StepCancelledError) return err;
  if (err instanceof Refused) {
    return err.code === CANCELLED
      ? new StepCancelledError(err.message)
      : new CheckpointStepRefused(err.code, err.message, err.result);
  }
  return err;
}

/** Whether a folder is there. */
async function isFolder(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Whether two Organization Ids name one org: the 15-character id and its 18-character form alike. */
function sameOrganization(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.length >= 15 && a.slice(0, 15) === b.slice(0, 15);
}

/** An Organization Id, in its 15- or 18-character form. */
const ORGANIZATION_ID = /^00D[0-9A-Za-z]{12}(?:[0-9A-Za-z]{3})?$/;

/**
 * The objects a rewind is limited to, by their API names as `checkpoint`
 * holds them, whatever the case they were asked in, each once; undefined when
 * none was asked, every object. One the checkpoint does not hold is refused.
 */
function heldObjectsOf(
  checkpoint: OrgCheckpoint,
  asked: readonly string[] | undefined,
): string[] | undefined {
  if (asked === undefined) return undefined;
  const byName = new Map(
    checkpoint.objects.map(({ objectApiName }) => [objectApiName.toLowerCase(), objectApiName]),
  );
  const unknown = asked.filter((name) => !byName.has(name.toLowerCase()));
  if (unknown.length > 0) {
    throw new Refused(
      'NOT_HELD',
      `The checkpoint '${checkpoint.name}' holds no ${unknown.join(', ')}: a rewind is limited ` +
        'to objects it holds. No record was read or written.',
    );
  }
  return [...new Set(asked.flatMap((name) => byName.get(name.toLowerCase()) ?? []))];
}

/** How the user knows an org: its alias, else its username. */
function nameOf(org: Pick<SalesforceOrg, 'alias' | 'username'>): string {
  return org.alias || org.username;
}

/**
 * `message` with none of `paths` in it: a file named by its name alone, the
 * folders it was in left out, a folder named alone by its own name. What the
 * page is told of an export or an import names no place on this machine,
 * whatever words a failure of the disk came in.
 */
function withoutPaths(message: string, paths: readonly string[]): string {
  const longestFirst = [...paths].sort((a, b) => b.length - a.length);
  let said = message;
  for (const path of longestFirst) said = said.replaceAll(path, basename(path));
  for (const path of longestFirst) {
    const folder = dirname(path);
    if (folder === path || folder.length <= 1) continue;
    said = said.replaceAll(`${folder}${sep}`, '').replaceAll(folder, basename(folder));
  }
  return said;
}

/** What the page is told of a checkpoint file before it asks for the key: its header, without how it is encrypted. */
function archiveSummaryOf(header: CheckpointArchiveHeader): CheckpointArchiveSummary {
  return {
    formatVersion: header.formatVersion,
    checkpointFormat: header.checkpointFormat,
    sandforgeVersion: header.sandforgeVersion,
    organizationId: header.organizationId,
    orgTier: header.orgTier,
    checkpointId: header.checkpointId,
    takenAt: header.takenAt,
    records: header.records,
    objects: header.objects,
    files: header.files,
    bytes: header.bytes,
  };
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
 *   written (`previewCheckpoint`); of a rewind limited to some objects, its
 *   estimate, automation and refusal those of a rewind of them.
 * - `checkpoint:plan-selection` — what a rewind limited to the objects picked
 *   would do and leave, and the objects it depends on: planned on this
 *   machine by the rewind's own plan (`planSelection`) from the folder of the
 *   preview named, as that preview read the org — the org not read, the
 *   plan's folder removed once it is told. A preview this handler did not
 *   answer, or no longer kept, is refused: preview again.
 * - `checkpoint:rewind` — the rewind (`rewindOrg`) on the preview it names,
 *   and `checkpoint:undo` — the undo of the org's last rewind
 *   (`undoCheckpoint`): each under the id of its request, as a take is, in
 *   the registry and in Live Operations, stopped by their Cancel and the
 *   page's Stop between two calls, and held under that id from the request
 *   on. Each holds the org's lock for its whole length, which the engine
 *   takes, and is recorded in the audit trail (`checkpoint_rewind`,
 *   `checkpoint_undo`): what it did, or the refusal it met before writing.
 *   One stopped part way answers with its result; one stopped before it
 *   wrote answers `CANCELLED`.
 * - `checkpoint:delete`, `checkpoint:keep`, `checkpoint:rename`,
 *   `checkpoint:ignore-fields` — changes to the checkpoints on this machine;
 *   the org is not touched.
 * - `checkpoint:rewinds` — the rewinds and undos the ledger of each org's
 *   folder keeps (`rewindLedger.ts`), each line with the registered orgs it
 *   is of, read from this machine alone: what the Seed, Sync and Forge
 *   histories mark a run rewound by.
 *
 * A checkpoint goes to another machine and comes from one through files the
 * host names: {@link CheckpointHandler.exportCheckpoint} writes it,
 * encrypted, to a file the host names, and
 * {@link CheckpointHandler.readImport} then
 * {@link CheckpointHandler.importCheckpoint} keep another machine's here
 * once the org has answered for it. A page names no path: its Export… and
 * Import… pick the file in the window's dialogs (`infraServices.checkpointFiles`).
 *
 * - `checkpoint:export` — the checkpoint refused, before anything is asked,
 *   when it can only be deleted; then the save dialog, the file written, and
 *   the key answered once, with the file's name alone.
 * - `checkpoint:import-read` — the open dialog, the file's header, and the
 *   registered orgs of its Organization Id, each asked live whether it lets
 *   the file be imported — the file's org, no production org, a user who
 *   sees all data — before any key is typed: the first refusal is the
 *   answer when none does. Where the file is stays here, behind a token.
 * - `checkpoint:import` — the file the token names, decrypted with the key
 *   typed and kept for the org named, every check made again in the
 *   engine's order.
 *
 * A pipeline's Checkpoint and Rewind steps go through the host alone too,
 * never a message: {@link CheckpointHandler.takeForPipeline} takes as the
 * page's take does, and {@link CheckpointHandler.rewindForPipeline} rewinds
 * from a preview it reads itself, held to the step's bounds
 * (`rewindBounds.ts`) in the place of the person who would read it, each
 * under an operation id of its own, which no page waits on.
 *
 * Every refusal a guard or a gate gives goes out as it gave it, its code and
 * its words, on `checkpoint:error`: a production org is refused by the
 * checkpoint's own guard, which nothing lifts, and this handler asks no
 * other. The org's lock is the store's, one per org on this machine, taken by
 * the take, the rewind and the undo for their own length, and by nothing
 * else here.
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
   * The previews this handler answered, by id, when a rewind acts on the
   * preview as it was read: see {@link rewindFromPreviewsAnswered}.
   */
  private previewsAnswered?: Map<string, RewindDiff>;
  /**
   * When each preview this handler answered read the org, by its id: what the
   * plan of a selection made from its folder holds the records to.
   */
  private readonly previewReads = new Map<string, { checkpointId: string; readAt: string }>();
  /** Told each time the checkpoints kept on this machine change: see {@link onCheckpointsChanged}. */
  private readonly changeListeners = new Set<() => void>();
  /**
   * The files the page's Import… read, by the token it names each by, oldest
   * first: where a file is never goes to the page.
   */
  private readonly importFiles = new Map<string, string>();

  /** Where and how the mute leases are kept, when not the home directory's. */
  private muteLeases: MuteLeaseOptions = {};

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

  /** Where and how a rewind or an undo that mutes keeps its lease, in place of the home directory's. */
  setMuteLeases(options: MuteLeaseOptions): void {
    this.muteLeases = options;
  }

  /**
   * Rewind from the preview this handler answered, as it read the org,
   * rather than from a fresh read of it: what a command line does, which
   * shows the preview and rewinds in the same command, its Tr the preview's.
   * The panel's rewind reads the org again and acts on what of the preview
   * still differs: a person may confirm a preview long after it was read.
   * Each preview's estimate then prices the rewind that follows it, which
   * reads no fresh diff.
   */
  rewindFromPreviewsAnswered(): void {
    this.previewsAnswered ??= new Map();
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
      case 'checkpoint:plan-selection':
        await this.handlePlanSelection(msg);
        return true;
      case 'checkpoint:rewind':
        await this.handleRewind(msg);
        return true;
      case 'checkpoint:undo':
        await this.handleUndo(msg);
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
      case 'checkpoint:rewinds':
        await this.handleRewinds(msg);
        return true;
      case 'checkpoint:export':
        await this.handleExport(msg);
        return true;
      case 'checkpoint:import-read':
        await this.handleImportRead(msg);
        return true;
      case 'checkpoint:import':
        await this.handleImport(msg);
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
      if (swept.checkpoints.length > 0) this.checkpointsChanged();
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

  /**
   * The registered org's latest checkpoint that can be rewound to, by the
   * rule the Home tile lists them by (`usableCheckpoints`): taken to its end,
   * neither of the org a sandbox was before its refresh nor of a scratch org
   * that has expired. Read from this machine, never from the org. Nothing for
   * an org SandForge does not know, nor for a production org, of which none is
   * ever taken.
   */
  async latestUsableOf(orgId: string): Promise<LatestUsableCheckpoint | undefined> {
    const org = this.deps.orgManager.getOrg(orgId);
    if (!org || !isDevelopmentOrg(org)) return undefined;
    const store = await this.openedStore();
    const latest = (await this.listOfOrg(store, orgId)).find(
      (entry) => entry.valid && entry.checkpoint !== undefined,
    )?.checkpoint;
    return latest
      ? { checkpointId: latest.checkpointId, name: latest.name, takenAt: latest.takenAt }
      : undefined;
  }

  /**
   * Call `listener` each time a checkpoint is kept, changed or deleted on
   * this machine by this window: a take kept, a rename, a Keep, a change of
   * the fields compared, a deletion, the sweep of those past their date. A
   * rewind and its undo leave what the side bar names of a checkpoint as it
   * was, and tell nothing.
   *
   * @returns What stops the calls.
   */
  onCheckpointsChanged(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  // ─── A pipeline's Checkpoint and Rewind steps ──────────────────────────────

  /**
   * Take a checkpoint for a pipeline's Checkpoint step as the page takes one,
   * with nobody to watch it: the take's own guards read live — no production
   * org, whatever the registry says; the user's permissions — the org's lock,
   * the runs this window writes to it, its limits, listed in the registry and
   * in Live Operations, whose Cancel and the step's `signal` stop it between
   * two reads. Each `{date}` of its name is put in the place of T0.
   *
   * @returns The checkpoint kept, as the step's output names it.
   * @throws {CheckpointStepRefused} When the take is refused before it reads
   *   a record — the org not connected, a configuration that does not read,
   *   the take's own refusals (production, permissions, the lock, a run
   *   writing, its limits, the day's requests) — with the refusal's code and
   *   words.
   * @throws {StepCancelledError} When it was stopped: nothing of it is kept.
   * @throws The take's error when it fails: nothing of it is kept.
   */
  async takeForPipeline(
    request: CheckpointPipelineTakeRequest,
    signal?: AbortSignal,
  ): Promise<CheckpointPipelineTakeOutcome> {
    const operationId = `checkpoint:pipeline:${randomUUID()}`;
    try {
      const read = pipelineCheckpointStepConfigSchema.safeParse(request.config);
      if (!read.success) {
        throw new Refused(
          'CONFIG_INVALID',
          `The Checkpoint step "${request.origin.step}" does not read: ` +
            `${read.error.issues[0]?.message ?? 'its configuration is not one'}. Nothing was read.`,
        );
      }
      const config = read.data;
      const org = this.registeredOrg(config.orgId);
      const m = await this.modules();
      const store = await this.openedStore();
      const conn = await this.connect(org);
      if (signal?.aborted) throw new Refused(CANCELLED, new m.CheckpointTakeStopped().message);
      const { checkpoint } = await this.take(
        operationId,
        m,
        store,
        conn,
        org,
        {
          ...(config.name !== undefined ? { nameWithDate: config.name } : {}),
          mode: config.mode,
          ...(config.objects !== undefined ? { objects: config.objects } : {}),
          ...(config.excluded !== undefined ? { excluded: config.excluded } : {}),
          ...(config.maxTotal !== undefined ? { maxTotal: config.maxTotal } : {}),
          keepDays: config.keepDays,
          ...(config.ignoredFields !== undefined ? { ignoredFields: config.ignoredFields } : {}),
        },
        {
          description: `Pipeline '${request.origin.pipeline}': taking a checkpoint of ${nameOf(org)}`,
          ...(signal ? { signal } : {}),
        },
      );
      return {
        operationId,
        checkpointId: checkpoint.checkpointId,
        name: checkpoint.name,
        records: checkpoint.objects.reduce((total, object) => total + object.records, 0),
        objects: checkpoint.objects.length,
        bytes: checkpoint.bytes,
        movedWhileTaken: checkpoint.movedWhileTaken,
      };
    } catch (err: unknown) {
      throw stepErrorOf(err);
    }
  }

  /**
   * Rewind an org for a pipeline's Rewind step, with nobody to read its
   * preview nor to type the org's alias: the confirmation the Automation side
   * verified stands for the alias, and the step's bounds for the person who
   * would read the preview. In order, each refusal saying why, nothing
   * written:
   *
   * 1. the configuration reads, and the confirmation is the one given for it
   *    (`rewindGrantDigest`) and for its checkpoint's org (`NOT_CONFIRMED`);
   * 2. the checkpoint is kept here, can be rewound to, and is of the org the
   *    step names; the objects it is limited to are some it holds;
   * 3. a fresh preview, read by the step itself — never one the panel
   *    answered, which stays as it was: the guard read live (production, the
   *    same Organization Id, the user's permissions), then the org's lock, a
   *    run writing, the day's requests, the emails and the file storage its
   *    writes would take;
   * 4. the bounds (`rewindBounds.ts`): records past `maxRecords`, people at
   *    work in the org in the hour before (`refuseWhenActive`), an acceptance
   *    it needs and the configuration does not give, the emails of a daily
   *    limit;
   * 5. the rewind, from that preview as read (`reusesPreview`, for this call
   *    alone), under the org's lock, in the registry and in Live Operations,
   *    whose Cancel and the step's `signal` stop it before its next call. A
   *    deletion of records its user may not delete is answered no, with
   *    nobody to ask: left untouched (`UNDELETABLE_UNATTENDED`).
   *
   * Recorded in the audit trail (`checkpoint_rewind`) with what it did, or the
   * refusal it met once the org was read, beside the pipeline, the step, the
   * trigger's type and when the step was confirmed.
   *
   * @returns How the rewind ended: its result whole, one a Stop ended once it
   *   had written included (`cancelled`).
   * @throws {CheckpointStepRefused} When it was refused: before it wrote,
   *   with the refusal's code and words; `UNDELETABLE_UNATTENDED` with the
   *   result of the rewind that was left untouched.
   * @throws {StepCancelledError} When it was stopped before it wrote anything.
   * @throws A read's or the rewind's error when it fails.
   */
  async rewindForPipeline(
    request: CheckpointPipelineRewindRequest,
    signal?: AbortSignal,
  ): Promise<CheckpointPipelineRewindOutcome> {
    const operationId = `checkpoint:pipeline:${randomUUID()}`;
    const { grant, origin } = request;
    try {
      const m = await this.modules();
      const read = pipelineRewindStepConfigSchema.safeParse(request.config);
      if (!read.success) {
        throw new Refused(
          'CONFIG_INVALID',
          `The Rewind step "${origin.step}" does not read: ` +
            `${read.error.issues[0]?.message ?? 'its configuration is not one'}. No record was ` +
            'read or written.',
        );
      }
      const config = read.data;
      if (
        grant.digest !== rewindGrantDigest(config) ||
        grant.checkpointId !== config.checkpointId
      ) {
        throw this.refusalOf(m.notConfirmedRefusal(origin.step, true));
      }
      const store = await this.openedStore();
      const { folder, checkpoint } = await this.checkpointOf(store, config.checkpointId);
      if (!sameOrganization(grant.organizationId, checkpoint.org.organizationId)) {
        throw this.refusalOf(m.notConfirmedRefusal(origin.step, true));
      }
      this.usable(m, checkpoint, 'rewind');
      const org = this.registeredOrg(config.orgId);
      if (
        !sameOrganization(org.orgId, checkpoint.org.organizationId) &&
        !sameOrganization(
          this.deps.sandboxRefreshes?.organizationIdOf(org.id),
          checkpoint.org.organizationId,
        )
      ) {
        throw new Refused(
          'OTHER_ORG',
          `The checkpoint '${checkpoint.name}' is not of ${nameOf(org)}, the org the Rewind step ` +
            `"${origin.step}" names. No record was read or written.`,
        );
      }
      const objects = heldObjectsOf(checkpoint, config.objects);
      const conn = await this.connect(org);
      const orgName = nameOf(org);
      const at: ActAt = { operationId, pipeline: { origin, grantedAt: grant.grantedAt } };
      // Recorded once the org is reached, as the panel records a rewind stopped before it starts.
      const stopped = (): StepCancelledError => {
        this.audit(at, 'rewind', org, checkpoint, 'stopped', { code: ABORTED_BEFORE_START });
        return new StepCancelledError(new m.RewindStopped().message);
      };
      const refuse = (refusal: CheckpointRefusal): Refused => {
        this.audit(at, 'rewind', org, checkpoint, 'stopped', { code: refusal.code });
        return this.refusalOf(refusal);
      };
      if (signal?.aborted) throw stopped();

      let preview: Awaited<ReturnType<CheckpointModules['previewCheckpoint']>>;
      try {
        preview = await m.previewCheckpoint(
          {
            org: m.takeOrgOf(conn),
            store,
            readAutomation: (written) => this.readAutomation(org.id, written),
            runWriting: this.runWriting(
              org.id,
              orgName,
              'rewind',
              'No record would be read or written.',
            ),
            ...(signal ? { signal } : {}),
          },
          {
            checkpoint,
            folder,
            orgName,
            registered: org,
            username: org.username,
            ...(objects !== undefined ? { objects } : {}),
            // The rewind acts on this preview as read: priced so.
            reusesPreview: true,
          },
        );
      } catch (err: unknown) {
        if (signal?.aborted) throw stopped();
        throw err;
      }
      // The guard's refusal, or the one the rewind would meet now.
      if (!preview.previewed) throw refuse(preview.refusal);
      if (preview.refusal !== undefined) throw refuse(preview.refusal);
      // Of a rewind of some objects, the counts its plan acts on.
      const acted =
        objects !== undefined
          ? m.selectionDiff(
              preview.diff,
              await m.planSelection({
                checkpoint,
                previewDir: m.previewDirOf(folder, preview.diff.previewId),
                readAt: preview.diff.readAt,
                objects: new Set(objects),
                acceptOutside: config.acceptOutside,
                heldRows: m.snapshotRowsOf(checkpoint, folder),
                ...(signal ? { signal } : {}),
              }),
            )
          : preview.diff;
      const bound = await m.boundsRefusal({
        orgName,
        preview: {
          diff: acted,
          ...(preview.automation ? { automation: preview.automation } : {}),
          ...(preview.emails ? { emails: preview.emails } : {}),
          ...(preview.emailsUncounted !== undefined
            ? { emailsUncounted: preview.emailsUncounted }
            : {}),
        },
        bounds: { maxRecords: config.maxRecords, refuseWhenActive: config.refuseWhenActive },
        accepted: config,
        writers: async () => m.rewindWriters(checkpoint.takenBy, await m.takeOrgOf(conn).userId()),
        words: m.REWIND_STEP_WORDS,
        user: org.username,
      });
      if (bound !== undefined) throw refuse(bound);
      if (signal?.aborted) throw stopped();

      // Nobody is there to say whether to delete the rest.
      const declined: Array<{ objectApiName: string; records: number }> = [];
      let notes: string[] = [];
      const result = await this.writeAct(
        at,
        'rewind',
        org,
        checkpoint,
        `Pipeline '${origin.pipeline}': rewinding ${orgName} to '${checkpoint.name}'`,
        async (stop, onProgress) => {
          const outcome = await m.rewindOrg(
            {
              org: m.rewindOrgOf(conn),
              undelete: (ids) => conn.soap.undelete(ids),
              store,
              readAutomation: (written) => this.readAutomation(org.id, written),
              runWriting: this.runWriting(
                org.id,
                orgName,
                'rewind',
                'No record was read or written.',
              ),
              onUndeletable: (undeletable) => {
                declined.push(...undeletable);
                this.deps.log(
                  `[WARN] checkpoint:rewind ${operationId}: the user may not delete ` +
                    `${undeletable.map((o) => `${o.objectApiName} (${o.records})`).join(', ')} ` +
                    'in the target, and nobody runs the pipeline to be asked: the deletion is left untouched',
                );
                return Promise.resolve(false);
              },
              onProgress: ({ percentage, step }) => onProgress(percentage, step),
              signal: stop,
            },
            {
              checkpoint,
              folder,
              orgName,
              registered: org,
              username: org.username,
              previewId: preview.diff.previewId,
              reusesPreview: preview.diff,
              ...(objects !== undefined ? { objects } : {}),
              acceptAutomation: config.acceptAutomation,
              acceptNoUndo: config.acceptNoUndo,
              acceptRecreate: config.acceptRecreate,
              acceptOutside: config.acceptOutside,
              acceptUnseen: config.acceptUnseen,
            },
          );
          if (outcome.rewound) notes = outcome.notes;
          return outcome.rewound
            ? { done: true, result: outcome.result, notes: outcome.notes }
            : { done: false, refusal: outcome.refusal };
        },
        (err) => err instanceof m.RewindStopped,
        {
          ...(signal ? { signal } : {}),
          refusalOf: (ended) =>
            declined.length > 0
              ? m.undeletableUnattendedRefusal(orgName, declined, wroteAny(ended))
              : undefined,
        },
      );
      return {
        operationId,
        checkpointId: checkpoint.checkpointId,
        result,
        notes,
        estimate: preview.estimate,
      };
    } catch (err: unknown) {
      throw stepErrorOf(err);
    }
  }

  // ─── A checkpoint to another machine, and from one ─────────────────────────

  /**
   * Export a kept checkpoint to a `.sfcheckpoint` file (`checkpointArchive.ts`),
   * encrypted under the key given — a CI step's — or under one drawn here,
   * which the answer carries once and nothing keeps. The org is not
   * contacted. Refused for a checkpoint that can only be deleted, as a
   * preview refuses it, and for a file there already. Recorded in the audit
   * trail (`checkpoint_export`) with its counts and its org, never the
   * file's path nor the key, which no log line names either.
   */
  async exportCheckpoint(request: CheckpointExportRequest): Promise<CheckpointExportAnswer> {
    try {
      const m = await this.modules();
      const store = await this.openedStore();
      const { folder, checkpoint } = await this.checkpointOf(store, request.checkpointId);
      this.usable(m, checkpoint, 'export');
      const key = request.key ?? m.newArchiveKey();
      const exported = await m.exportCheckpointArchive({
        folder,
        checkpoint,
        out: request.out,
        key,
        sandforgeVersion: request.sandforgeVersion,
      });
      const { header } = exported;
      recordWriteRun(this.deps, {
        action: 'checkpoint_export',
        module: MODULE,
        operationId: randomUUID(),
        orgId: this.orgOfCheckpoint(checkpoint)?.id ?? checkpoint.org.organizationId,
        outcome: 'success',
        details: {
          checkpointId: checkpoint.checkpointId,
          records: header.records,
          objects: header.objects,
          files: header.files,
          bytes: exported.bytes,
        },
      });
      return {
        exported: true,
        checkpoint,
        header,
        bytes: exported.bytes,
        sha256: exported.sha256,
        ...(request.key === undefined ? { key: m.archiveKeyText(key) } : {}),
      };
    } catch (err: unknown) {
      return { exported: false, refusal: await this.transferRefusalOf(err, 'EXPORT_ERROR') };
    }
  }

  /**
   * What a `.sfcheckpoint` file holds, from its header, and whether the
   * registered org lets it be imported, asked before any key: the file must
   * be one this SandForge reads, and the org must answer live that it is the
   * file's org, no production org, and that its user sees and changes all
   * data — this machine never holds what its user could not see in the org.
   * Nothing is decrypted, nothing kept.
   */
  async readImport(request: CheckpointImportFile): Promise<CheckpointImportCheck> {
    const checked = await this.importChecked(request);
    if ('refusal' in checked) return { allowed: false, ...checked };
    return { allowed: true, header: checked.read.header };
  }

  /**
   * Import a `.sfcheckpoint` file another machine exported: the checks of
   * {@link readImport} made again, then the file decrypted with `key` and
   * kept as a checkpoint of the org on this machine, listed under its alias
   * here, kept `keepDays` (30 unless given). The same checkpoint kept here
   * already is left as it is, `alreadyKept`; another of its id refuses it.
   * Recorded in the audit trail (`checkpoint_import`) with its counts and its
   * org, or the refusal's code, never the file's path nor the key.
   */
  async importCheckpoint(
    request: CheckpointImportFile & { key: Buffer; keepDays?: number },
  ): Promise<CheckpointImportAnswer> {
    const checked = await this.importChecked(request);
    const audit = (
      orgId: string,
      outcome: AuditOutcome,
      header: CheckpointArchiveHeader | undefined,
      extra: { code?: string; alreadyKept?: true } = {},
    ): void => {
      recordWriteRun(this.deps, {
        action: 'checkpoint_import',
        module: MODULE,
        operationId: randomUUID(),
        orgId,
        outcome,
        ...(extra.code !== undefined ? { code: extra.code } : {}),
        details: {
          ...(header
            ? {
                checkpointId: header.checkpointId,
                records: header.records,
                objects: header.objects,
              }
            : {}),
          ...(extra.alreadyKept ? { alreadyKept: true } : {}),
        },
      });
    };
    if ('refusal' in checked) {
      if (checked.orgId !== undefined) {
        audit(checked.orgId, 'stopped', checked.header, { code: checked.refusal.code });
      }
      return {
        imported: false,
        refusal: checked.refusal,
        ...(checked.header ? { header: checked.header } : {}),
      };
    }
    const { m, store, org, read } = checked;
    try {
      const done = await m.importCheckpointArchive({
        store,
        file: request.file,
        read,
        key: request.key,
        ...(org.alias ? { alias: org.alias } : {}),
        keepDays: request.keepDays ?? m.DEFAULT_KEEP_DAYS,
        takenOn: { host: hostname(), pid: process.pid },
      });
      if (!done.imported) {
        audit(org.id, 'stopped', read.header, { code: done.refusal.code });
        return { imported: false, header: read.header, refusal: done.refusal };
      }
      audit(
        org.id,
        'success',
        read.header,
        done.outcome === 'alreadyKept' ? { alreadyKept: true } : {},
      );
      if (done.outcome === 'imported') this.checkpointsChanged();
      const orgName = nameOf(org);
      return {
        imported: true,
        outcome: done.outcome,
        checkpoint: done.checkpoint,
        warnings: [
          `Rewinds of ${orgName} from two machines at once fight each other: the lock is per ` +
            'machine. Agree on who rewinds.',
          'A field your user cannot see is neither compared nor written back by a rewind from ' +
            'this machine, and its preview names it.',
          'The rewinds made from the machine it came from, and their Undo, stayed there.',
        ],
      };
    } catch (err: unknown) {
      audit(org.id, 'failure', read.header);
      return {
        imported: false,
        header: read.header,
        refusal: await this.transferRefusalOf(err, 'IMPORT_ERROR'),
      };
    }
  }

  /**
   * The file's header and the org's answer to it, as {@link readImport} says
   * them: the registered org, its connection's guard on the file's
   * Organization Id. An org the registry knows was that id before a refresh
   * is told so.
   */
  private async importChecked(request: CheckpointImportFile): Promise<
    | {
        m: CheckpointModules;
        store: OrgCheckpointStore;
        org: SalesforceOrg;
        read: ArchiveRead;
      }
    | { refusal: CheckpointTransferRefusal; header?: CheckpointArchiveHeader; orgId?: string }
  > {
    let header: CheckpointArchiveHeader | undefined;
    let orgId: string | undefined;
    try {
      const m = await this.modules();
      const store = await this.openedStore();
      const org = this.registeredOrg(request.orgId);
      orgId = org.id;
      const opened = await m.readArchiveHeader(request.file);
      if ('refusal' in opened) return { refusal: opened.refusal, orgId };
      header = opened.read.header;
      const conn = await this.connect(org);
      const guarded = await m.guardCheckpoint(conn, {
        act: 'import',
        orgName: nameOf(org),
        registered: org,
        username: org.username,
        organizationId: header.organizationId,
      });
      if (!guarded.allowed) {
        const refreshed =
          guarded.refusal.code === 'OTHER_ORG'
            ? this.refreshedAt(header.organizationId)
            : undefined;
        const refusal =
          refreshed !== undefined
            ? {
                code: 'OTHER_ORG',
                message:
                  `The sandbox this file's checkpoint was taken of was refreshed on ` +
                  `${refreshed.slice(0, 10)}: ${nameOf(org)} is another org now, and the ` +
                  'checkpoint can no longer be rewound to. Nothing was imported.',
              }
            : guarded.refusal;
        return { refusal, header, orgId };
      }
      return { m, store, org, read: opened.read };
    } catch (err: unknown) {
      return {
        refusal: await this.transferRefusalOf(err, 'IMPORT_ERROR'),
        ...(header ? { header } : {}),
        ...(orgId !== undefined ? { orgId } : {}),
      };
    }
  }

  /** An export's or an import's failure, as its answer says it: a refusal as it was given. */
  private async transferRefusalOf(err: unknown, code: string): Promise<CheckpointTransferRefusal> {
    if (err instanceof Refused) return { code: err.code, message: err.message };
    const m = await this.modules().catch(() => undefined);
    if (m !== undefined && err instanceof m.CheckpointExportError) {
      return { code: err.code, message: err.message };
    }
    return { code, message: extractErrorMessage(err) };
  }

  // ─── The page's Export… and Import… ────────────────────────────────────────

  /**
   * Export… on the page: the checkpoint refused, before the save dialog
   * asks anything, when it can only be deleted; then the dialog, the file
   * written by {@link exportCheckpoint}, and the key drawn for it answered
   * once, with the file's name alone. A file there already is one the person
   * confirmed to replace in the dialog: the new one is written beside it and
   * takes its place once whole, so what was there stays until then.
   */
  private async handleExport(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(
      checkpointExportPayloadSchema,
      msg,
      'checkpoint:error',
      this.deps,
    );
    if (!parsed) return;
    const paths: string[] = [];
    try {
      const dialogs = this.fileDialogs('export');
      const m = await this.modules();
      const store = await this.openedStore();
      paths.push(store.root);
      const { checkpoint } = await this.checkpointOf(store, parsed.checkpointId);
      this.usable(m, checkpoint, 'export');
      const { checkpointId } = checkpoint;
      // Named by its id, not its name: a name may carry a client's, and the
      // file travels.
      const out = await dialogs.pickExportFile(`${checkpointId}${m.ARCHIVE_EXTENSION}`);
      if (out === undefined) {
        this.respond(msg, 'checkpoint:export:response', { status: 'cancelled', checkpointId });
        return;
      }
      paths.push(out);
      const replaces = await lstat(out).then(
        () => true,
        () => false,
      );
      const written = replaces
        ? join(dirname(out), `.${basename(out)}.${randomBytes(4).toString('hex')}.export`)
        : out;
      paths.push(written);
      const answer = await this.exportCheckpoint({
        checkpointId,
        out: written,
        sandforgeVersion: dialogs.sandforgeVersion,
      });
      if (!answer.exported) throw new Refused(answer.refusal.code, answer.refusal.message);
      if (replaces) {
        try {
          await rename(written, out);
        } catch (err: unknown) {
          await rm(written, { force: true });
          throw err;
        }
      }
      this.respond(msg, 'checkpoint:export:response', {
        status: 'saved',
        checkpointId,
        fileName: basename(out),
        key: answer.key,
        records: answer.header.records,
        objects: answer.header.objects,
        bytes: answer.bytes,
      });
    } catch (err: unknown) {
      this.fail(msg, this.pathless(err, paths, 'EXPORT_ERROR'), 'EXPORT_ERROR');
    }
  }

  /**
   * Import… on the page: the open dialog, the file's header, and the orgs
   * registered here that are, or were before a refresh, its org, each asked
   * live by {@link readImport} before any key is typed. Answered with the
   * orgs that let it be imported, under a token that names the file; with
   * the first refusal when an org of it is registered and none lets it; with
   * no org when none is registered.
   */
  private async handleImportRead(msg: InboundRequest): Promise<void> {
    const paths: string[] = [];
    try {
      const dialogs = this.fileDialogs('import');
      const m = await this.modules();
      const store = await this.openedStore();
      paths.push(store.root);
      const file = await dialogs.pickImportFile();
      if (file === undefined) {
        this.respond(msg, 'checkpoint:import-read:response', { status: 'cancelled' });
        return;
      }
      paths.push(file);
      const opened = await m.readArchiveHeader(file);
      if ('refusal' in opened) throw this.refusalOf(opened.refusal);
      const { header } = opened.read;
      const orgIds: string[] = [];
      let refusal: CheckpointTransferRefusal | undefined;
      for (const org of this.deps.orgManager.getAllOrgs()) {
        const ids = this.organizationIdsOf(org.id);
        if (!ids.some((id) => sameOrganization(id, header.organizationId))) continue;
        const check = await this.readImport({ orgId: org.id, file });
        if (check.allowed) orgIds.push(org.id);
        else refusal ??= check.refusal;
      }
      if (orgIds.length === 0 && refusal !== undefined) {
        throw new Refused(refusal.code, refusal.message);
      }
      const keptHere = (await store.read(header.checkpointId)) !== undefined;
      this.respond(msg, 'checkpoint:import-read:response', {
        status: 'read',
        token: this.keepImportFile(file),
        fileName: basename(file),
        summary: archiveSummaryOf(header),
        orgIds,
        ...(keptHere ? { keptHere: true } : {}),
      });
    } catch (err: unknown) {
      this.fail(msg, this.pathless(err, paths, 'IMPORT_ERROR'), 'IMPORT_ERROR');
    }
  }

  /**
   * The import the page confirmed, of the file its token names, for the org
   * named, by {@link importCheckpoint}: every check made again, in the
   * engine's order. What the org refuses comes before the key typed, a key
   * that is no key SandForge draws included.
   */
  private async handleImport(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(
      checkpointImportPayloadSchema,
      msg,
      'checkpoint:error',
      this.deps,
    );
    if (!parsed) return;
    const file = this.importFiles.get(parsed.token);
    const paths = file !== undefined ? [file] : [];
    try {
      if (file === undefined) {
        throw new Refused(
          'IMPORT_FILE_GONE',
          'This window no longer knows the file to import: choose it again with Import…. ' +
            'Nothing was imported.',
        );
      }
      const m = await this.modules();
      paths.push((await this.openedStore()).root);
      const key = m.parseArchiveKey(parsed.key);
      if (key === undefined) {
        const check = await this.readImport({ orgId: parsed.orgId, file });
        if (!check.allowed) throw new Refused(check.refusal.code, check.refusal.message);
        throw new Refused(
          'IMPORT_KEY',
          'That is not a key SandForge draws: 52 letters and digits, in groups of four as the ' +
            'export showed it. Nothing was imported.',
        );
      }
      const answer = await this.importCheckpoint({
        orgId: parsed.orgId,
        file,
        key,
        keepDays: parsed.keepDays,
      });
      if (!answer.imported) throw new Refused(answer.refusal.code, answer.refusal.message);
      this.importFiles.delete(parsed.token);
      this.respond(msg, 'checkpoint:import:response', {
        checkpoint: answer.checkpoint,
        outcome: answer.outcome,
      });
    } catch (err: unknown) {
      this.fail(msg, this.pathless(err, paths, 'IMPORT_ERROR'), 'IMPORT_ERROR');
    }
  }

  /** The window's dialogs, or the refusal of a page's Export… or Import… without them. */
  private fileDialogs(act: 'export' | 'import'): CheckpointFileDialogs {
    const dialogs = this.deps.infraServices?.checkpointFiles;
    if (!dialogs) {
      throw new Refused(
        'NO_FILE_DIALOG',
        act === 'export'
          ? 'This window has no dialog to ask where the file goes: export the checkpoint with ' +
              'sandforge-checkpoint export. Nothing was written.'
          : 'This window has no dialog to ask which file to read: import it with ' +
              'sandforge-checkpoint import. Nothing was imported.',
      );
    }
    return dialogs;
  }

  /** A token naming `file` for the page, the oldest one forgotten past {@link IMPORT_FILES_KEPT}. */
  private keepImportFile(file: string): string {
    const token = randomUUID();
    this.importFiles.set(token, file);
    for (const old of this.importFiles.keys()) {
      if (this.importFiles.size <= IMPORT_FILES_KEPT) break;
      this.importFiles.delete(old);
    }
    return token;
  }

  /** A failure of an export or an import as the page is told it: a refusal, naming none of `paths`. */
  private pathless(err: unknown, paths: readonly string[], code: string): Refused {
    const refused = err instanceof Refused ? err : new Refused(code, extractErrorMessage(err));
    return new Refused(refused.code, withoutPaths(refused.message, paths), refused.retryable);
  }

  /** Tell the listeners the checkpoints kept have changed: one that throws stops neither the others nor the request. */
  private checkpointsChanged(): void {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch (err: unknown) {
        this.deps.log(`[WARN] A listener of the checkpoints failed: ${extractErrorMessage(err)}`);
      }
    }
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
   * kept: its scope, the objects left out of it, the custom settings it holds
   * by name and the limit of its records, which the command line names
   * (`--exclude-object`, `--custom-setting`, `--max-total`).
   */
  private takeRequestOf(
    org: SalesforceOrg,
    scope: {
      mode: CheckpointScopeMode;
      objects?: readonly string[];
      excluded?: readonly string[];
      customSettings?: CheckpointCustomSettings;
      maxTotal?: number;
    },
  ): TakeRequest {
    const expires = org.metadata?.expirationDate;
    const { mode, objects, excluded, customSettings, maxTotal } = scope;
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
      ...(customSettings !== undefined ? { customSettings } : {}),
      ...(maxTotal !== undefined ? { maxTotal } : {}),
    };
  }

  /**
   * Whether a run of this machine writes to the registered org `orgId`, the
   * Organization Id `organizationId`: a run of this window its handler says
   * writes to it (`WindowWriters.writingTo`), or a Sync or Seed run — a CSV
   * import's and a clone's among them — whose file has no end, still written
   * by this window or by another process alive. Said as a
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
      if (this.writers.writingTo?.(orgId) === true) return words;
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
   * The checkpoints of a registered org, those of every Organization Id it
   * was: ids are named by when the take began, so newest first, across them.
   */
  private async listOfOrg(
    store: OrgCheckpointStore,
    orgId: string,
  ): Promise<CheckpointListEntry[]> {
    const refreshedAt = (organizationId: string): string | undefined =>
      this.refreshedAt(organizationId);
    const lists = await Promise.all(
      this.organizationIdsOf(orgId).map((organizationId) =>
        store.list({ organizationId, refreshedAt }),
      ),
    );
    return lists
      .flat()
      .sort((a, b) =>
        a.checkpointId < b.checkpointId ? 1 : a.checkpointId > b.checkpointId ? -1 : 0,
      );
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

  /**
   * Refuse to preview, rewind to or undo a rewind of a checkpoint that cannot
   * be: one whose take is under way, never ended or failed, one of the org a
   * sandbox was before its refresh, and one of a scratch org that has expired.
   * Each can only be deleted; none of these reads the org.
   */
  private usable(
    m: CheckpointModules,
    checkpoint: OrgCheckpoint,
    act: 'preview' | 'rewind' | 'undo' | 'export',
  ): void {
    const kept = checkpoint.org.alias ?? checkpoint.org.username;
    if (checkpoint.status !== 'ready') {
      throw new Refused(
        checkpoint.status === 'taking' ? 'TAKING' : 'FAILED',
        checkpoint.status === 'taking'
          ? `The checkpoint '${checkpoint.name}' is being taken, or its take never ended: it can be ${ACT_WORDS[act]} once taken, or deleted.`
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
  }

  /** The registered org a checkpoint is of, or a refusal saying to connect it to `then`. */
  private connectedOrgOf(checkpoint: OrgCheckpoint, then: string): SalesforceOrg {
    const org = this.orgOfCheckpoint(checkpoint);
    if (!org) {
      const kept = checkpoint.org.alias ?? checkpoint.org.username;
      throw new Refused(
        'ORG_NOT_FOUND',
        `${kept} is not connected in SandForge: connect it to ${then}.`,
      );
    }
    return org;
  }

  /**
   * Refuse the undo of a rewind the list does not offer to undo: Undo is
   * offered for an org's last rewind only, until the recycle bin's 15 days
   * after it are over, while its journal is kept, and until it is undone.
   */
  private async undoOffered(
    store: OrgCheckpointStore,
    folder: CheckpointFolder,
    checkpoint: OrgCheckpoint,
    rewindId: string,
  ): Promise<void> {
    const entry = (
      await store.list({
        organizationId: folder.organizationId,
        refreshedAt: (organizationId) => this.refreshedAt(organizationId),
      })
    ).find((listed) => listed.checkpointId === checkpoint.checkpointId);
    if (entry?.undo?.rewindId === rewindId) return;
    const last = checkpoint.lastRewind;
    const why =
      last?.rewindId !== rewindId
        ? `the rewind ${rewindId} is not the last rewind to '${checkpoint.name}'`
        : last.undoneAt !== undefined
          ? `it was undone on ${last.undoneAt.slice(0, 10)}, and there is nothing left to undo`
          : last.undoUntil !== undefined && Date.parse(last.undoUntil) <= Date.now()
            ? `its 15 days ended on ${last.undoUntil.slice(0, 10)}, and what it deleted may have left the recycle bin`
            : 'Undo is offered for the last rewind of an org only, while its journal is kept on this machine';
    throw new Refused(
      'UNDO_CLOSED',
      `This rewind can no longer be undone: ${why}. No record was read or written.`,
    );
  }

  /**
   * Record a rewind or an undo in the audit trail: what it did, or why it
   * stopped before writing. A pipeline step's rewind names, in its details,
   * the pipeline, the step, the type of the trigger that started the run and
   * when the step's confirmation was given (`pipeline`, `step`, `trigger`,
   * `grantedAt`), as an Approval step's entry names its pipeline: the entry
   * has no field of its own for where a run came from.
   */
  private audit(
    at: Pick<ActAt, 'operationId' | 'pipeline'>,
    act: 'rewind' | 'undo',
    org: SalesforceOrg,
    checkpoint: OrgCheckpoint,
    outcome: AuditOutcome,
    extra: { result?: RewindResult; code?: string; rewindId?: string } = {},
  ): void {
    const { result, code } = extra;
    const rewindId = result?.rewindId ?? extra.rewindId;
    const pipeline = at.pipeline;
    recordWriteRun(this.deps, {
      action: act === 'rewind' ? 'checkpoint_rewind' : 'checkpoint_undo',
      module: MODULE,
      operationId: at.operationId,
      orgId: org.id,
      outcome,
      ...(result
        ? {
            objects: withRestoreAudit(
              removalAuditObjects(result.deleted),
              result.restored,
              result.undeleted,
            ),
          }
        : {}),
      ...(code !== undefined ? { code } : {}),
      ...(result?.mutedAutomation ? { muted: auditMutedOf(result.mutedAutomation) } : {}),
      details: {
        checkpointId: checkpoint.checkpointId,
        ...(rewindId !== undefined ? { rewindId } : {}),
        ...(result ? { status: result.status, passes: result.passes } : {}),
        ...(result?.scope ? { limitedTo: result.scope.objects.join(', ') } : {}),
        ...(pipeline
          ? {
              pipeline: pipeline.origin.pipeline,
              step: pipeline.origin.step,
              trigger: pipeline.origin.trigger,
              grantedAt: pipeline.grantedAt,
            }
          : {}),
      },
    });
  }

  // ─── The requests ──────────────────────────────────────────────────────────

  private async handleList(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(checkpointListPayloadSchema, msg, 'checkpoint:error', this.deps);
    if (parsed === null) return;
    try {
      const store = await this.openedStore();
      const checkpoints =
        parsed?.orgId === undefined
          ? await store.list({ refreshedAt: (organizationId) => this.refreshedAt(organizationId) })
          : await this.listOfOrg(store, parsed.orgId);
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
        ...(scope.files ? { files: scope.files } : {}),
        ...(scope.customSettings ? { customSettings: scope.customSettings } : {}),
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
      await this.take(msg.id, m, store, conn, org, parsed, {
        kept: ({ checkpoint, requests, estimate }) =>
          this.respond(msg, 'checkpoint:take:response', {
            checkpoint,
            operationId: msg.id,
            ...(requests ? { requests } : {}),
            estimate,
          }),
      });
    } catch (err: unknown) {
      this.fail(msg, err, 'TAKE_ERROR');
    } finally {
      pending?.release();
    }
  }

  /**
   * The take once the org is reached, run on the registry and in Live
   * Operations under `operationId`, stopped by their Cancel, by the page's
   * Stop, and by `options.signal`: a pipeline step's.
   *
   * @param options.kept - Told what the take kept as soon as it is kept, before
   *   its operation is said complete: the page's answer.
   */
  private async take(
    operationId: string,
    m: CheckpointModules,
    store: OrgCheckpointStore,
    conn: Awaited<ReturnType<CheckpointHandler['connect']>>,
    org: SalesforceOrg,
    asked: TakeAsked,
    options: { description?: string; signal?: AbortSignal; kept?: (kept: TakeKept) => void } = {},
  ): Promise<TakeKept> {
    const orgName = nameOf(org);
    const description = options.description ?? `Taking a checkpoint of ${orgName}`;
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
    const onAbort = (): void => {
      if (registry) registry.abort(operationId);
      else stop.abort();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
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
          ...(asked.name !== undefined ? { name: asked.name } : {}),
          ...(asked.nameWithDate !== undefined ? { nameWithDate: asked.nameWithDate } : {}),
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
      const kept: TakeKept = {
        checkpoint,
        ...(outcome.requests ? { requests: outcome.requests } : {}),
        estimate: outcome.estimate,
      };
      options.kept?.(kept);
      this.checkpointsChanged();
      sendOperationCompleted(this.deps, operationId, {
        status: 'success',
        objects: checkpoint.objects.length,
        records: checkpoint.objects.reduce((total, object) => total + object.records, 0),
      });
      live.complete();
      settle();
      return kept;
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
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
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
      this.usable(m, checkpoint, 'preview');
      const objects = heldObjectsOf(checkpoint, parsed.objects);
      const org = this.connectedOrgOf(checkpoint, `preview the checkpoint '${checkpoint.name}'`);
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
          ...(objects !== undefined ? { objects } : {}),
          // Priced as the rewind that follows it: from this preview as read,
          // on a host that rewinds so; from a fresh read, the panel's.
          ...(this.previewsAnswered !== undefined ? { reusesPreview: true } : {}),
        },
      );
      if (!outcome.previewed) throw this.refusalOf(outcome.refusal);
      this.previewsAnswered?.set(outcome.diff.previewId, outcome.diff);
      this.previewReads.set(outcome.diff.previewId, {
        checkpointId: checkpoint.checkpointId,
        readAt: outcome.diff.readAt,
      });
      this.respond(msg, 'checkpoint:preview:response', {
        diff: outcome.diff,
        ...(outcome.automation ? { automation: outcome.automation } : {}),
        ...(outcome.emails ? { emails: outcome.emails } : {}),
        ...(outcome.emailsUncounted !== undefined
          ? { emailsUncounted: outcome.emailsUncounted }
          : {}),
        estimate: outcome.estimate,
        ...(outcome.refusal ? { refusal: outcome.refusal } : {}),
      });
    } catch (err: unknown) {
      this.fail(msg, err, 'PREVIEW_ERROR');
    }
  }

  /** The plan of a selection: see the class's comment. */
  private async handlePlanSelection(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(
      checkpointPlanSelectionPayloadSchema,
      msg,
      'checkpoint:error',
      this.deps,
    );
    if (!parsed) return;
    try {
      const m = await this.modules();
      const store = await this.openedStore();
      const { folder, checkpoint } = await this.checkpointOf(store, parsed.checkpointId);
      this.usable(m, checkpoint, 'preview');
      const objects = heldObjectsOf(checkpoint, parsed.objects) ?? [];
      const previewDir = m.previewDirOf(folder, parsed.previewId);
      const read = this.previewReads.get(parsed.previewId);
      if (read?.checkpointId !== checkpoint.checkpointId || !(await isFolder(previewDir))) {
        throw new Refused(
          'PREVIEW_GONE',
          'The preview to plan this selection from is no longer kept on this machine: preview ' +
            `the rewind to '${checkpoint.name}' again. No record was read or written.`,
        );
      }
      const plan = await m.planSelection({
        checkpoint,
        previewDir,
        readAt: read.readAt,
        objects: new Set(objects),
        acceptOutside: parsed.acceptOutside,
        heldRows: m.snapshotRowsOf(checkpoint, folder),
      });
      this.respond(msg, 'checkpoint:plan-selection:response', {
        checkpointId: checkpoint.checkpointId,
        previewId: parsed.previewId,
        plan,
      });
    } catch (err: unknown) {
      this.fail(msg, err, 'PLAN_SELECTION_ERROR');
    }
  }

  /** The rewind: see the class's comment. */
  private async handleRewind(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(
      checkpointRewindPayloadSchema,
      msg,
      'checkpoint:error',
      this.deps,
    );
    if (!parsed) return;
    const registry = this.deps.infraServices?.backgroundRegistry;
    // Held from the request on: the page offers Stop as soon as it asks.
    const pending = registry?.holdUntilStart(msg.id);
    try {
      const m = await this.modules();
      const store = await this.openedStore();
      const { folder, checkpoint } = await this.checkpointOf(store, parsed.checkpointId);
      this.usable(m, checkpoint, 'rewind');
      const objects = heldObjectsOf(checkpoint, parsed.objects);
      // A rewind acts on what its user confirmed: a preview no longer kept
      // would leave it nothing confirmed, and every difference named as new.
      if (!(await isFolder(m.previewDirOf(folder, parsed.previewId)))) {
        throw new Refused(
          'PREVIEW_GONE',
          'The preview this rewind was confirmed on is no longer kept on this machine: preview ' +
            `the rewind to '${checkpoint.name}' again, then rewind. No record was read or written.`,
        );
      }
      const org = this.connectedOrgOf(
        checkpoint,
        `rewind it to the checkpoint '${checkpoint.name}'`,
      );
      const conn = await this.connect(org);
      const at = this.pageAt(msg);
      if (pending?.signal.aborted) {
        this.audit(at, 'rewind', org, checkpoint, 'stopped', { code: ABORTED_BEFORE_START });
        throw new Refused(CANCELLED, new m.RewindStopped().message, true);
      }
      const answered = this.previewsAnswered?.get(parsed.previewId);
      this.previewsAnswered?.delete(parsed.previewId);
      const reused = answered?.checkpointId === checkpoint.checkpointId ? answered : undefined;
      const orgName = nameOf(org);
      await this.writeAct(
        at,
        'rewind',
        org,
        checkpoint,
        `Rewinding ${orgName} to '${checkpoint.name}'`,
        async (signal, onProgress) => {
          const outcome = await m.rewindOrg(
            {
              org: m.rewindOrgOf(conn),
              undelete: (ids) => conn.soap.undelete(ids),
              store,
              readAutomation: (objects) => this.readAutomation(org.id, objects),
              runWriting: this.runWriting(
                org.id,
                orgName,
                'rewind',
                'No record was read or written.',
              ),
              onUndeletable: undeletableAsker(this.deps, org.id, 'checkpoint:rewind'),
              onProgress: ({ percentage, step }) => onProgress(percentage, step),
              signal,
              ...(parsed.muteAutomation === true ? { mute: this.muteOf(conn) } : {}),
            },
            {
              checkpoint,
              folder,
              orgName,
              registered: org,
              username: org.username,
              previewId: parsed.previewId,
              ...(reused ? { reusesPreview: reused } : {}),
              ...(objects !== undefined ? { objects } : {}),
              acceptAutomation: parsed.acceptAutomation,
              acceptNoUndo: parsed.acceptNoUndo,
              acceptRecreate: parsed.acceptRecreate,
              acceptOutside: parsed.acceptOutside,
              acceptUnseen: parsed.acceptUnseen,
            },
          );
          return outcome.rewound
            ? { done: true, result: outcome.result, notes: outcome.notes }
            : { done: false, refusal: outcome.refusal };
        },
        (err) => err instanceof m.RewindStopped,
      );
    } catch (err: unknown) {
      this.fail(msg, err, 'REWIND_ERROR');
    } finally {
      pending?.release();
    }
  }

  /** The undo of the org's last rewind: see the class's comment. */
  private async handleUndo(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(checkpointUndoPayloadSchema, msg, 'checkpoint:error', this.deps);
    if (!parsed) return;
    const registry = this.deps.infraServices?.backgroundRegistry;
    // Held from the request on: the page offers Stop as soon as it asks.
    const pending = registry?.holdUntilStart(msg.id);
    try {
      const m = await this.modules();
      const store = await this.openedStore();
      const { folder, checkpoint } = await this.checkpointOf(store, parsed.checkpointId);
      this.usable(m, checkpoint, 'undo');
      await this.undoOffered(store, folder, checkpoint, parsed.rewindId);
      const org = this.connectedOrgOf(checkpoint, `undo its rewind to '${checkpoint.name}'`);
      const conn = await this.connect(org);
      const at = this.pageAt(msg);
      if (pending?.signal.aborted) {
        this.audit(at, 'undo', org, checkpoint, 'stopped', {
          code: ABORTED_BEFORE_START,
          rewindId: parsed.rewindId,
        });
        throw new Refused(CANCELLED, new m.UndoStopped().message, true);
      }
      const orgName = nameOf(org);
      await this.writeAct(
        at,
        'undo',
        org,
        checkpoint,
        `Undoing the rewind of ${orgName} to '${checkpoint.name}'`,
        async (signal, onProgress) => {
          const outcome = await m.undoCheckpoint(
            {
              org: m.rewindOrgOf(conn),
              undelete: (ids) => conn.soap.undelete(ids),
              store,
              readAutomation: (objects) => this.readAutomation(org.id, objects),
              runWriting: this.runWriting(
                org.id,
                orgName,
                'undo the rewind',
                'No record was read or written.',
              ),
              onUndeletable: undeletableAsker(this.deps, org.id, 'checkpoint:undo'),
              onProgress: ({ percentage, step }) => onProgress(percentage, step),
              signal,
              ...(parsed.muteAutomation === true ? { mute: this.muteOf(conn) } : {}),
            },
            {
              checkpoint,
              folder,
              orgName,
              registered: org,
              username: org.username,
              rewindId: parsed.rewindId,
              acceptAutomation: parsed.acceptAutomation,
            },
          );
          return outcome.undone
            ? { done: true, result: outcome.result, notes: outcome.notes }
            : { done: false, refusal: outcome.refusal };
        },
        (err) => err instanceof m.UndoStopped,
        { rewindId: parsed.rewindId },
      );
    } catch (err: unknown) {
      this.fail(msg, err, 'UNDO_ERROR');
    } finally {
      pending?.release();
    }
  }

  /**
   * How a rewind or an undo asked to mute plans it: through the org's own
   * bypass, assigned to the user it writes as for the act alone
   * (`AutomationMuteLease`).
   */
  private muteOf(conn: Connection): MuteOfWrites {
    return (automation, writes) =>
      muteForRun(async () => muteOrgOf(conn), automation, {
        ...this.muteLeases,
        writes,
      });
  }

  /** A page's request, as an act answers it. */
  private pageAt(msg: InboundRequest): ActAt {
    return {
      operationId: msg.id,
      respond: (type, payload) => this.respond(msg, type, payload),
    };
  }

  /**
   * A rewind or an undo once the org is reached, under the id of its request
   * or its step: listed in the registry and in Live Operations, its progress
   * on that id, recorded in the audit trail, and answered with its result —
   * one stopped part way included — or with the refusal a guard or a gate
   * gave, as it gave it.
   *
   * @param stoppedBefore - Whether an error is the act's own stop before it
   *   wrote anything, answered `CANCELLED`.
   * @param options.rewindId - The rewind an undo takes back, recorded when it is refused.
   * @param options.signal - A pipeline step's: aborted, the act stops as
   *   Live Operations' Cancel stops it.
   * @param options.refusalOf - The refusal a result is answered with in its
   *   place, when it has one: a rewind nobody could be asked about.
   * @returns Its result, once it ran.
   */
  private async writeAct(
    at: ActAt,
    act: 'rewind' | 'undo',
    org: SalesforceOrg,
    checkpoint: OrgCheckpoint,
    description: string,
    run: (
      signal: AbortSignal,
      onProgress: (percentage: number, step: string) => void,
    ) => Promise<WriteOutcome>,
    stoppedBefore: (err: unknown) => boolean,
    options: {
      rewindId?: string;
      signal?: AbortSignal;
      refusalOf?: (result: RewindResult) => CheckpointRefusal | undefined;
    } = {},
  ): Promise<RewindResult> {
    const { operationId } = at;
    const { rewindId } = options;
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
    const refused = rewindId !== undefined ? { rewindId } : {};
    const onProgress = (percentage: number, step: string): void => {
      sendOperationProgress(this.deps, operationId, percentage, 0, 0, step);
      // A run stopped from Live Operations ends before its next call; the
      // registry has recorded the stop and hears no more of it.
      if (!stop.signal.aborted) registry?.updateProgress(operationId, percentage);
      live.progress(percentage, 0, 0, step);
    };
    const onAbort = (): void => {
      if (registry) registry.abort(operationId);
      else stop.abort();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    try {
      const outcome = await run(stop.signal, onProgress);
      if (!outcome.done) {
        this.audit(at, act, org, checkpoint, 'stopped', {
          code: outcome.refusal.code,
          ...refused,
        });
        sendOperationCompleted(this.deps, operationId, {
          status: 'refused',
          code: outcome.refusal.code,
        });
        live.fail(outcome.refusal.message);
        settle(new Error(outcome.refusal.message));
        throw this.refusalOf(outcome.refusal);
      }
      const { result, notes } = outcome;
      for (const note of notes) this.deps.log(`[WARN] checkpoint:${act} ${operationId}: ${note}`);
      // Named as the sweep names the journals it deletes.
      for (const gone of result.removedJournals ?? []) {
        this.deps.log(
          `[INFO] Removed the journal of rewind ${gone.rewindId} of checkpoint '${gone.name}': ` +
            'Undo reaches the last rewind of the org alone',
        );
      }
      const refusedAfter = options.refusalOf?.(result);
      if (refusedAfter !== undefined) {
        this.audit(at, act, org, checkpoint, wroteAny(result) ? 'partial' : 'stopped', {
          result,
          code: refusedAfter.code,
        });
        sendOperationCompleted(this.deps, operationId, {
          status: 'refused',
          code: refusedAfter.code,
        });
        live.fail(refusedAfter.message);
        settle(new Error(refusedAfter.message));
        throw new Refused(refusedAfter.code, refusedAfter.message, false, result);
      }
      this.audit(at, act, org, checkpoint, AUDIT_OUTCOMES[result.status], { result });
      at.respond?.(`checkpoint:${act}:response`, { result, operationId });
      if (result.status === 'cancelled') {
        // Aborted in the registry already when the stop came through it.
        registry?.abort(operationId);
        sendOperationCompleted(this.deps, operationId, { aborted: true });
        live.cancel();
        settle();
      } else if (result.status === 'failure') {
        const why = `Nothing the ${act} set out to write went through: its result says why.`;
        sendOperationCompleted(this.deps, operationId, { status: result.status });
        live.fail(why);
        settle(new Error(why));
      } else {
        sendOperationCompleted(this.deps, operationId, { status: result.status });
        live.complete();
        settle();
      }
      return result;
    } catch (err: unknown) {
      if (err instanceof Refused) throw err;
      if (stoppedBefore(err)) {
        // Aborted in the registry already when the stop came through it.
        registry?.abort(operationId);
        sendOperationCompleted(this.deps, operationId, { aborted: true });
        live.cancel();
        settle();
        this.audit(at, act, org, checkpoint, 'stopped', { code: CANCELLED, ...refused });
        throw new Refused(CANCELLED, extractErrorMessage(err), true);
      }
      this.audit(at, act, org, checkpoint, 'failure', refused);
      sendOperationCompleted(this.deps, operationId, { status: 'failure' });
      live.fail(extractErrorMessage(err));
      settle(err);
      throw err;
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
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
      if (deleted.length > 0) this.checkpointsChanged();
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
   * The rewinds the ledgers of the store keep, of the registered orgs named
   * or of every registered org, each line with those it is of: an org's are
   * those of every Organization Id it was, a sandbox refreshed since among
   * them. Read from this machine alone; a line that does not parse is left
   * out, and named in the log.
   */
  private async handleRewinds(msg: InboundRequest): Promise<void> {
    const parsed = validatePayload(
      checkpointRewindsPayloadSchema,
      msg,
      'checkpoint:error',
      this.deps,
    );
    if (parsed === null) return;
    try {
      const store = await this.openedStore();
      const { readRewindLedgers } = await import('../../modules/checkpoint/rewindLedger.js');
      const orgIds = parsed?.orgIds ?? this.deps.orgManager.getAllOrgs().map((org) => org.id);
      const was = orgIds.map((orgId) => ({ orgId, ids: this.organizationIdsOf(orgId) }));
      const reads = await readRewindLedgers(
        store.root,
        was.flatMap(({ ids }) => ids),
      );
      const rewinds: CheckpointRewindListed[] = [];
      for (const [organizationId, read] of reads) {
        for (const line of read.unreadable) {
          this.deps.log(
            `[WARN] Line ${line} of the rewind ledger of ${organizationId} does not parse: left out`,
          );
        }
        for (const record of read.records) {
          const of = was.filter(({ ids }) =>
            ids.some((id) => sameOrganization(id, record.organizationId)),
          );
          rewinds.push({ ...record, orgIds: of.map(({ orgId }) => orgId) });
        }
      }
      this.respond(msg, 'checkpoint:rewinds:response', { rewinds });
    } catch (err: unknown) {
      this.fail(msg, err, 'REWINDS_ERROR');
    }
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
      this.checkpointsChanged();
    } catch (err: unknown) {
      this.fail(msg, err, 'CHANGE_ERROR');
    }
  }
}
