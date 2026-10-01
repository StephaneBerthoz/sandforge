import type { ForgeExecutionResult, ForgeUndoMark } from '../types/forge.types.js';

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

/**
 * The records a run linked to that removing its records leaves where they are,
 * by source id: those `idRemapExisting` names, less the contacts the platform
 * wrote with a person account the run created (`idRemapWithTheirAccount`),
 * which the platform deletes with that account. Counted as kept, a removal's
 * confirmation said they stayed in the org, though they went with their
 * accounts.
 *
 * @param entry - A run's history entry.
 */
export function forgeRunLinkedKept(
  entry: Pick<ForgeExecutionResult, 'idRemapExisting' | 'idRemapWithTheirAccount'>,
): string[] {
  const existing = Array.isArray(entry.idRemapExisting) ? entry.idRemapExisting : [];
  const withTheirAccount = new Set(
    Array.isArray(entry.idRemapWithTheirAccount) ? entry.idRemapWithTheirAccount : [],
  );
  return existing.filter((sourceId) => !withTheirAccount.has(sourceId));
}

/**
 * Whether the removals of a run's records — a Forge run's, a Frozen load's —
 * are through: the last one that marked it left none of them in the org.
 * One that kept some, changed since or held by records that stay, had some
 * refused, or was cancelled before it reached them all, leaves them for a
 * removal of what is left.
 *
 * @param mark - What the run keeps of its removals; undefined before one marked it.
 */
export function removalTookAll(mark: ForgeUndoMark | undefined): boolean {
  return mark !== undefined && mark.kept + mark.refused + (mark.notReached ?? 0) === 0;
}

/**
 * What a removal of a run's records takes now: the records it created, as
 * {@link forgeRunCreatedRecords} reads them, that its removals have not taken
 * — in the same order — and nothing once one of them took all that was left.
 *
 * A removal that ended partial marked the run, and the next one was refused
 * as a removal done already: nothing in the product could take what it left,
 * and a person deleted it by hand. An entry kept before removals recorded
 * what they left names what the run created: the removal finds the rest gone.
 *
 * @param entry - A run's history entry.
 */
export function forgeRunRecordsLeft(
  entry: Pick<
    ForgeExecutionResult,
    'idRemapTable' | 'idRemapExisting' | 'idRemapCreated' | 'undo' | 'removalLeft'
  >,
): ForgeRunObjectRecords[] {
  if (removalTookAll(entry.undo)) return [];
  const created = forgeRunCreatedRecords(entry);
  if (!Array.isArray(entry.removalLeft)) return created;
  const left = new Set(
    entry.removalLeft.filter((id): id is string => typeof id === 'string').map(recordKey),
  );
  return created.flatMap(({ objectApiName, ids }) => {
    const still = ids.filter((id) => left.has(recordKey(id)));
    return still.length > 0 ? [{ objectApiName, ids: still }] : [];
  });
}
