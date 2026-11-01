/**
 * A checkpoint of what a run writes, taken before its first write (Checkpoint
 * first), and the one order every run that writes keeps from its reads to its
 * result: the five ideas of this release meet on that path, and each one's
 * part is in its place in it.
 *
 * The order of a run's write path, the same for Forge, Sync, Seed, Autopilot
 * and Frozen:
 *
 * 1. `reads` — the run's reads and the read of the target's automation, as
 *    they were.
 * 2. `leasePlan` — the plan of the mute's lease, nothing assigned: which sets
 *    it is to hold, what they silence and what still runs.
 * 3. `stillRunning` — what is computed of what still runs, by one function
 *    (`stillRunningOf`, shared): the checkpoint's scope (the objects the
 *    flows that still run create), the fit's room, the senders of emails.
 * 4. `deliverabilityRead` — whether the target delivers its emails, read only
 *    when a sender is left. The Apex runs as the run's user, lease or not:
 *    read before the lease, it reads the same.
 * 5. `question` — one question, its blocks in this order: what leaves the org
 *    (deliverability, the day's emails); the automation that still runs; the
 *    checkpoint (its cost, what it adds, what it leaves out); the storage,
 *    the API requests and the fit. Forge puts its automation and its emails
 *    before it reads its rows, and its checkpoint at its write gate, once they
 *    are read: two questions, the take after the second.
 * 6. `checkpointTake` — the take, as close to the first write as the answer
 *    lets it: what others change between the take and the run's end is taken
 *    back by a rewind to it too, so the take never waits on a person.
 * 7. `leaseAcquire` — the lease, taken as late as it can be, just before the
 *    first write, and read back: the shortest window the bypass is held.
 *    Taken after the take, it never dates what the take holds (an assignment
 *    and its removal left the data's `SystemModstamp` as it was).
 * 8. `afterLeaseCheck` — the lease held against its plan: a set not held that
 *    leaves a sender of emails running unaccepted, or a flow creating outside
 *    the checkpoint, refuses the run before any write, the lease given back
 *    and the checkpoint deleted ("the run wrote nothing"). A lease that
 *    assigned anything has the describes of the objects written read again:
 *    an assignment may open record types, and a fresh describe says so.
 * 9. `write`, then `leaseRelease` in a `finally`.
 * 10. `recordTypeReadBack` — the read of the record types the target gave
 *     the records created without one, once the lease is given back.
 * 11. `result`.
 *
 * Each module's order test counts its writes, assignments, deliverability
 * reads and takes against {@link writePathOrderDefects}.
 *
 * The take itself — its scope, its estimate, the disk it needs, the run's
 * own mark left out of what refuses it, its deletion when the run wrote
 * nothing — is built on these types.
 *
 * - Its scope is computed at the run's gate from what the run knows there,
 *   reading nothing ({@link beforeRunScopeOf}): the objects the run writes,
 *   and those the flows that still run once the mute's plan holds create as
 *   the run's writes fire them — never those of a flow the mute keeps quiet.
 *   Every other object of the org stays out: a checkpoint of everything
 *   people work in cost 204 objects and 232 requests on a scratch org for a
 *   clone of 26 records.
 * - Each object is held whole, as every checkpoint holds an object: a rewind
 *   to one holding part of an object would delete the rest as created since.
 *   Its cost is that of the target's tables, not of the run's rows — the
 *   fixture clone's twelve objects, 38 records and 68 requests on a scratch
 *   org, 40 of them its recycle bin's; five tables of a client's full
 *   sandbox, 7,588 records — and the question says it before anything is
 *   taken.
 * - The take is asked to leave out, named, an object a user without View All
 *   Data and Modify All Data is not proven to hold: the run's objects are not
 *   a person's pick. One that holds none of the objects the run writes is
 *   refused (`NOTHING_HELD`): the option promised a rewind.
 * - The disk of the store is read before anything is: a take that fills it
 *   fails and keeps nothing, after minutes of reads (`DISK`).
 * - A take whose run then writes nothing is deleted: there is nothing for it
 *   to take back, and it holds the target's values in clear on this machine.
 */

