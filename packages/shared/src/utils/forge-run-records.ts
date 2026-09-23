import type { ForgeExecutionResult } from '../types/forge.types.js';

/** A Salesforce record id: 15 or 18 letters and digits. */
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** An object API name, as a query can name it. */
const OBJECT_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** The records of one object a Forge run created, by their ids in its target org. */
export interface ForgeRunObjectRecords {
  /** API name of the object. */
  objectApiName: string;
  /** Target record ids, the last one written first. */
  ids: string[];
}

/** A record by its first fifteen characters: the same record, whichever length its id was written in. */
function recordKey(id: string): string {
  return id.slice(0, 15);
}

/**
 * What removing a run's records takes from its target org: per object, the
 * ids of the records the run created, the objects in the order they are to be
 * removed — children before their parents, the reverse of the order the run
 * wrote them — and within an object the last record written first.
 *
 * Created means a row `idRemapCreated` names. A record any row of
 * `idRemapExisting` points at — one the target already held, linked to rather
 * than written — is never the run's to remove, whichever row names it. A row
 * whose target is not a record id, and an object whose name could not be
 * queried, are left out: the entry comes back from storage.
 *
 * Shared by the panel that asks for a removal and the extension that runs it,
 * so the counts a confirmation names are the ones the removal sets out to
 * delete.
 *
 * @param entry - A run's history entry.
 * @returns Nothing for an entry recorded before runs kept what they created.
 */
export function forgeRunCreatedRecords(
  entry: Pick<ForgeExecutionResult, 'idRemapTable' | 'idRemapExisting' | 'idRemapCreated'>,
): ForgeRunObjectRecords[] {
  const table = entry.idRemapTable ?? {};
  const targetOf = (sourceId: string): string | undefined => {
    const id = Object.prototype.hasOwnProperty.call(table, sourceId) ? table[sourceId] : undefined;
    return typeof id === 'string' && RECORD_ID.test(id) ? id : undefined;
  };
  const linkedTargets = new Set<string>();
  for (const sourceId of Array.isArray(entry.idRemapExisting) ? entry.idRemapExisting : []) {
    const target = targetOf(sourceId);
    if (target) linkedTargets.add(recordKey(target));
  }

  const created = Array.isArray(entry.idRemapCreated) ? entry.idRemapCreated : [];
  const taken = new Set<string>();
  const objects: ForgeRunObjectRecords[] = [];
  for (const { objectApiName, sourceIds } of [...created].reverse()) {
    if (!OBJECT_NAME.test(objectApiName) || !Array.isArray(sourceIds)) continue;
    const ids: string[] = [];
    for (const sourceId of [...sourceIds].reverse()) {
      const target = targetOf(sourceId);
      if (!target) continue;
      const key = recordKey(target);
      if (linkedTargets.has(key) || taken.has(key)) continue;
      taken.add(key);
      ids.push(target);
    }
    if (ids.length > 0) objects.push({ objectApiName, ids });
  }
  return objects;
}
