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
 * theirs, and is counted. What the undo's own undeletes restamp of what it
 * gives back — a lookup the rewind's delete cleared on a field the checkpoint
 * does not compare, which an undelete puts back — is read before each
 * give-back, and taken for the undo's doing.
 *
 * What the rewind brought back for a moment and deleted again — a carrier,
 * a record the checkpoint does not hold that had taken records of it along —
 * stays in the bin, and so does what went back there with it. What the
 * rewind gave back of what it took along it moved off it: that goes back to
 * the bin on its own (`carriedAlone`), its lookup to the carrier not given
 * back — the org refuses a lookup to a record in the bin. A value from before
 * that names any record the undo leaves in the bin is left as it is.
 *
 * The links between files and records the rewind wrote on its own are taken
 * back last but one: the links it inserted again removed before anything
 * goes back to the bin, the links it removed inserted again — each under a
 * new Id, as Salesforce brings no link back from the recycle bin (P-A3) —
 * and the sharing it gave back given the sharing from before, once the files
 * and records they tie are back. A file the rewind deleted comes back with
 * its links, a file it brought back goes back to the bin with them, as any
 * record (P-A1).
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
  RewindFilesResult,
  SyncRestoreObjectResult,
  SyncUndeleteObjectResult,
} from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { readColumnsApart } from '../../core/common/wideRead.js';
import { idLists, RECORDS_PER_CALL } from '../dataops/RecordRemoval.js';
import {
  CLOCK_LEEWAY_MS,
  removeRunRecords,
  type RemovalOrg,
  type RunRemovalOptions,
  type RunRemovalOutcome,
} from '../forge/ForgeRunRemoval.js';
import { removalStatus } from '../forge/removalOutcome.js';
import type { SyncRunRemovalState } from '../sync/SyncRunCreations.js';
import { withRestore, withUndelete } from '../sync/SyncRunRemoval.js';
import {
  orgAheadOf,
  restoreOverwrites,
  sameValue,
  stampsWritten,
  writerOnce,
  type BackupReader,
  type SyncRestoreOutcome,
} from '../sync/SyncRunRestore.js';
import {
  undeleteRunDeletions,
  type SyncUndeleteOutcome,
  type UndeleteCall,
} from '../sync/SyncRunUndelete.js';
import {
  addWritten,
  insertFileLinks,
  nothingWritten,
  removeFileLinks,
  shareFileLinks,
  type FileLinksOrg,
  type FileLinksWritten,
} from './fileLinksWrite.js';
import type { CheckpointFolder, OrgLock } from './OrgCheckpointStore.js';
import {
  reopenRewindJournal,
  spoolUndoPlans,
  type RewindJournal,
  type RewindJournalFacts,
  type SpooledUndoPlans,
} from './rewindJournal.js';
import { SNAPSHOT_CHUNK_IDS } from './snapshotIndex.js';
import { RecordKeySet, type IdSpool } from './spooledRunRecords.js';

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
  /**
   * The org; its inserts are what the links the rewind removed are inserted
   * again through: an org that takes none has them refused, named.
   */
  org: RemovalOrg & Partial<Pick<FileLinksOrg, 'create'>>;
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
  /**
   * Of what it was to send to the recycle bin, per object, the records the
   * rewind made again with new Ids that are no longer in the org: deleted by
   * it, or gone with a record it deleted. Absent when there is none.
   */
  remade?: Array<{ objectApiName: string; count: number }>;
  /**
   * Of what it sent back to the recycle bin, per object, the records that had
   * gone there with a carrier the rewind brought back for a moment, which
   * stays there: back in the bin on their own. Absent when there is none.
   */
  carriedAlone?: Array<{ objectApiName: string; count: number }>;
  /** What it gave back its values from before the rewind, per object. */
  restored: SyncRestoreObjectResult[];
  /** What it brought back from the recycle bin, per object, parents first. */
  undeleted: SyncUndeleteObjectResult[];
  /**
   * What it took back of the links between files and records the rewind
   * wrote: the links it inserted again removed (`unlinked`), the links it
   * removed inserted again (`relinked`), the sharing it gave back given back
   * (`linksUpdated`). Absent when the rewind wrote no link.
   */
  files?: RewindFilesResult;
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
 * Why a record the org answered "not in the recycle bin" for still reads as
 * in it, in words that say so: the org's own say the opposite of what a read
 * of the bin shows. Salesforce lists a record emptied from the bin as deleted
 * until it deletes it for good — half an hour later still, a day later no
 * longer, on a scratch org — and keeps there for good one deleted on its own
 * before a record it hangs from.
 */
