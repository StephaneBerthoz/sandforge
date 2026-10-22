/**
 * Taking back what a Sync run created: the records it inserted, or upserted
 * where the target held none, and the files it created — as the run kept
 * them (`SyncRunCreations`), never what a request names. And giving back what
 * it wrote over: the records an update, or an upsert that matched, wrote,
 * given the values they held before the run (`SyncRunRestore`), before
 * anything is deleted.
 *
 * The removal is Forge's (`removeRunRecords`), which a Frozen load's removal
 * runs too: every object read before anything is deleted, a record changed
 * since the run kept unless the user includes it, one that records staying in
 * the org depend on kept, children before their parents, and what the org
 * refuses counted with its reasons. A file the run created goes before the
 * record it hangs on: deleted after it, it would stay in the org, its owner's.
 *
 * What the removal took is then dropped from the configuration that ran: the
 * copies of files it deleted leave the record of copied files, and the
 * objects whose copies went are read whole by the next run, since a delta
 * read from their watermark would take the copies for still there; and the
 * records it took leave the configuration's pairs (`SyncIdMap`), which a
 * later run points its lookups by.
 */

import type {
  ForgeUndoObjectResult,
  ForgeUndoStatus,
  SyncRemovalResult,
  SyncRestoreObjectResult,
} from '@sandforge/shared';
import { removeRunRecords, type RemovalOrg } from '../forge/ForgeRunRemoval.js';
import { removalMark, removalStatus } from '../forge/removalOutcome.js';
import type { SyncCopiedFile } from './SyncFiles.js';
import type { SyncLinkForgetter } from './SyncIdMap.js';
import {
  SYNC_FILE_OBJECTS,
  syncRemovalPlan,
  syncRestorePlan,
  type SyncRunKept,
  type SyncRunRemovalState,
} from './SyncRunCreations.js';
import { restoreOverwrites, type BackupReader, type SyncRestoreOutcome } from './SyncRunRestore.js';

/** Where what the removals of a run did is kept: see `SyncRunCreations.updateRemoval`. */
export interface SyncRemovalStateStore {
  updateRemoval(
    runId: string,
    change: (state: SyncRunRemovalState) => SyncRunRemovalState,
  ): Promise<void>;
}

/**
 * The configuration that ran, as a removal of its run leaves it: see
 * `SyncConfigStore.forgetFiles` and `SyncConfigStore.markRemoved`.
 */
export interface SyncRemovalConfigs {
  /** Whether a configuration is still saved under that id. */
  isSaved(configId: string): boolean;
  forgetFiles(
    configId: string,
    orgs: { sourceOrgId: string; targetOrgId: string },
    targetIds: readonly string[],
  ): SyncCopiedFile[];
  markRemoved(
    configId: string,
    orgs: { sourceOrgId: string; targetOrgId: string },
    objects: readonly string[],
    at: string,
  ): string[];
}

/** What a removal of a run's creations is given. */
export interface SyncRunRemovalInput {
  /** The run, as it kept what it created. */
  run: SyncRunKept;
  /** The org it wrote to. */
  org: RemovalOrg;
  /** Remove the records changed since the run too, and what was added to them since. */
  includeChanged: boolean;
  /** Where what the removals of the run did is kept. */
  store: SyncRemovalStateStore;
  /** The configuration that ran; absent from the command line, which saves none. */
  configs?: SyncRemovalConfigs;
  /**
   * Which record of the target each source record the configuration's runs
   * wrote became (`SyncIdMap`): what the removal deleted leaves it, so no
   * later run points a lookup at a copy that is gone.
   */
  links?: SyncLinkForgetter;
  /**
   * The sweep of what the target's automation created during the run, made
   * once the removal has read the run's records and before its first delete
   * (`RunRemovalOptions.sweep`); it resolves to whether it deleted anything.
   * A Seed run's removal offers it, and a Sync run's.
   */
  sweep?: () => Promise<boolean>;
  /**
   * The DataOps backup store the run kept the values it wrote over in, by
   * the backup its file names: what the removal gives back reads it. Absent,
   * nothing is given back, and the records stay offered.
   */
  backups?: BackupReader;
  /** Stops the removal before its next call to the org. */
  signal?: AbortSignal;
  /** Told how many of the run's creations are settled, after each step. */
  onProgress?: (settled: number, total: number, objectApiName: string) => void;
}

