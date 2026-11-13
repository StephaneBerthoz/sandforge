/**
 * One pass of deletes over whole objects: every record handed over goes, in
 * the order the objects are given, nothing held back for what hangs from it.
 * What a delete takes along — a cascade's children — goes with its parent:
 * a parent sent first takes them, and their own ids, read before, answer
 * that they are gone (`ENTITY_IS_DELETED`). The order is the caller's: a
 * parent before what its delete takes along keeps an undelete of the parent
 * able to bring back the whole tree (F41, P7); children before a parent only
 * where the platform refuses the parent while they live.
 *
 * Unlike the removal of a run's records, nothing here reads what changed
 * since, nor what hangs from a record: it deletes what it is handed, through
 * the same deletes ({@link sendDeletes}), the same Draft first for an order
 * past it ({@link backToDraft}), and the same rounds of tries of what the org
 * refused ({@link retryRounds}).
 */

import { limitSplitting, type LimitSplitting } from '../common/governorLimit.js';
import { readRecordsById } from '../../modules/dataops/RecordRemoval.js';
import {
  BULK_DELETE_JOB_RECORDS,
  FILE_NOT_FOR_GOOD,
  HARD_DELETE_UNAVAILABLE,
  deleteLimitNotes,
  goesByJob,
  lockResendNote,
  retryRounds,
  sendDeletes,
  takenAlong,
  type DeleteMode,
  type DeleteOutcome,
  type DeletesEnd,
  type DeletionOrg,
} from './deleteRecords.js';
import { backToDraft, namedDraftNote, putBackStatuses, type Drafted } from './recordsToDraft.js';

/** Reasons kept per object: an org repeats the same few. */
const REASON_LIMIT = 5;

/**
 * Refused records of one object kept by id for the second try: a job's
 * worth. Past it — a table the org refuses whole — the rest are counted and
 * said, never held: a million refused ids would be the million a pass reads
 * from disk so as not to hold them.
 */
export const REFUSED_KEPT = BULK_DELETE_JOB_RECORDS;

/** The records a pass deletes, per object in the order they go, a page at a time. */
export interface PassRecords {
  readonly objects: ReadonlyArray<{ readonly objectApiName: string; readonly count: number }>;
  pages(objectApiName: string): AsyncIterable<readonly string[]>;
}

/** How a pass goes. */
export interface DeletePassOptions {
  /** To the recycle bin, or for good: see {@link DeleteMode}. */
  mode: DeleteMode;
  /** Stops the pass before its next call or job; a job the org has is awaited. */
  signal?: AbortSignal;
  /** The sizes the deletes go at and the smaller calls a limit may cost: 2 000 when absent. */
  splitting?: LimitSplitting;
  /**
   * Set records past Draft back to Draft before anything is deleted, and give
   * back the status of those the pass leaves: true when absent (P8).
   */
  toDraft?: boolean;
  /** Told how many records are settled, after each delete. */
  onProgress?: (settled: number, total: number, objectApiName: string) => void;
  /**
   * Told what became of the records of each delete, as the org answered it:
   * what a journal of the pass writes down.
   */
  onSettled?: (
    objectApiName: string,
    sent: readonly string[],
    outcomes: readonly DeleteOutcome[],
  ) => void;
  /** Waits before a record the org could not lock goes again; a timer when absent. */
  wait?: (ms: number) => Promise<void>;
}

/** What a pass did with one object's records. */
export interface PassObject {
  objectApiName: string;
  /** The records handed over. */
  planned: number;
  /** Deleted by the pass. */
  deleted: number;
  /**
   * Gone before their delete reached them: taken along by a parent the pass
   * deleted first, or deleted by someone since they were read — the org
   * answered `ENTITY_IS_DELETED`, or a read once the rest had gone no longer
   * found a record it had refused.
   */
  gone: number;
  /** Refused by the org, with why in `reasons`. */
  refused: number;
  /** Not reached when the pass was stopped. Absent when none. */
  notReached?: number;
  /** Why records stay, in the org's words where it gave them. */
  reasons: string[];
}

/** What a pass did. */
export interface DeletePassOutcome {
  /** Whether it deleted for good: nothing it deleted can be brought back. */
  hard: boolean;
  /** Per object, in the order they went, every object handed over. */
  objects: PassObject[];
  /** Whether it stopped before it was through. */
  cancelled: boolean;
  /**
   * Why the org refused to delete for good, before the job it refused held a
   * record: set, the pass stopped there, and sent nothing more.
   */
  hardRefused?: string;
}

/** Why the org refused one record. */
interface PassRefusal {
  reason: string;
  /** Refused for records still hanging from it: tried while a round takes something more. */
  dependency: boolean;
  /** Worth a second try: neither refused for a limit, nor never sendable. */
  again: boolean;
}

