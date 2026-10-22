/**
 * Bringing back what a Sync run deleted: the records of the target a delta
 * run deleted because the source had deleted them
 * (`SyncOrchestrator.carryDeletions`), as the run named them in its file,
 * taken out of the target's recycle bin by their ids — `undelete`, as a
 * DataOps restore brings back the records deleted since its snapshot.
 *
 * Tied by the write's key, they can be records the target held before any
 * run of SandForge. The removal of the run said nothing of them: it reported
 * success, and they stayed deleted until the bin was emptied. A record no
 * longer in the bin is gone for good, and counted so; one back in the org
 * already is counted apart; what the org refuses is counted with why.
 *
 * The removal of the run makes it before anything else it writes
 * (`SyncRunRemoval`): a record the run wrote over may name one of them.
 */

import type { SyncUndeleteObjectResult } from '@sandforge/shared';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { idLists, RECORDS_PER_CALL } from '../dataops/RecordRemoval.js';
import { CLOCK_LEEWAY_MS, type RemovalOrg } from '../forge/ForgeRunRemoval.js';
import { orgAheadOf, stampsWritten, writerOnce } from './SyncRunRestore.js';

/** Take records out of the recycle bin by their ids: jsforce's `conn.soap.undelete`. */
export type UndeleteCall = (ids: string[]) => Promise<unknown>;

/** What bringing back a run's deletions is given. */
export interface SyncUndeleteInput {
  org: Pick<RemovalOrg, 'query' | 'queryDeleted'> &
    Partial<Pick<RemovalOrg, 'serverTime' | 'userId'>>;
  /** What the run deleted that a removal brings back now (`syncUndeletePlan`). */
  plan: ReadonlyArray<{ objectApiName: string; ids: readonly string[] }>;
  undelete: UndeleteCall;
  /**
   * The records whose `LastModifiedDate` it says back once brought back
   * (`SyncUndeleteOutcome.stamps`): those an earlier run of the same target
   * names too — created it, wrote over it — whose removal would otherwise
   * read the undelete as a change since that run.
   */
  stampsFor?: (id: string) => boolean;
  /** Stops it before its next call to the org. */
  signal?: AbortSignal;
}

/** What bringing them back did. */
export interface SyncUndeleteOutcome {
  objects: SyncUndeleteObjectResult[];
  /** The records still to bring back: refused, not reached. */
  left: string[];
  /** Whether it wrote to the org. */
  wrote: boolean;
  /** Whether a stop ended it before it was through. */
  cancelled: boolean;
  /**
   * Of the records {@link SyncUndeleteInput.stampsFor} names, those it
   * brought back, by id, with the `LastModifiedDate` the org gives them, last
   * modified by its user since it began.
   */
  stamps: Record<string, string>;
}

/** Why records were refused, a few of each. */
const REASONS_KEPT = 5;

/** A record by its first fifteen characters. */
function recordKey(id: string): string {
  return id.slice(0, 15);
}

/** One record's answer to an undelete, as jsforce gives it. */
interface UndeleteAnswer {
  success?: boolean;
  errors?: Array<{ statusCode?: string; message?: string } | string>;
}

/** The org's reason for a refused record, in its words. */
function reasonOf(answer: UndeleteAnswer): string {
  const error = answer.errors?.[0];
  if (error === undefined) return 'The org gave no reason.';
  if (typeof error === 'string') return error;
  const code = error.statusCode ?? '';
  const message = error.message ?? '';
  return code && message ? `${code}: ${message}` : code || message || 'The org gave no reason.';
}

/** The ids a read answered with, by their first fifteen characters. */
function keysOf(records: readonly unknown[]): Set<string> {
  const keys = new Set<string>();
  for (const record of records) {
    const id = (record as { Id?: unknown }).Id;
    if (typeof id === 'string') keys.add(recordKey(id));
  }
  return keys;
}