import { statfs } from 'node:fs/promises';
import type {
  CheckpointBeforeRun,
  CheckpointBeforeRunModule,
  CheckpointLeftOutObject,
  CheckpointRefusal,
  RunCheckpointEstimate,
  RunCheckpointInfo,
  RunCheckpointObjectNote,
  RunCheckpointRequest,
  RunCheckpointTaken,
  StillRunning,
  StillRunningEntry,
} from '@sandforge/shared';
import { CHECKPOINT_BEFORE_RUN_KEEP_DAYS, CHECKPOINT_STEP_DATE } from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import {
  ATTACHMENT_OBJECT,
  FILE_LINK_OBJECT,
  FILE_OBJECT,
  FILE_VERSION_OBJECT,
} from './checkpointScope.js';
import type { OrgCheckpointStore, OrgLockHolder } from './OrgCheckpointStore.js';
import type {
  TakeDeps,
  TakeOutcome,
  TakeProgress,
  TakeRequest,
  TakeScope,
} from './takeCheckpoint.js';

/** The steps of a run's write path, in their order. */
export const WRITE_PATH_STEPS = [
  'reads',
  'leasePlan',
  'stillRunning',
  'deliverabilityRead',
  'question',
  'checkpointTake',
  'leaseAcquire',
  'afterLeaseCheck',
  'write',
  'leaseRelease',
  'recordTypeReadBack',
  'result',
] as const;

/** A step of a run's write path ({@link WRITE_PATH_STEPS}). */
export type WritePathStep = (typeof WRITE_PATH_STEPS)[number];

/**
 * The run a checkpoint is taken before, as the take's check of the runs
 * writing to the org knows it: its own mark — the operation the panel holds
 * for it, the run file it writes — is left out of what refuses the take,
 * and only its own. Another run of the window, a run file another live
 * process writes and the store's lock refuse it as ever.
 */
export interface BeforeRunOwn {
  operationId?: string;
  runId?: string;
}

/** What the scope of a checkpoint before a run is computed from, at the run's gate, reading no record. */
export interface BeforeRunScopeInput {
  module: CheckpointBeforeRunModule;
  /** The objects the run writes, every operation together: inserts, updates, upserts and deletes. */
  written: readonly string[];
  /** What still runs once the run's mute plan holds: the flows whose creations the checkpoint holds too. */
  running: Pick<StillRunning<unknown>, 'firing'>;
  request: RunCheckpointRequest;
}

/**
 * What a run's path did out of the order above, each in words; empty when it
 * kept it. `events` is what the run did, as a test of it counts it: a step it
 * did not make is absent, one it made more than once — Forge's two questions,
 * a write per call — is there each time.
 *
 * Reads may come between two questions (Forge reads its rows after its
 * automation question). Past the last question, the order is strict: the
 * take, the lease, its check, the writes, the release, the read-back.
 */
export function writePathOrderDefects(events: readonly WritePathStep[]): string[] {
  const defects: string[] = [];
  // The first and the last place of a step; -1 for one the run did not make.
  const first = (step: WritePathStep): number => events.indexOf(step);
  const last = (step: WritePathStep): number => events.lastIndexOf(step);
  const before = (
    a: WritePathStep,
    b: WritePathStep,
    said: string,
    aAt = last(a),
    bAt = first(b),
  ): void => {
    if (aAt >= 0 && bAt >= 0 && aAt > bAt) defects.push(said);
  };
  before('leasePlan', 'stillRunning', 'what still runs was computed before the lease was planned');
  before(
    'stillRunning',
    'deliverabilityRead',
    'the deliverability was read before what still runs was known',
  );
  before(
    'deliverabilityRead',
    'question',
    'the deliverability was read after the question it belongs to',
    first('deliverabilityRead'),
  );
  before('question', 'checkpointTake', 'the checkpoint was taken before the last question');
  before('question', 'leaseAcquire', 'the lease was taken before the last question');
  before('checkpointTake', 'leaseAcquire', 'the lease was taken before the checkpoint');
  before('leaseAcquire', 'afterLeaseCheck', 'the lease was checked before it was taken');
  before('checkpointTake', 'write', 'a record was written before the checkpoint was taken');
  before('leaseAcquire', 'write', 'a record was written before the lease was taken');
  before('afterLeaseCheck', 'write', 'a record was written before the lease was checked');
  before('write', 'leaseRelease', 'the lease was given back before the last write');
  before('write', 'recordTypeReadBack', 'the record types were read back before the last write');
  before(
    'leaseRelease',
    'recordTypeReadBack',
    'the record types were read back while the lease was held',
  );
  if (first('leaseAcquire') >= 0 && first('leaseRelease') < 0) {
    defects.push('the lease was never given back');
  }
  const resultAt = first('result');
  if (resultAt >= 0 && events.slice(resultAt + 1).some((step) => step !== 'result')) {
    defects.push('the run went on past its result');
  }
  return defects;
}

