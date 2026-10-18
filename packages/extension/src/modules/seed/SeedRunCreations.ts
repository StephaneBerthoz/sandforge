/**
 * What each Seed run of the panel created, kept so the run can be taken back
 * from its results, or from the list of earlier seeds: the records it
 * inserted, per object in the order it wrote them, as the removal Sync, Forge
 * and Frozen run reads a run (`removeSyncRun`).
 *
 * The results the page shows cannot be what a removal reads: they carry the
 * first thousand ids of an object at most, and a removal of a cut list would
 * leave the rest of the run's records in the org with nothing to tell them
 * from the org's own. The ids are kept here, whole, as the run returns them.
 *
 * Kept on disk, in the extension's storage directory, one file per run under
 * `seed-runs/`, as a Sync run's creations are kept (`SyncRunCreations`), and
 * never in globalState, which VS Code writes whole on every change: a seed of
 * fifty thousand records keeps fifty thousand ids. They were kept in memory,
 * for the window's life: a seed written into an org, then the window reloaded,
 * could no longer be taken back from the panel. Ids and dates alone, never a
 * value of a record.
 *
 * Bounded: the {@link SEED_RUNS_KEPT} latest runs are kept, the oldest run
 * removed with nothing left going first past it, then the oldest; and the
 * files are bounded on bytes as a Sync run's are.
 *
 * A run the command line made is taken back from the summary it printed
 * (`sandforge-seed --remove`), which builds the run the same way
 * (`seedRunKept`).
 */

import type { ApiName } from '@sandforge/shared';
import {
  nodeSyncRunCreations,
  settled,
  type SyncRunCreations,
  type SyncRunKept,
  type SyncRunRemovalState,
} from '../sync/SyncRunCreations.js';
import type { SyncRemovalStateStore } from '../sync/SyncRunRemoval.js';

/** Runs kept at most; the oldest goes past it, one removed with nothing left first. */
export const SEED_RUNS_KEPT = 20;

/** The directory, under the extension's storage, that the runs' files go in. */
export const SEED_RUNS_DIR = 'seed-runs';

/** Who the removal of a Seed run says ran it, where a Sync run names its configuration. */
const SEED_CONFIGURATION = 'sandforge-seed';

/** The most ids one line of a run's file holds, as a Sync run's file reads one. */
const IDS_PER_LINE = 50_000;

/** A Seed run as its result says it ended: what `seedRunKept` reads. */
export interface SeedRunEnded {
  runId: string;
  /** The org it wrote to: an alias on the command line, the org's id in the panel. */
  targetOrgId: string;
  startedAt?: string;
  finishedAt?: string;
  status: 'success' | 'partial' | 'failure';
  /** Whether a cancel stopped it. */
  cancelled?: boolean;
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

/** The store over Node's file system, under the extension's storage directory. */
export function nodeSeedRunCreations(storagePath: string): SeedRunCreations {
  return new SeedRunCreations(nodeSyncRunCreations(storagePath, SEED_RUNS_DIR));
}

/** The Seed runs of the panel and what their removals did: see the module's comment. */
export class SeedRunCreations implements SyncRemovalStateStore {
  /**
   * @param runs - Where the runs' files are kept: a Sync run's store, under
   *   {@link SEED_RUNS_DIR}.
   * @param max - Runs kept at most: {@link SEED_RUNS_KEPT} unless a test sets another.
   */
  constructor(
    private readonly runs: SyncRunCreations,
    private readonly max: number = SEED_RUNS_KEPT,
  ) {}

  /**
   * Keep what a run created; a run that created nothing is not kept. Then the
   * runs past the most kept go, the oldest removed with nothing left first.
   *
   * @throws When what the run created could not all be written: its removal
   *   would leave the rest in the org.
   */
  async record(run: SeedRunEnded): Promise<void> {
    const kept = seedRunKept(run);
    if (kept.created.length === 0) return;
    const recorder = this.runs.recorder({
      runId: kept.runId,
      configId: kept.configId,
      configName: kept.configName,
      sourceOrgId: kept.sourceOrgId,
      targetOrgId: kept.targetOrgId,
      startedAt: kept.startedAt,
    });
    // Dated when the run ended, as its result says: what a removal reads the
    // org's dates against, a record modified after it being changed since.
    const endedAt = kept.end?.at;
    for (const { objectApiName, ids } of kept.created) {
      for (let at = 0; at < ids.length; at += IDS_PER_LINE) {
        recorder.note(objectApiName, ids.slice(at, at + IDS_PER_LINE), endedAt);
      }
    }
    await recorder.end({
      status: run.status,
      ...(run.cancelled ? { cancelled: true } : {}),
      ...(endedAt !== undefined ? { at: endedAt } : {}),
    });
    const failure = await recorder.flush();
    if (failure !== undefined) throw new Error(failure);
    await this.keepTheLatest(kept.runId);
  }

  /** Drop the runs past the most kept: the oldest settled ones first, then the oldest. */
  private async keepTheLatest(recorded: string): Promise<void> {
    const runs = (await this.runs.list()).filter((run) => run.runId !== recorded);
    let over = runs.length + 1 - this.max;
    if (over <= 0) return;
    const oldestFirst = [...runs].reverse();
    for (const run of [...oldestFirst.filter(settled), ...oldestFirst.filter((r) => !settled(r))]) {
      if (over <= 0) return;
      await this.runs.forget(run.runId);
      over--;
    }
  }

  /** What a run kept, with what its removals did; undefined when nothing of it is kept. */
  get(runId: string): Promise<SyncRunKept | undefined> {
    return this.runs.get(runId);
  }

  /** Every run kept, newest first. */
  list(): Promise<SyncRunKept[]> {
    return this.runs.list();
  }

  /** Keep what a removal of a run did, for the next one: see `SyncRemovalStateStore`. */
  async updateRemoval(
    runId: string,
    change: (state: SyncRunRemovalState) => SyncRunRemovalState,
  ): Promise<void> {
    if (!(await this.runs.get(runId))) return;
    await this.runs.updateRemoval(runId, change);
  }
}