/**
 * Bring back from the recycle bin what a run deleted: see the module's
 * comment. A call that fails outright counts the records it was for refused,
 * with why, and the next ones are tried all the same.
 */
export async function undeleteRunDeletions(input: SyncUndeleteInput): Promise<SyncUndeleteOutcome> {
  const objects: SyncUndeleteObjectResult[] = [];
  const left: string[] = [];
  const stamps: Record<string, string> = {};
  let wrote = false;
  let cancelled = false;
  const stampsFor = input.stampsFor;
  const writerOf = writerOnce(input.org);
  const serverTime = input.org.serverTime?.bind(input.org);
  /** When it began, by the org's clock, give or take the drift; read only when stamped. */
  const from =
    stampsFor && serverTime
      ? Date.now() + (await orgAheadOf({ serverTime })) - CLOCK_LEEWAY_MS
      : Number.NaN;
  for (const { objectApiName, ids } of input.plan) {
    const result: SyncUndeleteObjectResult = {
      objectApiName,
      planned: ids.length,
      undeleted: 0,
      alreadyBack: 0,
      goneForGood: 0,
      refused: 0,
      reasons: [],
    };
    objects.push(result);
    const reason = (words: string): void => {
      if (result.reasons.length < REASONS_KEPT && !result.reasons.includes(words)) {
        result.reasons.push(words);
      }
    };
    const object = assertSoqlIdentifier(objectApiName);
    for (let at = 0; at < ids.length; at += RECORDS_PER_CALL) {
      const batch = ids.slice(at, at + RECORDS_PER_CALL);
      if (cancelled || input.signal?.aborted) {
        cancelled = true;
        result.notReached = (result.notReached ?? 0) + batch.length;
        left.push(...batch);
        continue;
      }
      const [list] = idLists(batch, RECORDS_PER_CALL);
      let inBin: Set<string>;
      let present: Set<string>;
      try {
        inBin = keysOf(
          (
            await input.org.queryDeleted(
              `SELECT Id FROM ${object} WHERE Id IN (${list}) AND IsDeleted = true`,
            )
          ).records,
        );
        present = keysOf(
          (await input.org.query(`SELECT Id FROM ${object} WHERE Id IN (${list})`)).records,
        );
      } catch (err: unknown) {
        result.refused += batch.length;
        reason(`The recycle bin could not be read: ${extractErrorMessage(err)}`);
        left.push(...batch);
        continue;
      }
      const back = batch.filter((id) => inBin.has(recordKey(id)));
      for (const id of batch) {
        if (inBin.has(recordKey(id))) continue;
        if (present.has(recordKey(id))) result.alreadyBack++;
        else result.goneForGood++;
      }
      if (back.length === 0) continue;
      let answers: UndeleteAnswer[];
      try {
        wrote = true;
        const answer = await input.undelete(back);
        const rows = Array.isArray(answer)
          ? (answer as UndeleteAnswer[])
          : [answer as UndeleteAnswer];
        answers = back.map((_, place) => rows[place] ?? { success: false });
      } catch (err: unknown) {
        const words = extractErrorMessage(err);
        answers = back.map(() => ({ success: false, errors: [words] }));
      }
      const brought: string[] = [];
      answers.forEach((answer, place) => {
        if (answer.success === true) {
          result.undeleted++;
          if (stampsFor?.(back[place])) brought.push(back[place]);
          return;
        }
        result.refused++;
        reason(reasonOf(answer));
        left.push(back[place]);
      });
      if (brought.length > 0 && Number.isFinite(from)) {
        Object.assign(stamps, await stampsWritten(input.org, object, brought, from, writerOf));
      }
    }
  }
  return { objects, left, wrote, cancelled, stamps };
}

/** Records a removal left deleted that the run deleted: refused, gone for good, not reached. */
export function undeleteLeftOver(object: SyncUndeleteObjectResult): number {
  return object.refused + object.goneForGood + (object.notReached ?? 0);
}
