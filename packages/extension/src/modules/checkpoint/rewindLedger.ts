/**
 * The rewinds of an org, kept for the histories of Seed, Sync and Forge to
 * mark the runs they took back: `rewinds.ndjson` in the org's folder of the
 * store, beside its checkpoints and not in any of them, so a rewind's line
 * outlives its checkpoint and its journal — the journal goes once the rewind
 * can no longer be undone, or at the org's next rewind, and the checkpoint
 * at its expiry.
 *
 * ```
 * <store>/<organizationId>/rewinds.ndjson    a line per rewind that wrote,
 *                                            and per undo that went through
 * ```
 *
 * One line is added as a rewind that wrote ends — gone through, stopped part
 * way, or ended before it was through — and one as an undo goes through,
 * whole or in part, each under the org's lock, which the rewind and the undo
 * hold for their whole length: two processes never add to one ledger at
 * once. Each line is flushed to the disk as it is added. Past
 * {@link LEDGER_MAX_LINES} lines, the file is written again whole, through a
 * file beside it renamed over it, with its last {@link LEDGER_KEPT_LINES}: a
 * history that reaches back two hundred rewinds is long enough, and the file
 * stays small enough to be read whole each time a history opens.
 *
 * A line holds dates, names and counts — the checkpoint's times and objects,
 * the rewind's times, how it ended and what it did in all — and never a
 * record's id or value: what is written is what `checkpointRewindRecordSchema`
 * parsed. The ledger informs and drives no write: a line that does not parse
 * — written half by a process killed as it wrote, or by a SandForge that
 * wrote it otherwise — is left out of the read and said, never a failure, and
 * a ledger that cannot be written is a note of the rewind's result, never its
 * failure.
 *
 * The store lists folders alone (`OrgCheckpointStore.list`), and sweeps what
 * is in checkpoints' folders: the file is neither listed nor swept.
 */

import { randomBytes } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  checkpointRewindRecordSchema,
  type CheckpointRewindEnded,
  type CheckpointRewindRecord,
  type CheckpointRewindTotals,
  type CheckpointRewindUndone,
  type OrgCheckpoint,
  type RewindResult,
} from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import {
  CHECKPOINT_FILE_MODE,
  CheckpointStoreError,
  makePrivateDir,
  organizationKey,
  type CheckpointFolder,
  type OrgLock,
} from './OrgCheckpointStore.js';

/** The ledger's file, in an org's folder of the store. */
export const REWIND_LEDGER_FILE = 'rewinds.ndjson';

/** Lines past which the ledger is written again with its last {@link LEDGER_KEPT_LINES}. */
export const LEDGER_MAX_LINES = 400;

/** Lines the ledger keeps once it passed {@link LEDGER_MAX_LINES}: the latest. */
export const LEDGER_KEPT_LINES = 200;

/** Where an org's ledger is, in the store `root`. */
export function rewindLedgerFileOf(root: string, organizationId: string): string {
  return join(root, organizationKey(organizationId), REWIND_LEDGER_FILE);
}

/** Where the ledger of the org a checkpoint is filed under is: beside the checkpoint's folder. */
export function rewindLedgerBeside(folder: Pick<CheckpointFolder, 'dir'>): string {
  return join(dirname(folder.dir), REWIND_LEDGER_FILE);
}

// ─── Writing ─────────────────────────────────────────────────────────────────

/** How many lines a ledger keeps, when a test says other than the defaults. */
export interface LedgerBounds {
  maxLines: number;
  keptLines: number;
}

/**
 * Add `record` to the ledger `file`, under the lock of its org: checked
 * first, so nothing the read would leave out is written, flushed to the
 * disk, and the ledger written again with its latest lines once it passed
 * its bound.
 *
 * @throws {CheckpointStoreError} `invalid`, when the lock is another org's
 *   or the record does not parse; what the file system throws.
 */
