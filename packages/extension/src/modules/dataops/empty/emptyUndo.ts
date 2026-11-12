/**
 * The undo of an emptying: what it deleted brought back from the recycle
 * bin, by the ids its journal names, while the bin holds them.
 *
 * **Parents first.** The passes are taken back in the reverse of their order:
 * a parent whose delete took records along went before them, and comes back
 * first, with them (P7); records the platform made go before the record they
 * name — a case before its account — come back after it. What each pass took
 * along is not named in the journal: it comes back with its parent.
 *
 * **What does not come back** is named, never counted back:
 *
 * - not in the recycle bin, the org answers ("Entity is not in the recycle
 *   bin"): emptied from it, purged past its capacity, or kept there for good —
 *   a record deleted on its own before a record it hangs from deleted after
 *   it (F41, G1), which the preview counted as what no undo brings back. A
 *   record no read finds, in the bin or out, was purged too. Salesforce lists
 *   a record emptied from the bin as deleted for a while still (P11): only
 *   the undelete's answer tells, so each is sent, and one answered so that a
 *   parent brought back later took back with it is read again at the end and
 *   counted back;
 * - deleted by another user, whose deletions only Modify All Data brings back
 *   (P-B3, `INSUFFICIENT_ACCESS_OR_READONLY`): an undo by another user than
 *   the one who emptied;
 * - anything else the org refuses, in its words.
 *
 * A run that deleted for good is refused before this is reached: no undelete
 * brings back what a `hardDelete` job deleted, and `queryAll` lists it as
 * deleted all the same (probed live), so nothing is read from it.
 *
 * **What it brings back** is what the journal names deleted. A run whose
 * process stopped while it deleted left the answers of its last deletes
 * unwritten: its undo reads the ids of each pass that attempt read, less
 * those named gone, and brings back those the recycle bin holds.
 *
 * Stop reaches it between two calls; an undo stopped part way is taken up by
 * the next one, which finds back in the org what this one brought back.
 */

import type { DataOpsEmptyStatus, DataOpsEmptyUndoObject } from '@sandforge/shared';
import { extractErrorMessage } from '../../../core/common/extractErrorMessage.js';
import { assertSoqlIdentifier } from '../../../core/common/soqlValidator.js';
import { idLists, RECORDS_PER_CALL } from '../RecordRemoval.js';
import type { UndeleteCall } from '../../sync/SyncRunUndelete.js';
import { EMPTYING } from '../../../core/removal/tableIds.js';
import { IdSpool, RecordKeySet } from '../../checkpoint/spooledRunRecords.js';
import type { EmptyJournal } from './emptyJournal.js';

/** What an undo reads the org through: queries, and queries of its recycle bin too. */
export interface EmptyUndoOrg {
  query(soql: string): Promise<{ records: unknown[] }>;
  queryDeleted(soql: string): Promise<{ records: unknown[] }>;
}

/** What an undo is given. */
export interface EmptyUndoDeps {
  org: EmptyUndoOrg;
  undelete: UndeleteCall;
  journal: EmptyJournal;
  signal?: AbortSignal;
  onProgress?: (progress: { percentage: number; step: string }) => void;
}

/** What an undo did. */
export interface EmptyUndoOutcome {
  status: DataOpsEmptyStatus;
  objects: DataOpsEmptyUndoObject[];
  notes: string[];
}

/** What the org answers an undelete of a record not in the recycle bin, in its words. */
const NOT_IN_BIN = /Entity is not in the recycle bin/;

/** What the org answers an undelete of another user's deletion, without Modify All Data. */
const OTHERS_DELETION = /INSUFFICIENT_ACCESS/;

/** Reasons kept per object: an org repeats the same few. */
const REASONS_KEPT = 5;

/**
 * Records answered "not in the recycle bin" read again at the end, at most:
 * past them, those a parent brought back later took along are not told
 * apart, and the result says so.
 */
const NOT_IN_BIN_READ_AGAIN = 50_000;

/** A record by its first fifteen characters. */
function keyOf(id: string): string {
  return id.slice(0, 15);
}

/** The ids a read answered with, by key. */
function keysOf(records: readonly unknown[]): Set<string> {
  const keys = new Set<string>();
  for (const record of records) {
    const id = (record as { Id?: unknown } | null)?.Id;
    if (typeof id === 'string') keys.add(keyOf(id));
  }
  return keys;
}

