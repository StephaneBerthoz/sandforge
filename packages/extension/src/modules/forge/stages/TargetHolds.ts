/**
 * The users and queues a copy's rows name that the target holds no record of,
 * and the records outside the run it holds none of.
 *
 * A copy carries a lookup at an object no clone creates — a user, a queue — as
 * the source holds it, which two sandboxes of one production share. Between
 * two orgs that do not share their users — two scratch orgs, a Developer
 * Edition and a sandbox — the target refused every row with
 * INVALID_CROSS_REFERENCE_KEY on its owner. Each id is asked of the target
 * once a run, of every object its lookup can name; the row then goes without
 * the lookup, which the platform fills — the owner with the user the copy
 * writes as. Forge's runs of whole tables and Seed's Clone from Org ask so.
 *
 * A run of whole tables carries as read, too, a lookup at an object it does
 * not write (`outsideTheRun`): the account of a table of contacts copied
 * alone. Run for real between two unrelated orgs, a simulation said both
 * contacts would be inserted, and the run had both refused with
 * INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY on `AccountId`: the source's
 * account id named nothing in the target. Such an id is asked of the target
 * as well, `Id IN` the object's ids a statement, and the run decides what a
 * row naming one the target lacks becomes.
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
   * The lookups the write sends. Only those {@link isAskedOfTheTarget} names
   * are asked about; the record type, which a run maps or keeps as read,
   * never is.
   */
  readonly lookups: readonly TargetHeldLookup[];
  /** The rows about to be written, as the write sends them. */
  readonly rows: readonly Record<string, unknown>[];
  /** Owners mapped to a user of the target, by source id: not asked about. */
  readonly ownerMappings?: Readonly<Record<string, string>>;
  /**
   * Whether the run neither writes nor links to records of an object a clone
   * can create: a lookup whose one object is such an object is asked about
   * too. One that can name several is not: a task's `WhatId` names any of
   * hundreds, and no read could ask each id of every one. Absent, only the
   * lookups at objects no clone creates are asked about.
   */
  readonly outsideTheRun?: (objectApiName: string) => boolean;
  /** Whether the run has a counterpart in the target for a source id: not asked about. */
  readonly mapped?: (sourceId: string) => boolean;
  /** Per id, whether the target holds a record of it: what earlier calls of the run found, filled here. */
  readonly known: Map<string, boolean>;
  /**
   * Objects the target refused a read of earlier in the run, filled here:
   * not asked again, their ids carried as before. Asked again, a table read
   * a page at a time sent a refused read for every page.
   */
  readonly refused?: Set<string>;
  /** A read of the target. */
  readonly query: (soql: string) => Promise<readonly Record<string, unknown>[]>;
}

/**
 * Whether {@link idsTheTargetLacks} asks about a lookup: one whose every object
 * no clone creates, or whose one object is outside the run. Never the record
 * type, which a run maps or keeps as read.
 */
function isAskedOfTheTarget(
  lookup: TargetHeldLookup,
  outsideTheRun?: (objectApiName: string) => boolean,
): boolean {
  const targets = lookup.referenceTo ?? [];
  if (lookup.name === 'RecordTypeId' || targets.length === 0) return false;
  if (targets.every((target) => isNeverCopied(target))) return true;
  return targets.length === 1 && outsideTheRun?.(targets[0]) === true;
}

/**
 * The most ids a run keeps the target's answer for (`TargetHoldsQuestion.known`),
 * some ten megabytes: past it, an id is asked again on each page that names
 * it. Every id kept, a table of a million contacts naming as many accounts
 * outside the run would keep a million answers, where a run read page by page
 * holds a page of rows.
 */
export const KNOWN_IDS_BOUND = 100_000;

/**
 * Of the ids `rows` carry in a lookup at an object no clone creates, or at
 * the one object outside the run it names, those the target holds no record
 * of. An id the target could not be asked about, a query refused, is not
 * among them: it is carried as before.
 */
export async function idsTheTargetLacks(
  question: TargetHoldsQuestion,
): Promise<ReadonlySet<string>> {
  const { known, ownerMappings = {}, mapped, refused } = question;
  const lookups = question.lookups.filter((lookup) =>
    isAskedOfTheTarget(lookup, question.outsideTheRun),
  );
  /** Per object asked, the ids not yet asked about. */
  const toAsk = new Map<string, Set<string>>();
  /** The ids of the rows the answer is about: asked now, or known from earlier. */
  const carried = new Set<string>();
  for (const lookup of lookups) {
    for (const row of question.rows) {
      const id = row[lookup.name];
      if (typeof id !== 'string' || !SALESFORCE_ID.test(id)) continue;
      if (lookup.name === 'OwnerId' && ownerMappings[id] !== undefined) continue;
      if (mapped?.(id) === true) continue;
      carried.add(id);
      if (known.has(id)) continue;
      const objects = lookup.referenceTo ?? [];
      // An object the target refused a read of cannot say it lacks the id.
      if (objects.some((object) => refused?.has(object) === true)) continue;
      for (const object of objects) {
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
        refused?.add(object);
        break;
      }
    }
  }
  /** What this call's reads settled, kept for the run while the bound allows. */
  const answered = new Map<string, boolean>();
  for (const ids of toAsk.values()) {
    for (const id of ids) {
      if (found.has(id) || found.has(id.slice(0, 15))) answered.set(id, true);
      else if (!unsettled.has(id) && !answered.has(id)) answered.set(id, false);
    }
  }
  for (const [id, held] of answered) {
    if (known.size >= KNOWN_IDS_BOUND) break;
    known.set(id, held);
  }
  const lacking = new Set<string>();
  for (const id of carried) if ((answered.get(id) ?? known.get(id)) === false) lacking.add(id);
  return lacking;
}
