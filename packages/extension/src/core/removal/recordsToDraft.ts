/**
 * Records past Draft set back to Draft before they are deleted, and given
 * back the status they had when they stay: an activated order keeps its
 * products and itself from being deleted — "unable to modify activated
 * order" — and set back to Draft through the API it is deleted (P8, live).
 */

import { extractErrorMessage } from '../common/extractErrorMessage.js';
import {
  DELETED_PAST_DRAFT,
  STATUS_LIFECYCLES,
  statusCategories,
  type StatusCategories,
} from '../common/platformRecords.js';
import { readRecordsById, RECORDS_PER_CALL } from '../../modules/dataops/RecordRemoval.js';
import { describeError, queryOf, writeResultSchema, type DeletionOrg } from './deleteRecords.js';

/** A record {@link backToDraft} set to Draft, and the status it had. */
export interface Drafted {
  objectApiName: string;
  id: string;
  /** The Draft status it was set to. */
  draft: string;
  /** The status it had, and gets back if it stays in the org. */
  status: string;
}

/** The records of some objects, a page of ids at a time, as a delete is handed them. */
export interface IdPages {
  pages(objectApiName: string): AsyncIterable<readonly string[]>;
}

/**
 * Those of `objects` whose records past Draft a removal sets back to Draft
 * before it deletes them ({@link backToDraft}), and gives back their status
 * when it keeps them: what fires on their update fires then too.
 */
export function setBackToDraftOf(objects: readonly string[]): string[] {
  return objects.filter(
    (objectApiName) =>
      STATUS_LIFECYCLES[objectApiName] !== undefined && !DELETED_PAST_DRAFT.has(objectApiName),
  );
}

/**
 * Return to a Draft status, before anything is deleted, the records of an
 * object with a status lifecycle — an order — that are past Draft and set to
 * go. A contract is left as it stands: the org deletes an activated one, and
 * would not set it back to Draft (`DELETED_PAST_DRAFT`).
 *
 * An activated order keeps its products and itself from being deleted —
 * "unable to modify activated order" — and a clone now writes orders back as
 * the source held them, activated ones included. The Frozen purge learnt it
 * first. Only a record meant to be deleted is touched: one kept — changed
 * since a run, or held for a record that stays (`held`) — is left as it is. A
 * refusal here shows again, with its reason, as the delete that follows.
 *
 * Which records stay is only known once the deletes are through — an item the
 * org refuses holds its order — so each record set to Draft is handed back
 * with the status it had, for {@link putBackStatuses}. Stopped, it sets
 * nothing more.
 *
 * @param goes - Whether the record is still in the org and not kept as changed.
 * @param held - Of some records of an object about to be set to Draft, the
 *   keys of those records that stay hang from: they stay too, as they are.
 */
export async function backToDraft(
  org: Pick<DeletionOrg, 'query' | 'update'>,
  order: ReadonlyArray<{ readonly objectApiName: string }>,
  records: IdPages,
  goes: (objectApiName: string, id: string) => boolean,
  stopped: () => boolean,
  held: (objectApiName: string, candidates: readonly string[]) => Promise<ReadonlySet<string>>,
): Promise<{ drafted: Drafted[]; cancelled: boolean }> {
  const query = queryOf(org);
  const drafted: Drafted[] = [];
  for (const { objectApiName } of order) {
    const lifecycle = STATUS_LIFECYCLES[objectApiName];
    if (!lifecycle || DELETED_PAST_DRAFT.has(objectApiName)) continue;
    /** The object's statuses, read once its first page holds a record to set back. */
    let categories: StatusCategories | undefined;
    for await (const page of records.pages(objectApiName)) {
      const candidates = page.filter((id) => goes(objectApiName, id));
      if (candidates.length === 0) continue;
      if (stopped()) return { drafted, cancelled: true };
      categories ??= await statusCategories(query, lifecycle);
      const known = categories;
      const draft = known?.draft;
      if (!known || !draft) break;
      const kept = await held(objectApiName, candidates);
      let rows: Array<Record<string, unknown>>;
      try {
        rows = await readRecordsById(org, objectApiName, ['Status'], candidates);
      } catch {
        continue;
      }
      const pastDraft = rows
        .filter((row) => typeof row.Id === 'string' && !kept.has(row.Id.slice(0, 15)))
        .filter((row) => {
          const category = known.categoryOf.get(String(row.Status));
          return category !== undefined && category !== 'Draft';
        })
        .map((row) => ({ objectApiName, id: String(row.Id), draft, status: String(row.Status) }));
      for (let at = 0; at < pastDraft.length; at += RECORDS_PER_CALL) {
        if (stopped()) return { drafted, cancelled: true };
        const batch = pastDraft.slice(at, at + RECORDS_PER_CALL);
        // Kept before the call: an update the org applied without answering is
        // put back all the same.
        drafted.push(...batch);
        try {
          await org.update(
            objectApiName,
            batch.map(({ id }) => ({ Id: id, Status: draft })),
          );
        } catch {
          // Shown again by the delete.
        }
      }
    }
  }
  return { drafted, cancelled: false };
}