// ─── The scope, at the run's gate ────────────────────────────────────────────

/** What a checkpoint before a run is asked to pick, from what the run knows at its gate. */
export interface BeforeRunScope {
  /** The objects the run writes, by API name, each once, in the order the run names them. */
  written: string[];
  /**
   * The objects the flows that still run create beside those, each with the
   * automations that create it and the writes that start them.
   */
  added: RunCheckpointObjectNote[];
  /** The objects left out by name, each once. */
  excluded: string[];
  /** What the take picks: the objects the run writes, then those added. */
  picked: string[];
}

/** The write that starts an automation, as the reason of an object added says it. */
const WRITE_WORDS: Readonly<Record<StillRunningEntry['write'], string>> = {
  insert: 'go in',
  update: 'are updated',
  delete: 'are deleted',
  undelete: 'come back',
};

/** An automation that creates records, as the reason of an object added names its kind. */
const KIND_WORDS: Readonly<Record<StillRunningEntry['kind'], string>> = {
  flow: 'flow',
  process: 'process',
  workflowRule: 'workflow rule',
  trigger: 'Apex trigger',
};

/** The most automations the reason of an object added names; the others are counted. */
const CREATORS_NAMED = 3;

/** A platform event's object: published, never kept, so no record a checkpoint holds. */
const PLATFORM_EVENT = /__e$/i;

/** A name as two names of one object are compared: the org reads API names without case. */
function keyOf(name: string): string {
  return name.toLowerCase();
}

/** `names` each once, the first spelling kept, in their order. */
function eachOnce(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const once: string[] = [];
  for (const name of names) {
    if (seen.has(keyOf(name))) continue;
    seen.add(keyOf(name));
    once.push(name);
  }
  return once;
}

/** The automations that create an object, as one sentence: three named, the others counted. */
function createdByWords(clauses: readonly string[]): string {
  const named = clauses.slice(0, CREATORS_NAMED);
  const more = clauses.length - named.length;
  const said = `${named.join('; ')}${more > 0 ? `; and ${more} more` : ''}`;
  return `${said.charAt(0).toUpperCase()}${said.slice(1)}.`;
}

/**
 * What a checkpoint before a run picks, read from what the run knows at its
 * gate, nothing read from the org: every object the run writes, whatever it
 * does to it — a rewind deletes what was created since, gives back what was
 * changed and brings back what was deleted — and every object a flow, a
 * process or a workflow rule that still runs creates as the run's writes
 * fire it, named with what creates it. What the mute keeps quiet is not in
 * `running` (`stillRunningOf`), so nothing it would have created is added.
 * An Apex trigger's code is not read, and what it creates is not known; a
 * platform event is no record. The objects left out by name stay among those
 * picked, for the take to name them left out as asked.
 */
export function beforeRunScopeOf(input: BeforeRunScopeInput): BeforeRunScope {
  const written = eachOnce(input.written);
  const writtenKeys = new Set(written.map(keyOf));
  const creators = new Map<string, { objectApiName: string; clauses: string[] }>();
  for (const entry of input.running.firing) {
    if (entry.flow === undefined) continue;
    for (const created of entry.flow.creates ?? []) {
      const key = keyOf(created);
      if (writtenKeys.has(key) || PLATFORM_EVENT.test(created)) continue;
      let creator = creators.get(key);
      if (creator === undefined) {
        creator = { objectApiName: created, clauses: [] };
        creators.set(key, creator);
      }
      const clause =
        `the target's ${KIND_WORDS[entry.kind]} '${entry.name}' creates ${created} records as ` +
        `${entry.objectApiName} records ${WRITE_WORDS[entry.write]}`;
      if (!creator.clauses.includes(clause)) creator.clauses.push(clause);
    }
  }
  const added = [...creators.values()].map(({ objectApiName, clauses }) => ({
    objectApiName,
    reason: createdByWords(clauses),
  }));
  return {
    written,
    added,
    excluded: eachOnce(input.request.excluded ?? []),
    picked: [...written, ...added.map(({ objectApiName }) => objectApiName)],
  };
}