/** One record's answer to an undelete, as jsforce gives it. */
interface UndeleteAnswer {
  success?: boolean;
  errors?: Array<{ statusCode?: string; message?: string } | string>;
}

/** The org's reason for a refused undelete, in its words. */
function reasonOf(answer: UndeleteAnswer | undefined): string {
  const error = answer?.errors?.[0];
  if (error === undefined) return 'The org gave no reason.';
  if (typeof error === 'string') return error;
  const code = error.statusCode ?? '';
  const message = error.message ?? '';
  return code && message ? `${code}: ${message}` : code || message || 'The org gave no reason.';
}

/** An object's tally, as it is added to. */
function emptyTally(objectApiName: string): DataOpsEmptyUndoObject {
  return {
    objectApiName,
    planned: 0,
    undeleted: 0,
    alreadyBack: 0,
    notInBin: 0,
    othersDeletion: 0,
    refused: 0,
    reasons: [],
  };
}

function addReason(tally: DataOpsEmptyUndoObject, reason: string): void {
  if (tally.reasons.length < REASONS_KEPT && !tally.reasons.includes(reason)) {
    tally.reasons.push(reason);
  }
}

/**
 * The ids of `objectApiName` the run deleted, a page at a time: those its
 * journal names deleted, then — when an attempt of it stopped with its
 * process — those that attempt read of the object and the journal names
 * neither deleted nor gone.
 */
async function* undoIdsOf(
  journal: EmptyJournal,
  objectApiName: string,
  unended: { place: number; count: number } | undefined,
): AsyncGenerator<string[]> {
  const named = unended ? new RecordKeySet() : undefined;
  for await (const line of journal.settledOf(objectApiName)) {
    if (named) for (const id of [...line.deleted, ...line.gone]) named.add(id);
    if (line.deleted.length > 0) yield [...line.deleted];
  }
  if (!unended || !named) return;
  const spool = await IdSpool.open(journal.idsDirOf(unended.place, objectApiName), EMPTYING);
  for await (const page of spool.pages(objectApiName)) {
    const unnamed = page.filter((id) => !named.has(id));
    if (unnamed.length > 0) yield unnamed;
  }
}