export async function appendToRewindLedger(
  file: string,
  lock: OrgLock,
  record: CheckpointRewindRecord,
  bounds: LedgerBounds = { maxLines: LEDGER_MAX_LINES, keptLines: LEDGER_KEPT_LINES },
): Promise<void> {
  if (organizationKey(record.organizationId) !== lock.organizationId) {
    throw new CheckpointStoreError(
      'invalid',
      'A rewind is kept in its org’s ledger, under its lock.',
    );
  }
  const parsed = checkpointRewindRecordSchema.safeParse(record);
  if (!parsed.success) {
    throw new CheckpointStoreError('invalid', 'A line of the rewind ledger does not parse.');
  }
  await makePrivateDir(dirname(file));
  const before = await textOf(file);
  // A line a killed process left without its end is closed first: the new
  // line is never read as part of it.
  const opening = before !== '' && !before.endsWith('\n') ? '\n' : '';
  const handle = await open(file, 'a', CHECKPOINT_FILE_MODE);
  try {
    await handle.writeFile(`${opening}${JSON.stringify(parsed.data)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  const lines = linesOf(before).length + 1;
  if (lines > bounds.maxLines) await keepLatest(file, bounds.keptLines);
}

/** Write the ledger again with its last `kept` lines: through a file beside it, renamed over it. */
async function keepLatest(file: string, kept: number): Promise<void> {
  const latest = linesOf(await textOf(file)).slice(-kept);
  const temp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  const handle = await open(temp, 'wx', CHECKPOINT_FILE_MODE);
  try {
    try {
      await handle.writeFile(latest.map((line) => `${line}\n`).join(''), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } catch (err: unknown) {
    await rm(temp, { force: true });
    throw err;
  }
}

// ─── Reading ─────────────────────────────────────────────────────────────────

/** A ledger, read: its lines that parse, in the order they were written, and those that did not. */
export interface RewindLedgerRead {
  records: CheckpointRewindRecord[];
  /** The lines left out, by their number in the file, from 1. */
  unreadable: number[];
}

/** A ledger's lines that parse, and the numbers of those that do not; none when it is not there. */
export async function readRewindLedger(file: string): Promise<RewindLedgerRead> {
  const read: RewindLedgerRead = { records: [], unreadable: [] };
  const text = await textOf(file);
  text.split('\n').forEach((line, index) => {
    if (line.trim() === '') return;
    const parsed = checkpointRewindRecordSchema.safeParse(parsedJson(line));
    if (parsed.success) read.records.push(parsed.data);
    else read.unreadable.push(index + 1);
  });
  return read;
}

/**
 * The ledgers of the orgs named, by their Organization Ids, in the store
 * `root`: each read once, by the org's key, whichever form of its
 * Organization Id names it.
 */
export async function readRewindLedgers(
  root: string,
  organizationIds: readonly string[],
): Promise<Map<string, RewindLedgerRead>> {
  const reads = new Map<string, RewindLedgerRead>();
  for (const id of organizationIds) {
    const key = organizationKey(id);
    if (reads.has(key)) continue;
    reads.set(key, await readRewindLedger(rewindLedgerFileOf(root, key)));
  }
  return reads;
}

// ─── The org's clock, as a rewind last read it ───────────────────────────────

/**
 * How far an org's clock is ahead of this machine's, from the last time a
 * rewind read it: the middle of the call against the time it answered. A
 * rewind reads the clock as it begins each read of the org — no request is
 * sent for the ledger alone.
 */
export class OrgClockWatch {
  private reading: { org: number; machine: number } | undefined;

  /** @param now - This machine's clock, in milliseconds. */
  constructor(private readonly now: () => number) {}

  /** `org`, its clock watched: every other call goes through to it as it was. */
  watched<T extends { serverTime(): Promise<string> }>(org: T): T {
    const watching = Object.create(org) as T;
    watching.serverTime = async () => {
      const sent = this.now();
      const answer = await org.serverTime();
      const at = Date.parse(answer);
      if (Number.isFinite(at)) this.reading = { org: at, machine: (sent + this.now()) / 2 };
      return answer;
    };
    return watching;
  }

  /** How far the org's clock is ahead of this machine's; undefined before it was read. */
  aheadMs(): number | undefined {
    return this.reading === undefined
      ? undefined
      : Math.round(this.reading.org - this.reading.machine);
  }

  /** Now on the org's clock, as far as it was last read: this machine's clock when it never was. */
  orgNow(): Date {
    return new Date(this.now() + (this.aheadMs() ?? 0));
  }
}

// ─── The lines of a rewind and of an undo ────────────────────────────────────

/** What a rewind or an undo did in all, by its result: records, never which. */
export function rewindTotalsOf(
  result: Pick<RewindResult, 'deleted' | 'restored' | 'undeleted' | 'recreated'>,
): CheckpointRewindTotals {
  const sum = <T>(objects: readonly T[], count: (object: T) => number): number =>
    objects.reduce((total, object) => total + count(object), 0);
  return {
    deleted: sum(result.deleted, (object) => object.deleted),
    restored: sum(result.restored, (object) => object.restored + (object.restoredWithout ?? 0)),
    undeleted: sum(result.undeleted, (object) => object.undeleted),
    recreated: sum(result.recreated ?? [], (object) => object.created),
  };
}

/** What a rewind that wrote is kept in the ledger with, as it ends. */
export interface RewindEnded {
  folder: Pick<CheckpointFolder, 'dir'>;
  lock: OrgLock;
  checkpoint: OrgCheckpoint;
  result: RewindResult;
  /** Tr of its first pass, on the org's clock. */
  startedAt: string;
  /** When its last read of the org began, on the org's clock; absent for one stopped part way. */
  endedAt?: string;
  clock: OrgClockWatch;
}

/** The ledger's line of a rewind that ended, as {@link noteRewindEnded} adds it. */
export function rewindEndedRecord(
  ended: Omit<RewindEnded, 'folder' | 'lock'>,
): CheckpointRewindEnded {
  const { checkpoint, result, clock } = ended;
  const ahead = clock.aheadMs();
  return {
    kind: 'rewind',
    rewindId: result.rewindId,
    checkpointId: checkpoint.checkpointId,
    checkpointName: checkpoint.name,
    organizationId: checkpoint.org.organizationId,
    mode: checkpoint.scope.mode,
    objects: checkpoint.objects.map(({ objectApiName }) => objectApiName),
    readFrom: checkpoint.readFrom,
    takenAt: checkpoint.takenAt,
    startedAt: ended.startedAt,
    endedAt: ended.endedAt ?? clock.orgNow().toISOString(),
    ...(ahead !== undefined ? { orgAheadMs: ahead } : {}),
    status: result.status,
    totals: rewindTotalsOf(result),
  };
}

/**
 * Add the line of a rewind that wrote to its org's ledger, as it ends.
 *
 * @returns The note its result carries when the line could not be added; nothing once it was.
 */
export async function noteRewindEnded(ended: RewindEnded): Promise<string | undefined> {
  try {
    await appendToRewindLedger(
      rewindLedgerBeside(ended.folder),
      ended.lock,
      rewindEndedRecord(ended),
    );
    return undefined;
  } catch (err: unknown) {
    return (
      `The rewind could not be kept in the org’s rewind ledger (${extractErrorMessage(err)}): ` +
      'the Seed, Sync and Forge histories will not mark the runs it took back.'
    );
  }
}

/** What an undo that went through is kept in the ledger with. */
export interface RewindUndone {
  folder: Pick<CheckpointFolder, 'dir'>;
  lock: OrgLock;
  checkpoint: Pick<OrgCheckpoint, 'checkpointId' | 'org'>;
  rewindId: string;
  status: CheckpointRewindUndone['status'];
  /** When it went through, on this machine's clock. */
  undoneAt: string;
}

/**
 * Add the line of an undo that went through, whole or in part, to its org's
 * ledger: the runs its rewind took back are marked undone.
 *
 * @returns The note its result carries when the line could not be added; nothing once it was.
 */
export async function noteRewindUndone(undone: RewindUndone): Promise<string | undefined> {
  try {
    await appendToRewindLedger(rewindLedgerBeside(undone.folder), undone.lock, {
      kind: 'undo',
      rewindId: undone.rewindId,
      checkpointId: undone.checkpoint.checkpointId,
      organizationId: undone.checkpoint.org.organizationId,
      status: undone.status,
      undoneAt: undone.undoneAt,
    });
    return undefined;
  } catch (err: unknown) {
    return (
      `The undo could not be kept in the org’s rewind ledger (${extractErrorMessage(err)}): ` +
      'the Seed, Sync and Forge histories may still mark the runs its rewind took back as rewound.'
    );
  }
}

// ─── Small helpers ───────────────────────────────────────────────────────────

/** A file's text; empty when it is not there. */
async function textOf(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return '';
    throw err;
  }
}

/** A file's lines that hold something, without their ends. */
function linesOf(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '');
}

function parsedJson(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}