// ─── What it holds, and what it does not ─────────────────────────────────────

/**
 * Why the take holds an object nobody asked for: the files every checkpoint
 * of picked objects holds, so that a rewind deletes those added since.
 */
const FILES_WORDS: Readonly<Record<string, string>> = {
  [keyOf(FILE_OBJECT)]:
    'Files, which every checkpoint of picked objects holds: a rewind deletes the files added ' +
    'since to the records it holds.',
  [keyOf(ATTACHMENT_OBJECT)]:
    'Attachments, which every checkpoint of picked objects holds: a rewind deletes the ' +
    'attachments added since.',
};

/** Why the take holds an object nobody asked for, when it is no file. */
const HELD_UNASKED = 'Held as every checkpoint of picked objects holds it.';

/**
 * A file's versions and its links: held with the file, never as objects of
 * their own. A run that writes files writes their versions, and the file is
 * what the checkpoint holds of them.
 */
const HELD_WITH_FILE: ReadonlySet<string> = new Set(
  [FILE_VERSION_OBJECT, FILE_LINK_OBJECT].map(keyOf),
);

/** What a rewind does to an object the checkpoint does not hold, as its reason ends. */
const LEFT_AS_THEY_ARE = 'A rewind leaves its records as they are.';

/** What the take of a refused checkpoint did not do, as its refusal ends. */
const NOTHING_READ = 'No record was read.';

/** What of a scope a take holds, said for the run. */
interface HeldOfScope {
  /** The objects held, by the org's names: those the run writes, then those added, then the files. */
  objects: string[];
  added: RunCheckpointObjectNote[];
  notHeld: RunCheckpointObjectNote[];
  /** Whether the take holds `name`, as an object or with its file. */
  holds(name: string): boolean;
  /** Why the take left `name` out, when it said. */
  why(name: string): string | undefined;
}

/** What a take holds of a scope, from the objects it holds and those it left out with why. */
function heldOfScope(
  scope: BeforeRunScope,
  held: readonly string[],
  leftOut: readonly CheckpointLeftOutObject[],
): HeldOfScope {
  const byKey = new Map(held.map((name) => [keyOf(name), name]));
  const withFile = byKey.has(keyOf(FILE_OBJECT));
  const holds = (name: string): boolean =>
    byKey.has(keyOf(name)) || (withFile && HELD_WITH_FILE.has(keyOf(name)));
  const objects: string[] = [];
  const place = (name: string): void => {
    const asHeld = byKey.get(keyOf(name));
    if (asHeld !== undefined && !objects.includes(asHeld)) objects.push(asHeld);
  };
  for (const name of scope.written) place(name);
  for (const { objectApiName } of scope.added) place(objectApiName);
  for (const name of held) place(name);
  const picked = new Set(scope.picked.map(keyOf));
  const added: RunCheckpointObjectNote[] = [
    ...scope.added.flatMap(({ objectApiName, reason }) => {
      const asHeld = byKey.get(keyOf(objectApiName));
      return asHeld === undefined ? [] : [{ objectApiName: asHeld, reason }];
    }),
    ...held
      .filter((name) => !picked.has(keyOf(name)))
      .map((name) => ({ objectApiName: name, reason: FILES_WORDS[keyOf(name)] ?? HELD_UNASKED })),
  ];
  const notHeld = leftOut
    .filter(({ objectApiName }) => !holds(objectApiName))
    .map(({ objectApiName, reason }) => ({
      objectApiName,
      reason: `${reason} ${LEFT_AS_THEY_ARE}`,
    }));
  const reasons = new Map(
    leftOut.map(({ objectApiName, reason }) => [keyOf(objectApiName), reason]),
  );
  return { objects, added, notHeld, holds, why: (name) => reasons.get(keyOf(name)) };
}

/**
 * The refusal of a checkpoint before a run that would hold none of the
 * objects the run writes: what it holds beside them — files, what the
 * automation creates — would let no rewind take the run back.
 */
