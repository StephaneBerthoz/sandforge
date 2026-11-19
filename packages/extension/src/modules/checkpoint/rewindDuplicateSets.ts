/**
 * The duplicate record sets the org's duplicate rules made, since a
 * checkpoint, of the records a rewind deletes: part of what it takes back,
 * though no checkpoint holds one.
 *
 * A duplicate rule that alerts reports the records a save finds alike in a
 * set (`DuplicateRecordSet`), one item a record (`DuplicateRecordItem`), which
 * the org deletes with its record (`forge/duplicateRecordSets.ts`). A
 * checkpoint holds neither object — the platform's bookkeeping, which every
 * copy leaves out —, and a rewind read neither: run for real, an Autopilot
 * run's checkpoint first on a scratch org whose Contact rule alerts, the rule
 * made a set of two of the run's contacts as it wrote them; the rewind,
 * `--accept-outside` given, deleted the contacts and their items with them,
 * and the set stayed, empty, named by neither the run nor the rewind.
 *
 * A set is the rewind's when it was made after the checkpoint's end — made in
 * its second or before, it may have been in the org at the checkpoint — and
 * its items name records the rewind deletes, beside one other record at most,
 * which a record deleted was found alike to: once they go, it reports that
 * record alone, beside nothing. One that names two others or more still
 * reports them alike, and stays. One that holds no item any more is no one's
 * to tell: it stays.
 *
 * The preview names them beside what the deletions take along outside the
 * checkpoint, under the records they name, and keeps their ids in its folder:
 * the rewind takes no set its preview did not name. The pass that deletes
 * their records reads them again and takes them before those records, their
 * items with them, journaled as the records are: an undo brings them back
 * after the records, as it brings back last what it deleted that the
 * checkpoint does not hold.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RewindDiff } from '@sandforge/shared';
import {
  DUPLICATE_SET_OBJECT,
  duplicateSetsRead,
  type DuplicateSetRead,
} from '../forge/duplicateRecordSets.js';
import { idLists } from '../dataops/RecordRemoval.js';
import type { RunRecords } from '../forge/ForgeRunRemoval.js';
import { CHECKPOINT_FILE_MODE, makePrivateDir } from './OrgCheckpointStore.js';
import { spooledRows } from './orgStreams.js';
import { classFileOf } from './rewindDiff.js';
import { RecordKeySet } from './spooledRunRecords.js';

export { DUPLICATE_SET_OBJECT };

/** A record's report in a set, which the org deletes with the record. */
const ITEM_OBJECT = 'DuplicateRecordItem';

/** The grain the org dates a write to. */
const ORG_DATE_GRAIN_MS = 1_000;

/** The classes of the records a rewind deletes in its first pass, as the diff spools them. */
const DELETED_FIRST = ['createdSince', 'broughtBackSince'] as const;

/** The file of a preview's folder that keeps the ids of the sets it named, one a line. */
const CONFIRMED_FILE = 'duplicate-record-sets.ids';

/** A record's key: the first fifteen characters of its id. */
function keyOf(id: string): string {
  return id.slice(0, 15);
}

/** The org, as far as the sets are read from it. */
export interface SetsOrg {
  query(soql: string): Promise<{ records: unknown[] }>;
}

/**
 * The sets of the records `deleting` holds, as the module's comment tells
 * them, read now: none when the org would not say, or when a read filled its
 * limit.
 *
 * @param span - The checkpoint's end (T1), and the read the rewind acts on (Tr).
 */
export async function rewindDuplicateSets(
  org: SetsOrg,
  deleting: { has(key: string): boolean },
  span: { takenAt: string; readAt: string },
): Promise<DuplicateSetRead[]> {
  const t1 = Date.parse(span.takenAt);
  const tr = Date.parse(span.readAt);
  if (!Number.isFinite(t1) || !Number.isFinite(tr)) return [];
  const madeFrom = (Math.floor(t1 / ORG_DATE_GRAIN_MS) + 1) * ORG_DATE_GRAIN_MS;
  return duplicateSetsRead(org, {
    has: (key) => deleting.has(key),
    start: madeFrom,
    end: tr,
    madeFrom,
  });
}

/**
 * Read the sets of the records the preview found to delete, name them in
 * `diff` beside what goes along outside the checkpoint — per object, the sets
 * that name its records and the records of it they name — and keep their ids
 * in the preview's folder, for the rewind that acts on it.
 *
 * A set names a record through an item, made with the set: read only of the
 * objects under whose records to delete the diff found items created since
 * ({@link ITEM_OBJECT}). Of the others, nothing is asked of the org.
 *
 * @returns How many sets it named.
 */
