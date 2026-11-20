/**
 * What runs from this machine wrote to an org that its `/limits` has not
 * counted yet, for a storage gate to take off what the org says it has left.
 *
 * Salesforce counts a load in `DataStorageMB` minutes after it: a Developer
 * Edition of 5 MB still said 5 left a hundred seconds after a load of
 * 1.95 MB, and 2 only 384 seconds after it; a scratch org said 500 of 500
 * sixteen seconds after 1,500 contacts. A run started in between read room
 * the first had already taken, and its gate let through what no longer fit.
 *
 * Each gate that reads `/limits` of an org notes what it said, and each run
 * notes what it wrote when it ends: per object, the records it created less
 * those it deleted. What a gate takes off is what the runs that ended in the
 * last {@link UNCOUNTED_WINDOW_MINUTES} minutes wrote, sized by the gate's own
 * sizes, less the drop `/limits` shows since the last thing it said before
 * the first of them: nothing once it has counted them, never more room than
 * it says. The folder is the journals' own, one file per org under its
 * 15-character id, so the panel and the command lines of the same user see
 * each other's runs.
 *
 * A run its gate lets through notes, before its first write, what it was let
 * through to write ({@link noteStorageBegun}), and its end closes it. Two runs
 * into the same org at once did not see each other: the second's gate read
 * room the first was about to take, the first noting nothing until it ended.
 * A run still writing is taken off by what it was let through to write less
 * what the org has counted since it began, for as long as its process runs.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import * as z from 'zod';
import { BYTES_PER_MB, type UncountedWrites } from '@sandforge/shared';

/**
 * Minutes after its end a run's writes are taken off what `/limits` says, at
 * most: past the slowest count measured, 384 seconds.
 */
export const UNCOUNTED_WINDOW_MINUTES = 10;

/** How long what is noted is kept: what a gate said before a long run began is its baseline. */
const KEPT_MS = 24 * 60 * 60_000;

/** Lines past which the file is rewritten with what is still kept. */
const LINES_BEFORE_PRUNE = 200;

/**
 * What the folder and its files are made with: their owner's alone, as the
 * checkpoints, locks and run histories beside them are. They say which orgs
 * this user wrote to, when and how much.
 */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

const MINUTE_MS = 60_000;

/** Where the notes are kept, and when now is: tests give both. */
export interface StorageWrittenOptions {
  /** The folder: {@link storageWrittenDirOf} when not told. */
  dir?: string;
  now?: Date;
  /**
   * Whether the process that noted a run as begun still runs: told by its
   * id on this machine ({@link processRuns}) unless a test says.
   */
  alive?: (pid: number, host: string) => boolean;
}

/**
 * Whether a process of this machine runs, by its id: signal 0 tests it and
 * sends nothing, refused for one of another user's that runs. A run noted on
 * another machine sharing the folder cannot be told: taken for running.
 */
