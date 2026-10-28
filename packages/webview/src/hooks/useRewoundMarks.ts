import { useCallback } from 'react';
import {
  rewoundMarkOf,
  type CheckpointRewindListed,
  type RewoundMark,
  type RewoundRun,
} from '@sandforge/shared';

import { useBridgeQuery } from './useBridgeQuery';

/** What `checkpoint:rewinds` answers. */
interface RewindsAnswer {
  rewinds: CheckpointRewindListed[];
}

/**
 * The mark a history puts on a run a rewind took back: Seed, Sync and Forge
 * read the rewinds this machine keeps of every registered org once, then
 * mark each run by its dates (`rewoundMarkOf`). Nothing is marked until they
 * are read, nor when they cannot be — a store refused, say: a run without a
 * mark reads as it did before rewinds were kept.
 *
 * @param skip - Read nothing yet: a history with no run to mark.
 * @returns The mark of `run`, or undefined when no rewind of its org took any of it back.
 */
export function useRewoundMarks(skip = false): (run: RewoundRun) => RewoundMark | undefined {
  const read = useBridgeQuery<RewindsAnswer>('checkpoint:rewinds', undefined, { skip });
  const rewinds = read.data?.rewinds;
  return useCallback(
    (run: RewoundRun) =>
      Array.isArray(rewinds) && rewinds.length > 0
        ? rewoundMarkOf(run, rewinds, Date.now())
        : undefined,
    [rewinds],
  );
}
