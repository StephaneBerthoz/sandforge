/**
 * The users and queues a copy's rows name that the target holds no record of.
 *
 * A copy carries a lookup at an object no clone creates — a user, a queue — as
 * the source holds it, which two sandboxes of one production share. Between
 * two orgs that do not share their users — two scratch orgs, a Developer
 * Edition and a sandbox — the target refused every row with
 * INVALID_CROSS_REFERENCE_KEY on its owner. Each id is asked of the target
 * once a run, of every object its lookup can name; the row then goes without
 * the lookup, which the platform fills — the owner with the user the copy
 * writes as. Forge's runs of whole tables and Seed's Clone from Org ask so.
 */

import { assertSoqlIdentifier } from '../../../core/common/soqlValidator.js';
import { idLists } from '../../dataops/RecordRemoval.js';
import { isNeverCopied } from '../excludedObjects.js';

/** A Salesforce id, 15 or 18 characters: what goes into the statement that asks for it. */
const SALESFORCE_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** A lookup of the object the rows are of, with the objects it can name. */
export interface TargetHeldLookup {
  readonly name: string;
  readonly referenceTo?: readonly string[];
}

/** What {@link idsTheTargetLacks} asks about. */
export interface TargetHoldsQuestion {
  /**
   * The lookups the write sends. Only those whose every object no clone
   * creates are asked about; the record type, which a run maps or keeps
   * as read, never is.
   */
  readonly lookups: readonly TargetHeldLookup[];
  /** The rows about to be written, as the write sends them. */
  readonly rows: readonly Record<string, unknown>[];
  /** Owners mapped to a user of the target, by source id: not asked about. */
  readonly ownerMappings?: Readonly<Record<string, string>>;
  /** Per id, whether the target holds a record of it: what earlier calls of the run found, filled here. */
  readonly known: Map<string, boolean>;
  /** A read of the target. */
  readonly query: (soql: string) => Promise<readonly Record<string, unknown>[]>;
}

/**
 * Of the ids `rows` carry in a lookup at an object no clone creates, those
 * the target holds no record of — every one the run has found so far. An id
 * the target could not be asked about, a query refused, is not among them:
 * it is carried as before.
 */
export async function idsTheTargetLacks(
  question: TargetHoldsQuestion,
): Promise<ReadonlySet<string>> {
  const { known, ownerMappings = {} } = question;
  const lookups = question.lookups.filter(
    (lookup) =>
      lookup.name !== 'RecordTypeId' &&
      (lookup.referenceTo ?? []).length > 0 &&
      (lookup.referenceTo ?? []).every((target) => isNeverCopied(target)),
  );
  /** Per object asked, the ids not yet asked about. */
  const toAsk = new Map<string, Set<string>>();
  for (const lookup of lookups) {
    for (const row of question.rows) {
      const id = row[lookup.name];
      if (typeof id !== 'string' || !SALESFORCE_ID.test(id) || known.has(id)) continue;
      if (lookup.name === 'OwnerId' && ownerMappings[id] !== undefined) continue;
      for (const object of lookup.referenceTo ?? []) {
        toAsk.set(object, (toAsk.get(object) ?? new Set<string>()).add(id));
      }
    }
  }
  /** Ids found in an object asked, and ids a query of an object could not settle. */
  const found = new Set<string>();
  const unsettled = new Set<string>();
  for (const [object, ids] of toAsk) {
    for (const list of idLists([...ids])) {
      try {
        const held = await question.query(
          `SELECT Id FROM ${assertSoqlIdentifier(object)} WHERE Id IN (${list})`,
        );
        for (const record of held) {
          const id = record['Id'];
          if (typeof id === 'string') {
            found.add(id);
            found.add(id.slice(0, 15));
          }
        }
      } catch {
        for (const id of ids) unsettled.add(id);
      }
    }
  }
  for (const ids of toAsk.values()) {
    for (const id of ids) {
      if (found.has(id) || found.has(id.slice(0, 15))) known.set(id, true);
      else if (!unsettled.has(id)) known.set(id, false);
    }
  }
  const lacking = new Set<string>();
  for (const [id, held] of known) if (!held) lacking.add(id);
  return lacking;
}