/** Where a pass stands with one object's records. */
class PassLedger {
  deleted = 0;
  gone = 0;
  /** Refused records kept for the second try, by id. */
  readonly refused = new Map<string, PassRefusal>();
  /** Refused past {@link REFUSED_KEPT}: counted, not held. */
  refusedUnkept = 0;
  /** Records sent again for a lock, by key, and their last answer. */
  readonly lockResent = new Map<string, DeleteOutcome['kind']>();
  /** What is said of the object beside the org's refusals. */
  readonly notes: string[] = [];

  constructor(
    readonly objectApiName: string,
    readonly planned: number,
  ) {}

  settle(sent: readonly string[], outcomes: readonly DeleteOutcome[]): void {
    sent.forEach((id, index) => {
      const outcome = outcomes[index];
      const key = id.slice(0, 15);
      if (outcome.lockResends !== undefined || this.lockResent.has(key)) {
        this.lockResent.set(key, outcome.kind);
      }
      if (outcome.kind !== 'refused') {
        this.refused.delete(id);
        if (outcome.kind === 'deleted') this.deleted++;
        else this.gone++;
        return;
      }
      const refusal: PassRefusal = {
        reason: outcome.reason,
        dependency: outcome.dependency,
        again: outcome.limit === undefined && outcome.reason !== FILE_NOT_FOR_GOOD,
      };
      if (this.refused.has(id) || this.refused.size < REFUSED_KEPT) this.refused.set(id, refusal);
      else {
        this.refusedUnkept++;
        this.note(outcome.reason);
      }
    });
  }

  note(reason: string): void {
    if (!this.notes.includes(reason)) this.notes.push(reason);
  }

  /** The first round's: every refused record worth a second try. */
  toSendAgain(): string[] {
    return [...this.refused].filter(([, refusal]) => refusal.again).map(([id]) => id);
  }

  /** The later rounds': the ones refused for records hanging from them. */
  heldByDependents(): string[] {
    return [...this.refused]
      .filter(([, refusal]) => refusal.again && refusal.dependency)
      .map(([id]) => id);
  }

  result(splitting: LimitSplitting, cancelled: boolean): PassObject {
    const refused = this.refused.size + this.refusedUnkept;
    const unkept =
      this.refusedUnkept > 0
        ? [
            `${this.refusedUnkept} more refused record(s) were counted, not kept for a second ` +
              'try: the reasons given are those of the records kept.',
          ]
        : [];
    const reasons = [
      ...deleteLimitNotes(this.objectApiName, splitting),
      ...lockResendNote(this.lockResent.values()),
      ...this.notes,
      ...unkept,
      ...[...this.refused.values()].map((refusal) => refusal.reason),
    ];
    const settled = this.deleted + this.gone + refused;
    return {
      objectApiName: this.objectApiName,
      planned: this.planned,
      deleted: this.deleted,
      gone: this.gone,
      refused,
      ...(cancelled && this.planned > settled ? { notReached: this.planned - settled } : {}),
      reasons: [...new Set(reasons)].slice(0, REASON_LIMIT),
    };
  }
}

/**
 * Delete every record of `records`, object by object in the order given, as
 * {@link DeletePassOptions} says, and say what became of each object's.
 *
 * An order past Draft is set to Draft before anything is deleted, and one the
 * pass leaves gets its status back as it ends. Each object's records go a
 * page at a time, or gathered into jobs where they go by job: to the recycle
 * bin from {@link BULK_DELETE_JOB_RECORDS}'s threshold, for good always. Once
 * every object has had its turn, what the org refused goes again in rounds
 * ({@link retryRounds}); then what it still refuses is read back, and a
 * record it no longer holds — taken along by a parent deleted after it — is
 * counted gone.
 *
 * For good, an org that cannot send a `hardDelete` job deletes nothing; one
 * that refuses it for want of Bulk API Hard Delete stops the pass at the
 * first job, before that job held a record, with the org's words: nothing of
 * the pass is ever sent to the recycle bin in its place.
 */
