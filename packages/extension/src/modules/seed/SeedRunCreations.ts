/**
 * What each Seed run of this window created, kept so the run can be taken
 * back from its results: the records it inserted, per object in the order it
 * wrote them, as the removal Sync, Forge and Frozen run reads a run
 * (`removeSyncRun`).
 *
 * The results the page shows cannot be what a removal reads: they carry the
 * first thousand ids of an object at most, and a removal of a cut list would
 * leave the rest of the run's records in the org with nothing to tell them
 * from the org's own. The ids are kept here, whole, as the run returns them.
 *
 * Kept in memory, for the window's life, the latest runs first to stay: a
 * seed of fifty thousand records keeps fifty thousand ids, and VS Code's
 * global state, written whole on every change, is no place for them. A run
 * the command line made is taken back from the summary it printed
 * (`sandforge-seed --remove`), which builds the run the same way
 * (`seedRunKept`).
 */

import type { ApiName } from '@sandforge/shared';
import type { SyncRunKept, SyncRunRemovalState } from '../sync/SyncRunCreations.js';
import type { SyncRemovalStateStore } from '../sync/SyncRunRemoval.js';

/** Runs kept at most; the oldest goes past it. */
export const SEED_RUNS_KEPT = 20;

/** Who the removal of a Seed run says ran it, where a Sync run names its configuration. */
const SEED_CONFIGURATION = 'sandforge-seed';

/** A Seed run as its result says it ended: what `seedRunKept` reads. */
export interface SeedRunEnded {
  runId: string;
  /** The org it wrote to: an alias on the command line, the org's id in the panel. */
  targetOrgId: string;
  startedAt?: string;
  finishedAt?: string;
  status: 'success' | 'partial' | 'failure';
  objectResults: ReadonlyArray<{ objectApiName: ApiName; createdIds: readonly string[] }>;
}

/**
 * A Seed run as the removal Sync runs reads it (`removeSyncRun`): what it
 * created per object, in the order it wrote them, which the removal takes back
 * the last first; and what earlier removals of it left, when any did.
 */
export function seedRunKept(run: SeedRunEnded, removal?: SyncRunRemovalState): SyncRunKept {
  const finishedAt = run.finishedAt ?? new Date().toISOString();
  return {
    runId: run.runId,
    configId: SEED_CONFIGURATION,
    configName: SEED_CONFIGURATION,
    sourceOrgId: run.targetOrgId,
    targetOrgId: run.targetOrgId,
    startedAt: run.startedAt ?? finishedAt,
    end: { at: finishedAt, status: run.status },
    lastWrittenAt: finishedAt,
    created: run.objectResults
      .filter((object) => object.createdIds.length > 0)
      .map((object) => ({ objectApiName: object.objectApiName, ids: [...object.createdIds] })),
    ...(removal ? { removal } : {}),
  };
}

/** The Seed runs of this window and what their removals did: see the module's comment. */
export class SeedRunCreations implements SyncRemovalStateStore {
  private readonly runs = new Map<string, SyncRunKept>();

  /** @param max - Runs kept at most: {@link SEED_RUNS_KEPT} unless a test sets another. */
  constructor(private readonly max: number = SEED_RUNS_KEPT) {}

  /** Keep what a run created; a run that created nothing is not kept. */
  record(run: SeedRunEnded): void {
    const kept = seedRunKept(run);
    if (kept.created.length === 0) return;
    this.runs.delete(run.runId);
    this.runs.set(run.runId, kept);
    while (this.runs.size > this.max) {
      const oldest = this.runs.keys().next();
      if (oldest.done) break;
      this.runs.delete(oldest.value);
    }
  }

  /** What a run kept, with what its removals did; undefined when nothing of it is kept. */
  get(runId: string): SyncRunKept | undefined {
    return this.runs.get(runId);
  }

  /** Keep what a removal of a run did, for the next one: see `SyncRemovalStateStore`. */
  async updateRemoval(
    runId: string,
    change: (state: SyncRunRemovalState) => SyncRunRemovalState,
  ): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) return;
    this.runs.set(runId, { ...run, removal: change(run.removal ?? {}) });
  }
}
