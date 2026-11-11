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
 *
 * A user the target holds may still be one it holds inactive. Run for real
 * across the whole org, from a production to a sandbox of it, every
 * `Aeroport__c` and `Paiement__c` the source's "Admin Salesforce" owned was
 * refused for that owner — the user was inactive in the sandbox — and every
 * record under them after them, for want of their parent. The same read of
 * the users says so, `IsActive` asked with the id when the run says it wants
 * to know (`TargetHoldsQuestion.inactive`); whether the user the run writes as
 * may give a record an inactive owner is read once, the first time a row
 * names one (`writesInactiveOwnersOnce`).
 */

import { assertSoqlIdentifier } from '../../../core/common/soqlValidator.js';
import { idLists } from '../../dataops/RecordRemoval.js';
import { isNeverCopied } from '../excludedObjects.js';

/** The object of the target's users: the one asked whether a record is active. */
const USER = 'User';

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
  /**
   * The users the target holds inactive, of the ids asked, filled here: each
   * as the row carried it and as the target answered it, in 18 characters and
   * in 15. Passed, a user is asked with its `IsActive`; absent — Seed's Clone
   * from Org — the statement is as it always was. An inactive user is a user
   * the target holds: it is never among the ids the target lacks, and the
   * caller decides what a row it owns becomes (`inactiveOwnersOf`).
   *
   * The caller passes it on every call of a run, or on none: an id `known`
   * answers for is not asked again, and one asked without `IsActive` would
   * never be found inactive.
   */
  readonly inactive?: Set<string>;
  /** A read of the target. */
  readonly query: (soql: string) => Promise<readonly Record<string, unknown>[]>;
  /**
   * Whether no clone of the run creates records of an object: by default
   * {@link isNeverCopied}. A clone of the whole org writes the objects of a
   * managed package that list leaves out by their namespace — its graph
   * holds them as nodes — and says so here: a lookup at one of them names a
   * record the run writes, which the target is not asked about.
   */
  readonly neverCopied?: (objectApiName: string) => boolean;
}

/**
 * Whether {@link idsTheTargetLacks} asks about a lookup: one whose every object
 * no clone creates, or whose one object is outside the run. Never the record
 * type, which a run maps or keeps as read.
 */
function isAskedOfTheTarget(
  lookup: TargetHeldLookup,
  outsideTheRun?: (objectApiName: string) => boolean,
  neverCopied: (objectApiName: string) => boolean = isNeverCopied,
): boolean {
  const targets = lookup.referenceTo ?? [];
  if (lookup.name === 'RecordTypeId' || targets.length === 0) return false;
  if (targets.every((target) => neverCopied(target))) return true;
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
  const { known, ownerMappings = {}, mapped, refused, inactive } = question;
  const lookups = question.lookups.filter((lookup) =>
    isAskedOfTheTarget(lookup, question.outsideTheRun, question.neverCopied),
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
  /** Of the users found, those the target holds inactive, in 18 characters and in 15. */
  const foundInactive = new Set<string>();
  for (const [object, ids] of toAsk) {
    // Only a user is asked whether it is active: a queue never is inactive,
    // and `Group` has no such field, which would have the read refused.
    const asksActive = inactive !== undefined && object === USER;
    const fields = asksActive ? 'Id, IsActive' : 'Id';
    for (const list of idLists([...ids])) {
      try {
        const held = await question.query(
          `SELECT ${fields} FROM ${assertSoqlIdentifier(object)} WHERE Id IN (${list})`,
        );
        for (const record of held) {
          const id = record['Id'];
          if (typeof id === 'string') {
            found.add(id);
            found.add(id.slice(0, 15));
            // Exactly false: a user the answer says nothing of is taken for
            // an active one, as every user was before the field was asked.
            if (asksActive && record['IsActive'] === false) {
              foundInactive.add(id);
              foundInactive.add(id.slice(0, 15));
            }
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
  // The users found inactive are kept whether `known` is full or not: past
  // its bound an id is asked again, and found inactive again. Kept as the
  // target answered them and as the rows carry them, which is what a row is
  // looked up by. Bounded on their own, by the users of an org a run names.
  if (inactive && foundInactive.size > 0) {
    const askedUsers = [...(toAsk.get(USER) ?? [])].filter(
      (id) => foundInactive.has(id) || foundInactive.has(id.slice(0, 15)),
    );
    for (const id of [...foundInactive, ...askedUsers]) {
      if (inactive.size >= KNOWN_IDS_BOUND) break;
      inactive.add(id);
    }
  }
  const lacking = new Set<string>();
  for (const id of carried) if ((answered.get(id) ?? known.get(id)) === false) lacking.add(id);
  return lacking;
}

/**
 * The owners `rows` name that the target holds inactive (`inactive`, which
 * {@link idsTheTargetLacks} fills), as the rows carry them: what a row goes
 * without when the user the run writes as may not give a record an inactive
 * owner. An owner mapped to a user of the target is not among them — the
 * mapping comes first — nor an owner the target holds active.
 */
export function inactiveOwnersOf(
  rows: readonly Record<string, unknown>[],
  inactive: ReadonlySet<string>,
  ownerMappings: Readonly<Record<string, string>> = {},
): Set<string> {
  const owners = new Set<string>();
  if (inactive.size === 0) return owners;
  for (const row of rows) {
    const owner = row['OwnerId'];
    if (typeof owner !== 'string' || !owner) continue;
    if (ownerMappings[owner] !== undefined) continue;
    if (inactive.has(owner)) owners.add(owner);
  }
  return owners;
}

/** Reads the target with SOQL: every row a statement returns. */
export type TargetRowsQuery = (soql: string) => Promise<readonly Record<string, unknown>[]>;

/** What {@link writesInactiveOwners} asks the target. */
export const INACTIVE_OWNER_PERMISSION_SOQL =
  'SELECT PermissionsUpdateWithInactiveOwner FROM UserPermissionAccess';

/**
 * Whether the user a connection runs as may give a record an inactive owner:
 * the Update Records with Inactive Owners permission, read from
 * `UserPermissionAccess`, which answers for the running user. An org that
 * will not say is taken for one where it may not: the field does not exist
 * while the org's setting is off (INVALID_FIELD), and a read refused or lost
 * says nothing either. Taken so, the row goes with the user the run writes as
 * for owner — a record given to another than its owner, said among the run's
 * notes — where taken the other way it was refused, and the records under it
 * with it.
 */
export async function writesInactiveOwners(query: TargetRowsQuery): Promise<boolean> {
  try {
    const [row] = await query(INACTIVE_OWNER_PERMISSION_SOQL);
    return row?.['PermissionsUpdateWithInactiveOwner'] === true;
  } catch {
    return false;
  }
}

/**
 * {@link writesInactiveOwners}, asked once, the first time a row names an
 * owner the target holds inactive, and answered from then on without asking
 * again. Asked then and not when the run begins, it sees the permission sets
 * a run that mutes the target's automation assigned once its write gate let
 * the rows through; and a run whose owners are all active never asks.
 */
export function writesInactiveOwnersOnce(query: TargetRowsQuery): () => Promise<boolean> {
  let asked: Promise<boolean> | undefined;
  return () => {
    asked ??= writesInactiveOwners(query);
    return asked;
  };
}