function nothingHeldOf(
  scope: BeforeRunScope,
  held: HeldOfScope,
  done: string,
): CheckpointRefusal | undefined {
  if (scope.written.some((name) => held.holds(name))) return undefined;
  if (scope.written.length === 0) {
    return {
      code: 'NOTHING_HELD',
      message:
        'The run names no object it writes: a checkpoint before it would hold nothing a rewind ' +
        `could take back. ${done}`,
    };
  }
  const why = scope.written
    .map((name) => `${name}: ${held.why(name) ?? 'The take did not hold it.'}`)
    .join(' ');
  return {
    code: 'NOTHING_HELD',
    message:
      'The checkpoint before the run would hold none of the objects the run writes, so a ' +
      `rewind to it could take nothing of the run back. ${why} ${done}`,
  };
}

/**
 * What a checkpoint before a run would hold and cost, from what the take's
 * scope read of the org (`scopeCheckpoint`): the objects it holds, those the
 * run writes first; what it holds beside them and why; what it leaves out and
 * why; and the refusal a real run would meet. A guard's refusal comes before
 * the scope is read, and is said alone. Then one that would hold none of the
 * objects the run writes is refused (`NOTHING_HELD`), whatever else refuses
 * it: no wait lifts that one. Then the take's own refusal — another run
 * writing, the org's lock, its limits, the day's requests.
 */
export function beforeRunEstimateOf(
  scope: BeforeRunScope,
  read: Pick<TakeScope, 'objects' | 'leftOut' | 'estimate' | 'refusal'>,
  keepDays: number,
): RunCheckpointEstimate {
  const planned = { state: 'planned' as const, estimate: read.estimate, keepDays };
  if (read.objects.length === 0 && read.leftOut.length === 0 && read.refusal !== undefined) {
    return { ...planned, objects: [], added: [], notHeld: [], refusal: read.refusal };
  }
  const held = heldOfScope(
    scope,
    read.objects.map(({ objectApiName }) => objectApiName),
    read.leftOut,
  );
  const refusal = nothingHeldOf(scope, held, NOTHING_READ) ?? read.refusal;
  return {
    ...planned,
    objects: held.objects,
    added: held.added,
    notHeld: held.notHeld,
    ...(refusal !== undefined ? { refusal } : {}),
  };
}

// ─── The disk ────────────────────────────────────────────────────────────────

/**
 * The room a take needs on the store's disk, times its estimated bytes: a
 * tenth more, its files and their index never weighing exactly what the
 * estimate said.
 */
export const BEFORE_RUN_DISK_ROOM = 1.1;

/** Megabytes, as a refusal says them. */
function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The refusal of a checkpoint before a run whose take would not fit on the
 * store's disk: less free than its bytes and a tenth more. Nothing when the
 * system does not say what is free: the take then fails, keeping nothing,
 * should the disk fill.
 */
export function beforeRunDiskRefusal(
  bytes: number,
  free: number | undefined,
): CheckpointRefusal | undefined {
  if (free === undefined || free >= Math.ceil(bytes * BEFORE_RUN_DISK_ROOM)) return undefined;
  return {
    code: 'DISK',
    message:
      `The checkpoint before the run takes about ${megabytes(bytes)} on this machine, and its ` +
      `disk has ${megabytes(free)} free, less than that and a tenth more: make room, or leave ` +
      `objects out of the checkpoint. ${NOTHING_READ}`,
  };
}

/** Bytes free on the disk `dir` is on, for this user; undefined where the system will not say. */
export async function freeBytesOf(dir: string): Promise<number | undefined> {
  try {
    const info = await statfs(dir);
    return Number(info.bavail) * Number(info.bsize);
  } catch {
    return undefined;
  }
}

// ─── The take, and what the run's result says of it ──────────────────────────

/** What a run calls its checkpoint before it, by module, in the checkpoint's name. */
const RUN_WORDS: Readonly<Record<CheckpointBeforeRunModule, string>> = {
  forge: 'Forge run',
  sync: 'Sync run',
  seed: 'Seed run',
  autopilot: 'Autopilot run',
  frozen: 'Frozen Dataset load',
};

/**
 * The name of a checkpoint before a run, `{date}` put in the place of T0 by
 * the take: `Before Forge run 2026-10-30 21:40 UTC`.
 */
export function beforeRunNameOf(module: CheckpointBeforeRunModule): string {
  return `Before ${RUN_WORDS[module]} ${CHECKPOINT_STEP_DATE}`;
}

