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
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
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

/** One line of the file: what `/limits` said was left, or what a run wrote, per object. */
const noteSchema = z.union([
  z.object({ at: z.string(), saidMB: z.number() }),
  z.object({ at: z.string(), wrote: z.record(z.string(), z.number()) }),
]);
type Note =
  { at: number; saidMB: number } | { at: number; wrote: Readonly<Record<string, number>> };

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
    notes.push(
      'saidMB' in read.data
        ? { at: time, saidMB: read.data.saidMB }
        : { at: time, wrote: read.data.wrote },
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
    const kept = notes
      .filter((kept) => now - kept.at <= KEPT_MS)
      .slice(-LINES_BEFORE_PRUNE / 2)
      .map((kept) => JSON.stringify({ ...kept, at: new Date(kept.at).toISOString() }));
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
 * Note what a run wrote to an org as it ends: per object, the records it
 * created less those it deleted. Nothing for none.
 */
export function noteStorageWritten(
  orgId: string,
  written: Readonly<Record<string, number>>,
  options: StorageWrittenOptions = {},
): void {
  const wrote = Object.fromEntries(
    Object.entries(written).filter(([, rows]) => Number.isFinite(rows) && rows !== 0),
  );
  if (Object.keys(wrote).length === 0) return;
  const at = (options.now ?? new Date()).toISOString();
  append(orgId, { at, wrote }, options);
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
 * {@link UNCOUNTED_WINDOW_MINUTES} minutes that `/limits`, saying
 * `remainingMB` now, has not counted yet: what they wrote, sized by
 * `bytesOf`, less the drop since the last thing it said before the first of
 * them ended. Nothing when it has counted it all, or nothing was written.
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
  const recent = (note: Note): note is { at: number; wrote: Readonly<Record<string, number>> } =>
    'wrote' in note && note.at <= now && now - note.at <= UNCOUNTED_WINDOW_MINUTES * MINUTE_MS;
  const writes = notes.filter(recent).map((note) => ({
    at: note.at,
    bytes: Object.entries(note.wrote).reduce(
      (sum, [objectApiName, rows]) =>
        sum + Math.sign(rows) * bytesOf(objectApiName, Math.abs(rows)),
      0,
    ),
  }));
  if (writes.length === 0) return undefined;
  const first = Math.min(...writes.map((write) => write.at));
  // What it said last before the first of them, in the order noted: a gate's
  // read and the end of the run it let through can fall in one millisecond.
  const before = notes
    .slice(0, notes.findIndex(recent))
    .filter((note): note is { at: number; saidMB: number } => 'saidMB' in note)
    .at(-1);
  const counted = before ? Math.max(0, before.saidMB - remainingMB) * BYTES_PER_MB : 0;
  const left = writes.reduce((sum, write) => sum + write.bytes, 0) - counted;
  if (left <= 0) return undefined;
  return {
    mb: left / BYTES_PER_MB,
    runs: writes.filter((write) => write.bytes > 0).length,
    minutes: Math.max(1, Math.ceil((now - first) / MINUTE_MS)),
  };
}
