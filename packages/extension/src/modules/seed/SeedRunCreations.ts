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
 * Written as the run writes, each insert's ids as soon as the org answers it
 * (`recorder`), as a Sync run's are: the file was written once the run ended,
 * so a window closed under a seed, or a host that stopped, left the records it
 * had inserted in the org with nothing to take them back from. Such a run is
 * kept with no end, and listed as one that did not end.
 *
 * Each call is kept before it goes too (`sending`), a Bulk API job with its id
 * once the org has opened it, as a Sync run keeps its calls: the records of a
 * job still running when the window closed were in the org with no line of
 * them, the job running on to its end on the org's side. Read back from the
 * job by its id once the run is listed again (`readJobCreated`), they are
 * added to the run's file as the job's answer (`answerInFlight`).
 *
 * The panel's CSV imports and clones from another org are kept here too,
 * named by their way (`SeedRunStart.origin`), and taken back the same way.
 *
 * Bounded: of the runs removed with nothing left, the {@link SEED_RUNS_KEPT}
 * latest are kept, the oldest going first past it; a run whose records are
 * still in its org is never dropped on a count. The runs of every org and of
 * every way share the folder: twenty small CSV imports, or a day of Quick
 * Seeds on scratch orgs, pushed out a template seed of thousands of records
 * that was never removed, without a word. The files are bounded on bytes as
 * a Sync run's are, which caps what they take on disk, and a run the hard
 * bound drops is said (`SyncRunCreationsDeps.onDropped`).
 *
 * A run the command line made is taken back from the summary it printed
 * (`sandforge-seed --remove`), which builds the run the same way
 * (`seedRunKept`), or from the file it keeps here as it writes, under the
 * folder `SANDFORGE_JOURNAL_DIR` names: a run killed before it printed its
 * summary kept what it created in memory alone.
 */

import type { ApiName } from '@sandforge/shared';
import {
  IDS_PER_LINE,
  nodeSyncRunCreations,
  PIPELINE_NAME_KEPT,
  settled,
  type SendingCall,
  type SyncRunCreations,
  type SyncRunKept,
  type SyncRunRemovalState,
} from '../sync/SyncRunCreations.js';
import type { SyncRemovalStateStore } from '../sync/SyncRunRemoval.js';

/** Runs removed with nothing left kept at most; the oldest of them goes past it. */
export const SEED_RUNS_KEPT = 20;

/** The directory, under the extension's storage, that the runs' files go in. */
export const SEED_RUNS_DIR = 'seed-runs';

/** Who the removal of a Seed run says ran it, where a Sync run names its configuration. */
const SEED_CONFIGURATION = 'sandforge-seed';

/**
 * A run of the panel as it begins: a seed the generator writes, or a CSV
 * import or a clone from another org, which are kept the same way and listed
 * with them (`origin`). A CSV import and a clone were not kept at all, and
 * what they wrote could not be taken back from SandForge.
 */
export interface SeedRunStart {
  runId: string;
  /** The org it writes to: the org's id in the panel. */
  targetOrgId: string;
  startedAt?: string;
  /** The org a clone reads from; the target for the other ways. */
  sourceOrgId?: string;
  /** Which way wrote the run, when not the generator. */
  origin?: 'csv' | 'clone';
  /** The pipeline whose Seed step runs the seed, by its name: absent for a run of the page. */
  pipeline?: { name: string };
  /**
   * The target's own Organization id, for a run of the command line, whose
   * `targetOrgId` is an alias: its removal is refused from any other org,
   * whatever org the alias names by then.
   */
  targetOrganizationId?: string;
}

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

