/**
 * What earlier runs between two orgs left in the target, as a run that
 * inserts the same objects again would meet it: what Quick Sync's preview and
 * a history entry's Run again say before they insert.
 *
 * Every re-run of a Sync inserted every record again, and no screen said so:
 * a Quick Sync run each week to refresh a sandbox added a full copy of every
 * record each time. A run of a saved configuration now leaves what earlier
 * runs of it copied as it is (`SyncOrchestrator`); any other insert — a
 * Quick Sync, which keeps no configuration, a run of one never saved or no
 * longer saved — writes every record again, and is told beforehand how many
 * the last run between the same orgs created that are still there.
 */

import type { SyncEarlierCopies } from '@sandforge/shared';
import { syncRemovalPlan, type SyncRunKept } from './SyncRunCreations.js';

/** The most records of one object asked of the target; past them, what the run kept is counted. */
export const EARLIER_COPIES_CHECKED = 10_000;

/** What {@link earlierCopiesOf} reads. */
export interface EarlierCopiesDeps {
  /** Every run kept on this machine, newest first. */
  runs: () => Promise<SyncRunKept[]>;
  /** Whether a configuration is saved under this id, so its runs leave what earlier ones copied. */
  isSaved: (configId: string) => boolean;
  /** Of these records of an object, how many the target still holds. */
  countInTarget: (objectApiName: string, ids: readonly string[]) => Promise<number>;
}

/**
 * What the last run kept between `sourceOrgId` and `targetOrgId` created of
 * `objects` that is still in the target, or that a run of the saved
 * configuration `configId` leaves as it is. What its removals took is not
 * counted, and the rest is asked of the target; when the target cannot be
 * asked, what the run kept less what its removals took is said, and why.
 */
export async function earlierCopiesOf(
  input: {
    sourceOrgId: string;
    targetOrgId: string;
    objects: readonly string[];
    configId?: string;
  },
  deps: EarlierCopiesDeps,
): Promise<SyncEarlierCopies> {
  if (input.configId !== undefined && deps.isSaved(input.configId)) {
    return { leftAsIs: true, objects: [] };
  }
  const wanted = new Set(input.objects);
  if (wanted.size === 0) return { leftAsIs: false, objects: [] };
  const left = (run: SyncRunKept): Array<{ objectApiName: string; ids: string[] }> =>
    syncRemovalPlan(run).filter((object) => wanted.has(object.objectApiName));
  const run = (await deps.runs()).find(
    (kept) =>
      kept.sourceOrgId === input.sourceOrgId &&
      kept.targetOrgId === input.targetOrgId &&
      left(kept).length > 0,
  );
  if (!run) return { leftAsIs: false, objects: [] };

  // In the order the run first wrote each object.
  const order = run.created.map((object) => object.objectApiName);
  const remaining = left(run).sort(
    (a, b) => order.indexOf(a.objectApiName) - order.indexOf(b.objectApiName),
  );
  let unread: string | undefined;
  const objects: SyncEarlierCopies['objects'] = [];
  for (const { objectApiName, ids } of remaining) {
    const asked = ids.slice(0, EARLIER_COPIES_CHECKED);
    let count: number;
    try {
      count = (await deps.countInTarget(objectApiName, asked)) + (ids.length - asked.length);
    } catch (err: unknown) {
      unread ??= err instanceof Error ? err.message : String(err);
      count = ids.length;
    }
    if (count > 0) objects.push({ objectApiName, count });
  }
  return {
    leftAsIs: false,
    run: {
      runId: run.runId,
      configName: run.configName,
      startedAt: run.startedAt,
      // A session's removal is on its tab: the history lists none.
      ...(run.realtime ? { realtime: true as const } : {}),
    },
    objects,
    ...(unread !== undefined ? { unread } : {}),
  };
}