function processRuns(pid: number, host: string): boolean {
  if (host !== hostname()) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The bytes `rows` records of an object take, by the sizes of the gate that asks. */
export type RecordBytesOf = (objectApiName: string, rows: number) => number;

/**
 * The folder the notes are kept in: `storage-written/` in the folder
 * `SANDFORGE_JOURNAL_DIR` names, or in `.sandforge` in the home directory —
 * where the runs' journals and checkpoints are kept.
 */
export function storageWrittenDirOf(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env['SANDFORGE_JOURNAL_DIR'];
  const home =
    dir !== undefined && dir.trim() !== '' ? resolve(dir) : join(homedir(), '.sandforge');
  return join(home, 'storage-written');
}

/** An org's own id, as Salesforce gives it: 15 or 18 letters and digits. */
const ORG_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** The file of an org, or nothing for what is not an org id. */
function fileOf(orgId: string, options: StorageWrittenOptions): string | undefined {
  if (!ORG_ID.test(orgId)) return undefined;
  return join(options.dir ?? storageWrittenDirOf(), `${orgId.slice(0, 15)}.ndjson`);
}

/** A run as its notes name it: the id of its operation, or of its run on the command line. */
const runKeySchema = z.string().min(1).max(200);

/**
 * One line of the file: what `/limits` said was left, what a run wrote, per
 * object, as it ended, or what a run its gate let through was to write, in
 * MB, as it began, with the process that writes it.
 */
const noteSchema = z.union([
  z.object({ at: z.string(), saidMB: z.number() }),
  z.object({
    at: z.string(),
    wrote: z.record(z.string(), z.number()),
    run: runKeySchema.optional(),
  }),
  z.object({
    at: z.string(),
    begunMB: z.number().positive(),
    run: runKeySchema,
    pid: z.number().int().positive(),
    host: z.string(),
  }),
]);
interface Said {
  at: number;
  saidMB: number;
}
interface Wrote {
  at: number;
  wrote: Readonly<Record<string, number>>;
  run?: string;
}
interface Begun {
  at: number;
  begunMB: number;
  run: string;
  pid: number;
  host: string;
}
type Note = Said | Wrote | Begun;

/** The notes of a file in the order they happened, a line that does not hold passed over. */
function notesOf(file: string): Note[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const notes: Note[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let read: ReturnType<typeof noteSchema.safeParse>;
    try {
      read = noteSchema.safeParse(JSON.parse(line));
    } catch {
      continue;
    }
    if (!read.success) continue;
    const time = Date.parse(read.data.at);
    if (Number.isNaN(time)) continue;
    const { data } = read;
    notes.push(
      'saidMB' in data
        ? { at: time, saidMB: data.saidMB }
        : 'wrote' in data
          ? { at: time, wrote: data.wrote, ...(data.run !== undefined ? { run: data.run } : {}) }
          : { at: time, begunMB: data.begunMB, run: data.run, pid: data.pid, host: data.host },
    );
  }
  // Two processes may append out of order: read in the order they happened.
  return notes.sort((a, b) => a.at - b.at);
}

/**
 * Add a note to an org's file, rewriting it with what is still kept once it
 * grows. Never throws: a note that cannot be kept leaves a later gate where
 * it was before notes were kept.
 */
function append(orgId: string, note: object, options: StorageWrittenOptions): void {
  const file = fileOf(orgId, options);
  if (!file) return;
  const now = (options.now ?? new Date()).getTime();
  try {
    mkdirSync(options.dir ?? storageWrittenDirOf(), { recursive: true, mode: DIR_MODE });
    appendFileSync(file, `${JSON.stringify(note)}\n`, { encoding: 'utf8', mode: FILE_MODE });
    const notes = notesOf(file);
    if (notes.length <= LINES_BEFORE_PRUNE) return;
    const day = notes.filter((kept) => now - kept.at <= KEPT_MS);
    const ended = new Set(
      day.flatMap((kept) => ('wrote' in kept && kept.run !== undefined ? [kept.run] : [])),
    );
    // A run still writing keeps what it began with, however many lines came since.
    const writing = day
      .slice(0, -LINES_BEFORE_PRUNE / 2)
      .filter((kept) => 'begunMB' in kept && !ended.has(kept.run));
    const kept = [...writing, ...day.slice(-LINES_BEFORE_PRUNE / 2)].map((kept) =>
      JSON.stringify({ ...kept, at: new Date(kept.at).toISOString() }),
    );
    const next = `${file}.${process.pid}.tmp`;
    writeFileSync(next, kept.length > 0 ? `${kept.join('\n')}\n` : '', {
      encoding: 'utf8',
      mode: FILE_MODE,
    });
    renameSync(next, file);
  } catch {
    // Nothing to do: the gate reads what it can.
  }
}

/** Note what `/limits` of an org said it had left, in MB, as a gate read it. */
export function noteStorageSaid(
  orgId: string,
  remainingMB: number,
  options: StorageWrittenOptions = {},
): void {
  const at = (options.now ?? new Date()).toISOString();
  append(orgId, { at, saidMB: remainingMB }, options);
}

/**
 * Note, before a run's first write, what its gate let it through to write
 * to an org, in MB, by the run's key — the id of its operation, or of its run
 * on the command line — and the process that writes it: until its end is
 * noted under the same key ({@link noteStorageWritten}), or its process is
 * gone, the gates of that org take it off what `/limits` says. Nothing for
 * nothing to write.
 */
export function noteStorageBegun(
  orgId: string,
  run: string,
  mb: number,
  options: StorageWrittenOptions = {},
): void {
  if (!Number.isFinite(mb) || mb <= 0 || !runKeySchema.safeParse(run).success) return;
  const at = (options.now ?? new Date()).toISOString();
  append(orgId, { at, begunMB: mb, run, pid: process.pid, host: hostname() }, options);
}

/**
 * Note what a run wrote to an org as it ends: per object, the records it
 * created less those it deleted. Nothing for none, unless `run` names a run
 * noted as begun ({@link noteStorageBegun}): its end is noted, written or not,
 * and the gates of the org no longer take it off as still writing.
 */
export function noteStorageWritten(
  orgId: string,
  written: Readonly<Record<string, number>>,
  options: StorageWrittenOptions & { run?: string } = {},
): void {
  const wrote = Object.fromEntries(
    Object.entries(written).filter(([, rows]) => Number.isFinite(rows) && rows !== 0),
  );
  const { run } = options;
  const keyed = run !== undefined && runKeySchema.safeParse(run).success ? run : undefined;
  if (Object.keys(wrote).length === 0 && !begunUnder(orgId, keyed, options)) return;
  const at = (options.now ?? new Date()).toISOString();
  append(orgId, { at, wrote, ...(keyed !== undefined ? { run: keyed } : {}) }, options);
}

/** Whether an org's file holds what `run` began with, its end not noted yet. */
function begunUnder(
  orgId: string,
  run: string | undefined,
  options: StorageWrittenOptions,
): boolean {
  if (run === undefined) return false;
  const file = fileOf(orgId, options);
  if (!file) return false;
  const notes = notesOf(file);
  return (
    notes.some((note) => 'begunMB' in note && note.run === run) &&
    !notes.some((note) => 'wrote' in note && note.run === run)
  );
}

/**
 * What a run wrote, per object, from its counts as its audit entry keeps
 * them: the records it created — those an upsert wrote without saying which
 * among them, as a gate counts what may take room — less those it deleted.
 */
export function writtenOfCounts(
  objects: ReadonlyArray<{
    objectApiName: string;
    created: number;
    deleted: number;
    upserted?: number;
  }>,
): Record<string, number> {
  const written: Record<string, number> = {};
  for (const { objectApiName, created, deleted, upserted = 0 } of objects) {
    written[objectApiName] = (written[objectApiName] ?? 0) + created + upserted - deleted;
  }
  return written;
}

/**
 * What runs from this machine wrote to an org in the last
 * {@link UNCOUNTED_WINDOW_MINUTES} minutes, and are still writing, that
 * `/limits`, saying `remainingMB` now, has not counted yet, sized by
 * `bytesOf`: the runs that came after the ones the change in what it says
 * accounts for. Nothing when it has counted them all, when what is left to
 * count frees more than it takes, or nothing was written.
 *
 * Salesforce counts the runs in the order they ended, each a while after it:
 * the change since the last thing it said before the first of them is what
 * the first few of them came to, signed — a removal it counted raises what
 * it says. The few are those whose sum is closest to that change, which
 * `/limits` says to the MB: a drop of 1 for 1.05 MB written counts the run
 * whole. Read so, a removal counted before a run of the same records ran
 * again no longer cancels that run, and a run counted leaves no remnant
 * under the MB said not counted yet. Nothing said before them, none is
 * counted. Run for real on a scratch org of 500 MB: an insert was counted
 * 15 to 22 s after it ended, a removal 24 to 28 s after.
 *
 * A run still writing ({@link noteStorageBegun}) is read from when it began,
 * the runs that ended since among the few, those past the window counted
 * whatever the change: what the change comes to past them is what the org
 * has counted of it, and the rest of what it was let through to write is
 * taken off.
 */
export function uncountedWritesOf(
  orgId: string,
  remainingMB: number,
  bytesOf: RecordBytesOf,
  options: StorageWrittenOptions = {},
): UncountedWrites | undefined {
  const file = fileOf(orgId, options);
  if (!file) return undefined;
  const now = (options.now ?? new Date()).getTime();
  const notes = notesOf(file);
  const window = UNCOUNTED_WINDOW_MINUTES * MINUTE_MS;
  const open = stillWriting(notes, now, options.alive ?? processRuns);
  // Back to the first run still writing: what ended since it began explains
  // part of the change, and is counted past the window, as any run ended so
  // long ago is.
  const since = Math.min(now - window, open[0]?.at ?? Infinity);
  const isWrite = (note: Note): note is Wrote =>
    'wrote' in note && note.at <= now && note.at >= since;
  const writes = notes.filter(isWrite).map((note) => ({
    at: note.at,
    bytes: Object.entries(note.wrote).reduce(
      (sum, [objectApiName, rows]) =>
        sum + Math.sign(rows) * bytesOf(objectApiName, Math.abs(rows)),
      0,
    ),
  }));
  if (writes.length === 0 && open.length === 0) return undefined;
  // What it said last before the first of them, in the order noted: a gate's
  // read and the end of the run it let through can fall in one millisecond.
  const first = notes.findIndex((note) => isWrite(note) || open.includes(note as Begun));
  const before = notes
    .slice(0, first)
    .filter((note): note is Said => 'saidMB' in note)
    .at(-1);
  const past = writes.filter((write) => now - write.at > window).length;
  const taken = before ? (before.saidMB - remainingMB) * BYTES_PER_MB : 0;
  const counted = before ? countedRunsOf(writes, taken, past) : past;
  const left = writes.slice(counted);
  // What the change comes to past the runs it counted is what the org has
  // counted of those still writing, the first begun first.
  let ofTheOpen = before ? taken - sumOf(writes.slice(0, counted)) : 0;
  const writing = open
    .map((run) => {
      const begun = run.begunMB * BYTES_PER_MB;
      const countedOfIt = Math.min(begun, Math.max(0, ofTheOpen));
      ofTheOpen -= countedOfIt;
      return { at: run.at, bytes: begun - countedOfIt };
    })
    .filter((run) => run.bytes > 0);
  const bytes = sumOf(left) + sumOf(writing);
  if (bytes <= 0) return undefined;
  const from = Math.min(left[0]?.at ?? now, writing[0]?.at ?? now);
  return {
    mb: bytes / BYTES_PER_MB,
    runs: left.filter((write) => write.bytes > 0).length + writing.length,
    minutes: Math.max(1, Math.ceil((now - from) / MINUTE_MS)),
    ...(writing.length > 0 ? { writing: writing.length } : {}),
  };
}

/**
 * The runs of `notes` let through by their gate that are still writing: no
 * end noted under their key, begun no more than a day ago, their process
 * running. In the order they began.
 */
function stillWriting(
  notes: readonly Note[],
  now: number,
  alive: (pid: number, host: string) => boolean,
): Begun[] {
  const ended = new Set(
    notes.flatMap((note) => ('wrote' in note && note.run !== undefined ? [note.run] : [])),
  );
  const seen = new Set<string>();
  return notes.filter((note): note is Begun => {
    if (!('begunMB' in note) || note.at > now || now - note.at > KEPT_MS) return false;
    if (ended.has(note.run) || seen.has(note.run)) return false;
    seen.add(note.run);
    return alive(note.pid, note.host);
  });
}

/** The bytes of `writes` together. */
function sumOf(writes: ReadonlyArray<{ bytes: number }>): number {
  return writes.reduce((sum, write) => sum + write.bytes, 0);
}

/**
 * How many of `writes`, in the order they ended, the change `taken` in what
 * `/limits` says came to, in bytes, signed: the first few whose sum is the
 * closest to it, `past` of them at least. Of two as close, the fewer: a run
 * is not taken for counted on a figure that cannot tell which. Of two that
 * come to the same, the more, which leaves as much to take off: run for
 * real, a run, its removal and the same run again, nothing said between
 * them, were all said not counted — "what 2 runs … in the last 3 minute(s)" —
 * where the first two came to nothing.
 */
function countedRunsOf(writes: ReadonlyArray<{ bytes: number }>, taken: number, past = 0): number {
  let sum = sumOf(writes.slice(0, past));
  let counted = past;
  let countedSum = sum;
  let closest = Math.abs(taken - sum);
  for (let index = past; index < writes.length; index++) {
    sum += writes[index]?.bytes ?? 0;
    const off = Math.abs(taken - sum);
    // Sizes are whole bytes: less than one apart, the same sum.
    if (off < closest || Math.abs(sum - countedSum) < 1) {
      closest = Math.min(off, closest);
      counted = index + 1;
      countedSum = sum;
    }
  }
  return counted;
}
