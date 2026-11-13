/**
 * The duplicate record sets the target's duplicate rules made as a run wrote:
 * part of the run, though its id map never held them.
 *
 * A duplicate rule that only alerts reports the records a save finds alike
 * in a set (`DuplicateRecordSet`), one item per record (`DuplicateRecordItem`,
 * which the org deletes with its record). Run for real on a scratch org whose
 * Lead and Contact rules alert, a clone of the whole org had them make two
 * sets of its own records; the removal deleted every record and their items
 * with them, and the two sets stayed, empty (`RecordCount` 0), seen by no
 * removal and no sweep.
 *
 * A set is the run's when the run's user created it while the run wrote —
 * from {@link TIE_LEAD_MS} before its first write to {@link MADE_WITHIN_MS}
 * after its last, the platform writing it a moment after the save — and every
 * item it still holds names a record of the run: one holding a record that is
 * not the run's is that record's report too, and stays. A set the org already
 * held, into which the run's records were reported, stays whatever it holds.
 *
 * A sweep takes, by the same rule, the sets made with the records it takes
 * (`ForgeRunSweep`): the run's records and its own together, at least one of
 * its own among them. Left, a set reporting a contact the target's
 * automation made with an account of the run stayed once the sweep had taken
 * the contact and the removal the account: neither read it as its own.
 */

import { idLists } from '../dataops/RecordRemoval.js';
import type { PlatformCopy } from './quoteSyncCopies.js';
import { MADE_WITHIN_MS, TIE_LEAD_MS } from './sweepTies.js';

/** The object of a duplicate rule's report, and of its items. */
export const DUPLICATE_SET_OBJECT = 'DuplicateRecordSet';
const DUPLICATE_ITEM_OBJECT = 'DuplicateRecordItem';

/**
 * Rows one read takes. A read that fills it may hold more than it read, and
 * no set is told from it.
 */
const READ_LIMIT = 2_000;

/** A Salesforce id, as a query takes one. */
const SF_ID_RE = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** A record by its first fifteen characters. */
function recordKey(id: string): string {
  return id.slice(0, 15);
}

/** A date as SOQL writes one, to the second. */
function soqlDate(epoch: number): string {
  return new Date(epoch).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function epochOf(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}

/** What {@link duplicateSetsOf} tells the run's sets by. */
export interface DuplicateSetsRun {
  /** Whether a record, by key, is one the removal takes. */
  has(key: string): boolean;
  /** The run's span, by the org's clock. */
  start: number;
  end: number;
  /** The user the run wrote as, by id. */
  user: string;
}

/** A set of the run, as read: when it was made and last modified, and by whom. */
export interface DuplicateSetRead {
  id: string;
  created: number;
  modified: number;
  modifiedBy?: string;
  /** The records its items still name, by their first fifteen characters. */
  names: string[];
}

/**
 * The sets the target's duplicate rules made for the run's records: see the
 * module's comment. A read that fails, or fills its limit, tells none.
 */
export async function duplicateSetsOf(
  org: { query(soql: string): Promise<{ records: unknown[] }> },
  run: DuplicateSetsRun,
): Promise<PlatformCopy[]> {
  return (await duplicateSetsRead(org, run)).map((set) => ({
    id: set.id,
    modified: modifiedOf(set, run),
  }));
}

/**
 * The same sets, each with what tells it the run's: when it was made and
 * last modified, by whom, and the records its items still name.
 */
export async function duplicateSetsRead(
  org: { query(soql: string): Promise<{ records: unknown[] }> },
  run: DuplicateSetsRun,
): Promise<DuplicateSetRead[]> {
  if (!Number.isFinite(run.start) || !Number.isFinite(run.end) || !SF_ID_RE.test(run.user)) {
    return [];
  }
  let sets: Array<Record<string, unknown>>;
  try {
    const answer = await org.query(
      `SELECT Id, CreatedDate, LastModifiedDate, LastModifiedById FROM ${DUPLICATE_SET_OBJECT} ` +
        `WHERE CreatedById = '${run.user}' ` +
        `AND CreatedDate >= ${soqlDate(run.start - TIE_LEAD_MS)} ` +
        `AND CreatedDate <= ${soqlDate(run.end + MADE_WITHIN_MS)} LIMIT ${READ_LIMIT}`,
    );
    if (answer.records.length >= READ_LIMIT) return [];
    sets = answer.records.filter(
      (row): row is Record<string, unknown> => typeof row === 'object' && row !== null,
    );
  } catch {
    // An org without duplicate management, or a user who may not read them.
    return [];
  }
  const ids = sets.flatMap((row) => (typeof row.Id === 'string' ? [row.Id] : []));
  if (ids.length === 0) return [];
  /** Keys of the sets an item of which names a record that is not the run's. */
  const others = new Set<string>();
  /** By the key of each set, the records its items name. */
  const names = new Map<string, string[]>();
  try {
    for (const list of idLists(ids)) {
      const answer = await org.query(
        `SELECT Id, RecordId, DuplicateRecordSetId FROM ${DUPLICATE_ITEM_OBJECT} ` +
          `WHERE DuplicateRecordSetId IN (${list}) LIMIT ${READ_LIMIT}`,
      );
      if (answer.records.length >= READ_LIMIT) return [];
      for (const record of answer.records) {
        const row = (record ?? {}) as Record<string, unknown>;
        const set = row.DuplicateRecordSetId;
        const named = row.RecordId;
        if (typeof set !== 'string') continue;
        if (typeof named !== 'string' || !run.has(recordKey(named))) others.add(recordKey(set));
        else names.set(recordKey(set), [...(names.get(recordKey(set)) ?? []), recordKey(named)]);
      }
    }
  } catch {
    return [];
  }
  return sets.flatMap((row) =>
    typeof row.Id === 'string' && !others.has(recordKey(row.Id))
      ? [
          {
            id: row.Id,
            created: epochOf(row.CreatedDate),
            modified: epochOf(row.LastModifiedDate),
            ...(typeof row.LastModifiedById === 'string'
              ? { modifiedBy: row.LastModifiedById }
              : {}),
            names: names.get(recordKey(row.Id)) ?? [],
          },
        ]
      : [],
  );
}

/**
 * When a set of the run was last modified, as the removal reads a change
 * since the run: the platform restamps it as the run's user each time it
 * reports a record of the run into it, up to a moment after the run's last
 * write, which is no change since the run. Read by its date alone, a set
 * reported into after the run's last save read as changed since, and stayed.
 * One someone else modified, or the run's user later, holds its own date.
 */
export function modifiedOf(
  set: Pick<DuplicateSetRead, 'modified' | 'modifiedBy'>,
  run: Pick<DuplicateSetsRun, 'end' | 'user'>,
): number {
  const by = set.modifiedBy !== undefined ? recordKey(set.modifiedBy) : '';
  return by === recordKey(run.user) && set.modified <= run.end + MADE_WITHIN_MS
    ? Math.min(set.modified, run.end)
    : set.modified;
}