export async function nameDuplicateSets(
  org: SetsOrg,
  diff: Pick<RewindDiff, 'objects' | 'readAt'>,
  previewDir: string,
  takenAt: string,
): Promise<number> {
  const keys = new Map<string, RecordKeySet>();
  for (const object of diff.objects) {
    if (object.toDelete.createdSince + object.toDelete.broughtBackSince === 0) continue;
    if (!object.outside.some(({ objectApiName }) => objectApiName === ITEM_OBJECT)) continue;
    const held = new RecordKeySet();
    for (const cls of DELETED_FIRST) {
      if (object.toDelete[cls] === 0) continue;
      for await (const row of spooledRows(classFileOf(previewDir, object.objectApiName, cls))) {
        if (typeof row.Id === 'string') held.add(row.Id);
      }
    }
    if (held.size > 0) keys.set(object.objectApiName, held);
  }
  if (keys.size === 0) return 0;
  const sets = await rewindDuplicateSets(
    org,
    { has: (key) => [...keys.values()].some((held) => held.has(key)) },
    { takenAt, readAt: diff.readAt },
  );
  if (sets.length === 0) return 0;
  for (const object of diff.objects) {
    const held = keys.get(object.objectApiName);
    if (!held) continue;
    const of = sets.filter((set) => set.names.some((key) => held.has(key)));
    if (of.length === 0) continue;
    const parents = new Set(of.flatMap((set) => set.names.filter((key) => held.has(key))));
    object.outside = [
      ...object.outside.filter(({ objectApiName }) => objectApiName !== DUPLICATE_SET_OBJECT),
      { objectApiName: DUPLICATE_SET_OBJECT, count: of.length, parents: parents.size },
    ].sort((a, b) => (a.objectApiName < b.objectApiName ? -1 : 1));
  }
  await makePrivateDir(previewDir);
  await writeFile(join(previewDir, CONFIRMED_FILE), sets.map((set) => `${set.id}\n`).join(''), {
    encoding: 'utf8',
    mode: CHECKPOINT_FILE_MODE,
  });
  return sets.length;
}

/** How many sets `diff` names beside what goes along outside the checkpoint, its objects together. */
export function setsNamed(diff: Pick<RewindDiff, 'objects'>): number {
  return diff.objects.reduce(
    (sum, object) =>
      sum +
      object.outside
        .filter(({ objectApiName }) => objectApiName === DUPLICATE_SET_OBJECT)
        .reduce((of, { count }) => of + count, 0),
    0,
  );
}

/**
 * The keys of the sets a preview named ({@link nameDuplicateSets}): none for
 * a preview that named none, or made before sets were named.
 */
export async function confirmedDuplicateSets(previewDir: string): Promise<ReadonlySet<string>> {
  let text: string;
  try {
    text = await readFile(join(previewDir, CONFIRMED_FILE), 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Set();
    throw err;
  }
  return new Set(
    text
      .split('\n')
      .filter((line) => /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/.test(line))
      .map(keyOf),
  );
}

/**
 * Of the sets `keys` names, by their keys, those still in the org, and how
 * many items each still holds: what a rewind that did not take them says of
 * them. A read that fails finds none, said by its caller.
 *
 * @throws When the org would not read them.
 */
export async function setsLeftOf(
  org: SetsOrg,
  keys: readonly string[],
): Promise<Array<{ id: string; items: number }>> {
  const left = new Map<string, { id: string; items: number }>();
  for (const list of idLists([...keys])) {
    const { records } = await org.query(
      `SELECT Id FROM ${DUPLICATE_SET_OBJECT} WHERE Id IN (${list})`,
    );
    for (const row of records as Array<{ Id?: unknown }>) {
      if (typeof row.Id === 'string') left.set(keyOf(row.Id), { id: row.Id, items: 0 });
    }
  }
  for (const list of idLists([...left.values()].map((set) => set.id))) {
    const { records } = await org.query(
      `SELECT DuplicateRecordSetId FROM ${ITEM_OBJECT} WHERE DuplicateRecordSetId IN (${list})`,
    );
    for (const row of records as Array<{ DuplicateRecordSetId?: unknown }>) {
      const set =
        typeof row.DuplicateRecordSetId === 'string'
          ? left.get(keyOf(row.DuplicateRecordSetId))
          : undefined;
      if (set) set.items++;
    }
  }
  return [...left.values()];
}

/**
 * `records` with the sets `ids` before them: a removal goes in the order it
 * is handed objects that hang from none of the others (`removalOrder`), so
 * the sets go first, their items with them.
 */
export function withDuplicateSets(records: RunRecords, ids: readonly string[]): RunRecords {
  if (ids.length === 0) return records;
  const sets = new Set(ids.map(keyOf));
  return {
    objects: [{ objectApiName: DUPLICATE_SET_OBJECT, count: ids.length }, ...records.objects],
    pages: (objectApiName) =>
      objectApiName === DUPLICATE_SET_OBJECT
        ? (async function* () {
            yield [...ids];
          })()
        : records.pages(objectApiName),
    has: (key) => sets.has(keyOf(key)) || records.has(key),
  };
}
