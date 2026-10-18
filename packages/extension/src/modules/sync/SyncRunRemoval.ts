/**
 * Taking back what a Sync run created: the records it inserted, or upserted
 * where the target held none, and the files it created — as the run kept
 * them (`SyncRunCreations`), never what a request names.
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

import type { ForgeUndoObjectResult, SyncRemovalResult } from '@sandforge/shared';
import { removeRunRecords, type RemovalOrg } from '../forge/ForgeRunRemoval.js';
import { removalMark, removalStatus } from '../forge/removalOutcome.js';
import type { SyncCopiedFile } from './SyncFiles.js';
import type { SyncLinkForgetter } from './SyncIdMap.js';
import {
  SYNC_FILE_OBJECTS,
  syncRemovalPlan,
  type SyncRunKept,
  type SyncRunRemovalState,
} from './SyncRunCreations.js';

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
   * A Seed run's removal offers it.
   */
  sweep?: () => Promise<boolean>;
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
  const outcome = await removeRunRecords(input.org, plan, {
    ...runTimes(run),
    ...(run.removal?.removalStamps ? { removalStamps: run.removal.removalStamps } : {}),
    ...(run.removal?.removalSpans ? { removalSpans: run.removal.removalSpans } : {}),
    includeChanged,
    ...(input.sweep ? { sweep: input.sweep } : {}),
    signal: input.signal,
    onProgress: input.onProgress,
  });
  const finishedAt = new Date().toISOString();
  const leftBy = run.removal?.undo?.removedAt;
  const notes: string[] = [];
  let result: SyncRemovalResult = {
    runId: run.runId,
    status: removalStatus(outcome.objects, outcome.cancelled),
    includeChanged,
    objects: outcome.objects,
    finishedAt,
    ...(leftBy ? { leftBy } : {}),
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
  if (mark || stamped || outcome.span || left) {
    try {
      await input.store.updateRemoval(run.runId, (state) => ({
        ...state,
        ...(mark ? { undo: mark } : {}),
        ...(stamped ? { removalStamps: { ...state.removalStamps, ...outcome.stamps } } : {}),
        ...(outcome.span ? { removalSpans: [...(state.removalSpans ?? []), outcome.span] } : {}),
        ...(left ? { removalLeft: left } : {}),
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
  return { result, planned, notes, ...(linksForgotten ? { linksForgotten } : {}) };
}
