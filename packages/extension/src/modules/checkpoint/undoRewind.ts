/**
 * Undo a rewind: take back what it did to the org, from its journal
 * (`rewindJournal.ts`) — bring back from the recycle bin what it deleted,
 * give what it wrote over the values those records held before it, send back
 * to the bin what it brought back — and leave what anyone changed since it as
 * they made it.
 *
 * It composes the bricks a Sync run's removal goes through, in that removal's
 * order (`removeSyncRun`): the removal of what the rewind brought back reads
 * its records first; in its sweep, before its first delete, what the rewind
 * deleted comes back, parents first — a record it wrote over may name one of
 * them — then what it wrote over gets its values back, a chunk of 2,000 a
 * call, as the rewind gave them; then the removal deletes, children first.
 * What the rewind gave back once records hanging from it that it deleted were
 * gone — values they held in place — gets its values back before those
 * records come back (`heldInPlaceOrder`): the org takes a value a child needs
 * before the child, and refuses one a child forbids while it is there.
 * Each brick holds the records to the rewind's span, from its first pass's
 * start to its last write, and leaves one changed after it as it is
 * (`includeChanged: false`): a colleague's change made since the rewind stays
 * theirs, and is counted.
 *
 * Once through, it reads again by their ids the records it gave back, and
 * compares the values the org holds with those from before the rewind: a
 * field the org's automation set again on save, or one someone changed
 * meanwhile, is named, by who last changed it. What it brought back and
 * sent back the bricks read just before and after their writes.
 *
 * What it did, and what it left, goes into the journal, as a Sync run's
 * removal keeps its own: an undo stopped part way is taken up by the next one,
 * which reads what the first wrote as no change since the rewind.
 *
 * The org's lock is taken for it (`OrgCheckpointStore.lock`), and the guards
 * of a rewind are passed before it (`checkpointGuard.ts`): it checks only
 * that the lock it is handed is the checkpoint's org's.
 */

import type {
  CheckpointObject,
  ForgeUndoObjectResult,
  ForgeUndoStatus,
  SyncRestoreObjectResult,
  SyncUndeleteObjectResult,
} from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { readColumnsApart } from '../../core/common/wideRead.js';
import { idLists, RECORDS_PER_CALL } from '../dataops/RecordRemoval.js';
import {
  removeRunRecords,
  type RemovalOrg,
  type RunRemovalOptions,
  type RunRemovalOutcome,
} from '../forge/ForgeRunRemoval.js';
import { removalStatus } from '../forge/removalOutcome.js';
import type { SyncRunRemovalState } from '../sync/SyncRunCreations.js';
import { withRestore, withUndelete } from '../sync/SyncRunRemoval.js';
import {
  restoreOverwrites,
  sameValue,
  type BackupReader,
  type SyncRestoreOutcome,
} from '../sync/SyncRunRestore.js';
import {
  undeleteRunDeletions,
  type SyncUndeleteOutcome,
  type UndeleteCall,
} from '../sync/SyncRunUndelete.js';
import type { CheckpointFolder, OrgLock } from './OrgCheckpointStore.js';
import {
  reopenRewindJournal,
  undoPlans,
  type RewindJournal,
  type RewindUndoPlans,
} from './rewindJournal.js';
import { SNAPSHOT_CHUNK_IDS } from './snapshotIndex.js';

/** What an undo is given. */
export interface UndoRewindInput {
  /** The checkpoint the rewind was to. */
  folder: CheckpointFolder;
  rewindId: string;
  /** The lock of the checkpoint's org, held for the undo. */
  lock: OrgLock;
  /**
   * The checkpoint's objects, children first (`OrgCheckpoint.objects`): what
   * comes back from the recycle bin comes parents first.
   */
  objects: ReadonlyArray<Pick<CheckpointObject, 'objectApiName' | 'readOrder'>>;
  org: RemovalOrg;
  /** Takes records out of the recycle bin by their ids (`conn.soap.undelete`). */
  undelete: UndeleteCall;
  /** Stops the undo before its next call to the org. */
  signal?: AbortSignal;
  /** Told how many of what goes back to the bin are settled, after each step. */
  onProgress?: RunRemovalOptions['onProgress'];
  /** Asked before the first write when the user may not delete some objects' records. */
  onUndeletable?: RunRemovalOptions['onUndeletable'];
}