/** What a removal of a run's creations did, and what the follow-ups it made noted. */
export interface SyncRunRemovalOutcome {
  result: SyncRemovalResult;
  /** How many records and files it set out to take. */
  planned: number;
  /** How many records it set out to give their values back. */
  plannedBack: number;
  /** Why a follow-up could not be made, when one could not: said, never thrown. */
  notes: string[];
  /** How many of the configuration's pairs it forgot, the records it took. */
  linksForgotten?: number;
}

/**
 * When the run wrote, by this machine's clock, as its removal reads the org's
 * dates against them: from its start to its last write — or its end, for a run
 * kept before its writes were dated.
 */
function runTimes(run: SyncRunKept): { runRecordedAt?: Date; runDurationMs?: number } {
  const started = Date.parse(run.startedAt);
  const last = Date.parse(run.lastWrittenAt ?? run.end?.at ?? '');
  if (!Number.isFinite(last)) return {};
  return {
    runRecordedAt: new Date(last),
    ...(Number.isFinite(started) ? { runDurationMs: Math.max(0, last - started) } : {}),
  };
}

/** The objects whose records or files the removal took, deleted or found gone. */
function objectsTaken(objects: readonly ForgeUndoObjectResult[]): string[] {
  return objects.filter((o) => o.deleted + o.alreadyGone > 0).map((o) => o.objectApiName);
}

/**
 * Remove from its target what a run created, as the run kept it, and keep
 * what the removal did for the next one: see the module's comment.
 *
 * @returns Nothing is thrown for a follow-up that fails; a call to the org
 *   that fails outright is thrown, as Forge's removal throws it.
 */