/** Records, as one Seed run of the panel writes, what it creates: see the module's comment. */
export interface SeedRunRecorder {
  /** The id the run's creations are kept under: its result's `operationId`. */
  readonly runId: string;
  /**
   * The records of an object an insert of the run has just created: written
   * at once, dated now. Never throws: a write that fails is said by
   * {@link SeedRunRecorder.end}.
   */
  note(objectApiName: ApiName, ids: readonly string[]): void;
  /**
   * A call of `rows` rows of an object is about to go — a REST call, a Bulk
   * API job — and, once the org has opened the job, its id (`call.job`):
   * written at once, so a run cut short while the call is under way names it
   * (`SyncRunKept.inFlight`), and a job that ran on is read back by its id.
   */
  sending(objectApiName: ApiName, rows: number, call?: SendingCall): void;
  /**
   * The call {@link sending} announced answered: what it created, none
   * included, written at once.
   */
  answered(objectApiName: ApiName, ids: readonly string[]): void;
  /**
   * The run wrote again to records it created — a clone's second pass, which
   * fills the lookups they went in without: dated now, so a removal reads the
   * dates the pass left on them as the run's doing and not as changes since.
   * An id the run did not create is not one of them.
   */
  wroteAgain(objectApiName: ApiName, ids: readonly string[]): void;
  /**
   * The run ended as its result says: an id the result holds that no insert
   * noted is kept too, then how it ended. A run that created nothing leaves
   * no file. Then the runs past the most kept go, the oldest removed with
   * nothing left first.
   *
   * @throws When what the run created could not all be written: its removal
   *   would leave the rest in the org.
   */
  end(
    run: Pick<SeedRunEnded, 'finishedAt' | 'status' | 'cancelled' | 'objectResults'>,
  ): Promise<void>;
}

/**
 * The store over Node's file system, under the extension's storage directory.
 *
 * @param onDropped - Told of a run the files' hard bound dropped though its
 *   records are still in its org (`SyncRunCreationsDeps.onDropped`).
 */
export function nodeSeedRunCreations(
  storagePath: string,
  onDropped?: (run: SyncRunKept) => void,
): SeedRunCreations {
  return new SeedRunCreations(nodeSyncRunCreations(storagePath, SEED_RUNS_DIR, onDropped));
}

/** The Seed runs of the panel and what their removals did: see the module's comment. */
export class SeedRunCreations implements SyncRemovalStateStore {
  /**
   * @param runs - Where the runs' files are kept: a Sync run's store, under
   *   {@link SEED_RUNS_DIR}.
   * @param max - Runs removed with nothing left kept at most: {@link SEED_RUNS_KEPT}
   *   unless a test sets another.
   */
  constructor(
    private readonly runs: SyncRunCreations,
    private readonly max: number = SEED_RUNS_KEPT,
  ) {}

