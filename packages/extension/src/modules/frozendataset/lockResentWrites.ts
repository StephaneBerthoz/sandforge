/**
 * What a load's updates and its reload's purge's deletes met of the target's
 * record locks: the records the target refused because it could not lock a
 * record their write needed, which the load's writer sent again on their own
 * (`BulkDataWriter.locksAgain`, `OperationOutcome.lockResends`), per object
 * and kind of write, and what became of them.
 *
 * The report counted those of the inserts alone (`PerObjectLoadResult
 * .sentAgainForALock`). The links of pass 2, the statuses set aside, the
 * fields of what the platform wrote, and the purge's deletes and
 * deactivations go through the same writer and the same sends again: said in
 * the writer's log alone, a load whose updates or purge met the lock and wrote
 * every record read as one that never met it.
 */

import type { FrozenSentAgainForALock } from '@sandforge/shared';
import { refusedForALock } from '../../core/engine/lockedRows.js';
import type { OperationOutcome } from '../sync/DataSync.js';

type Write = FrozenSentAgainForALock['write'];

/** A record by its first fifteen characters: the same record, whichever length its id is written in. */
function recordKey(id: string): string {
  return id.slice(0, 15);
}

/** What one object's writes of one kind met of the lock so far. */
interface Met {
  objectApiName: string;
  write: Write;
  /** Of the updates, the answer of each one sent again: each counted on its own. */
  updates: OperationOutcome[];
  /** Of the deletes, the last answer of each record sent again, by its key. */
  deletes: Map<string, { id: string; outcome: OperationOutcome }>;
}

/**
 * The records of a load's updates and of its purge's deletes its writer sent
 * again for a lock, as the load hands it each answer.
 *
 * An update is counted on its own, by its answer: two updates of a record —
 * its link in pass 2, its status after — are two writes, the one taken, the
 * other perhaps refused for another reason, and judged by the last, the one
 * the target took read as refused. A record of the purge is counted once, by
 * the purge's last word on it: one the lock held through its first delete is
 * sent once more when the rest has gone, and taken then, it was deleted.
 */
export class LockResentWrites {
  /** By object and write, in the order the load met them. */
  private readonly met = new Map<string, Met>();

  /** Note the answers of an update of `objectApiName`, in the order of its records. */
  updated(objectApiName: string, outcomes: readonly OperationOutcome[]): void {
    const sent = outcomes.filter((outcome) => outcome.lockResends !== undefined);
    if (sent.length > 0) this.of(objectApiName, 'update').updates.push(...sent);
  }

  /**
   * Note the answers of a delete of `objectApiName`, each at the place of its
   * record among `ids`: a record sent again for a lock, or sent again before,
   * keeps this answer as its last.
   */
  deleted(
    objectApiName: string,
    ids: readonly string[],
    outcomes: readonly OperationOutcome[],
  ): void {
    const before = this.met.get(keyOf(objectApiName, 'delete'))?.deletes;
    outcomes.forEach((outcome, i) => {
      const id = ids[i];
      if (id === undefined) return;
      const key = recordKey(id);
      if (outcome.lockResends === undefined && !before?.has(key)) return;
      this.of(objectApiName, 'delete').deletes.set(key, { id, outcome });
    });
  }

  /**
   * What they came to, per object and write, in the order the load met them;
   * empty when none met the lock.
   *
   * @param purged - Whether the purge counts the record purged: deleted,
   *   found gone, or taken along by a parent deleted after it. One it does
   *   not is among its failures, still refused for the lock or for another
   *   reason, by its last answer.
   */
  list(purged: (objectApiName: string, id: string) => boolean): FrozenSentAgainForALock[] {
    return [...this.met.values()].map(({ objectApiName, write, updates, deletes }) => {
      const answers =
        write === 'update'
          ? updates.map((outcome) => ({ outcome, taken: outcome.success }))
          : [...deletes.values()].map(({ id, outcome }) => ({
              outcome,
              taken: purged(objectApiName, id),
            }));
      let written = 0;
      let stillLocked = 0;
      for (const { outcome, taken } of answers) {
        if (taken) written++;
        else if (refusedForALock(outcome.errors, outcome.errorDetails)) stillLocked++;
      }
      return { objectApiName, write, rows: answers.length, written, stillLocked };
    });
  }

  private of(objectApiName: string, write: Write): Met {
    const key = keyOf(objectApiName, write);
    let met = this.met.get(key);
    if (!met) {
      met = { objectApiName, write, updates: [], deletes: new Map() };
      this.met.set(key, met);
    }
    return met;
  }
}

function keyOf(objectApiName: string, write: Write): string {
  return `${write}:${objectApiName}`;
}