/**
 * The days a checkpoint before a run is kept: those its request asks, else
 * the setting `sandforge.checkpoint.beforeRunKeepDays`, else 7. A setting
 * written by hand outside its bounds is read as not set; a request outside
 * them is refused, as its payload's check would refuse it.
 *
 * @throws {RangeError} When `asked` is no whole number of days from 0 to 3,650.
 */
export function beforeRunKeepDaysOf(asked: number | undefined, setting: unknown): number {
  const { min, max } = CHECKPOINT_BEFORE_RUN_KEEP_DAYS;
  const within = (days: unknown): days is number =>
    typeof days === 'number' && Number.isInteger(days) && days >= min && days <= max;
  if (asked !== undefined) {
    if (!within(asked)) {
      throw new RangeError(`Not a number of days to keep a checkpoint, ${min} to ${max}: ${asked}`);
    }
    return asked;
  }
  return within(setting) ? setting : CHECKPOINT_BEFORE_RUN_KEEP_DAYS.default;
}

/** What a run asks of its checkpoint, resolved: who takes it, and the days it is kept. */
export interface BeforeRunRequest extends BeforeRunScopeInput {
  /** The run, as the checkpoint's file names it. */
  operationId: string;
  tool: CheckpointBeforeRun['tool'];
  /** The days it is kept ({@link beforeRunKeepDaysOf}); 0 keeps it until it is deleted. */
  keepDays: number;
}

/** The org a checkpoint before a run is taken of, as a take is asked it. */
export type BeforeRunOrg = Pick<
  TakeRequest,
  'orgId' | 'orgName' | 'alias' | 'username' | 'instanceUrl' | 'registered' | 'scratchExpiresAt'
>;

/** What a take before a run is asked beside its org: the scope picked, its name, how long it is kept, and the run. */
export type BeforeRunAsked = Required<
  Pick<
    TakeRequest,
    'mode' | 'objects' | 'nameWithDate' | 'keepDays' | 'unprovenLeftOut' | 'beforeRun'
  >
> &
  Pick<TakeRequest, 'excluded'>;

/** What the take of a checkpoint before a run is asked beside its org. */
export function beforeRunAskedOf(scope: BeforeRunScope, request: BeforeRunRequest): BeforeRunAsked {
  return {
    mode: 'picked',
    objects: scope.picked,
    ...(scope.excluded.length > 0 ? { excluded: scope.excluded } : {}),
    nameWithDate: beforeRunNameOf(request.module),
    keepDays: request.keepDays,
    unprovenLeftOut: true,
    beforeRun: { module: request.module, operationId: request.operationId, tool: request.tool },
  };
}

/** What a take kept, as the run's result names it from. */
export type BeforeRunKept = Pick<
  Extract<TakeOutcome, { taken: true }>,
  'checkpoint' | 'requests' | 'estimate'
>;

/** The checkpoint a run took before its first write, as its result and its history name it. */
export function beforeRunTakenOf(scope: BeforeRunScope, kept: BeforeRunKept): RunCheckpointTaken {
  const { checkpoint } = kept;
  const held = heldOfScope(
    scope,
    checkpoint.objects.map(({ objectApiName }) => objectApiName),
    checkpoint.scope.leftOut,
  );
  return {
    state: 'taken',
    checkpointId: checkpoint.checkpointId,
    name: checkpoint.name,
    takenAt: checkpoint.takenAt,
    expiresAt: checkpoint.expiresAt,
    objects: held.objects,
    records: checkpoint.objects.reduce((total, object) => total + object.records, 0),
    bytes: checkpoint.bytes,
    requests: kept.requests?.total ?? kept.estimate.apiRequests,
    added: held.added,
    notHeld: held.notHeld,
  };
}

/** How the take of a checkpoint before a run ended, when it did not fail. */
export type BeforeRunTake =
  | { taken: true; checkpoint: RunCheckpointTaken }
  | { taken: false; refusal: CheckpointRefusal }
  /** The run's Stop came while it read: nothing of it is kept, and the run writes nothing. */
  | { taken: false; stopped: true };