/**
 * Records of one object the undo gave back that still differ from how they
 * were before the rewind, read again once it was through: the org's
 * automation set a field again on save, someone changed it meanwhile, or the
 * org no longer takes a value from before (which the give-back says why).
 */
export interface UndoResidual {
  objectApiName: string;
  /** How many. */
  count: number;
  /** Their ids, the first {@link RESIDUAL_IDS_KEPT} of them. */
  ids: string[];
  /** Who last changed them, by User Id, and how many each. */
  by: Record<string, number>;
}

/** What an undo did. */
export interface UndoRewindOutcome {
  rewindId: string;
  /**
   * How it ended, as a rewind's removal ends (`withUndelete`, `withRestore`):
   * partial when it left a record as someone changed it since the rewind, or
   * one still differs once read again.
   */
  status: ForgeUndoStatus;
  /** What it sent back to the recycle bin, per object, children first. */
  deleted: ForgeUndoObjectResult[];
  /** What it gave back its values from before the rewind, per object. */
  restored: SyncRestoreObjectResult[];
  /** What it brought back from the recycle bin, per object, parents first. */
  undeleted: SyncUndeleteObjectResult[];
  residual: UndoResidual[];
  /** How many records each part set out to take back. */
  planned: { remove: number; bringBack: number; giveBack: number };
  /** Why something could not be kept or read, said, never thrown. */
  notes: string[];
  /** Set when it stopped before its first write, as asked of objects the user may not delete. */
  stoppedForUndeletable?: true;
  finishedAt: string;
}

/** Ids a residual names at most: the count says how many there are. */
export const RESIDUAL_IDS_KEPT = 50;

/** What the org answers an undelete of a record it will not bring back, in its words. */
const NOT_IN_BIN = /Entity is not in the recycle bin/;

/**
 * Why a record the org answered "not in the recycle bin" for is still in it,
 * in words that say so: the org's own say the opposite of what a read of the
 * bin shows.
 */
export const KEPT_IN_BIN_WORDS =
  'Salesforce keeps it in the recycle bin and will not bring it back: deleted on its own, ' +
  'then a record it hangs from was deleted after it, it can no longer come back, with that ' +
  'record or without; deleted with a record still in the bin, it comes back only with that ' +
  "record (the org answers 'UNDELETE_FAILED: Entity is not in the recycle bin')";

/** Columns past which a read by id names a quarter as many ids, as the give-back reads them. */
const WIDE_COLUMNS = 100;

/** A record by its first fifteen characters. */
function recordKey(id: string): string {
  return id.slice(0, 15);
}

/** How many ids plans hold. */
function count(plan: ReadonlyArray<{ ids: readonly string[] }>): number {
  return plan.reduce((sum, object) => sum + object.ids.length, 0);
}

/** A removal that had nothing to delete: what goes back to the bin was nothing. */
function nothingRemoved(cancelled: boolean): RunRemovalOutcome {
  return {
    objects: [],
    cancelled,
    gone: [],
    stamps: {},
    left: async function* () {
      // Nothing was handed over.
    },
  };
}