  /**
   * The recorder of one run, told of it as it begins: its file is begun with
   * the first ids noted.
   */
  recorder(start: SeedRunStart): SeedRunRecorder {
    const recorder = this.runs.recorder({
      runId: start.runId,
      configId: SEED_CONFIGURATION,
      configName: SEED_CONFIGURATION,
      sourceOrgId: start.sourceOrgId ?? start.targetOrgId,
      targetOrgId: start.targetOrgId,
      ...(start.startedAt !== undefined ? { startedAt: start.startedAt } : {}),
      ...(start.origin !== undefined ? { origin: start.origin } : {}),
      ...(start.pipeline !== undefined
        ? { pipeline: { name: start.pipeline.name.slice(0, PIPELINE_NAME_KEPT) } }
        : {}),
      ...(start.targetOrganizationId !== undefined
        ? { targetOrganizationId: start.targetOrganizationId }
        : {}),
    });
    /** The ids noted so far, by their first fifteen characters, as the file reads them back. */
    const noted = new Set<string>();
    /** Of `ids`, those not noted yet, noted now. */
    const fresh = (ids: readonly string[]): string[] => {
      const unseen = ids.filter((id) => !noted.has(id.slice(0, 15)));
      for (const id of unseen) noted.add(id.slice(0, 15));
      return unseen;
    };
    /** `ids` written down in lines of at most what a line holds, each by `write`. */
    const inLines = (ids: readonly string[], write: (line: string[]) => void): void => {
      for (let from = 0; from < ids.length; from += IDS_PER_LINE) {
        write(ids.slice(from, from + IDS_PER_LINE));
      }
    };
    const note = (objectApiName: ApiName, ids: readonly string[], at?: string): void =>
      inLines(fresh(ids), (line) => recorder.note(objectApiName, line, at));
    /** The Bulk API job of each object's call under way, until the call answers. */
    const unanswered = new Map<string, string>();
    return {
      runId: start.runId,
      note: (objectApiName, ids) => note(objectApiName, ids),
      sending: (objectApiName, rows, call) => {
        if (call?.job !== undefined) unanswered.set(objectApiName, call.job);
        else unanswered.delete(objectApiName);
        recorder.sending?.(objectApiName, rows, call);
      },
      answered: (objectApiName, ids) => {
        unanswered.delete(objectApiName);
        const created = fresh(ids);
        // A line however few it created: the call is answered once one follows it.
        recorder.answered?.(objectApiName, created.slice(0, IDS_PER_LINE));
        inLines(created.slice(IDS_PER_LINE), (line) => recorder.note(objectApiName, line));
      },
      wroteAgain: (objectApiName, ids) =>
        inLines(
          ids.filter((id) => noted.has(id.slice(0, 15))),
          (line) => recorder.note(objectApiName, line),
        ),
      end: async (run) => {
        // Dated when the run ended, as its result says: what a removal reads
        // the org's dates against, a record modified after it being changed since.
        const endedAt = run.finishedAt ?? new Date().toISOString();
        for (const { objectApiName, createdIds } of run.objectResults) {
          note(objectApiName, createdIds, endedAt);
        }
        if (noted.size === 0 && unanswered.size === 0) {
          // Its calls were kept as they went, and it created nothing: no file.
          // A job the org opened that never answered stays: it ran on, and
          // its records are read back from it.
          await recorder.flush();
          await this.runs.forget(start.runId);
          return;
        }
        await recorder.end({
          status: run.status,
          ...(run.cancelled ? { cancelled: true } : {}),
          at: endedAt,
        });
        const failure = await recorder.flush();
        if (failure !== undefined) throw new Error(failure);
        await this.keepTheLatest();
      },
    };
  }

  /**
   * Keep what a run created, once it has ended: a run that created nothing is
   * not kept. Then the runs past the most kept go, the oldest removed with
   * nothing left first.
   *
   * @throws When what the run created could not all be written: its removal
   *   would leave the rest in the org.
   */
  record(run: SeedRunEnded): Promise<void> {
    const startedAt = run.startedAt ?? run.finishedAt;
    return this.recorder({
      runId: run.runId,
      targetOrgId: run.targetOrgId,
      ...(startedAt !== undefined ? { startedAt } : {}),
    }).end(run);
  }

  /**
   * Drop the runs removed with nothing left past the most kept, the oldest
   * first. A run whose records are still in its org is never dropped here:
   * only the hard bound on bytes of the store drops one, and says so.
   */
  private async keepTheLatest(): Promise<void> {
    const removed = (await this.runs.list()).filter(settled);
    let over = removed.length - this.max;
    for (const run of [...removed].reverse()) {
      if (over <= 0) return;
      await this.runs.forget(run.runId);
      over--;
    }
  }

  /** The file a run's lines go to, once it writes one: what the command line names. */
  pathOf(runId: string): string {
    return this.runs.pathOf(runId);
  }

  /** What a run kept, with what its removals did; undefined when nothing of it is kept. */
  get(runId: string): Promise<SyncRunKept | undefined> {
    return this.runs.get(runId);
  }

  /** Every run kept, newest first. */
  list(): Promise<SyncRunKept[]> {
    return this.runs.list();
  }

  /**
   * Answer a Bulk API job of a run that no line answers with what it created,
   * read back from the org since: see `SyncRunCreations.answerInFlight`.
   */
  answerInFlight(
    runId: string,
    objectApiName: string,
    ids: readonly string[],
    at: string,
    job?: string,
  ): Promise<boolean> {
    return this.runs.answerInFlight(runId, objectApiName, ids, at, job);
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
