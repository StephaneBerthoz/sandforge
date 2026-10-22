/**
 * What a sweep of a Seed run's removal is told of the run (`SweepInput`):
 * Forge's sweep (`sweepRunRecords`), which a Frozen load's removal makes too,
 * takes what the target's automation created during the run, as the run's
 * user, that the run did not write itself.
 *
 * A seed into an org whose flows open a task on each new contact left those
 * tasks behind once it was removed: the removal takes the records the run
 * inserted, and nothing else. The weekly canary deleted them itself.
 *
 * A Seed run keeps no dates from the org, only its own clock's, which a sweep
 * never compares with the org's. Its window is read back from the run's own
 * records instead: a seed only inserts, so the run wrote from the earliest
 * `CreatedDate` of its records to the latest. The recycle bin is read with
 * them, so the window stands once a removal has taken some.
 *
 * A Sync run writes more than it creates: an update, an upsert that matched,
 * before its first creation or after its last — a delta run's updates, the
 * second write that sets the lookups of a cycle. What the target's automation
 * did on those was outside a window that ran from the first record created
 * to a minute after the last, and stayed once the run was removed. Its window
 * runs from its first write to its last instead, the dates its file gave its
 * calls, read on the org's clock (`writtenSince`).
 *
 * A Sync run that created nothing — it updated, or upserted onto records the
 * target held — had no window at all: none of its records dated one, and its
 * removal swept nothing, whatever the target's update flows had opened. Its
 * window is its first write to its last alone (`writesWindow`), and the user
 * it wrote as is read from the records it wrote over (`writerOf`), before a
 * removal puts their values back.
 */

import type { ForgeTargetAutomation, ForgeWrittenBetween } from '@sandforge/shared';

import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { idLists } from '../dataops/RecordRemoval.js';
import type { RemovalOrg } from '../forge/ForgeRunRemoval.js';
import {
  SWEEP_LEAD_MS,
  SWEEP_TRAIL_MS,
  sweepAutomationOf,
  type SweepInput,
} from '../forge/ForgeRunSweep.js';

/** What a run created, per object, as it kept it. */
type Created = ReadonlyArray<{ readonly objectApiName: string; readonly ids: readonly string[] }>;

/**
 * When the target dated the run's writes: the earliest and the latest
 * `CreatedDate` of the records it created, read from the org and its recycle
 * bin. Undefined when none of them could be read, and the sweep then sweeps
 * nothing, as for a run the target did not date.
 */
export async function seedWrittenBetween(
  org: Pick<RemovalOrg, 'queryDeleted'>,
  created: Created,
  signal?: AbortSignal,
): Promise<ForgeWrittenBetween | undefined> {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  for (const { objectApiName, ids } of created) {
    const object = assertSoqlIdentifier(objectApiName);
    for (const list of idLists(ids)) {
      if (signal?.aborted) return undefined;
      const answer = await org.queryDeleted(
        `SELECT Id, CreatedDate FROM ${object} WHERE Id IN (${list})`,
      );
      for (const row of answer.records) {
        const at = Date.parse(String((row as { CreatedDate?: unknown }).CreatedDate ?? ''));
        if (!Number.isFinite(at)) continue;
        first = Math.min(first, at);
        last = Math.max(last, at);
      }
    }
  }
  if (!Number.isFinite(first) || !Number.isFinite(last)) return undefined;
  return { first: new Date(first).toISOString(), last: new Date(last).toISOString() };
}

/**
 * When a run first and last wrote to its target, on this machine's clock,
 * and the org's clock to read them on.
 */
export interface RunWrites {
  /** The date the run's file gave its first call to the target. */
  at: string;
  /**
   * The latest date its file gave a write, whatever it wrote: a call as it
   * went or as it answered, an update included (`SyncRunKept.lastWriteAt`).
   */
  lastAt?: string;
  /** The org's clock now. */
  serverTime: () => Promise<string>;
  /** This machine's clock; now unless a test says. */
  now?: () => Date;
}

/**
 * A run's window, `written` from its records, begun at its first write when
 * that came earlier and ended at its last write when that came later: the
 * dates this machine's clock gave the run's calls, moved onto the org's clock
 * by how far the two stand apart now. The first, written before its call
 * went, is never after the org dated what the call wrote; the last, written
 * as a call went or answered, is never before the org dated what the calls
 * before it wrote. As it was, when the run says neither, or the org's clock
 * cannot be read: this machine's clock may stand minutes away from the org's.
 */
export async function writtenSince(
  written: ForgeWrittenBetween | undefined,
  writes: RunWrites | undefined,
): Promise<ForgeWrittenBetween | undefined> {
  if (!written || !writes) return written;
  const at = Date.parse(writes.at);
  const lastAt = Date.parse(writes.lastAt ?? '');
  const first = Date.parse(written.first);
  const last = Date.parse(written.last);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return written;
  if (!Number.isFinite(at) && !Number.isFinite(lastAt)) return written;
  const ahead = await orgAheadOf(writes);
  if (ahead === undefined) return written;
  const began = Number.isFinite(at) ? Math.min(first, at + ahead) : first;
  const ended = Number.isFinite(lastAt) ? Math.max(last, lastAt + ahead) : last;
  if (began === first && ended === last) return written;
  return {
    first: began === first ? written.first : new Date(began).toISOString(),
    last: ended === last ? written.last : new Date(ended).toISOString(),
  };
}