export async function removeSyncRun(input: SyncRunRemovalInput): Promise<SyncRunRemovalOutcome> {
  const { run, includeChanged } = input;
  const plan = syncRemovalPlan(run);
  const planned = plan.reduce((sum, object) => sum + object.ids.length, 0);
  const back = syncRestorePlan(run);
  const plannedBack = back.reduce((sum, object) => sum + object.ids.length, 0);
  const notes: string[] = [];
  const backups = input.backups;
  if (back.length > 0 && !backups) {
    notes.push(
      `The values from before the run of ${plannedBack} record(s) it wrote over could not be ` +
        'read here: they were not put back, and the next removal offers them again.',
    );
  }
  // What the run wrote over gets its values back once the removal has read
  // what changed since the run among the records it created, and before the
  // sweep and the first delete: a record put back first no longer names a
  // record the run created, which would stay in the org depending on it,
  // and a roll-up a delete recalculates would date it as changed since.
  let restored: SyncRestoreOutcome | undefined;
  const sweep = input.sweep;
  const beforeDeletes =
    (back.length > 0 && backups) || sweep
      ? async (): Promise<boolean> => {
          if (back.length > 0 && backups) {
            restored = await restoreOverwrites({
              org: input.org,
              plan: back,
              backups,
              ...(writtenUntil(run) !== undefined ? { lastWriteAt: writtenUntil(run) } : {}),
              includeChanged,
              ...(input.signal ? { signal: input.signal } : {}),
            });
          }
          if (restored?.cancelled || input.signal?.aborted) return restored?.wrote ?? false;
          const swept = sweep ? await sweep() : false;
          return (restored?.wrote ?? false) || swept;
        }
      : undefined;
  const outcome = await removeRunRecords(input.org, plan, {
    ...runTimes(run),
    ...(run.removal?.removalStamps ? { removalStamps: run.removal.removalStamps } : {}),
    ...(run.removal?.removalSpans ? { removalSpans: run.removal.removalSpans } : {}),
    includeChanged,
    ...(beforeDeletes ? { sweep: beforeDeletes } : {}),
    signal: input.signal,
    onProgress: input.onProgress,
  });
  const finishedAt = new Date().toISOString();
  const leftBy = run.removal?.undo?.removedAt;
  let result: SyncRemovalResult = {
    runId: run.runId,
    status: withRestore(
      removalStatus(outcome.objects, outcome.cancelled),
      outcome.objects,
      restored,
    ),
    includeChanged,
    objects: outcome.objects,
    finishedAt,
    ...(leftBy ? { leftBy } : {}),
    ...(restored && restored.objects.length > 0 ? { restored: restored.objects } : {}),
  };

  // Kept whatever the removal ended on, cancelled included: the run's
  // creations it did not take, which the next removal sets out to take, with
  // what it wrote to them and when it ran, which the next one reads as its
  // doing, not as changes since the run.
  const mark = removalMark(result, planned, run.removal?.undo);
  const gone = new Set(outcome.gone);
  const left =
    gone.size > 0 ? plan.flatMap(({ ids }) => ids.filter((id) => !gone.has(id))) : undefined;
  const stamped = Object.keys(outcome.stamps).length > 0;
  // What it gave back is no longer offered, and when it last gave some back.
  const gaveBack = restored?.objects.some((object) => object.restored > 0) === true;
  if (mark || stamped || outcome.span || left || restored) {
    try {
      await input.store.updateRemoval(run.runId, (state) => ({
        ...state,
        ...(mark ? { undo: mark } : {}),
        ...(stamped ? { removalStamps: { ...state.removalStamps, ...outcome.stamps } } : {}),
        ...(outcome.span ? { removalSpans: [...(state.removalSpans ?? []), outcome.span] } : {}),
        ...(left ? { removalLeft: left } : {}),
        ...(restored ? { restoreLeft: restored.left } : {}),
        ...(gaveBack ? { restoredAt: finishedAt } : {}),
      }));
    } catch (err: unknown) {
      notes.push(
        `What this removal did could not be kept (${err instanceof Error ? err.message : String(err)}): ` +
          'the next removal of the run may set out to take records already gone.',
      );
    }
  }

  // The configuration forgets what is gone: the copies of files deleted, and
  // the watermarks of the objects whose copies went.
  const configs = input.configs;
  if (configs && gone.size > 0 && configs.isSaved(run.configId)) {
    const orgs = { sourceOrgId: run.sourceOrgId, targetOrgId: run.targetOrgId };
    try {
      const filesGone = plan
        .filter((object) => SYNC_FILE_OBJECTS.includes(object.objectApiName))
        .flatMap(({ ids }) => ids.filter((id) => gone.has(id)));
      const forgotten = configs.forgetFiles(run.configId, orgs, filesGone);
      const records = objectsTaken(outcome.objects).filter(
        (name) => !SYNC_FILE_OBJECTS.includes(name),
      );
      const readWhole = configs.markRemoved(
        run.configId,
        orgs,
        [...new Set([...records, ...forgotten.map((entry) => entry.objectApiName)])],
        finishedAt,
      );
      result = {
        ...result,
        ...(readWhole.length > 0 ? { readWhole } : {}),
        ...(forgotten.length > 0 ? { filesForgotten: forgotten.length } : {}),
      };
    } catch (err: unknown) {
      notes.push(
        `The configuration could not be told what this removal took ` +
          `(${err instanceof Error ? err.message : String(err)}): run it full next time.`,
      );
    }
  }

  // Nor does a later run point a lookup at a record the removal took: its
  // pair leaves the configuration's, whether the removal deleted it or found
  // it gone.
  let linksForgotten: number | undefined;
  if (input.links && gone.size > 0) {
    try {
      linksForgotten = await input.links.forget(
        run.configId,
        { sourceOrgId: run.sourceOrgId, targetOrgId: run.targetOrgId },
        [...gone],
      );
    } catch (err: unknown) {
      notes.push(
        `Which records of the target this removal took could not be forgotten ` +
          `(${err instanceof Error ? err.message : String(err)}): a later run of the ` +
          'configuration may point a lookup at one of them.',
      );
    }
  }
  return { result, planned, plannedBack, notes, ...(linksForgotten ? { linksForgotten } : {}) };
}

/**
 * When the run last wrote, by this machine's clock: its last write of any
 * kind, or, for a run kept before its writes were all dated, its last
 * creation or its end. A record it wrote over modified later was changed since.
 */
function writtenUntil(run: SyncRunKept): string | undefined {
  return run.lastWriteAt ?? run.lastWrittenAt ?? run.end?.at;
}

/** Records a restore left holding the run's values: changed since, refused, no longer kept, not reached. */
function leftOver(object: SyncRestoreObjectResult): number {
  return object.keptChanged + object.refused + object.notKept + (object.notReached ?? 0);
}

/**
 * How a removal ended once what it gave back is counted with what it
 * deleted: a success only when it left nothing holding the run's values
 * either; partial when it deleted or gave back something, and left the rest.
 */
function withRestore(
  status: ForgeUndoStatus,
  deleted: readonly ForgeUndoObjectResult[],
  restored: SyncRestoreOutcome | undefined,
): ForgeUndoStatus {
  if (!restored || status === 'cancelled') return status;
  if (restored.cancelled) return 'cancelled';
  const backLeft = restored.objects.some((object) => leftOver(object) > 0);
  if (status === 'success' && !backLeft) return 'success';
  const did =
    deleted.some((object) => object.deleted > 0) ||
    restored.objects.some((object) => object.restored > 0);
  return did ? 'partial' : 'failure';
}