/** How {@link putBackStatuses} says what it did. */
export interface PutBackHooks {
  /**
   * Say something of an object's records on its result.
   *
   * @param failed - Whether a record of it was left in Draft.
   * @param record - The record it is said of, when it is said of one.
   */
  note: (objectApiName: string, reason: string, failed: boolean, record?: Drafted) => void;
}

/**
 * `reason`, said of `record` by its id, or, said of an object's records as a
 * whole, followed by the id and the status before of each of `drafted` of
 * that object: a record a run left in Draft is never left unnamed.
 */
export function namedDraftNote(
  objectApiName: string,
  reason: string,
  record: Drafted | undefined,
  drafted: readonly Drafted[],
): string {
  if (record) return `${objectApiName} ${record.id}: ${reason}`;
  const each = drafted
    .filter((one) => one.objectApiName === objectApiName)
    .map((one) => `${one.id} (${one.status})`);
  return each.length > 0
    ? `${objectApiName}: ${reason} Set to Draft, with the status each had: ${each.join(', ')}.`
    : `${objectApiName}: ${reason}`;
}

/**
 * Give each record {@link backToDraft} set to Draft that a delete leaves in
 * the org — kept, refused, or not reached — the status it had, and say so on
 * its object, whether the org took it back or not.
 *
 * Set to Draft before any delete, an order was then held by an item the org
 * refused, or refused itself, or the removal was cancelled before its turn:
 * it stayed in the org deactivated, and nothing said so. A record set to
 * Draft that someone changed since is left as they left it.
 */
export async function putBackStatuses(
  org: Pick<DeletionOrg, 'query' | 'update'>,
  drafted: readonly Drafted[],
  hooks: PutBackHooks,
): Promise<void> {
  const objects = [...new Set(drafted.map((record) => record.objectApiName))];
  for (const objectApiName of objects) {
    const records = drafted.filter((record) => record.objectApiName === objectApiName);
    const byKey = new Map(records.map((record) => [record.id.slice(0, 15), record]));
    const ids = records.map((record) => record.id);
    let rows: Array<Record<string, unknown>>;
    try {
      rows = await readRecordsById(org, objectApiName, ['Status'], ids);
    } catch (err: unknown) {
      hooks.note(
        objectApiName,
        `Status set to ${records[0].draft} for the delete, and not read back to be restored: ${extractErrorMessage(err)}`,
        true,
      );
      continue;
    }
    const inDraft = rows.flatMap((row) => {
      const record = typeof row.Id === 'string' ? byKey.get(row.Id.slice(0, 15)) : undefined;
      return record && row.Status === record.draft ? [record] : [];
    });
    for (let at = 0; at < inDraft.length; at += RECORDS_PER_CALL) {
      const batch = inDraft.slice(at, at + RECORDS_PER_CALL);
      let answer: unknown;
      try {
        answer = await org.update(
          objectApiName,
          batch.map(({ id, status }) => ({ Id: id, Status: status })),
        );
      } catch (err: unknown) {
        answer = batch.map(() => ({ success: false, errors: [extractErrorMessage(err)] }));
      }
      const answered = Array.isArray(answer) ? answer : [answer];
      batch.forEach(({ draft, status }, index) => {
        const row = writeResultSchema.safeParse(answered[index]);
        if (row.success && row.data.success) {
          hooks.note(
            objectApiName,
            `Status set to ${draft} for the delete, then back to ${status}.`,
            false,
            batch[index],
          );
          return;
        }
        const errors = row.success ? (row.data.errors ?? []) : [];
        const reason = errors.length > 0 ? describeError(errors[0]) : 'The org gave no reason.';
        hooks.note(
          objectApiName,
          `Status set to ${draft} for the delete, and left there: the org refused ${status} back — ${reason}`,
          true,
          batch[index],
        );
      });
    }
  }
}