/** How far the org's clock runs ahead of this machine's, or undefined when it cannot be read. */
async function orgAheadOf(writes: RunWrites): Promise<number | undefined> {
  const now = writes.now ?? (() => new Date());
  try {
    const before = now().getTime();
    const orgNow = Date.parse(await writes.serverTime());
    if (!Number.isFinite(orgNow)) return undefined;
    return orgNow - (before + now().getTime()) / 2;
  } catch {
    return undefined;
  }
}

/**
 * The window of a run that created nothing, from the dates its file gave its
 * writes alone: its first write to its last, moved onto the org's clock as
 * {@link writtenSince} moves them. Undefined when it names no first write, or
 * the org's clock cannot be read: this machine's may stand minutes away.
 */
export async function writesWindow(
  writes: RunWrites | undefined,
): Promise<ForgeWrittenBetween | undefined> {
  if (!writes) return undefined;
  const at = Date.parse(writes.at);
  if (!Number.isFinite(at)) return undefined;
  const lastAt = Date.parse(writes.lastAt ?? '');
  const ahead = await orgAheadOf(writes);
  if (ahead === undefined) return undefined;
  const last = Number.isFinite(lastAt) ? Math.max(at, lastAt) : at;
  return { first: new Date(at + ahead).toISOString(), last: new Date(last + ahead).toISOString() };
}

/** Records read per object, and objects read, to tell who wrote over them. */
const WRITER_SAMPLE = 50;
const WRITER_SAMPLE_OBJECTS = 3;

/** A 15- or 18-character Salesforce id. */
const SF_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/**
 * The user a run that created nothing wrote as: who last modified, in its
 * window (`written`, a second before and a minute after, as a sweep looks),
 * the records it wrote over — a few of a few objects, who must agree. A
 * record modified since, by a colleague or a removal that put its values
 * back, is out of the window and tells nothing; read once a removal has put
 * them all back, none does, and the sweep is refused, as for a run whose
 * user cannot be read. Undefined when none tells it, or two users do.
 */
export async function writerOf(
  org: Pick<RemovalOrg, 'query'>,
  writtenOver: Created,
  written: ForgeWrittenBetween,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const from = Date.parse(written.first) - SWEEP_LEAD_MS;
  const to = Date.parse(written.last) + SWEEP_TRAIL_MS;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return undefined;
  const writers = new Map<string, string>();
  let objectsRead = 0;
  for (const { objectApiName, ids } of writtenOver) {
    if (objectsRead >= WRITER_SAMPLE_OBJECTS || writers.size > 1 || signal?.aborted) break;
    const sample = ids.slice(0, WRITER_SAMPLE);
    if (sample.length === 0) continue;
    let rows: unknown[];
    try {
      const [list] = idLists(sample, sample.length);
      rows = (
        await org.query(
          `SELECT Id, LastModifiedById, LastModifiedDate FROM ${assertSoqlIdentifier(objectApiName)} WHERE Id IN (${list})`,
        )
      ).records;
    } catch {
      continue;
    }
    let told = false;
    for (const row of rows) {
      const { LastModifiedById: by, LastModifiedDate: date } = (row ?? {}) as Record<
        string,
        unknown
      >;
      const at = typeof date === 'string' ? Date.parse(date) : Number.NaN;
      if (typeof by !== 'string' || !SF_ID.test(by) || !(at >= from && at <= to)) continue;
      if (!writers.has(by.slice(0, 15))) writers.set(by.slice(0, 15), by);
      told = true;
    }
    if (told) objectsRead++;
  }
  return writers.size === 1 ? [...writers.values()][0] : undefined;
}

/**
 * What a sweep of a Seed run is told: its window, read back from its records
 * (`seedWrittenBetween`), begun at its first write and ended at its last when
 * it says them (`writtenSince`); what it created, which the user it wrote as
 * is read from and which is never swept, the removal taking it; and what the
 * target's automation creates as the run's objects are written.
 *
 * @param automation - What the target runs on the run's objects, or why it
 *   could not be read: Forge's reader.
 * @param writes - When the run first and last wrote: a Sync run's calls,
 *   which may be updates before anything was created or after the last.
 * @param writtenOver - The records a Sync run wrote over: never swept, and,
 *   of a run that created nothing, what tells the user it wrote as. Read
 *   before a removal puts their values back.
 */
export async function seedSweepInput(
  org: Pick<RemovalOrg, 'queryDeleted'> & Partial<Pick<RemovalOrg, 'query'>>,
  created: Created,
  automation: ForgeTargetAutomation | { error: string },
  signal?: AbortSignal,
  writes?: RunWrites,
  writtenOver: Created = [],
): Promise<SweepInput> {
  const createdAny = created.some(({ ids }) => ids.length > 0);
  // A run that created nothing is dated by its writes alone.
  const writtenBetween = createdAny
    ? await writtenSince(await seedWrittenBetween(org, created, signal), writes)
    : await writesWindow(writes);
  const query = org.query?.bind(org);
  const user =
    !createdAny && writtenBetween && query
      ? await writerOf({ query }, writtenOver, writtenBetween, signal)
      : undefined;
  return {
    writtenBetween,
    created,
    remap: new Set(
      [...created, ...writtenOver].flatMap(({ ids }) => ids.map((id) => id.slice(0, 15))),
    ),
    automation: sweepAutomationOf(automation),
    ...(user ? { user } : {}),
    ...(signal ? { signal } : {}),
  };
}