/** Bring back what the run deleted: see the module's comment. */
export async function undoEmpty(deps: EmptyUndoDeps): Promise<EmptyUndoOutcome> {
  const { journal, org } = deps;
  const head = journal.head;
  const notes: string[] = [];
  const stopped = (): boolean => deps.signal?.aborted === true;

  // An attempt that began and wrote no end: its process stopped while it
  // deleted, and the answers of its last deletes may be unwritten.
  let attempts = 0;
  let ends = 0;
  const spooledIn = new Map<string, { place: number; count: number; attempt: number }>();
  for await (const line of journal.lines()) {
    if (line.kind === 'attempt') attempts++;
    else if (line.kind === 'end') ends++;
    else if (line.kind === 'spooled') {
      spooledIn.set(line.objectApiName, {
        place: line.place,
        count: line.count,
        attempt: attempts,
      });
    }
  }
  const unendedAttempt = attempts > ends ? attempts : undefined;

  const objects: DataOpsEmptyUndoObject[] = [];
  const notInBin = new Map<string, string[]>();
  let cancelled = false;
  const passes = [...head.passes].reverse();
  for (const [at, { objectApiName }] of passes.entries()) {
    const tally = emptyTally(objectApiName);
    objects.push(tally);
    const object = assertSoqlIdentifier(objectApiName);
    const read = spooledIn.get(objectApiName);
    const unended =
      read !== undefined && unendedAttempt !== undefined && read.attempt === unendedAttempt
        ? read
        : undefined;
    for await (const page of undoIdsOf(journal, objectApiName, unended)) {
      tally.planned += page.length;
      for (let from = 0; from < page.length; from += RECORDS_PER_CALL) {
        const batch = page.slice(from, from + RECORDS_PER_CALL);
        if (cancelled || stopped()) {
          cancelled = true;
          tally.notReached = (tally.notReached ?? 0) + batch.length;
          continue;
        }
        const [list] = idLists(batch, RECORDS_PER_CALL);
        let inBin: Set<string>;
        let present: Set<string>;
        try {
          inBin = keysOf(
            (
              await org.queryDeleted(
                `SELECT Id FROM ${object} WHERE Id IN (${list}) AND IsDeleted = true`,
              )
            ).records,
          );
          present = keysOf(
            (await org.query(`SELECT Id FROM ${object} WHERE Id IN (${list})`)).records,
          );
        } catch (err: unknown) {
          tally.refused += batch.length;
          addReason(tally, `The recycle bin could not be read: ${extractErrorMessage(err)}`);
          continue;
        }
        const back = batch.filter((id) => inBin.has(keyOf(id)));
        for (const id of batch) {
          if (inBin.has(keyOf(id))) continue;
          if (present.has(keyOf(id))) tally.alreadyBack++;
          else {
            tally.notInBin++;
            addReason(
              tally,
              'No longer in the recycle bin, nor in the org: emptied from the bin, or pushed out of it.',
            );
          }
        }
        if (back.length === 0) continue;
        let answers: UndeleteAnswer[];
        try {
          const answer = await deps.undelete(back);
          const rows = Array.isArray(answer)
            ? (answer as UndeleteAnswer[])
            : [answer as UndeleteAnswer];
          answers = back.map((_, place) => rows[place] ?? { success: false });
        } catch (err: unknown) {
          const words = extractErrorMessage(err);
          answers = back.map(() => ({ success: false, errors: [words] }));
        }
        answers.forEach((answer, place) => {
          if (answer.success === true) {
            tally.undeleted++;
            return;
          }
          const reason = reasonOf(answer);
          if (NOT_IN_BIN.test(reason)) {
            tally.notInBin++;
            const kept = notInBin.get(objectApiName) ?? [];
            if (kept.length < NOT_IN_BIN_READ_AGAIN) kept.push(back[place]);
            notInBin.set(objectApiName, kept);
            addReason(
              tally,
              'Salesforce still lists it as deleted but will not bring it back: emptied from the ' +
                'recycle bin, or kept there for good — deleted on its own before a record it ' +
                "hangs from was deleted after it (the org answers 'Entity is not in the recycle bin')",
            );
          } else if (OTHERS_DELETION.test(reason)) {
            tally.othersDeletion++;
            addReason(
              tally,
              'Deleted by another user than the one bringing it back: only Modify All Data ' +
                `brings back another's deletions (${reason})`,
            );
          } else {
            tally.refused++;
            addReason(tally, reason);
          }
        });
      }
      deps.onProgress?.({
        percentage: Math.round(((at + 1) / Math.max(1, passes.length)) * 100),
        step: `${objectApiName}: ${tally.undeleted.toLocaleString('en-US')} brought back`,
      });
    }
  }

  // Those answered not in the bin that a parent brought back after them took
  // back with it: in the org now.
  if (!cancelled) {
    for (const tally of objects) {
      const ids = notInBin.get(tally.objectApiName) ?? [];
      if (ids.length === 0) continue;
      if (tally.notInBin > ids.length) {
        notes.push(
          `${tally.objectApiName}: past ${NOT_IN_BIN_READ_AGAIN.toLocaleString('en-US')} records ` +
            'answered not in the recycle bin, whether a parent brought back later took them back ' +
            'was not read: they are counted as not back.',
        );
      }
      const object = assertSoqlIdentifier(tally.objectApiName);
      try {
        let live = 0;
        for (const list of idLists(ids, RECORDS_PER_CALL)) {
          const answer = await org.query(`SELECT Id FROM ${object} WHERE Id IN (${list})`);
          live += keysOf(answer.records).size;
        }
        const taken = Math.min(live, tally.notInBin);
        tally.notInBin -= taken;
        tally.alreadyBack += taken;
      } catch (err: unknown) {
        notes.push(
          `Whether the ${tally.objectApiName} records the org answered were not in the recycle ` +
            `bin came back with their parent could not be read (${extractErrorMessage(err)}): ` +
            'they are counted as not back.',
        );
      }
    }
  }

  const back = objects.reduce((sum, o) => sum + o.undeleted + o.alreadyBack, 0);
  const left = objects.reduce(
    (sum, o) => sum + o.notInBin + o.othersDeletion + o.refused + (o.notReached ?? 0),
    0,
  );
  const status: DataOpsEmptyStatus = cancelled
    ? 'cancelled'
    : left === 0
      ? 'success'
      : back > 0
        ? 'partial'
        : 'failure';
  return { status, objects: objects.filter((o) => o.planned > 0), notes };
}
