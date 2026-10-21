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
 */

import type { ForgeTargetAutomation, ForgeWrittenBetween } from '@sandforge/shared';

import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { idLists } from '../dataops/RecordRemoval.js';
import type { RemovalOrg } from '../forge/ForgeRunRemoval.js';
import { sweepAutomationOf, type SweepInput } from '../forge/ForgeRunSweep.js';

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
  const now = writes.now ?? (() => new Date());
  let ahead: number;
  try {
    const before = now().getTime();
    const orgNow = Date.parse(await writes.serverTime());
    if (!Number.isFinite(orgNow)) return written;
    ahead = orgNow - (before + now().getTime()) / 2;
  } catch {
    return written;
  }
  const began = Number.isFinite(at) ? Math.min(first, at + ahead) : first;
  const ended = Number.isFinite(lastAt) ? Math.max(last, lastAt + ahead) : last;
  if (began === first && ended === last) return written;
  return {
    first: began === first ? written.first : new Date(began).toISOString(),
    last: ended === last ? written.last : new Date(ended).toISOString(),
  };
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
 */
export async function seedSweepInput(
  org: Pick<RemovalOrg, 'queryDeleted'>,
  created: Created,
  automation: ForgeTargetAutomation | { error: string },
  signal?: AbortSignal,
  writes?: RunWrites,
): Promise<SweepInput> {
  return {
    writtenBetween: await writtenSince(await seedWrittenBetween(org, created, signal), writes),
    created,
    remap: new Set(created.flatMap(({ ids }) => ids.map((id) => id.slice(0, 15)))),
    automation: sweepAutomationOf(automation),
    ...(signal ? { signal } : {}),
  };
}