export const KEPT_IN_BIN_WORDS =
  'Salesforce still lists it as deleted but will not bring it back: emptied from the recycle ' +
  'bin, or kept there for good — deleted on its own, then a record it hangs from was deleted ' +
  'after it, it can no longer come back, with that record or without; deleted with a record ' +
  'still in the bin, it comes back only with that record ' +
  "(the org answers 'UNDELETE_FAILED: Entity is not in the recycle bin')";

/** Columns past which a read by id names a quarter as many ids, as the give-back reads them. */
const WIDE_COLUMNS = 100;

/** A record by its first fifteen characters. */
function recordKey(id: string): string {
  return id.slice(0, 15);
}

/** A Salesforce id, of either length. */
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/**
 * `values` without the fields whose value from before names a record of
 * `compensated`: in the recycle bin before the rewind and after it, which
 * the undo leaves there. The org refuses a lookup to a record in the bin
 * (`ENTITY_IS_DELETED`, live): a contact a rewind brought back with an
 * account created since, then gave its own account back, held that account
 * from before, which its undo could not write.
 */
function withoutCompensated(
  values: BackupReader,
  compensated: Pick<RecordKeySet, 'has'>,
): BackupReader {
  return {
    batches: async (operationId, objectApiName, size) => {
      const batches = await values.batches(operationId, objectApiName, size);
      if (!batches) return null;
      return {
        async *[Symbol.asyncIterator]() {
          for await (const batch of batches) {
            yield batch.map((record) =>
              Object.fromEntries(
                Object.entries(record).filter(
                  ([field, value]) =>
                    field === 'Id' ||
                    typeof value !== 'string' ||
                    !RECORD_ID.test(value) ||
                    !compensated.has(value),
                ),
              ),
            );
          }
        },
      };
    },
  };
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
 * The ids of `objectApiName` in a plan, `size` at a time, those `keep` takes:
 * pages of the spool read again into chunks of `size`, so a chunk is whole
 * whatever the filter leaves of a page.
 */
async function* chunksOf(
  spool: Pick<IdSpool, 'pages'>,
  objectApiName: string,
  size: number,
  keep: (key: string) => boolean = () => true,
): AsyncGenerator<string[]> {
  let chunk: string[] = [];
  for await (const page of spool.pages(objectApiName, size)) {
    for (const id of page) {
      if (!keep(recordKey(id))) continue;
      chunk.push(id);
      if (chunk.length >= size) {
        yield chunk;
        chunk = [];
      }
    }
  }
  if (chunk.length > 0) yield chunk;
}

/**
 * The order an undo's sweep writes in, from its plans: what the rewind
 * deleted, parents first, then what it wrote over — but the records whose
 * values records it deleted held in place (`SpooledUndoPlans.held`) are given
 * back before those records come back from the bin, once every object
 * brought back before the first of them is back.
 *
 * Seen live, the rewind gave an opportunity its price book and amount back
 * once the product created since under it was gone: an opportunity's price
 * book cannot change while it has products, and its amount is theirs to add
 * up. Its undo brought the product back first, then could not give the
 * opportunity back the values the product needs.
 */
export function heldInPlaceOrder(plans: Pick<SpooledUndoPlans, 'bringBack' | 'held'>): {
  /** Brought back first: the objects before the first whose records held values in place. */
  bringFirst: string[];
  /** Brought back then: the objects of the records that held them, and those after them. */
  bringAfter: string[];
  /** Of what is given back, the records held in place, given back between the two. */
  held: (key: string) => boolean;
} {
  const objects = plans.bringBack.objects
    .filter(({ count: records }) => records > 0)
    .map(({ objectApiName }) => objectApiName);
  const holders = new Set(plans.held.objects.flatMap(({ by }) => by));
  const first = objects.findIndex((objectApiName) => holders.has(objectApiName));
  const split = first < 0 || plans.held.keys.size === 0 ? objects.length : first;
  return {
    bringFirst: objects.slice(0, split),
    bringAfter: objects.slice(split),
    held: (key) => plans.held.keys.has(key),
  };
}

/** What two bring-backs of an object did, as one. */
function mergedUndeleteObject(
  into: SyncUndeleteObjectResult,
  from: SyncUndeleteObjectResult,
): void {
  into.planned += from.planned;
  into.undeleted += from.undeleted;
  into.alreadyBack += from.alreadyBack;
  into.goneForGood += from.goneForGood;
  into.refused += from.refused;
  if (from.notReached) into.notReached = (into.notReached ?? 0) + from.notReached;
  for (const reason of from.reasons) {
    if (into.reasons.length < 5 && !into.reasons.includes(reason)) into.reasons.push(reason);
  }
}

/** What two bring-backs of an undo did, as one: an object brought back in both counted once. */
function mergedUndelete(
  into: SyncUndeleteOutcome | undefined,
  from: SyncUndeleteOutcome,
): SyncUndeleteOutcome {
  if (!into) return from;
  const objects = into.objects.map((object) => ({ ...object, reasons: [...object.reasons] }));
  for (const object of from.objects) {
    const same = objects.find((held) => held.objectApiName === object.objectApiName);
    if (same) mergedUndeleteObject(same, object);
    else objects.push({ ...object, reasons: [...object.reasons] });
  }
  return {
    objects,
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
 *
 * @param plan - What was sent, per object; only the records the outcome
 *   left are read.
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
  plans: Pick<SpooledUndoPlans, 'giveBack' | 'backup'>,
  values: BackupReader,
  left: RecordKeySet,
  notes: string[],
): Promise<UndoResidual[]> {
  const residual: UndoResidual[] = [];
  const backup = plans.backup;
  for (const { objectApiName } of plans.giveBack.objects) {
    const object = assertSoqlIdentifier(objectApiName);
    const differing: UndoResidual = { objectApiName, count: 0, ids: [], by: {} };
    try {
      for await (const given of chunksOf(
        plans.giveBack,
        objectApiName,
        SNAPSHOT_CHUNK_IDS,
        (key) => !left.has(key),
      )) {
        const before = await valuesBefore(values, backup, objectApiName, given);
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
 * Of the records the undo gives back, by key, those the org dates modified no
 * later than the rewind's end on its clock, or than what the rewind's
 * removals and the undos before left on them: unchanged since the rewind. A
 * read that fails leaves its records out, taken for changed.
 */
async function unchangedSince(
  org: Pick<RemovalOrg, 'query'>,
  giveBack: Pick<IdSpool, 'objects' | 'pages'>,
  rewindEnd: number,
  stampsBefore: Readonly<Record<string, string>>,
  signal: AbortSignal | undefined,
): Promise<RecordKeySet> {
  const stamped = new Map(
    Object.entries(stampsBefore).map(([id, at]) => [recordKey(id), Date.parse(at)]),
  );
  const unchanged = new RecordKeySet();
  for (const { objectApiName } of giveBack.objects) {
    const object = assertSoqlIdentifier(objectApiName);
    for await (const page of giveBack.pages(objectApiName)) {
      for (const list of idLists(page, RECORDS_PER_CALL)) {
        if (signal?.aborted) return unchanged;
        let rows: Array<Record<string, unknown>>;
        try {
          rows = (
            await org.query(`SELECT Id, LastModifiedDate FROM ${object} WHERE Id IN (${list})`)
          ).records as Array<Record<string, unknown>>;
        } catch {
          continue;
        }
        for (const row of rows) {
          if (typeof row.Id !== 'string') continue;
          const key = recordKey(row.Id);
          const modified = Date.parse(String(row.LastModifiedDate ?? ''));
          if (modified <= rewindEnd || modified <= (stamped.get(key) ?? Number.NaN)) {
            unchanged.add(row.Id);
          }
        }
      }
    }
  }
  return unchanged;
}

/**
 * Undo a rewind from its journal: see the module's comment.
 *
 * Its plans are read from the journal on disk into files of their own, a line
 * at a time (`spoolUndoPlans`), and taken a page at a time: held in memory,
 * the plans of a rewind of a million records took some 700 MB of the
 * extension host. They are removed once it is through.
 *
 * @returns Nothing is thrown for a follow-up that fails; a call to the org
 *   that fails outright is thrown, as the removal throws it.
 * @throws {CheckpointStoreError} When the journal is not kept, cannot be
 *   read, or the lock held is not of the checkpoint's org: nothing is sent.
 */
export async function undoRewind(input: UndoRewindInput): Promise<UndoRewindOutcome> {
  const journal = await reopenRewindJournal(input.folder, input.rewindId, input.lock);
  try {
    const facts = await journal.facts();
    const plans = await spoolUndoPlans(journal.dir, facts, input.objects);
    try {
      return await undoFrom(journal, facts, plans, input);
    } finally {
      await plans.dispose();
    }
  } finally {
    await journal.close();
  }
}

async function undoFrom(
  journal: RewindJournal,
  read: RewindJournalFacts,
  plans: SpooledUndoPlans,
  input: UndoRewindInput,
): Promise<UndoRewindOutcome> {
  const { org, signal } = input;
  const along = plans.goesWithParent;
  /** The values from before, but those that name a record the undo leaves in the bin. */
  const valuesBefore = withoutCompensated(journal.values, plans.compensated);
  const planned = {
    remove: plans.remove.spool.count + along.count,
    bringBack: plans.bringBack.count,
    giveBack: plans.giveBack.count,
  };
  const notes: string[] = [];
  // What the rewind's removals, and the undos before this one, left on
  // records: a record last modified no later than its stamp was not changed
  // since the rewind, one of them having written it. And when each ran, as
  // whom: what that user created meanwhile goes with what it removed.
  const stampsBefore = { ...read.rewind.removalStamps, ...read.undo.removalStamps };
  const stamps = Object.keys(stampsBefore).length > 0 ? stampsBefore : undefined;
  const spansBefore = [...(read.rewind.removalSpans ?? []), ...(read.undo.removalSpans ?? [])];
  // What this undo's undeletes restamp of the records it gives back next. An
  // undelete puts back the lookups the rewind's delete cleared, and the org
  // dates the record anew, as the undo's user: on a field the checkpoint does
  // not compare, which the rewind never gave back, its delete cleared the
  // lookup, and the record then read as changed since the rewind, kept as
  // someone else had changed it. One unchanged since the rewind when the
  // undeletes began, and last modified by the undo's user since, is the
  // undo's own doing: read before the first undelete, then before each
  // give-back. One someone changed before is theirs still, whoever the
  // undelete names its last modifier.
  const writerOf = writerOnce(org);
  /** When the undo's undeletes began, by the org's clock, give or take the drift. */
  let undeletesFrom: number | undefined;
  /** Of what it gives back, the records unchanged since the rewind when its undeletes began. */
  let untouched = new RecordKeySet();
  const restamped: Record<string, string> = {};

  const order = heldInPlaceOrder(plans);
  let undeleted: SyncUndeleteOutcome | undefined;
  let restored: SyncRestoreOutcome | undefined;
  /** What the bring-back left, per object: what the settling of what it refused reads. */
  const undeleteLeft = new Map<string, string[]>();
  /**
   * Bring back the records of `objects`, in their order, a page at a time:
   * whether it went through. Once stopped, what it did not reach is left.
   */
  const bringBack = async (objects: readonly string[]): Promise<boolean> => {
    for (const objectApiName of objects) {
      for await (const page of plans.bringBack.pages(objectApiName)) {
        const stopped = (undeleted?.cancelled ?? false) || signal?.aborted === true;
        const outcome = stopped
          ? {
              objects: [
                {
                  objectApiName,
                  planned: page.length,
                  undeleted: 0,
                  alreadyBack: 0,
                  goneForGood: 0,
                  refused: 0,
                  notReached: page.length,
                  reasons: [],
                },
              ],
              left: [...page],
              wrote: false,
              cancelled: true,
              stamps: {},
            }
          : await undeleteRunDeletions({
              org,
              plan: [{ objectApiName, ids: page }],
              undelete: input.undelete,
              ...(signal ? { signal } : {}),
            });
        undeleteLeft.set(objectApiName, [
          ...(undeleteLeft.get(objectApiName) ?? []),
          ...outcome.left,
        ]);
        undeleted = mergedUndelete(undeleted, outcome);
      }
    }
    return !(undeleted?.cancelled ?? false) && signal?.aborted !== true;
  };
  /**
   * Give back the records of the plan `keep` takes, a chunk of
   * {@link SNAPSHOT_CHUNK_IDS} a call, as the rewind gave records their
   * checkpoint values: one call never holds more of an object's values from
   * before in memory. What its undeletes restamped of a chunk is read just
   * before it. A stop between two chunks leaves the rest not reached.
   */
  const giveBackOf = async (keep: (key: string) => boolean): Promise<boolean> => {
    for (const { objectApiName } of plans.giveBack.objects) {
      const object = assertSoqlIdentifier(objectApiName);
      const tally: SyncRestoreObjectResult = {
        objectApiName,
        planned: 0,
        restored: 0,
        keptChanged: 0,
        alreadyGone: 0,
        refused: 0,
        notKept: 0,
        reasons: [],
      };
      const outcome: SyncRestoreOutcome = {
        objects: [tally],
        left: [],
        wrote: false,
        cancelled: false,
        stamps: {},
      };
      for await (const chunk of chunksOf(plans.giveBack, objectApiName, SNAPSHOT_CHUNK_IDS, keep)) {
        tally.planned += chunk.length;
        if ((restored?.cancelled ?? false) || outcome.cancelled || signal?.aborted) {
          outcome.cancelled = true;
          tally.notReached = (tally.notReached ?? 0) + chunk.length;
          outcome.left.push(...chunk);
          continue;
        }
        if (undeletesFrom !== undefined) {
          const unchanged = chunk.filter((id) => untouched.has(id));
          Object.assign(
            restamped,
            await stampsWritten(org, object, unchanged, undeletesFrom, writerOf),
          );
        }
        const held = { ...stampsBefore, ...restamped };
        const call = await restoreOverwrites({
          org,
          plan: [{ objectApiName, backup: plans.backup, ids: chunk }],
          backups: valuesBefore,
          ...(read.lastWriteAt !== undefined ? { lastWriteAt: read.lastWriteAt } : {}),
          includeChanged: false,
          ...(Object.keys(held).length > 0 ? { stamps: held } : {}),
          ...(signal ? { signal } : {}),
        });
        addTally(tally, call.objects[0]);
        outcome.left.push(...call.left);
        outcome.wrote ||= call.wrote;
        outcome.cancelled ||= call.cancelled;
        Object.assign(outcome.stamps, call.stamps);
      }
      if (tally.planned > 0) restored = mergedRestore(restored, outcome);
    }
    return !(restored?.cancelled ?? false) && signal?.aborted !== true;
  };
  const sweep = async (): Promise<boolean> => {
    if (plans.bringBack.count > 0 && plans.giveBack.count > 0) {
      const ahead = await orgAheadOf(org);
      undeletesFrom = Date.now() + ahead - CLOCK_LEEWAY_MS;
      const lastWrite = Date.parse(read.lastWriteAt ?? '');
      const rewindEnd = Number.isFinite(lastWrite)
        ? lastWrite + ahead + CLOCK_LEEWAY_MS
        : Number.NEGATIVE_INFINITY;
      untouched = await unchangedSince(org, plans.giveBack, rewindEnd, stampsBefore, signal);
    }
    // What it deleted first, parents first: a record it wrote over may name
    // one of them. But values the records it deleted held in place go back
    // before those records come back: the org refuses them while they are
    // there, or refuses them under values they never had.
    const through =
      (await bringBack(order.bringFirst)) &&
      (await giveBackOf(order.held)) &&
      (await bringBack(order.bringAfter));
    if (through) {
      // Every record brought back: what came back with a record after it is
      // live now, and was answered not in the bin when it was sent first.
      if (undeleted) {
        undeleted = await settleNotInBin(
          org,
          undeleted,
          [...undeleteLeft].map(([objectApiName, ids]) => ({ objectApiName, ids })),
          notes,
        );
      }
      await giveBackOf((key) => !order.held(key));
    }
    return (undeleted?.wrote ?? false) || (restored?.wrote ?? false);
  };

  // What came back with a record it sends back to the bin goes with that
  // record, unless someone changed it since the rewind: older than the
  // rewind, it would hold its parent for the removal; changed since, it
  // does, and both stay. What this undo gave back of it is its own write.
  /** Read once the sweep is through, as the removal reads what hangs from its records. */
  let swept: { stamps: Map<string, number>; notGiven: RecordKeySet } | undefined;
  const goesWithParent = (row: Readonly<Record<string, unknown>>, runEnd: number): boolean => {
    if (typeof row.Id !== 'string' || !along.keys.has(row.Id)) return false;
    if (swept === undefined) {
      const notGiven = new RecordKeySet();
      for (const id of restored?.left ?? []) notGiven.add(id);
      swept = {
        stamps: new Map(
          Object.entries({ ...stampsBefore, ...restamped }).map(([id, at]) => [
            recordKey(id),
            Date.parse(at),
          ]),
        ),
        notGiven,
      };
    }
    const modified = Date.parse(String(row.LastModifiedDate ?? row.SystemModstamp ?? ''));
    const key = recordKey(row.Id);
    if (modified <= runEnd || modified <= (swept.stamps.get(key) ?? Number.NaN)) return true;
    return plans.giveBackKeys.has(key) && restored !== undefined && !swept.notGiven.has(key);
  };

  // The links the rewind inserted again go first, before what it brought
  // back goes back to the bin: a link to a record in the bin is read by no
  // one, and comes back with it the day it does.
  const links = plans.links;
  const linksDone: Record<'removed' | 'reinserted' | 'shared', FileLinksWritten> = {
    removed: nothingWritten(),
    reinserted: nothingWritten(),
    shared: nothingWritten(),
  };
  if (links && links.remove.count > 0 && !signal?.aborted) {
    for await (const page of links.remove.pages()) {
      addWritten(
        linksDone.removed,
        await removeFileLinks(org, page, {
          after: async ({ done }) => {
            if (done.length > 0) {
              await journal.linksUndone(
                'removed',
                done.map((link) => link.Id),
              );
            }
          },
          stopped: () => signal?.aborted === true,
        }),
      );
    }
  }

  let outcome: RunRemovalOutcome;
  if (plans.remove.spool.count > 0) {
    outcome = await removeRunRecords(org, plans.remove, {
      runStartedAt: new Date(read.head.startedAt),
      ...(read.lastWriteAt !== undefined ? { runRecordedAt: new Date(read.lastWriteAt) } : {}),
      ...(stamps ? { removalStamps: stamps } : {}),
      ...(spansBefore.length > 0 ? { removalSpans: spansBefore } : {}),
      includeChanged: false,
      ...(along.count > 0 ? { goesWithParent } : {}),
      ...(plans.bringBack.count > 0 || plans.giveBack.count > 0 ? { sweep } : {}),
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
  // Once the files and records they tie are back: the links the rewind
  // removed, inserted again, and the sharing it gave back given back.
  if (links && !outcome.stoppedForUndeletable && !signal?.aborted) {
    const create = org.create?.bind(org);
    for await (const page of links.reinsert.pages()) {
      if (!create) {
        linksDone.reinserted.refused += page.length;
        linksDone.reinserted.reasons.push(
          'The links the rewind removed could not be inserted again: this connection inserts no record.',
        );
        continue;
      }
      addWritten(
        linksDone.reinserted,
        await insertFileLinks({ create }, page, {
          after: async ({ made }) => {
            if (made.length > 0) {
              await journal.linksUndone(
                'reinserted',
                made.map((pair) => pair.from),
              );
            }
          },
          stopped: () => signal?.aborted === true,
        }),
      );
    }
    for await (const page of links.share.pages()) {
      addWritten(
        linksDone.shared,
        await shareFileLinks(
          org,
          // Every field it holds sent: what the rewind wrote is not kept,
          // and a value sent as the link holds it changes nothing.
          page.map((link) => ({ ...link, now: { ShareType: '', Visibility: '' } })),
          {
            after: async ({ done }) => {
              if (done.length > 0) {
                await journal.linksUndone(
                  'shared',
                  done.map((link) => link.Id),
                );
              }
            },
            stopped: () => signal?.aborted === true,
          },
        ),
      );
    }
  }
  const files: RewindFilesResult | undefined = links
    ? {
        unlinked: linksDone.removed.done,
        relinked: linksDone.reinserted.done,
        linksUpdated: linksDone.shared.done,
        linksRefused:
          linksDone.removed.refused + linksDone.reinserted.refused + linksDone.shared.refused,
      }
    : undefined;
  for (const reason of [
    ...linksDone.removed.reasons,
    ...linksDone.reinserted.reasons,
    ...linksDone.shared.reasons,
  ]) {
    if (!notes.includes(reason)) notes.push(`A link between a file and a record: ${reason}`);
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

  // What the removal left of what it was handed, read again a page at a
  // time; what went with its parent is counted deleted with it, and what
  // stayed with a parent the removal kept is the parent's to say, and the
  // next undo's to take with it.
  const removalLeft: string[] = [];
  const left = new RecordKeySet();
  /** Per object, the records made again the removal left. */
  const remadeLeft = new Map<string, number>();
  /** Per object, the records carried by a carrier the removal left. */
  const carriedLeft = new Map<string, number>();
  for await (const { objectApiName, ids } of outcome.left()) {
    for (const id of ids) {
      left.add(id);
      removalLeft.push(id);
      if (plans.remade.keys.has(id)) {
        remadeLeft.set(objectApiName, (remadeLeft.get(objectApiName) ?? 0) + 1);
      }
      if (plans.carriedAlone.keys.has(id)) {
        carriedLeft.set(objectApiName, (carriedLeft.get(objectApiName) ?? 0) + 1);
      }
    }
  }
  const remade = plans.remade.objects
    .map(({ objectApiName, count }) => ({
      objectApiName,
      count: count - (remadeLeft.get(objectApiName) ?? 0),
    }))
    .filter(({ count }) => count > 0);
  const carriedAlone = plans.carriedAlone.objects
    .map(({ objectApiName, count }) => ({
      objectApiName,
      count: count - (carriedLeft.get(objectApiName) ?? 0),
    }))
    .filter(({ count }) => count > 0);
  const wentAlong: ForgeUndoObjectResult[] = [];
  for (const { objectApiName } of along.objects) {
    let went = 0;
    for await (const page of along.pages(objectApiName)) {
      for (const { id, parent } of page) {
        if (left.has(parent)) removalLeft.push(id);
        else went++;
      }
    }
    if (went === 0) continue;
    wentAlong.push({
      objectApiName,
      planned: went,
      deleted: went,
      alreadyGone: 0,
      keptChanged: 0,
      keptDependents: 0,
      refused: 0,
      heldBy: [],
      unchecked: [],
      reasons: [],
    });
  }
  const removed = [...wentAlong, ...outcome.objects];
  let status = withUndelete(
    withRestore(removalStatus(removed, outcome.cancelled), removed, restored),
    removed,
    restored,
    undeleted,
  );
  let residual: UndoResidual[] = [];
  if (restored && status !== 'cancelled') {
    const notGiven = new RecordKeySet();
    for (const id of restored.left) notGiven.add(id);
    residual = await stillDiffering(org, plans, valuesBefore, notGiven, notes);
  }
  if (residual.length > 0 && status === 'success') status = 'partial';
  if ((files?.linksRefused ?? 0) > 0 && status === 'success') status = 'partial';

  // Kept whatever it ended on, cancelled included, as a Sync run's removal
  // keeps its own: what the next undo sets out to take back, what it wrote
  // to records it did not delete, and when it ran.
  const removalRan = plans.remove.spool.count > 0;
  const gaveBack =
    restored?.objects.some((object) => object.restored + (object.restoredWithout ?? 0) > 0) ===
    true;
  // What this undo's undeletes restamped is its own, for the next undo too.
  const undoStamps = { ...restamped, ...outcome.stamps };
  const change: SyncRunRemovalState = {
    ...(Object.keys(undoStamps).length > 0 ? { removalStamps: undoStamps } : {}),
    ...(outcome.span ? { removalSpans: [outcome.span] } : {}),
    ...(removalRan ? { removalLeft } : {}),
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
    deleted: removed,
    ...(remade.length > 0 ? { remade } : {}),
    ...(carriedAlone.length > 0 ? { carriedAlone } : {}),
    restored: restored?.objects ?? [],
    undeleted: undeleted?.objects ?? [],
    ...(files ? { files } : {}),
    residual,
    planned,
    notes,
    finishedAt,
  };
}