/** Add one call's tally of an object to the object's. */
function addTally(into: SyncRestoreObjectResult, from: SyncRestoreObjectResult | undefined): void {
  if (!from) return;
  into.restored += from.restored;
  into.keptChanged += from.keptChanged;
  into.alreadyGone += from.alreadyGone;
  into.refused += from.refused;
  into.notKept += from.notKept;
  if (from.notReached) into.notReached = (into.notReached ?? 0) + from.notReached;
  if (from.restoredWithout)
    into.restoredWithout = (into.restoredWithout ?? 0) + from.restoredWithout;
  for (const reason of from.reasons) {
    if (into.reasons.length < 5 && !into.reasons.includes(reason)) into.reasons.push(reason);
  }
}

/**
 * Give back what the rewind wrote over, a chunk of {@link SNAPSHOT_CHUNK_IDS}
 * records a call, as the rewind gave records their checkpoint values: one
 * call never holds more of an object's values from before in memory. A stop
 * between two chunks leaves the rest not reached.
 */
async function giveBack(
  org: RemovalOrg,
  plan: RewindUndoPlans['giveBack'],
  values: BackupReader,
  options: { lastWriteAt?: string; stamps?: Record<string, string>; signal?: AbortSignal },
): Promise<SyncRestoreOutcome> {
  const merged: SyncRestoreOutcome = {
    objects: [],
    left: [],
    wrote: false,
    cancelled: false,
    stamps: {},
  };
  for (const { objectApiName, backup, ids } of plan) {
    const tally: SyncRestoreObjectResult = {
      objectApiName,
      planned: ids.length,
      restored: 0,
      keptChanged: 0,
      alreadyGone: 0,
      refused: 0,
      notKept: 0,
      reasons: [],
    };
    merged.objects.push(tally);
    for (let at = 0; at < ids.length; at += SNAPSHOT_CHUNK_IDS) {
      const chunk = ids.slice(at, at + SNAPSHOT_CHUNK_IDS);
      if (merged.cancelled || options.signal?.aborted) {
        merged.cancelled = true;
        tally.notReached = (tally.notReached ?? 0) + chunk.length;
        merged.left.push(...chunk);
        continue;
      }
      const outcome = await restoreOverwrites({
        org,
        plan: [{ objectApiName, backup, ids: chunk }],
        backups: values,
        ...(options.lastWriteAt !== undefined ? { lastWriteAt: options.lastWriteAt } : {}),
        includeChanged: false,
        ...(options.stamps ? { stamps: options.stamps } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      addTally(tally, outcome.objects[0]);
      merged.left.push(...outcome.left);
      merged.wrote ||= outcome.wrote;
      merged.cancelled ||= outcome.cancelled;
      Object.assign(merged.stamps, outcome.stamps);
    }
  }
  return merged;
}

/**
 * The order an undo's sweep writes in, from its plans: what the rewind
 * deleted, parents first, then what it wrote over — but the records whose
 * values records it deleted held in place (`RewindUndoPlans.held`) are given
 * back before those records come back from the bin, once every object
 * brought back before the first of them is back.
 *
 * Seen live, the rewind gave an opportunity its price book and amount back
 * once the product created since under it was gone: an opportunity's price
 * book cannot change while it has products, and its amount is theirs to add
 * up. Its undo brought the product back first, then could not give the
 * opportunity back the values the product needs.
 */
export function heldInPlaceOrder(plans: RewindUndoPlans): {
  /** Brought back first: the objects before the first whose records held values in place. */
  bringFirst: RewindUndoPlans['bringBack'];
  /** Given back next: the records held in place. */
  giveHeld: RewindUndoPlans['giveBack'];
  /** Brought back then: the records that held them, and the objects after them. */
  bringAfter: RewindUndoPlans['bringBack'];
  /** Given back last: the rest of what the rewind wrote over. */
  giveRest: RewindUndoPlans['giveBack'];
} {
  const held = new Set((plans.held ?? []).flatMap(({ ids }) => ids.map(recordKey)));
  const holders = new Set((plans.held ?? []).flatMap(({ by }) => by));
  const first = plans.bringBack.findIndex(({ objectApiName }) => holders.has(objectApiName));
  const split = first < 0 || held.size === 0 ? plans.bringBack.length : first;
  const giveWhere = (keep: (key: string) => boolean): RewindUndoPlans['giveBack'] =>
    plans.giveBack.flatMap((object) => {
      const ids = object.ids.filter((id) => keep(recordKey(id)));
      return ids.length > 0 ? [{ ...object, ids }] : [];
    });
  return {
    bringFirst: plans.bringBack.slice(0, split),
    giveHeld: giveWhere((key) => held.has(key)),
    bringAfter: plans.bringBack.slice(split),
    giveRest: giveWhere((key) => !held.has(key)),
  };
}

/** What two bring-backs of an undo did, as one: their objects are apart. */
function mergedUndelete(
  into: SyncUndeleteOutcome | undefined,
  from: SyncUndeleteOutcome,
): SyncUndeleteOutcome {
  if (!into) return from;
  return {
    objects: [...into.objects, ...from.objects],
    left: [...into.left, ...from.left],
    wrote: into.wrote || from.wrote,
    cancelled: into.cancelled || from.cancelled,
    stamps: { ...into.stamps, ...from.stamps },
  };
}

/** What two give-backs of an undo did, as one: an object given back in both counted once. */
function mergedRestore(
  into: SyncRestoreOutcome | undefined,
  from: SyncRestoreOutcome,
): SyncRestoreOutcome {
  if (!into) return from;
  const objects = into.objects.map((object) => ({ ...object, reasons: [...object.reasons] }));
  for (const object of from.objects) {
    const same = objects.find((held) => held.objectApiName === object.objectApiName);
    if (!same) {
      objects.push(object);
      continue;
    }
    same.planned += object.planned;
    addTally(same, object);
  }
  return {
    objects,
    left: [...into.left, ...from.left],
    wrote: into.wrote || from.wrote,
    cancelled: into.cancelled || from.cancelled,
    stamps: { ...into.stamps, ...from.stamps },
  };
}

/**
 * `outcome` once what the undelete refused as not in the recycle bin is
 * settled, the bring back through: of those records — read in the bin just
 * before they were sent — one live now came back with a record it hangs from,
 * brought back after it, and is counted back already (`alreadyBack`), never
 * refused; one still in the bin is named with words that say why
 * ({@link KEPT_IN_BIN_WORDS}).
 *
 * Seen live: an undo brought back contacts before the accounts their delete
 * had gone with, as the order of the objects had it. The org answered each
 * contact "Entity is not in the recycle bin", then brought it back with its
 * account; the undo named six contacts refused, and ended partial.
 *
 * A read that fails leaves the outcome as it was, said in `notes`.
 */
export async function settleNotInBin(
  org: Pick<RemovalOrg, 'query'>,
  outcome: SyncUndeleteOutcome,
  plan: ReadonlyArray<{ objectApiName: string; ids: readonly string[] }>,
  notes: string[],
): Promise<SyncUndeleteOutcome> {
  if (outcome.cancelled) return outcome;
  const left = new Set(outcome.left.map(recordKey));
  const back = new Set<string>();
  const settled: SyncUndeleteObjectResult[] = [];
  for (const object of outcome.objects) {
    const words = object.reasons.find((reason) => NOT_IN_BIN.test(reason));
    if (words === undefined || object.refused === 0) {
      settled.push(object);
      continue;
    }
    const ids = plan
      .filter(({ objectApiName }) => objectApiName === object.objectApiName)
      .flatMap((each) => each.ids.filter((id) => left.has(recordKey(id))));
    let live = 0;
    try {
      const name = assertSoqlIdentifier(object.objectApiName);
      for (const list of idLists(ids, RECORDS_PER_CALL)) {
        const answer = await org.query(`SELECT Id FROM ${name} WHERE Id IN (${list})`);
        for (const row of answer.records as Array<{ Id?: unknown }>) {
          if (typeof row.Id !== 'string' || back.has(recordKey(row.Id))) continue;
          back.add(recordKey(row.Id));
          live++;
        }
      }
    } catch (err: unknown) {
      notes.push(
        `Whether the ${object.objectApiName} records the org answered were not in the recycle bin ` +
          `came back with their parent could not be read (${extractErrorMessage(err)}): they are ` +
          'counted refused.',
      );
      settled.push(object);
      continue;
    }
    const taken = Math.min(live, object.refused);
    const refused = object.refused - taken;
    settled.push({
      ...object,
      refused,
      alreadyBack: object.alreadyBack + taken,
      reasons:
        refused === 0
          ? object.reasons.filter((reason) => reason !== words)
          : object.reasons.map((reason) => (reason === words ? KEPT_IN_BIN_WORDS : reason)),
    });
  }
  return {
    ...outcome,
    objects: settled,
    left: outcome.left.filter((id) => !back.has(recordKey(id))),
  };
}

/** The values from before of `ids`, by key: each field once, as first kept. */
async function valuesBefore(
  values: BackupReader,
  backup: string,
  objectApiName: string,
  ids: readonly string[],
): Promise<Map<string, { id: string; values: Record<string, unknown> }>> {
  const wanted = new Map(ids.map((id) => [recordKey(id), id]));
  const before = new Map<string, { id: string; values: Record<string, unknown> }>();
  const batches = await values.batches(backup, objectApiName, RECORDS_PER_CALL);
  for await (const batch of batches ?? []) {
    for (const record of batch) {
      if (typeof record.Id !== 'string') continue;
      const id = wanted.get(recordKey(record.Id));
      if (id === undefined) continue;
      const held = before.get(recordKey(id)) ?? { id, values: {} };
      for (const [field, value] of Object.entries(record)) {
        if (field !== 'Id' && !(field in held.values)) held.values[field] = value;
      }
      before.set(recordKey(id), held);
    }
  }
  return before;
}

/**
 * Read again by their ids the records the undo gave back — all of a plan's
 * but those it left — and name those that still differ from their values
 * from before the rewind, a chunk at a time. An object whose records could not
 * be read again is said in `notes`.
 */
async function stillDiffering(
  org: RemovalOrg,
  plan: RewindUndoPlans['giveBack'],
  values: BackupReader,
  left: ReadonlySet<string>,
  notes: string[],
): Promise<UndoResidual[]> {
  const residual: UndoResidual[] = [];
  for (const { objectApiName, backup, ids } of plan) {
    const object = assertSoqlIdentifier(objectApiName);
    const differing: UndoResidual = { objectApiName, count: 0, ids: [], by: {} };
    const given = ids.filter((id) => !left.has(recordKey(id)));
    try {
      for (let at = 0; at < given.length; at += SNAPSHOT_CHUNK_IDS) {
        const before = await valuesBefore(
          values,
          backup,
          objectApiName,
          given.slice(at, at + SNAPSHOT_CHUNK_IDS),
        );
        if (before.size === 0) continue;
        const fields = new Set<string>();
        for (const { values: held } of before.values()) {
          for (const field of Object.keys(held)) fields.add(assertSoqlIdentifier(field));
        }
        const columns = ['Id', 'LastModifiedById', ...fields];
        const perQuery = columns.length > WIDE_COLUMNS ? RECORDS_PER_CALL / 4 : RECORDS_PER_CALL;
        const read = async (statement: string): Promise<Array<Record<string, unknown>>> =>
          (await org.query(statement)).records as Array<Record<string, unknown>>;
        for (const list of idLists(
          [...before.values()].map((held) => held.id),
          perQuery,
        )) {
          const rows = await readColumnsApart(
            `SELECT ${columns.join(', ')} FROM ${object} WHERE Id IN (${list})`,
            read,
          );
          for (const row of rows) {
            if (typeof row.Id !== 'string') continue;
            const held = before.get(recordKey(row.Id));
            if (!held) continue;
            const differs = Object.entries(held.values).some(
              ([field, value]) => !sameValue(value, row[field]),
            );
            if (!differs) continue;
            differing.count++;
            if (differing.ids.length < RESIDUAL_IDS_KEPT) differing.ids.push(held.id);
            const by = typeof row.LastModifiedById === 'string' ? row.LastModifiedById : 'unknown';
            differing.by[by] = (differing.by[by] ?? 0) + 1;
          }
        }
      }
    } catch (err: unknown) {
      notes.push(
        `The ${objectApiName} records the undo gave back could not be read again ` +
          `(${extractErrorMessage(err)}): whether they all hold their values from before the ` +
          'rewind was not checked.',
      );
    }
    if (differing.count > 0) residual.push(differing);
  }
  return residual;
}

/**
 * Undo a rewind from its journal: see the module's comment.
 *
 * @returns Nothing is thrown for a follow-up that fails; a call to the org
 *   that fails outright is thrown, as the removal throws it.
 * @throws {CheckpointStoreError} When the journal is not kept, cannot be
 *   read, or the lock held is not of the checkpoint's org: nothing is sent.
 */
export async function undoRewind(input: UndoRewindInput): Promise<UndoRewindOutcome> {
  const journal = await reopenRewindJournal(input.folder, input.rewindId, input.lock);
  try {
    return await undoFrom(journal, input);
  } finally {
    await journal.close();
  }
}

async function undoFrom(
  journal: RewindJournal,
  input: UndoRewindInput,
): Promise<UndoRewindOutcome> {
  const { org, signal } = input;
  const read = await journal.read();
  const plans = undoPlans(read, input.objects);
  const planned = {
    remove: count(plans.remove),
    bringBack: count(plans.bringBack),
    giveBack: count(plans.giveBack),
  };
  const notes: string[] = [];
  // What the rewind's removals, and the undos before this one, left on
  // records: a record last modified no later than its stamp was not changed
  // since the rewind, one of them having written it. And when each ran, as
  // whom: what that user created meanwhile goes with what it removed.
  const stampsBefore = { ...read.rewind.removalStamps, ...read.undo.removalStamps };
  const stamps = Object.keys(stampsBefore).length > 0 ? stampsBefore : undefined;
  const spansBefore = [...(read.rewind.removalSpans ?? []), ...(read.undo.removalSpans ?? [])];

  const order = heldInPlaceOrder(plans);
  let undeleted: SyncUndeleteOutcome | undefined;
  let restored: SyncRestoreOutcome | undefined;
  const bringBack = async (plan: RewindUndoPlans['bringBack']): Promise<boolean> => {
    if (plan.length === 0) return true;
    undeleted = mergedUndelete(
      undeleted,
      await undeleteRunDeletions({
        org,
        plan,
        undelete: input.undelete,
        ...(signal ? { signal } : {}),
      }),
    );
    return !undeleted.cancelled && signal?.aborted !== true;
  };
  const giveBackOf = async (plan: RewindUndoPlans['giveBack']): Promise<boolean> => {
    if (plan.length === 0) return true;
    restored = mergedRestore(
      restored,
      await giveBack(org, plan, journal.values, {
        ...(read.lastWriteAt !== undefined ? { lastWriteAt: read.lastWriteAt } : {}),
        ...(stamps ? { stamps } : {}),
        ...(signal ? { signal } : {}),
      }),
    );
    return !restored.cancelled && signal?.aborted !== true;
  };
  const sweep = async (): Promise<boolean> => {
    // What it deleted first, parents first: a record it wrote over may name
    // one of them. But values the records it deleted held in place go back
    // before those records come back: the org refuses them while they are
    // there, or refuses them under values they never had.
    const through =
      (await bringBack(order.bringFirst)) &&
      (await giveBackOf(order.giveHeld)) &&
      (await bringBack(order.bringAfter));
    if (through) {
      // Every record brought back: what came back with a record after it is
      // live now, and was answered not in the bin when it was sent first.
      if (undeleted) undeleted = await settleNotInBin(org, undeleted, plans.bringBack, notes);
      await giveBackOf(order.giveRest);
    }
    return (undeleted?.wrote ?? false) || (restored?.wrote ?? false);
  };

  let outcome: RunRemovalOutcome;
  if (plans.remove.length > 0) {
    outcome = await removeRunRecords(org, plans.remove, {
      runStartedAt: new Date(read.head.startedAt),
      ...(read.lastWriteAt !== undefined ? { runRecordedAt: new Date(read.lastWriteAt) } : {}),
      ...(stamps ? { removalStamps: stamps } : {}),
      ...(spansBefore.length > 0 ? { removalSpans: spansBefore } : {}),
      includeChanged: false,
      ...(plans.bringBack.length > 0 || plans.giveBack.length > 0 ? { sweep } : {}),
      ...(input.onUndeletable ? { onUndeletable: input.onUndeletable } : {}),
      ...(signal ? { signal } : {}),
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    });
  } else {
    // Nothing goes back to the bin: the sweep's bricks run on their own, and
    // no removal reads the org's clock and user for nothing.
    if (!signal?.aborted) await sweep();
    outcome = nothingRemoved(signal?.aborted === true && !undeleted && !restored);
  }
  const finishedAt = new Date().toISOString();
  if (outcome.stoppedForUndeletable) {
    return {
      rewindId: input.rewindId,
      status: 'cancelled',
      deleted: [],
      restored: [],
      undeleted: [],
      residual: [],
      planned,
      notes: [],
      stoppedForUndeletable: true,
      finishedAt,
    };
  }

  let status = withUndelete(
    withRestore(removalStatus(outcome.objects, outcome.cancelled), outcome.objects, restored),
    outcome.objects,
    restored,
    undeleted,
  );
  const residual =
    restored && status !== 'cancelled'
      ? await stillDiffering(
          org,
          plans.giveBack,
          journal.values,
          new Set(restored.left.map(recordKey)),
          notes,
        )
      : [];
  if (residual.length > 0 && status === 'success') status = 'partial';

  // Kept whatever it ended on, cancelled included, as a Sync run's removal
  // keeps its own: what the next undo sets out to take back, what it wrote
  // to records it did not delete, and when it ran.
  const gone = new Set(outcome.gone);
  const removalLeft =
    gone.size > 0
      ? plans.remove.flatMap(({ ids }) => ids.filter((id) => !gone.has(id)))
      : undefined;
  const gaveBack =
    restored?.objects.some((object) => object.restored + (object.restoredWithout ?? 0) > 0) ===
    true;
  const change: SyncRunRemovalState = {
    ...(Object.keys(outcome.stamps).length > 0 ? { removalStamps: outcome.stamps } : {}),
    ...(outcome.span ? { removalSpans: [outcome.span] } : {}),
    ...(removalLeft ? { removalLeft } : {}),
    ...(restored ? { restoreLeft: restored.left } : {}),
    ...(gaveBack ? { restoredAt: finishedAt } : {}),
    ...(undeleted ? { undeleteLeft: undeleted.left } : {}),
    ...(undeleted && !undeleted.cancelled ? { undeletedAt: finishedAt } : {}),
  };
  try {
    await journal.undone(change, status);
  } catch (err: unknown) {
    notes.push(
      `What this undo did could not be kept in the rewind’s journal (${extractErrorMessage(err)}): ` +
        'an undo after it may set out to take back what it took back already.',
    );
  }
  return {
    rewindId: input.rewindId,
    status,
    deleted: outcome.objects,
    restored: restored?.objects ?? [],
    undeleted: undeleted?.objects ?? [],
    residual,
    planned,
    notes,
    finishedAt,
  };
}
