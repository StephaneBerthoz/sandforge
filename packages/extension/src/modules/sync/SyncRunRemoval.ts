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
import {
  CLOCK_LEEWAY_MS,
  removeRunRecords,
  type RemovalOrg,
  type RunRemovalOptions,
  type RunRemovalOutcome,
} from '../forge/ForgeRunRemoval.js';
import { removalMark, removalStatus } from '../forge/removalOutcome.js';
import type { SyncCopiedFile } from './SyncFiles.js';
import type { SyncLinkForgetter } from './SyncIdMap.js';
import {
  SYNC_FILE_OBJECTS,
  syncRemovalPlan,
  syncRestorePlan,
  syncUndeletePlan,
  type SyncRunKept,
  type SyncRunRemovalState,
} from './SyncRunCreations.js';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { idLists } from '../dataops/RecordRemoval.js';
import {
  orgAheadOf,
  restoreOverwrites,
  runEndOnOrgClock,
  stampsWritten,
  writerOnce,
  type BackupReader,
  type SyncRestoreOutcome,
} from './SyncRunRestore.js';
import {
  undeleteLeftOver,
  undeleteRunDeletions,
  type SyncUndeleteOutcome,
  type UndeleteCall,
} from './SyncRunUndelete.js';

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
  /**
   * Take every record and file the run created, not what its removals left
   * (`syncRemovalPlan`): an undo of a checkpoint's rewind brought back what a
   * removal had found gone. Each is read before it is deleted, as ever; the
   * undo dated them anew, so they read as changed since the run unless
   * `includeChanged`.
   */
  again?: boolean;
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
  /**
   * The runs of the same target that started before this one and are not
   * settled. A record this removal gives back its values from before, that
   * one of them created or wrote over too, holds that run's values again, and
   * the date the org gives it is stamped on that run
   * (`SyncRunRemovalState.removalStamps`): its own removal then reads it as
   * no change since it. Two runs of a saved upsert configuration wrote the
   * same records; removed newest first, the older one's removal kept every
   * one of them as changed since the run, and its copies with them.
   */
  earlierRuns?: readonly SyncRunKept[];
  /**
   * Takes records out of the target's recycle bin by their ids
   * (`conn.soap.undelete`): what the run deleted as the source had deleted
   * them is brought back with it (`SyncRunUndelete`). Absent, nothing is
   * brought back, and the records stay offered.
   */
  undelete?: UndeleteCall;
  /** Stops the removal before its next call to the org. */
  signal?: AbortSignal;
  /** Told how many of the run's creations are settled, after each step. */
  onProgress?: (settled: number, total: number, objectApiName: string) => void;
  /**
   * Asked before the first write when the user may not delete the records of
   * some objects of the run: see `RunRemovalOptions.onUndeletable`.
   */
  onUndeletable?: RunRemovalOptions['onUndeletable'];
}

/** What a removal of a run's creations did, and what the follow-ups it made noted. */
export interface SyncRunRemovalOutcome {
  result: SyncRemovalResult;
  /** How many records and files it set out to take. */
  planned: number;
  /** How many records it set out to give their values back. */
  plannedBack: number;
  /** How many records the run deleted it set out to bring back from the recycle bin. */
  plannedUndelete: number;
  /** Why a follow-up could not be made, when one could not: said, never thrown. */
  notes: string[];
  /** How many of the configuration's pairs it forgot, the records it took. */
  linksForgotten?: number;
  /** The earlier runs it stamped records of, and how many each. Absent when none. */
  earlierStamped?: Array<{ runId: string; records: number }>;
  /**
   * Set when it stopped before its first write, asked about objects whose
   * records the user may not delete (`onUndeletable`): nothing was removed.
   */
  stoppedForUndeletable?: true;
}

/**
 * Of the records a removal gives back their values, by their first fifteen
 * characters, those the org dates modified no later than the run's end on
 * its clock, or than what an earlier removal left on them: unchanged since
 * the run. A read that fails leaves its records out, taken for changed.
 */
