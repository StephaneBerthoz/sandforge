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
 * What a sweep of a Seed run is told: its window, read back from its records
 * (`seedWrittenBetween`); what it created, which the user it wrote as is read
 * from and which is never swept, the removal taking it; and what the target's
 * automation creates as the run's objects are written.
 *
 * @param automation - What the target runs on the run's objects, or why it
 *   could not be read: Forge's reader.
 */
export async function seedSweepInput(
  org: Pick<RemovalOrg, 'queryDeleted'>,
  created: Created,
  automation: ForgeTargetAutomation | { error: string },
  signal?: AbortSignal,
): Promise<SweepInput> {
  return {
    writtenBetween: await seedWrittenBetween(org, created, signal),
    created,
    remap: new Set(created.flatMap(({ ids }) => ids.map((id) => id.slice(0, 15)))),
    automation: sweepAutomationOf(automation),
    ...(signal ? { signal } : {}),
  };
}