export async function deletePass(
  org: Pick<DeletionOrg, 'query' | 'destroy' | 'update' | 'bulkDestroy' | 'bulkHardDestroy'>,
  records: PassRecords,
  options: DeletePassOptions,
): Promise<DeletePassOutcome> {
  const { mode } = options;
  const stopped = (): boolean => options.signal?.aborted === true;
  const splitting = options.splitting ?? limitSplitting();
  const total = records.objects.reduce((sum, object) => sum + object.count, 0);
  const ledgers: PassLedger[] = [];
  let settled = 0;
  let drafted: Drafted[] = [];

  const ledgerOf = (objectApiName: string): PassLedger => {
    let ledger = ledgers.find((held) => held.objectApiName === objectApiName);
    if (!ledger) {
      const planned = records.objects.find((object) => object.objectApiName === objectApiName);
      ledger = new PassLedger(objectApiName, planned?.count ?? 0);
      ledgers.push(ledger);
    }
    return ledger;
  };
  const end = async (cancelled: boolean, hardRefused?: string): Promise<DeletePassOutcome> => {
    await putBackStatuses(org, drafted, {
      // A record left in Draft is named by its id; one given its status back
      // is said once of its object.
      note: (objectApiName, reason, failed, record) =>
        ledgerOf(objectApiName).note(
          failed ? namedDraftNote(objectApiName, reason, record, drafted) : reason,
        ),
    });
    const objects = ledgers.map((ledger) => ledger.result(splitting, cancelled));
    if (cancelled) {
      for (const { objectApiName, count } of records.objects) {
        if (objects.some((object) => object.objectApiName === objectApiName)) continue;
        objects.push({
          ...new PassLedger(objectApiName, count).result(splitting, false),
          ...(count > 0 ? { notReached: count } : {}),
        });
      }
    }
    return {
      hard: mode === 'hard',
      objects,
      cancelled,
      ...(hardRefused !== undefined ? { hardRefused } : {}),
    };
  };
  const send = (ledger: PassLedger, ids: string[]): Promise<DeletesEnd> =>
    sendDeletes(org, ledger.objectApiName, ids, {
      mode,
      stopped,
      splitting,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.wait ? { wait: options.wait } : {}),
      settle: (sent, outcomes) => {
        const before = ledger.deleted + ledger.gone + ledger.refused.size + ledger.refusedUnkept;
        ledger.settle(sent, outcomes);
        options.onSettled?.(ledger.objectApiName, sent, outcomes);
        settled +=
          ledger.deleted + ledger.gone + ledger.refused.size + ledger.refusedUnkept - before;
        options.onProgress?.(settled, total, ledger.objectApiName);
      },
    });

  if (mode === 'hard' && org.bulkHardDestroy === undefined) {
    return end(true, HARD_DELETE_UNAVAILABLE);
  }
  if (options.toDraft !== false) {
    const drafting = await backToDraft(
      org,
      records.objects,
      records,
      () => true,
      stopped,
      // Nothing is held: every record of the pass goes.
      async () => new Set<string>(),
    );
    drafted = drafting.drafted;
    if (drafting.cancelled) return end(true);
  }

  for (const { objectApiName, count } of records.objects) {
    if (stopped()) return end(true);
    const ledger = ledgerOf(objectApiName);
    // Gathered up to a job before they are sent where they go by job, or no
    // page of a spool would ever reach the threshold.
    const gathers = goesByJob(org, objectApiName, count, mode);
    let candidates: string[] = [];
    const sendGathered = async (): Promise<DeletesEnd> => {
      const ids = candidates;
      candidates = [];
      return send(ledger, ids);
    };
    for await (const page of records.pages(objectApiName)) {
      if (stopped()) return end(true);
      candidates.push(...page);
      if (gathers && candidates.length < BULK_DELETE_JOB_RECORDS) continue;
      const ended = await sendGathered();
      if (ended.stopped) return end(true, ended.hardRefused);
    }
    if (candidates.length > 0) {
      if (stopped()) return end(true);
      const ended = await sendGathered();
      if (ended.stopped) return end(true, ended.hardRefused);
    }
  }

  let refusedHard: string | undefined;
  const stoppedRetrying = await retryRounds(ledgers, {
    stopped,
    idsOf: (ledger, round) => (round === 0 ? ledger.toSendAgain() : ledger.heldByDependents()),
    send: async (ledger, ids) => {
      const ended = await send(ledger, [...ids]);
      refusedHard = ended.hardRefused;
      return ended.stopped;
    },
    deleted: (ledger) => ledger.deleted,
  });
  if (stoppedRetrying) return end(true, refusedHard);

  // What the org still refuses that it no longer holds went with a parent
  // deleted after it. Every id was read from the org before the pass.
  for (const ledger of ledgers) {
    if (stopped()) return end(true);
    const { gone, unchecked, failure } = await takenAlong(
      [...ledger.refused.keys()],
      (ids) => readRecordsById(org, ledger.objectApiName, [], ids),
      () => true,
    );
    for (const id of gone) {
      ledger.refused.delete(id);
      ledger.gone++;
    }
    if (unchecked.length > 0) {
      ledger.note(
        `Not checked: ${unchecked.length} refused record(s) could not be read back once the ` +
          `rest had gone, to tell whether a parent deleted after them took them along` +
          (failure ? ` — ${failure}` : '.'),
      );
    }
  }
  return end(false);
}