async function unchangedSinceTheRun(
  org: Pick<RemovalOrg, 'query'>,
  back: ReadonlyArray<{ objectApiName: string; ids: readonly string[] }>,
  runEnd: number,
  stampsBefore: Readonly<Record<string, string>>,
): Promise<Set<string>> {
  const stamped = new Map(
    Object.entries(stampsBefore).map(([id, at]) => [id.slice(0, 15), Date.parse(at)]),
  );
  const unchanged = new Set<string>();
  for (const { objectApiName, ids } of back) {
    const object = assertSoqlIdentifier(objectApiName);
    for (const list of idLists(ids)) {
      let rows: Array<Record<string, unknown>>;
      try {
        rows = (await org.query(`SELECT Id, LastModifiedDate FROM ${object} WHERE Id IN (${list})`))
          .records as Array<Record<string, unknown>>;
      } catch {
        continue;
      }
      for (const row of rows) {
        if (typeof row.Id !== 'string') continue;
        const key = row.Id.slice(0, 15);
        const modified = Date.parse(String(row.LastModifiedDate ?? ''));
        if (modified <= runEnd || modified <= (stamped.get(key) ?? Number.NaN)) unchanged.add(key);
      }
    }
  }
  return unchanged;
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
  const again = input.again === true;
  const plan = syncRemovalPlan(run, again);
  const planned = plan.reduce((sum, object) => sum + object.ids.length, 0);
  const back = syncRestorePlan(run);
  const plannedBack = back.reduce((sum, object) => sum + object.ids.length, 0);
  const bringBack = syncUndeletePlan(run);
  const plannedUndelete = bringBack.reduce((sum, object) => sum + object.ids.length, 0);
  const notes: string[] = [];
  const backups = input.backups;
  const undelete = input.undelete;
  if (bringBack.length > 0 && !undelete) {
    notes.push(
      `The ${plannedUndelete} record(s) the run deleted could not be brought back from the ` +
        'recycle bin here: the next removal offers them again.',
    );
  }
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
  let undeleted: SyncUndeleteOutcome | undefined;
  /**
   * What the removal's undeletes dated anew of the records it gives back, by
   * id: its own writes, which neither this give-back nor the next removal
   * reads as a change since the run.
   */
  const restamped: Record<string, string> = {};
  // The records the earlier runs of the target still name, each run's by
  // their first fifteen characters.
  const earlier = (input.earlierRuns ?? []).map((other) => ({
    runId: other.runId,
    keys: new Set(
      [...syncRemovalPlan(other), ...syncRestorePlan(other)].flatMap(({ ids }) =>
        ids.map((id) => id.slice(0, 15)),
      ),
    ),
  }));
  const namedEarlier = (id: string): boolean =>
    earlier.some(({ keys }) => keys.has(id.slice(0, 15)));
  const sweep = input.sweep;
  const beforeDeletes =
    (back.length > 0 && backups) || (bringBack.length > 0 && undelete) || sweep
      ? async (): Promise<boolean> => {
          // What it deleted first: a record it wrote over may name one of them.
          if (bringBack.length > 0 && undelete) {
            // An undelete puts back the lookups the run's delete cleared, and
            // the org dates the records holding them anew, as the removal's
            // user: a record the run wrote over, whose lookup at one it
            // deleted is on a field the run does not compare, then read as
            // changed since the run, and kept. Read before the first
            // undelete, what had not changed since is the undeletes' doing.
            const unchanged =
              back.length > 0 && backups
                ? await unchangedSinceTheRun(
                    input.org,
                    back,
                    await runEndOnOrgClock(input.org, writtenUntil(run)),
                    run.removal?.removalStamps ?? {},
                  )
                : undefined;
            const undeletesFrom = unchanged
              ? Date.now() + (await orgAheadOf(input.org)) - CLOCK_LEEWAY_MS
              : 0;
            undeleted = await undeleteRunDeletions({
              org: input.org,
              plan: bringBack,
              undelete,
              ...(earlier.length > 0 ? { stampsFor: namedEarlier } : {}),
              ...(input.signal ? { signal: input.signal } : {}),
            });
            if (unchanged && undeleted.wrote) {
              const writerOf = writerOnce(input.org);
              for (const { objectApiName, ids } of back) {
                const still = ids.filter((id) => unchanged.has(id.slice(0, 15)));
                Object.assign(
                  restamped,
                  await stampsWritten(input.org, objectApiName, still, undeletesFrom, writerOf),
                );
              }
            }
            if (undeleted.cancelled || input.signal?.aborted) return undeleted.wrote;
          }
          if (back.length > 0 && backups) {
            const stamps = { ...run.removal?.removalStamps, ...restamped };
            restored = await restoreOverwrites({
              org: input.org,
              plan: back,
              backups,
              ...(writtenUntil(run) !== undefined ? { lastWriteAt: writtenUntil(run) } : {}),
              includeChanged,
              ...(Object.keys(stamps).length > 0 ? { stamps } : {}),
              ...(run.unkept ? { unkept: run.unkept } : {}),
              ...(earlier.length > 0 ? { stampsFor: namedEarlier } : {}),
              ...(input.signal ? { signal: input.signal } : {}),
            });
          }
          const wroteBefore = (undeleted?.wrote ?? false) || (restored?.wrote ?? false);
          if (restored?.cancelled || input.signal?.aborted) return wroteBefore;
          const swept = sweep ? await sweep() : false;
          return wroteBefore || swept;
        }
      : undefined;
  const outcome = await removeRunRecords(input.org, plan, {
    ...runTimes(run),
    ...(run.removal?.removalStamps ? { removalStamps: run.removal.removalStamps } : {}),
    ...(run.removal?.removalSpans ? { removalSpans: run.removal.removalSpans } : {}),
    includeChanged,
    ...(beforeDeletes ? { sweep: beforeDeletes } : {}),
    ...(input.onUndeletable ? { onUndeletable: input.onUndeletable } : {}),
    signal: input.signal,
    onProgress: input.onProgress,
  });
  const finishedAt = new Date().toISOString();
  // Stopped before its first write, as the user answered: nothing to keep.
  if (outcome.stoppedForUndeletable) {
    return {
      result: { runId: run.runId, status: 'cancelled', includeChanged, objects: [], finishedAt },
      planned,
      plannedBack,
      plannedUndelete,
      notes: [],
      stoppedForUndeletable: true,
    };
  }
  // One taking every record again picks up after no removal: it read them all.
  const leftBy = again ? undefined : run.removal?.undo?.removedAt;
  let result: SyncRemovalResult = {
    runId: run.runId,
    status: withUndelete(
      withRestore(removalStatus(outcome.objects, outcome.cancelled), outcome.objects, restored),
      outcome.objects,
      restored,
      undeleted,
    ),
    includeChanged,
    objects: outcome.objects,
    finishedAt,
    ...(leftBy ? { leftBy } : {}),
    ...(restored && restored.objects.length > 0 ? { restored: restored.objects } : {}),
    ...(undeleted && undeleted.objects.length > 0 ? { undeleted: undeleted.objects } : {}),
  };

  // Kept whatever the removal ended on, cancelled included: the run's
  // creations it did not take, which the next removal sets out to take, with
  // what it wrote to them and when it ran, which the next one reads as its
  // doing, not as changes since the run.
  const mark = removalMark(result, planned, run.removal?.undo, again);
  const gone = new Set(outcome.gone);
  // Taking every record again, what it left is what is left, though it took
  // none: what an earlier removal left no longer says it.
  const left =
    gone.size > 0 || (again && mark)
      ? plan.flatMap(({ ids }) => ids.filter((id) => !gone.has(id)))
      : undefined;
  // What its undeletes dated anew of the records it gives back is its own
  // doing, as what it wrote is: kept with the stamps of its writes.
  const ownStamps = { ...restamped, ...outcome.stamps };
  const stamped = Object.keys(ownStamps).length > 0;
  // What it gave back is no longer offered, and when it last gave some back.
  const gaveBack =
    restored?.objects.some((object) => object.restored + (object.restoredWithout ?? 0) > 0) ===
    true;
  // What it went through of what the run deleted is no longer offered,
  // brought back or gone for good, once it was not stopped part way.
  const wentThrough = undeleted !== undefined && !undeleted.cancelled;
  if (mark || stamped || outcome.span || left || restored || undeleted) {
    try {
      await input.store.updateRemoval(run.runId, (state) => ({
        ...state,
        ...(mark ? { undo: mark } : {}),
        ...(stamped ? { removalStamps: { ...state.removalStamps, ...ownStamps } } : {}),
        ...(outcome.span ? { removalSpans: [...(state.removalSpans ?? []), outcome.span] } : {}),
        ...(left ? { removalLeft: left } : {}),
        ...(restored ? { restoreLeft: restored.left } : {}),
        ...(gaveBack ? { restoredAt: finishedAt } : {}),
        ...(undeleted ? { undeleteLeft: undeleted.left } : {}),
        ...(wentThrough ? { undeletedAt: finishedAt } : {}),
      }));
    } catch (err: unknown) {
      notes.push(
        `What this removal did could not be kept (${err instanceof Error ? err.message : String(err)}): ` +
          'the next removal of the run may set out to take records already gone.',
      );
    }
  }

  // What it gave back of the records an earlier run names is that run's
  // again: stamped on it, whatever this removal ended on, with when this
  // removal ran and as whom. What the target made of its writes meanwhile —
  // the feed items field tracking posts under each record it gave back — is
  // then a removal's doing for that run too, and holds none of its records:
  // on a Developer Edition, two runs taken back newest first left the older
  // run's copy in the org, held by the feed items the newer run's removal
  // had made it post.
  //
  // But for a record someone else changed between that run and this one:
  // this removal gave it back that change, which the earlier run's removal
  // would otherwise read as no change since it, and write over. Told apart
  // by when the org dated it modified before this run first wrote it, and
  // by whom (`SyncRunKept.heldBefore`): a colleague's edit between two runs
  // of one configuration was stamped as the later run's, and lost.
  const changedBetween =
    Object.keys(restored?.stamps ?? {}).length > 0
      ? await changedBetweenRuns(input.org, run, input.earlierRuns ?? [])
      : new Map<string, Set<string>>();
  const earlierStamped: Array<{ runId: string; records: number }> = [];
  for (const { runId, keys } of earlier) {
    const between = changedBetween.get(runId);
    const picked = Object.fromEntries(
      Object.entries({ ...undeleted?.stamps, ...restored?.stamps }).filter(
        ([id]) => keys.has(id.slice(0, 15)) && !between?.has(id.slice(0, 15)),
      ),
    );
    const records = Object.keys(picked).length;
    if (records === 0) continue;
    try {
      await input.store.updateRemoval(runId, (state) => ({
        ...state,
        removalStamps: { ...state.removalStamps, ...picked },
        ...(outcome.span ? { removalSpans: [...(state.removalSpans ?? []), outcome.span] } : {}),
      }));
      earlierStamped.push({ runId, records });
    } catch (err: unknown) {
      notes.push(
        `What this removal gave back of ${records} record(s) the run ${runId} wrote too could ` +
          `not be kept on it (${err instanceof Error ? err.message : String(err)}): its removal ` +
          'reads them as changed since it.',
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
  return {
    result,
    planned,
    plannedBack,
    plannedUndelete,
    notes,
    ...(linksForgotten ? { linksForgotten } : {}),
    ...(earlierStamped.length > 0 ? { earlierStamped } : {}),
  };
}

/**
 * What a removal of a run's creations would do, read as {@link removeSyncRun}
 * reads the run before its first write — the run's span, what its earlier
 * removals stamped and when they ran — and nothing written, to the org or to
 * where what the run's removals did is kept (`RunRemovalOptions.previewOnly`).
 * What it would give back of the records the run wrote over, and bring back
 * of those it deleted, is not read: a Seed run, the one previewed so far,
 * only creates.
 *
 * @returns The removal's outcome, its `preview` set unless it was stopped,
 *   and how many records it sets out to take.
 */
export async function previewSyncRun(
  input: Pick<SyncRunRemovalInput, 'run' | 'org' | 'includeChanged' | 'signal'>,
): Promise<{ outcome: RunRemovalOutcome; planned: number }> {
  const { run } = input;
  const plan = syncRemovalPlan(run);
  const outcome = await removeRunRecords(input.org, plan, {
    ...runTimes(run),
    ...(run.removal?.removalStamps ? { removalStamps: run.removal.removalStamps } : {}),
    ...(run.removal?.removalSpans ? { removalSpans: run.removal.removalSpans } : {}),
    includeChanged: input.includeChanged,
    previewOnly: true,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  return { outcome, planned: plan.reduce((sum, object) => sum + object.ids.length, 0) };
}

/**
 * Of the records a run wrote over, per earlier run of the same target, those
 * someone changed between that run and this one: the org dated each modified
 * after the earlier run's last write — on the org's clock, with the leeway a
 * removal reads it with — and before this run first wrote it
 * (`SyncRunKept.heldBefore`), as someone other than the user the removal
 * writes as. Where people sign in as that same user, their changes cannot be
 * told from the runs'. By run id, each record by its first fifteen characters.
 */
export async function changedBetweenRuns(
  org: Pick<RemovalOrg, 'serverTime'> & Partial<Pick<RemovalOrg, 'userId'>>,
  run: Pick<SyncRunKept, 'heldBefore'>,
  earlierRuns: ReadonlyArray<Pick<SyncRunKept, 'runId' | 'lastWriteAt' | 'lastWrittenAt' | 'end'>>,
): Promise<Map<string, Set<string>>> {
  const between = new Map<string, Set<string>>();
  const held = Object.entries(run.heldBefore ?? {});
  if (held.length === 0 || earlierRuns.length === 0) return between;
  const writer = await writerOnce(org)();
  const ahead = await orgAheadOf(org);
  for (const other of earlierRuns) {
    const lastWrite = Date.parse(writtenUntil(other) ?? '');
    // An earlier run whose last write is unknown: every record reads as
    // changed since it, as its own removal reads them.
    const end = Number.isFinite(lastWrite)
      ? lastWrite + ahead + CLOCK_LEEWAY_MS
      : Number.NEGATIVE_INFINITY;
    const keys = new Set<string>();
    for (const [key, { at, by }] of held) {
      if (!(Date.parse(at) > end)) continue;
      if (writer !== undefined && by !== undefined && by.slice(0, 15) === writer) continue;
      keys.add(key);
    }
    if (keys.size > 0) between.set(other.runId, keys);
  }
  return between;
}

/**
 * When the run last wrote, by this machine's clock: its last write of any
 * kind, or, for a run kept before its writes were all dated, its last
 * creation or its end. A record it wrote over modified later was changed since.
 */
export function writtenUntil(
  run: Pick<SyncRunKept, 'lastWriteAt' | 'lastWrittenAt' | 'end'>,
): string | undefined {
  return run.lastWriteAt ?? run.lastWrittenAt ?? run.end?.at;
}

/**
 * Records a restore left holding the run's values, all or some of them:
 * changed since, refused, no longer kept, not reached, given back but for
 * fields the target no longer takes.
 */
function leftOver(object: SyncRestoreObjectResult): number {
  return (
    object.keptChanged +
    object.refused +
    object.notKept +
    (object.notReached ?? 0) +
    (object.restoredWithout ?? 0)
  );
}

/**
 * How a removal ended once what it brought back from the recycle bin is
 * counted too: a success only when it left none of the run's deletions
 * deleted either; partial when it did anything, and left some. A
 * checkpoint's rewind and its undo end by it as a Sync run's removal does.
 */
export function withUndelete(
  status: ForgeUndoStatus,
  deleted: readonly ForgeUndoObjectResult[],
  restored: SyncRestoreOutcome | undefined,
  undeleted: SyncUndeleteOutcome | undefined,
): ForgeUndoStatus {
  if (!undeleted || status === 'cancelled') return status;
  if (undeleted.cancelled) return 'cancelled';
  const leftDeleted = undeleted.objects.some((object) => undeleteLeftOver(object) > 0);
  if (status === 'success' && !leftDeleted) return 'success';
  const did =
    deleted.some((object) => object.deleted > 0) ||
    (restored?.objects ?? []).some((object) => object.restored > 0) ||
    undeleted.objects.some((object) => object.undeleted > 0);
  if (status === 'partial') return 'partial';
  return did ? 'partial' : 'failure';
}

/**
 * How a removal ended once what it gave back is counted with what it
 * deleted: a success only when it left nothing holding the run's values
 * either; partial when it deleted or gave back something, and left the rest.
 * A checkpoint's rewind and its undo end by it as a Sync run's removal does.
 */
export function withRestore(
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
    restored.objects.some((object) => object.restored + (object.restoredWithout ?? 0) > 0);
  return did ? 'partial' : 'failure';
}
