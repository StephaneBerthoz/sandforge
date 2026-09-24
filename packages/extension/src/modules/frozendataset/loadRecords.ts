/**
 * The records of a Frozen load, read from its mapping: what removing the load
 * takes from its target, and what it leaves there — and which of the loads
 * the mapping records a removal takes next.
 *
 * The removal is Forge's (`removeRunRecords`), and so is the shape of its
 * plan. A clone keeps its records in its history entry; a load keeps them in
 * the sas mapping, which says which of them it created.
 */

import type { ForgeRunObjectRecords, FrozenLoadRecordsInfo } from '@sandforge/shared';
import type { RecordedLoad } from './SasReferenceIdMappingStore.js';

/** A Salesforce record id: 15 or 18 letters and digits. */
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** An object API name, as a query can name it. */
const OBJECT_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** A record by its first fifteen characters: the same record, whichever length its id is written in. */
function recordKey(id: string): string {
  return id.slice(0, 15);
}

/** The target id a key names, when it is a record id. */
function targetOf(load: Pick<RecordedLoad, 'mapping'>, key: string): string | undefined {
  const id = load.mapping.get(key);
  return typeof id === 'string' && RECORD_ID.test(id) ? id : undefined;
}

/**
 * The records the load linked to or reused, by their keys: every record a
 * key the mapping does not list among the load's creations names.
 */
function linkedRecords(load: Pick<RecordedLoad, 'mapping' | 'created'>): Set<string> {
  const created = new Set((load.created ?? []).flatMap((object) => object.referenceIds));
  const linked = new Set<string>();
  for (const key of load.mapping.keys()) {
    if (created.has(key)) continue;
    const target = targetOf(load, key);
    if (target) linked.add(recordKey(target));
  }
  return linked;
}

/**
 * What removing a load's records takes from its target: per object, the ids
 * of the records the load created, the objects in the reverse of the order it
 * wrote them — children before their parents, as far as the load knew — and
 * within an object the last record written first.
 *
 * Created means a key the mapping lists among the load's creations: a record
 * it inserted, a technical placeholder, or — for a reload — a record an
 * earlier load created that the reload found again and kept. A record any
 * other key names — the standard price book, a selling model the target held,
 * a record a reload found by its identity keys that no load created — is
 * never the load's to remove, whichever key names it. A key the mapping no
 * longer holds, an id that is not a record id and an object whose name could
 * not be queried are left out: the file comes back from disk. An object named
 * twice is taken once, its records together.
 *
 * @returns Nothing for a mapping written before loads kept what they created.
 */
export function loadCreatedRecords(
  load: Pick<RecordedLoad, 'mapping' | 'created'>,
): ForgeRunObjectRecords[] {
  const linked = linkedRecords(load);
  const byObject = new Map<string, string[]>();
  for (const { objectApiName, referenceIds } of load.created ?? []) {
    if (!OBJECT_NAME.test(objectApiName)) continue;
    byObject.set(objectApiName, [...(byObject.get(objectApiName) ?? []), ...referenceIds]);
  }

  const taken = new Set<string>();
  const objects: ForgeRunObjectRecords[] = [];
  for (const [objectApiName, keys] of [...byObject].reverse()) {
    const ids: string[] = [];
    for (const key of [...keys].reverse()) {
      const target = targetOf(load, key);
      if (!target) continue;
      const record = recordKey(target);
      if (linked.has(record) || taken.has(record)) continue;
      taken.add(record);
      ids.push(target);
    }
    if (ids.length > 0) objects.push({ objectApiName, ids });
  }
  return objects;
}

/**
 * The load a removal takes next, of the loads a mapping records, the last one
 * first: the newest whose created records are still to take and that no
 * removal marked. A load's records can only depend on those of the loads
 * before it, so the newest goes first. With none left to take, the last load,
 * for the page to say why.
 *
 * @returns Undefined when no load wrote a mapping yet.
 */
export function loadToRemove(loads: readonly RecordedLoad[]): RecordedLoad | undefined {
  return loads.find((load) => !load.removal && loadCreatedRecords(load).length > 0) ?? loads[0];
}

/**
 * What the page says of a load's records: counts only, the ids staying in
 * the sas.
 */
export function loadRecordsInfo(load: RecordedLoad): FrozenLoadRecordsInfo {
  const recorded = load.created !== undefined;
  return {
    orgId: load.orgId,
    loadedAt: load.endedAt,
    created: loadCreatedRecords(load).map(({ objectApiName, ids }) => ({
      objectApiName,
      count: ids.length,
    })),
    // Unrecorded, every record reads as linked: nothing says which it created.
    linked: recorded ? linkedRecords(load).size : 0,
    recorded,
    ...(load.removal ? { removed: load.removal } : {}),
    ...(load.earlier ? { earlier: true as const } : {}),
  };
}