/** What holds an org's lock, as a checkpoint kept against the run's wish says it. */
function lockHolderWords(holder: OrgLockHolder): string {
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
 * What a take before a run kept, as the run is told it: the checkpoint, or —
 * deleted again — the refusal of one that holds none of the objects the run
 * writes, which the org's permissions could make so between the run's gate
 * and its take.
 */
export async function beforeRunOutcomeOf(
  store: Pick<OrgCheckpointStore, 'delete'>,
  scope: BeforeRunScope,
  kept: BeforeRunKept,
): Promise<BeforeRunTake> {
  const held = heldOfScope(
    scope,
    kept.checkpoint.objects.map(({ objectApiName }) => objectApiName),
    kept.checkpoint.scope.leftOut,
  );
  if (nothingHeldOf(scope, held, '') === undefined) {
    return { taken: true, checkpoint: beforeRunTakenOf(scope, kept) };
  }
  const deleted = await store.delete(kept.checkpoint.checkpointId);
  const done =
    deleted.outcome === 'busy'
      ? `It is kept all the same, as ${lockHolderWords(deleted.holder)}: delete it from the ` +
        'Checkpoints page once that has ended. Nothing was written.'
      : 'It was deleted again; nothing was written.';
  const refusal = nothingHeldOf(scope, held, done);
  return refusal === undefined
    ? { taken: true, checkpoint: beforeRunTakenOf(scope, kept) }
    : { taken: false, refusal };
}

/** What a checkpoint before a run reads the org and this machine through. */
export interface BeforeRunDeps extends TakeDeps {
  /** Bytes the store's disk has free; read from the system unless a test says. */
  freeBytes?: (dir: string) => Promise<number | undefined>;
}

/** The take's request: the org, then what a take before a run is asked. */
function takeRequestOf(
  org: BeforeRunOrg,
  scope: BeforeRunScope,
  request: BeforeRunRequest,
): TakeRequest {
  return { ...org, ...beforeRunAskedOf(scope, request) };
}

/**
 * What a checkpoint before a run would hold and cost, read at the run's gate
 * from the org's describes and counts, no record read, nothing kept
 * ({@link beforeRunEstimateOf}); then, when nothing refuses it, the disk.
 * `deps.runWriting` is the caller's: everything that writes to the org but
 * the run's own mark.
 */
export async function scopeBeforeRun(
  deps: BeforeRunDeps,
  org: BeforeRunOrg,
  request: BeforeRunRequest,
): Promise<RunCheckpointEstimate> {
  // The take's modules load when a run asks for one, off the paths that never do.
  const { scopeCheckpoint } = await import('./takeCheckpoint.js');
  const scope = beforeRunScopeOf(request);
  const read = await scopeCheckpoint(deps, takeRequestOf(org, scope, request));
  const estimate = beforeRunEstimateOf(scope, read, request.keepDays);
  if (estimate.refusal !== undefined) return estimate;
  const disk = beforeRunDiskRefusal(
    estimate.estimate.bytes,
    await (deps.freeBytes ?? freeBytesOf)(deps.store.root),
  );
  return disk === undefined ? estimate : { ...estimate, refusal: disk };
}

/**
 * Take the checkpoint before a run, once its question is answered, as close
 * to its first write as that lets it: the disk checked first against what the
 * question said it takes (`planned`), then the take with its own guards, the
 * org's lock and its limits, the objects it cannot prove left out and named,
 * its origin written into its file. One that holds none of the objects the
 * run writes is deleted again and refused.
 *
 * @returns The checkpoint, its refusal, or that the run's Stop came while it
 *   read: nothing kept but the checkpoint.
 * @throws The take's error when it fails: nothing of it is kept.
 */
export async function takeBeforeRun(
  deps: BeforeRunDeps,
  org: BeforeRunOrg,
  request: BeforeRunRequest,
  planned?: Pick<RunCheckpointEstimate, 'estimate'>,
): Promise<BeforeRunTake> {
  const take = await import('./takeCheckpoint.js');
  const scope = beforeRunScopeOf(request);
  if (planned !== undefined) {
    const disk = beforeRunDiskRefusal(
      planned.estimate.bytes,
      await (deps.freeBytes ?? freeBytesOf)(deps.store.root),
    );
    if (disk !== undefined) return { taken: false, refusal: disk };
  }
  let outcome: TakeOutcome;
  try {
    outcome = await take.takeCheckpoint(deps, takeRequestOf(org, scope, request));
  } catch (err: unknown) {
    if (err instanceof take.CheckpointTakeStopped) return { taken: false, stopped: true };
    throw err;
  }
  if (!outcome.taken) return { taken: false, refusal: outcome.refusal };
  return beforeRunOutcomeOf(deps.store, scope, outcome);
}

/** What became of a checkpoint before a run once the run ended. */
export interface BeforeRunSettled {
  info: RunCheckpointInfo;
  /** Why one the run wrote nothing after is kept all the same: the store would not delete it then. */
  notDeleted?: string;
}

/**
 * Keep the checkpoint a run took before its first write once the run wrote
 * a record — whatever became of the run after, a stop or a failure included —
 * or delete it when the run wrote none: its mute refused, no row to write, a
 * stop before its first write. One a take, a rewind or an undo of its org
 * holds the store's lock over stays, and says why.
 */
export async function settleBeforeRun(
  store: Pick<OrgCheckpointStore, 'delete'>,
  taken: RunCheckpointTaken,
  wrote: boolean,
): Promise<BeforeRunSettled> {
  if (wrote) return { info: taken };
  const deleted = await store.delete(taken.checkpointId);
  if (deleted.outcome === 'busy') {
    return {
      info: taken,
      notDeleted:
        `The checkpoint '${taken.name}' taken before the run is kept, though the run wrote ` +
        `nothing: ${lockHolderWords(deleted.holder)}. Delete it from the Checkpoints page once ` +
        'that has ended.',
    };
  }
  return { info: { state: 'deleted', deleted: 'nothingWritten' } };
}

// ─── What the run says of it ─────────────────────────────────────────────────

/** A run's refusal for its checkpoint's, as the run says it: nothing written, and what to do. */
export function beforeRunRefusedWords(refusal: Pick<CheckpointRefusal, 'message'>): string {
  const said = refusal.message.endsWith(NOTHING_READ)
    ? refusal.message.slice(0, -NOTHING_READ.length).trimEnd()
    : refusal.message;
  return (
    `The checkpoint before the run was refused: ${said} Nothing was written. Untick ` +
    'Checkpoint first to run without it, or fix what refuses it.'
  );
}

/** A run's failure for its checkpoint's, as the run says it. */
export function beforeRunFailedWords(err: unknown): string {
  const why = extractErrorMessage(err).replace(/\.$/, '');
  return `The checkpoint before the run could not be taken: ${why}. Nothing was written.`;
}

/** What a run that wrote nothing says of the checkpoint it took first, once deleted. */
export const BEFORE_RUN_DELETED_WORDS =
  'The checkpoint taken before the run was deleted: the run wrote nothing.';

/** The run's progress while its checkpoint is taken. */
export function beforeRunProgressWords(percentage: number): string {
  return `Taking the checkpoint first (${Math.round(percentage)}%)`;
}

// ─── The port the run handlers call ──────────────────────────────────────────

/** What a run handler asks of the checkpoint before its run. */
export interface BeforeRunAsk extends BeforeRunScopeInput {
  /** The registered org the run writes to. */
  orgId: string;
  /** The run, as the checkpoint's file and the take's audit entry name it. */
  operationId: string;
}

/** How the take before a run is run. */
export interface BeforeRunTakeOptions {
  /** What the run's question showed of it: the disk is checked against its bytes before anything is read. */
  planned?: Pick<RunCheckpointEstimate, 'estimate'>;
  /** The run's Stop: it stops the take between two reads, keeping nothing. */
  signal?: AbortSignal;
  /** The take's progress, for the run's own ({@link beforeRunProgressWords}). */
  onProgress?: (progress: TakeProgress) => void;
}

/**
 * What the handlers of the runs that write — Forge, Sync, Seed, Autopilot,
 * Frozen — take a checkpoint before their first write through. `own` is the
 * run's own mark, its operation or its run file, which alone does not refuse
 * the take: another run of the window, a run file another process writes and
 * the store's lock refuse it as ever.
 */
export interface BeforeRunCheckpoints {
  /** At the run's gate: what it would hold and cost, and the refusal a real run would meet. */
  scope(ask: BeforeRunAsk, own: BeforeRunOwn): Promise<RunCheckpointEstimate>;
  /** Once the question is answered, before the lease and the first write. */
  take(
    ask: BeforeRunAsk,
    own: BeforeRunOwn,
    options?: BeforeRunTakeOptions,
  ): Promise<BeforeRunTake>;
  /** Once the run ended: kept when it wrote a record, deleted when it wrote none. */
  settle(taken: RunCheckpointTaken, wrote: boolean): Promise<RunCheckpointInfo>;
}
