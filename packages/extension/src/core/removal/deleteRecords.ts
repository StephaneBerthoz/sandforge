/**
 * How records are deleted from an org, whoever asks: the calls a delete goes
 * in, over REST or as Bulk API 2.0 jobs, what the org answered for each
 * record, the calls a limit of the org's automation refuses sent again in
 * halves, the records it could not lock sent again, and the rounds of tries
 * of what it refused while something more goes. The removal of a run's
 * records (`removeRunRecords`), the rewind that drives it, and the emptying
 * of whole objects all delete through it.
 *
 * Nothing here reasons about a run — its span, what changed since it, what
 * hangs from its records: each caller says which records go, in which order,
 * and keeps its own account of them from what the deletes answer.
 *
 * A delete goes to the recycle bin (`recycle`), or past it for good (`hard`):
 * a Bulk API 2.0 `hardDelete` job, the only way the platform deletes for
 * good. The REST API's delete takes no such option — the client's DML
 * options carry `allOrNone`, `allowRecursive` and headers alone — so a pass
 * that deletes for good sends every record by job, however few, and never
 * one over REST.
 */

import * as z from 'zod';
import type { Connection } from 'jsforce';
import { isPricebookEntry, limitCauseOf } from '@sandforge/shared';

import { extractErrorMessage } from '../common/extractErrorMessage.js';
import {
  GOVERNOR_LIMIT_ALONE,
  GOVERNOR_LIMIT_KEPT_WHOLE,
  allowedFor,
  notSplitNote,
  sendSplittingOnLimits,
  smallerCallsNote,
  type CallKey,
  type LimitNote,
  type LimitSplitting,
} from '../common/governorLimit.js';
import { standardPriceIds, type SoqlQuery } from '../common/platformRecords.js';
import { BulkApiExecutor, type BulkApiConnection } from '../engine/BulkApiExecutor.js';
import { BulkApiManager } from '../engine/BulkApiManager.js';
import { BULK_RESULT_READS } from '../engine/bulkJobCost.js';
import { describedObjectSchema } from '../../modules/dataops/DataQualityScanner.js';
import {
  orgSession,
  readRecordsById,
  RECORDS_PER_CALL,
  type OrgSession,
} from '../../modules/dataops/RecordRemoval.js';

/**
 * Records of one object past which a removal deletes them through a Bulk API
 * 2.0 `delete` job rather than in calls of {@link RECORDS_PER_CALL}. A job
 * waits its turn in the org before it deletes anything: on a scratch org,
 * 2 000 contacts went in 8.6 seconds by ten calls and in 25.6 by one job, 24
 * of them waiting for the org; 6 000 took some 30 seconds either way; 12 000
 * went in 33 seconds as one job, where calls take about 52. Past ten
 * thousand, a job is the quicker, and its seven calls — opened, sent, closed,
 * polled, read back three times — stand for the fifty a removal sent before.
 */
export const BULK_DELETE_THRESHOLD = 10_000;

/**
 * Records one delete job holds at most. A removal is stopped between two
 * jobs, never within one the org has, so a job of a whole table held a stop
 * for as long as the org took to delete it; fifty thousand records is about a
 * minute and a half at the pace a scratch org deleted them, and every job
 * past the first saves the wait the org makes it start with.
 */
export const BULK_DELETE_JOB_RECORDS = 50_000;

/**
 * The code the org refuses a delete with while other records still hang from
 * the one deleted — "associated with the following opportunities", "some
 * opportunities of this account were closed won". A record refused with it is
 * tried again for as long as a round of tries takes something more; one the
 * org refuses with any other code, once.
 */
const DEPENDENCY_REFUSAL = 'DELETE_FAILED';

/**
 * The code the org refuses a record with when it could not lock it, or a
 * record the delete needed, within the ten seconds the platform waits for a
 * lock: another transaction held it — a job deleting children of the same
 * parents, a colleague's save. Nothing of the record was deleted.
 */
const LOCK_REFUSAL = 'UNABLE_TO_LOCK_ROW';

/**
 * Times a record the org could not lock is sent again, each after a wait:
 * the same three a write's row gets (`BatchWriter`). Sent again, a record
 * deleted meanwhile answers that it is gone: a delete never takes a record
 * twice.
 */
export const LOCK_RESENDS = 3;

/** The wait before the first of those sends, doubled before each next one, up to half of it left to chance. */
const LOCK_RESEND_DELAY_MS = 2_000;

/**
 * The code a Bulk API 2.0 job is refused with at its creation when it asks
 * for `hardDelete` and the user lacks Bulk API Hard Delete: asked live, the
 * job was refused before it held a record, "hardDelete operation requires
 * special user profile permission, please contact your system administrator".
 */
export const HARD_DELETE_NOT_ENABLED = 'FEATURENOTENABLED';

/** A file's version, which the org deletes only with its document. */
const FILE_VERSION = 'ContentVersion';

/** A file, which the org keeps when a record it was attached to goes. */
const FILE = 'ContentDocument';

/**
 * The objects whose records never go by a Bulk API job, however many: a
 * file's version, deleted by its document (`deleteVersions`); and a file,
 * which a rewind deletes over REST alone — a job of files was never tried on
 * an org, and 10,000 files go in 50 calls. Neither is deleted for good: that
 * would take a job.
 */
const NEVER_BY_JOB: ReadonlySet<string> = new Set([FILE_VERSION, FILE]);

/**
 * Where deleted records go: the recycle bin, from which an undelete brings
 * them back while it holds them; or nowhere, deleted for good, children the
 * org takes along included.
 */
export type DeleteMode = 'recycle' | 'hard';

/**
 * What a Bulk API 2.0 delete job answered: per record, in the order of the
 * ids it was sent, deleted or the org's error (`sf__Error`, `CODE:message:fields`);
 * or that it was aborted before the org had it; or that the org deleted none
 * of them — the job could not be handed over, an object the Bulk API does not
 * take, or it failed whole before it processed a record — which leaves them
 * to be deleted over REST, which answers each one; `code` is the org's, when
 * it gave one.
 *
 * Each says how many calls the job sent the org (`requests`): opened, its CSV
 * sent, closed or aborted, each read of its state, its results read three
 * ways. The org counts each against its daily requests, and the records none
 * (asked live: a job of 200 deletes cost five). Absent from an answer that
 * does not say, which counts as one.
 */
export type BulkDeleteAnswer = (
  | { kind: 'answered'; rows: ReadonlyArray<{ success: true } | { success: false; error: string }> }
  | { kind: 'aborted' }
  | { kind: 'untouched'; reason: string; code?: string }
) & { requests?: number };

/** What deleting records needs of an org. */
export type DeletionOrg = Pick<OrgSession, 'query' | 'destroy' | 'describe' | 'update'> & {
  /**
   * A query that reads the org's recycle bin too (`queryAll`): what tells a
   * record deleted from one the session cannot see.
   */
  queryDeleted(soql: string): Promise<{ records: unknown[] }>;
  /**
   * Delete `ids` of one object through one Bulk API 2.0 `delete` job, to the
   * recycle bin as a delete over REST sends them, and answer each of them, in
   * their order. Absent, every delete goes over REST.
   *
   * @param signal - A stop before the job is closed aborts it, and the org
   *   deletes none of its records; once closed, the job is awaited.
   */
  bulkDestroy?(
    objectApiName: string,
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<BulkDeleteAnswer>;
  /**
   * Delete `ids` of one object for good through one Bulk API 2.0 `hardDelete`
   * job, answered as {@link bulkDestroy} answers. A method of its own, never
   * an option of the other: an org handed on by a wrapper that knows nothing
   * of it cannot delete for good, rather than send to the recycle bin what
   * was asked to go for good. Absent, nothing is deleted for good.
   */
  bulkHardDestroy?(
    objectApiName: string,
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<BulkDeleteAnswer>;
};

/**
 * Delete `ids` of one object through one Bulk API 2.0 job — `delete` to the
 * recycle bin unless asked for `hardDelete` — as
 * {@link DeletionOrg.bulkDestroy} says: the CSV of their ids, the job's
 * results read back and matched to them by the `Id` each row echoes
 * (`normalizeBulkJobResults`). A row no result names is answered with why.
 *
 * Whatever fails before the job is closed — opened, sent — leaves the org
 * holding nothing to process, and so does a job that failed with no record
 * processed: `untouched`, with the org's code when it gave one — a job of
 * `hardDelete` the user may not send is refused as it is opened. A failure
 * once it is closed throws, as the org may have deleted any of its records.
 */
export async function bulkDeleteJob(
  connection: BulkApiConnection,
  objectApiName: string,
  ids: readonly string[],
  signal?: AbortSignal,
  operation: 'delete' | 'hardDelete' = 'delete',
): Promise<BulkDeleteAnswer> {
  let closed = false;
  /** The job's last state, and its message, as the org last told it. */
  let last: { state?: string; message?: string } = {};
  /** Rows the job's results answer, written or refused: none, and it processed nothing. */
  let processed = 0;
  /** The calls the job sent the org, each one of its daily requests. */
  let requests = 0;
  const sent = <T>(calls: number, call: () => Promise<T>): Promise<T> => {
    requests += calls;
    return call();
  };
  // The job, told what the org did with it: jsforce's handle, as the executor drives it.
  const tracked: BulkApiConnection = {
    bulk2: {
      createJob: (options) => {
        const job = connection.bulk2.createJob(options);
        return {
          get id() {
            return job.id;
          },
          open: () => sent(1, () => job.open()),
          uploadData: (csv) => sent(1, () => job.uploadData(csv)),
          close: async () => {
            await sent(1, () => job.close());
            closed = true;
          },
          abort: () => sent(1, () => job.abort()),
          check: async () => {
            const status = await sent(1, () => job.check());
            last = { state: status.state, message: status.errorMessage };
            return status;
          },
          getAllResults: async () => {
            // Its successful, failed and unprocessed records: three reads.
            const results = await sent(BULK_RESULT_READS, () => job.getAllResults());
            processed = Array.isArray(results)
              ? results.length
              : (results.successfulResults?.length ?? 0) + (results.failedResults?.length ?? 0);
            return results;
          },
        };
      },
    },
  };
  let result: Awaited<ReturnType<BulkApiExecutor['executeBulk']>>;
  try {
    result = await new BulkApiExecutor().executeBulk(
      // One job at a time, and nothing else of the removal's own shares them.
      { connection: tracked, bulkManager: new BulkApiManager(1), ...(signal ? { signal } : {}) },
      objectApiName,
      // A delete sends the records to the recycle bin, as a REST delete does;
      // a hard delete, nowhere.
      operation,
      ids.map((Id) => ({ Id })),
    );
  } catch (err: unknown) {
    if (!closed) {
      const code = (err as { errorCode?: unknown } | null)?.errorCode;
      return {
        kind: 'untouched',
        reason: extractErrorMessage(err),
        ...(typeof code === 'string' && code !== '' ? { code } : {}),
        requests,
      };
    }
    throw err;
  }
  if (result.aborted) return { kind: 'aborted', requests };
  if (last.state !== 'JobComplete' && processed === 0) {
    return {
      kind: 'untouched',
      reason: last.message || `job ${last.state ?? 'not complete'}`,
      requests,
    };
  }
  const byRow = new Map(result.outcomes.map((outcome) => [outcome.recordIndex, outcome]));
  return {
    kind: 'answered',
    requests,
    rows: ids.map((_, at) => {
      const outcome = byRow.get(at);
      if (outcome?.success) return { success: true };
      return { success: false, error: outcome?.error ?? 'The job gave no result for it.' };
    }),
  };
}

/**
 * The org a delete works on, over a jsforce connection: the session the
 * cleanup work uses, its recycle bin, and its Bulk API 2.0 for jobs that
 * delete to the bin and for jobs that delete for good.
 *
 * @param conn - The org's connection.
 * @param context - Names the work in the API-usage warnings.
 */
export function deletionOrg(conn: Connection, context: string): DeletionOrg {
  const bulk = conn as unknown as BulkApiConnection;
  return {
    ...orgSession(conn, context),
    queryDeleted: async (soql) => {
      const answer = await conn.query<Record<string, unknown>>(soql, { scanAll: true });
      return { records: answer.records };
    },
    bulkDestroy: (objectApiName, ids, signal) => bulkDeleteJob(bulk, objectApiName, ids, signal),
    bulkHardDestroy: (objectApiName, ids, signal) =>
      bulkDeleteJob(bulk, objectApiName, ids, signal, 'hardDelete'),
  };
}

/** One row of a delete's answer, or an update's. */
export const writeResultSchema = z
  .object({
    success: z.boolean(),
    errors: z
      .array(
        z.union([
          z
            .object({
              statusCode: z.string().optional(),
              errorCode: z.string().optional(),
              message: z.string().optional(),
            })
            .loose(),
          z.string(),
        ]),
      )
      .optional(),
  })
  .loose();

type WriteError = NonNullable<z.infer<typeof writeResultSchema>['errors']>[number];

/** A record by its first fifteen characters: the same record, whichever length its id is written in. */
function recordKey(id: string): string {
  return id.slice(0, 15);
}

/** The code of a write's error, whichever name the answer gave it. */
function codeOf(error: WriteError): string | undefined {
  return typeof error === 'string' ? undefined : (error.statusCode ?? error.errorCode);
}

/** One error of a write, as the org said it: `CODE: message`. */
export function describeError(error: WriteError): string {
  if (typeof error === 'string') return error;
  const code = codeOf(error);
  const message = error.message ?? '';
  return code && message ? `${code}: ${message}` : code || message || 'The org gave no reason.';
}

/** A SOQL query of the org, answering its rows. */
export function queryOf(org: Pick<OrgSession, 'query'>): SoqlQuery {
  return async (soql) => {
    const answer = await org.query(soql);
    return answer.records.filter(
      (row): row is Record<string, unknown> => typeof row === 'object' && row !== null,
    );
  };
}

/**
 * What a delete did to one record, and how many times it was sent again
 * because the org could not lock it (`lockResends`), when it was.
 */
export type DeleteOutcome = (
  | { kind: 'deleted' }
  | { kind: 'gone' }
  | {
      kind: 'refused';
      reason: string;
      dependency: boolean;
      /** Refused for a limit of the target's automation, and why it was not sent again. */
      limit?: LimitNote;
      /** Refused because the org could not lock it, or a record its delete needed. */
      locked?: true;
    }
) & { lockResends?: number };

/** How a delete sends again what the org could not lock. */
export interface LockResends {
  /** Asked before each send again: a stop leaves the record refused as the org last refused it. */
  stopped?: () => boolean;
  /** Waits `ms` before a send again; a timer when absent. */
  wait?: (ms: number) => Promise<void>;
}

/** Wait `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The wait before the send again numbered `resend`, from 0: doubled each time, its upper half left to chance. */
function lockDelayOf(resend: number): number {
  const delay = LOCK_RESEND_DELAY_MS * 2 ** resend;
  return Math.floor(delay / 2 + Math.random() * (delay / 2));
}

/**
 * `send` the records `ids`, then send again, up to {@link LOCK_RESENDS}
 * times, a wait before each, those it refused for a lock alone: each then
 * answers as its last send did, with how many times it went again. A send
 * that answers nothing (`undefined`) — a job aborted, or not handed over —
 * leaves its records as they stood.
 */
async function resendingLocked(
  ids: readonly string[],
  send: (ids: readonly string[]) => Promise<readonly DeleteOutcome[] | undefined>,
  first: readonly DeleteOutcome[],
  hooks: LockResends,
): Promise<DeleteOutcome[]> {
  const outcomes = [...first];
  for (let resend = 0; resend < LOCK_RESENDS; resend++) {
    const locked = outcomes.flatMap((outcome, at) =>
      outcome.kind === 'refused' && outcome.locked === true ? [at] : [],
    );
    if (locked.length === 0 || hooks.stopped?.() === true) break;
    await (hooks.wait ?? sleep)(lockDelayOf(resend));
    if (hooks.stopped?.() === true) break;
    const again = await send(locked.map((at) => ids[at]));
    if (again === undefined) break;
    locked.forEach((at, index) => {
      const outcome = again[index];
      if (outcome) outcomes[at] = { ...outcome, lockResends: resend + 1 };
    });
  }
  return outcomes;
}

/**
 * Delete one batch over REST and say what became of each record: deleted,
 * already gone — deleted since it was read, often along with a parent — or
 * refused, with the org's reason. A call the org refuses whole refuses every
 * record of it. A record the org could not lock goes again, alone with the
 * others it refused so, up to {@link LOCK_RESENDS} times.
 */
export async function deleteBatch(
  org: Pick<DeletionOrg, 'destroy' | 'query'>,
  objectApiName: string,
  batch: readonly string[],
  hooks: LockResends = {},
): Promise<DeleteOutcome[]> {
  if (objectApiName === FILE_VERSION) return deleteVersions(org, batch, hooks);
  const once = (ids: readonly string[]): Promise<DeleteOutcome[]> =>
    deleteOnce(org, objectApiName, ids);
  return resendingLocked(batch, once, await once(batch), hooks);
}

/** One delete call over REST, as {@link deleteBatch} reads its answer. */
async function deleteOnce(
  org: Pick<DeletionOrg, 'destroy'>,
  objectApiName: string,
  batch: readonly string[],
): Promise<DeleteOutcome[]> {
  let answer: unknown;
  try {
    answer = await org.destroy(objectApiName, [...batch]);
  } catch (err: unknown) {
    const reason = extractErrorMessage(err);
    return batch.map(() => ({ kind: 'refused', reason, dependency: false }));
  }
  const rows = Array.isArray(answer) ? answer : [answer];
  return batch.map((_, index): DeleteOutcome => {
    const row = writeResultSchema.safeParse(rows[index]);
    if (row.success && row.data.success) return { kind: 'deleted' };
    const errors = row.success ? (row.data.errors ?? []) : [];
    if (errors.some((error) => codeOf(error) === 'ENTITY_IS_DELETED')) return { kind: 'gone' };
    const locked = errors.length > 0 && errors.every((error) => codeOf(error) === LOCK_REFUSAL);
    return {
      kind: 'refused',
      reason: errors.length > 0 ? describeError(errors[0]) : 'The org gave no reason.',
      dependency: errors.some((error) => codeOf(error) === DEPENDENCY_REFUSAL),
      ...(locked ? { locked: true as const } : {}),
    };
  });
}

/** What a job ended with that leaves its records unanswered. */
export type JobEnd =
  /** Aborted before the org had it: nothing of it was deleted. */
  | 'aborted'
  /** The org deleted none of them by the job: they go over REST, which answers each one. */
  | 'untouched'
  /** The org refused to delete for good, in its words: nothing more is sent. */
  | { hardRefused: string };

/**
 * Delete one job's worth of records through the org's Bulk API 2.0 — to the
 * recycle bin, or for good — and say what became of each, in the words a
 * delete over REST gives it: deleted; already gone — `ENTITY_IS_DELETED`,
 * deleted since it was read; or refused with the org's reason, `CODE: message`
 * as {@link describeError} writes it, and refused for records still hanging
 * from it on `DELETE_FAILED`, tried again as such. A job the org answered
 * with an error that throws refuses every record of it, as a call the org
 * refuses whole does: the org may have deleted any of them, and the second
 * try reads which. A record the org could not lock goes again in a job of
 * its own, of the same kind, up to {@link LOCK_RESENDS} times.
 *
 * For good, nothing ever goes over REST, which would send to the recycle bin
 * what was asked to go for good: a job not handed over refuses its records
 * with why, and one the org refuses to open for want of Bulk API Hard Delete
 * — or an org that cannot send such a job at all — ends with the refusal.
 *
 * @returns The outcomes, or how the job ended without them: see {@link JobEnd}.
 */
export async function deleteByJob(
  org: Pick<DeletionOrg, 'bulkDestroy' | 'bulkHardDestroy'>,
  objectApiName: string,
  batch: readonly string[],
  mode: DeleteMode = 'recycle',
  hooks: LockResends & { signal?: AbortSignal } = {},
): Promise<DeleteOutcome[] | JobEnd> {
  const job = mode === 'hard' ? org.bulkHardDestroy?.bind(org) : org.bulkDestroy?.bind(org);
  if (job === undefined) {
    return mode === 'hard' ? { hardRefused: HARD_DELETE_UNAVAILABLE } : 'untouched';
  }
  const once = async (ids: readonly string[]): Promise<DeleteOutcome[] | JobEnd> => {
    let answer: BulkDeleteAnswer;
    try {
      answer = await job(objectApiName, ids, hooks.signal);
    } catch (err: unknown) {
      const reason = extractErrorMessage(err);
      return ids.map(() => ({ kind: 'refused', reason, dependency: false }));
    }
    if (answer.kind === 'aborted') return 'aborted';
    if (answer.kind === 'untouched') {
      if (mode !== 'hard') return 'untouched';
      if (answer.code === HARD_DELETE_NOT_ENABLED) {
        return { hardRefused: hardDeleteRefusedNote(answer.reason) };
      }
      const reason = `Not deleted for good: the job was not handed over — ${answer.reason}`;
      return ids.map(() => ({ kind: 'refused', reason, dependency: false }));
    }
    const { rows } = answer;
    return ids.map((_, at): DeleteOutcome => {
      const row = rows[at];
      if (row?.success === true) return { kind: 'deleted' };
      const { code, message } = bulkErrorOf(row?.error ?? '');
      if (code === 'ENTITY_IS_DELETED') return { kind: 'gone' };
      return {
        kind: 'refused',
        reason:
          code && message
            ? `${code}: ${message}`
            : row?.error || code || message || 'The org gave no reason.',
        dependency: code === DEPENDENCY_REFUSAL,
        ...(code === LOCK_REFUSAL ? { locked: true as const } : {}),
      };
    });
  };
  const first = await once(batch);
  if (!Array.isArray(first)) return first;
  return resendingLocked(
    batch,
    async (ids) => {
      const again = await once(ids);
      return Array.isArray(again) ? again : undefined;
    },
    first,
    hooks,
  );
}

/** Why nothing is deleted for good when the connection cannot send a `hardDelete` job at all. */
export const HARD_DELETE_UNAVAILABLE =
  'Records cannot be deleted for good through this connection: nothing was sent.';

/**
 * What a pass that was to delete for good says when the org refused the job
 * as it was opened, for want of Bulk API Hard Delete: the org's words, and
 * that nothing went.
 */
export function hardDeleteRefusedNote(orgWords: string): string {
  return (
    'The user SandForge connects as may not delete records for good in this org: Salesforce ' +
    `refused the job before it held a record (${HARD_DELETE_NOT_ENABLED}: ${orgWords}). ` +
    'Nothing was deleted for good, and nothing was sent to the recycle bin instead.'
  );
}

/** Why a file is never deleted for good: see {@link NEVER_BY_JOB}. */
export const FILE_NOT_FOR_GOOD =
  'A file is never deleted for good: that takes a Bulk API job, which no file was ever sent ' +
  'by. Not sent.';

/**
 * The code and message of an error as Bulk API writes it in `sf__Error`:
 * `CODE:message:fields`, the fields `--` when it names none. An error the job
 * wrote of a row it gave no result for carries no code.
 */
function bulkErrorOf(text: string): { code?: string; message: string } {
  const match = /^([A-Z][A-Z0-9_]*):([\s\S]*?)(?::(?:--|[\w.,]+))?$/.exec(text.trim());
  if (!match) return { message: text.trim() };
  return { code: match[1], message: match[2].trim() };
}

/**
 * Delete the file versions `batch` names by deleting their documents, and say
 * what became of each version: the org deletes no version on its own — its
 * describe says it is not deletable — and a run keeps a version alone when it
 * was stopped before it read the version's document back (`copyFiles`). A
 * version the org no longer holds went with its document.
 */
async function deleteVersions(
  org: Pick<DeletionOrg, 'destroy' | 'query'>,
  batch: readonly string[],
  hooks: LockResends,
): Promise<DeleteOutcome[]> {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = await readRecordsById(org, FILE_VERSION, ['ContentDocumentId'], batch);
  } catch (err: unknown) {
    const reason = extractErrorMessage(err);
    return batch.map(() => ({ kind: 'refused', reason, dependency: false }));
  }
  const documentOf = new Map<string, string>();
  for (const row of rows) {
    if (typeof row.Id === 'string' && typeof row.ContentDocumentId === 'string') {
      documentOf.set(recordKey(row.Id), row.ContentDocumentId);
    }
  }
  const documents = [...new Set(documentOf.values())];
  const outcomes = documents.length > 0 ? await deleteBatch(org, FILE, documents, hooks) : [];
  const byDocument = new Map(documents.map((document, at) => [document, outcomes[at]]));
  return batch.map((id): DeleteOutcome => {
    const document = documentOf.get(recordKey(id));
    if (document === undefined) return { kind: 'gone' };
    return (
      byDocument.get(document) ?? {
        kind: 'refused',
        reason: 'The org gave no answer for its document.',
        dependency: false,
      }
    );
  });
}

/** One delete: a call of up to {@link RECORDS_PER_CALL} records, or a job. */
interface DeleteRound {
  ids: string[];
  /** Sent as a Bulk API 2.0 job rather than over REST. */
  byJob: boolean;
}

/** `ids` cut into calls of {@link RECORDS_PER_CALL}. */
function callsOf(ids: readonly string[]): DeleteRound[] {
  const calls: DeleteRound[] = [];
  for (let at = 0; at < ids.length; at += RECORDS_PER_CALL) {
    calls.push({ ids: ids.slice(at, at + RECORDS_PER_CALL), byJob: false });
  }
  return calls;
}

/**
 * Whether `count` records of one object go by Bulk API jobs: for good,
 * always; to the recycle bin, from {@link BULK_DELETE_THRESHOLD} where the
 * org takes jobs. A file or a file's version never does ({@link NEVER_BY_JOB}).
 */
export function goesByJob(
  org: Pick<DeletionOrg, 'bulkDestroy'>,
  objectApiName: string,
  count: number,
  mode: DeleteMode = 'recycle',
): boolean {
  if (NEVER_BY_JOB.has(objectApiName)) return false;
  return mode === 'hard' || (org.bulkDestroy !== undefined && count >= BULK_DELETE_THRESHOLD);
}

/**
 * The deletes `ids` of one object go in: every custom price before any
 * standard one, which the org refuses while a custom price of its product is
 * left — `UNKNOWN_EXCEPTION` when both went in one call. Each such group of
 * {@link BULK_DELETE_THRESHOLD} records or more goes as jobs of up to
 * {@link BULK_DELETE_JOB_RECORDS}, where the org takes jobs; the rest in calls
 * of {@link RECORDS_PER_CALL}. For good, every group goes as jobs, however
 * small. A file's version is deleted by its document, read first
 * (`deleteVersions`), and a file over REST: never by a job ({@link NEVER_BY_JOB}).
 */
export async function deleteRounds(
  org: Pick<DeletionOrg, 'bulkDestroy' | 'query'>,
  objectApiName: string,
  ids: string[],
  mode: DeleteMode = 'recycle',
): Promise<DeleteRound[]> {
  const rounds: DeleteRound[] = [];
  const byJob =
    !NEVER_BY_JOB.has(objectApiName) && (mode === 'hard' || org.bulkDestroy !== undefined);
  const cut = (list: string[]): void => {
    if (list.length === 0) return;
    if (!byJob || (mode !== 'hard' && list.length < BULK_DELETE_THRESHOLD)) {
      rounds.push(...callsOf(list));
      return;
    }
    // Jobs of one size: 50 500 records go as two of 25 250, not as one of
    // 50 000 and one of 500 that costs as long.
    const size = Math.ceil(list.length / Math.ceil(list.length / BULK_DELETE_JOB_RECORDS));
    for (let at = 0; at < list.length; at += size) {
      rounds.push({ ids: list.slice(at, at + size), byJob: true });
    }
  };
  if (!isPricebookEntry(objectApiName) || ids.length === 0) {
    cut(ids);
    return rounds;
  }
  let standard = new Set<string>();
  try {
    standard = new Set([...(await standardPriceIds(queryOf(org), ids))].map(recordKey));
  } catch {
    // Unread, the prices go as they come: the retry takes what is refused.
  }
  cut(ids.filter((id) => !standard.has(recordKey(id))));
  cut(ids.filter((id) => standard.has(recordKey(id))));
  return rounds;
}

/** The key the sizes of an object's deletes are kept under. */
function deleteKey(objectApiName: string): CallKey {
  return { objectApiName, op: 'delete' };
}

/** How {@link deleteSplittingOnLimits} goes: when to stop, and what to do with each answer. */
export interface LimitedDeletes {
  /** Asked before every call but the first, whose check stays with the caller. */
  stopped: () => boolean;
  /**
   * Told what became of the records of each call, those sent again smaller
   * aside, once: a record refused for a limit and not sent again carries why
   * (`limit`), and is never a dependency's refusal.
   */
  settle: (sent: readonly string[], outcomes: readonly DeleteOutcome[]) => void;
  /** Waits before a record the org could not lock goes again: see {@link LockResends.wait}. */
  wait?: (ms: number) => Promise<void>;
}

/**
 * Delete `ids` of one object over REST, in calls of the size kept for it
 * (`splitting`), and settle what became of each: a call the target's
 * automation refuses for a Salesforce limit goes again — a record on its own
 * first, then in calls half as large, down to one — within the smaller calls
 * the removal allows itself (`sendSplittingOnLimits`). A delete never writes
 * twice: sent again, a record deleted since answers that it is gone. A call
 * the org refused whole — what threw, which `deleteBatch` reads as a refusal
 * of each record — is read as its words say: one that names a limit goes
 * again smaller, as one answered record by record does.
 *
 * @returns Whether a stop came before one of the calls: what it held, and
 *   what came after it, is left unsettled.
 */
export async function deleteSplittingOnLimits(
  org: Pick<DeletionOrg, 'destroy' | 'query'>,
  objectApiName: string,
  ids: readonly string[],
  splitting: LimitSplitting,
  hooks: LimitedDeletes,
): Promise<boolean> {
  const lockResends: LockResends = {
    stopped: hooks.stopped,
    ...(hooks.wait ? { wait: hooks.wait } : {}),
  };
  const { stopped } = await sendSplittingOnLimits<string, DeleteOutcome>(ids, {
    key: deleteKey(objectApiName),
    sizes: splitting.sizes,
    allowance: splitting.allowance,
    beforeEachSend: () => (hooks.stopped() ? 'stop' : undefined),
    send: async (part) => ({ answers: await deleteBatch(org, objectApiName, part, lockResends) }),
    limited: (outcome) =>
      outcome?.kind === 'refused' ? limitCauseOf([outcome.reason]) : undefined,
    settle: (part, answers, again, notes) => {
      const sent: string[] = [];
      const outcomes: DeleteOutcome[] = [];
      part.forEach((id, index) => {
        if (again.has(index)) return;
        const outcome: DeleteOutcome = answers[index] ?? {
          kind: 'refused',
          reason: 'The org gave no answer for it.',
          dependency: false,
        };
        const note = notes.get(index);
        sent.push(id);
        outcomes.push(
          note !== undefined && outcome.kind === 'refused'
            ? { ...outcome, dependency: false, limit: note }
            : outcome,
        );
      });
      if (sent.length > 0) hooks.settle(sent, outcomes);
    },
  });
  return stopped !== undefined;
}

/**
 * What the result of an object a removal or a sweep deleted says of the
 * calls a limit of the target's automation refused: which trigger hit which
 * limit on a call of how many, the size it went at and the calls that cost;
 * the records kept from smaller calls once the allowance was spent; and, for
 * a record refused though sent on its own, what to fix. Nothing when no limit
 * refused a call. Engine English, as the other notes.
 */
export function deleteLimitNotes(objectApiName: string, splitting: LimitSplitting): string[] {
  const key = deleteKey(objectApiName);
  const report = splitting.sizes.report(key);
  if (!report) return [];
  const notes: string[] = [];
  if (report.rows + report.alone + report.notSplit + report.keptWhole > 0) {
    notes.push(smallerCallsNote(report));
  }
  if (report.notSplit > 0) {
    // The object's own share when that is what ran out, the removal's otherwise.
    notes.push(notSplitNote(report.notSplit, allowedFor(splitting.allowance, key), 'removal'));
  }
  if (report.keptWhole > 0) notes.push(GOVERNOR_LIMIT_KEPT_WHOLE);
  else if (report.alone > 0) notes.push(GOVERNOR_LIMIT_ALONE);
  return notes;
}

/**
 * What an object's result says of the records the org could not lock, once
 * they were sent again (`DeleteOutcome.lockResends`): how many, and what
 * became of them in the end. Nothing when none was.
 *
 * @param kinds - What became of each record sent again, by its last answer.
 */
export function lockResendNote(kinds: Iterable<DeleteOutcome['kind']>): string[] {
  let sent = 0;
  let deleted = 0;
  let gone = 0;
  let refused = 0;
  for (const kind of kinds) {
    sent++;
    if (kind === 'deleted') deleted++;
    else if (kind === 'gone') gone++;
    else refused++;
  }
  if (sent === 0) return [];
  const parts = [
    deleted > 0 ? `${deleted} deleted` : '',
    gone > 0 ? `${gone} already gone` : '',
    refused > 0 ? `${refused} still refused` : '',
  ].filter(Boolean);
  return [
    `The org could not lock ${sent} record(s) (${LOCK_REFUSAL}), each sent again up to ` +
      `${LOCK_RESENDS} times, a wait before each: ${parts.join(', ')}.`,
  ];
}

/** How {@link sendDeletes} goes: when to stop, and what to do with each answer. */
export interface SendHooks {
  /** To the recycle bin unless told: see {@link DeleteMode}. */
  mode?: DeleteMode;
  stopped: () => boolean;
  /** The sizes the deletes go at, and the smaller calls a limit may still cost. */
  splitting: LimitSplitting;
  /** Aborts a job the org does not have yet: see {@link DeletionOrg.bulkDestroy}. */
  signal?: AbortSignal;
  /**
   * Read before each delete, with its records: what the caller needs of them
   * while they are still in the org — a file seen through its record may be
   * out of the session's reach once the record is gone.
   */
  prepare?: (batch: readonly string[]) => Promise<void>;
  /** Told what became of the records of each delete, once the org answered it. */
  settle: (sent: readonly string[], outcomes: readonly DeleteOutcome[]) => void;
  /** Waits before a record the org could not lock goes again: see {@link LockResends.wait}. */
  wait?: (ms: number) => Promise<void>;
}

/** How {@link sendDeletes} ended. */
export interface DeletesEnd {
  /** Stopped before it was through: what it had not sent stays unsettled. */
  stopped: boolean;
  /**
   * Set when the org refused to delete for good, in its words: nothing more
   * was sent, and the records not settled stay as they were.
   */
  hardRefused?: string;
}

/**
 * Delete `ids` of one object, in the deletes {@link deleteRounds} cuts them
 * into, and settle what became of each: over REST, a call the target's
 * automation refuses for a limit goes again smaller, in place, each call
 * after the first checked for a stop ({@link deleteSplittingOnLimits}); by
 * job, a job the org deleted none of goes over REST, before anything after
 * it, unless the records were to go for good, which never go over REST.
 */
export async function sendDeletes(
  org: Pick<DeletionOrg, 'destroy' | 'query' | 'bulkDestroy' | 'bulkHardDestroy'>,
  objectApiName: string,
  ids: string[],
  hooks: SendHooks,
): Promise<DeletesEnd> {
  const mode = hooks.mode ?? 'recycle';
  if (mode === 'hard' && NEVER_BY_JOB.has(objectApiName)) {
    if (ids.length > 0) {
      hooks.settle(
        ids,
        ids.map(() => ({ kind: 'refused', reason: FILE_NOT_FOR_GOOD, dependency: false })),
      );
    }
    return { stopped: false };
  }
  const wait = hooks.wait ? { wait: hooks.wait } : {};
  const queue = await deleteRounds(org, objectApiName, ids, mode);
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const { ids: batch, byJob } = next;
    if (hooks.stopped()) return { stopped: true };
    await hooks.prepare?.(batch);
    if (!byJob) {
      const stoppedPart = await deleteSplittingOnLimits(
        org,
        objectApiName,
        batch,
        hooks.splitting,
        {
          stopped: hooks.stopped,
          settle: hooks.settle,
          ...wait,
        },
      );
      if (stoppedPart) return { stopped: true };
      continue;
    }
    const answer = await deleteByJob(org, objectApiName, batch, mode, {
      stopped: hooks.stopped,
      ...wait,
      ...(hooks.signal ? { signal: hooks.signal } : {}),
    });
    if (answer === 'aborted') return { stopped: true };
    if (answer === 'untouched') {
      queue.unshift(...callsOf(batch));
      continue;
    }
    if (!Array.isArray(answer)) return { stopped: true, hardRefused: answer.hardRefused };
    hooks.settle(batch, answer);
  }
  return { stopped: false };
}

/** How {@link retryRounds} goes through the objects a pass deleted. */
export interface RoundHooks<T> {
  stopped: () => boolean;
  /**
   * The records of `object` a round sends: the first round, the ones the org
   * refused that are worth one more try once the rest has gone; the rounds
   * after it, the ones refused for records still hanging from them.
   */
  idsOf: (object: T, round: number) => readonly string[];
  /** Send them, and settle each; whether it was stopped part way. */
  send: (object: T, ids: readonly string[], round: number) => Promise<boolean>;
  /** How many of the object's records are deleted so far. */
  deleted: (object: T) => number;
}

/**
 * The second try, once every object has had its turn: each object's records
 * the org refused go once more, in the order the objects went, then again
 * while a round deletes something more. A record refused at its turn stayed
 * refused when what held it went later in the same pass; a cycle no order
 * breaks ends when a round takes nothing.
 *
 * @returns Whether it was stopped part way.
 */
export async function retryRounds<T>(
  objects: readonly T[],
  hooks: RoundHooks<T>,
): Promise<boolean> {
  for (let round = 0, progress = true; progress; round++) {
    progress = false;
    for (const object of objects) {
      const ids = hooks.idsOf(object, round);
      if (ids.length === 0) continue;
      if (hooks.stopped()) return true;
      const deletedBefore = hooks.deleted(object);
      if (await hooks.send(object, ids, round)) return true;
      if (hooks.deleted(object) > deletedBefore) progress = true;
    }
  }
  return false;
}

/**
 * The plan's objects in the order their records can go: each one after every
 * other object of the plan whose records point at it, and otherwise in the
 * order given. Where objects point at each other, the order given decides,
 * and what the org refuses for it is tried again once the rest is gone.
 *
 * Read from the child relationships the org lists for each object: which
 * objects hold a lookup to it. An object the org cannot describe keeps its
 * place.
 */
export async function removalOrder<T extends { readonly objectApiName: string }>(
  org: Pick<DeletionOrg, 'describe'>,
  plan: readonly T[],
): Promise<T[]> {
  const inPlan = new Set(plan.map((object) => object.objectApiName));
  /** Per object, the objects of the plan it points at. */
  const pointsAt = new Map<string, Set<string>>();
  for (const { objectApiName } of plan) {
    let children: string[];
    try {
      const described = describedObjectSchema.parse(await org.describe(objectApiName));
      children = (described.childRelationships ?? []).map((r) => r.childSObject);
    } catch {
      continue;
    }
    for (const child of children) {
      if (child === objectApiName || !inPlan.has(child)) continue;
      const parents = pointsAt.get(child) ?? new Set<string>();
      parents.add(objectApiName);
      pointsAt.set(child, parents);
    }
  }
  const remaining = [...plan];
  const ordered: T[] = [];
  while (remaining.length > 0) {
    const free = remaining.findIndex(
      (object) =>
        !remaining.some(
          (other) =>
            other !== object && pointsAt.get(other.objectApiName)?.has(object.objectApiName),
        ),
    );
    ordered.push(...remaining.splice(free >= 0 ? free : 0, 1));
  }
  return ordered;
}

/** What reading back the records the org refused to delete found. */
export interface ReadBack {
  /**
   * The ones the org no longer holds that the session had read before their
   * delete: a parent deleted after them took them along.
   */
  gone: string[];
  /**
   * The ones the read could not settle: all of them when it failed, and one
   * it no longer finds that the session had never read — gone, or out of the
   * session's sight. Not checked: never taken for gone.
   */
  unchecked: string[];
  /** Why the read failed, when it did. */
  failure?: string;
}

/**
 * Of the records the org refused to delete, the ones it no longer holds: a
 * parent deleted after them took them along. Read back by their ids. Shared by
 * the removal of a run's records and a reload's purge, which both delete
 * children before their parents.
 *
 * A record the read does not find is gone only if the session read it before
 * its delete: one the session cannot see — kept from it by sharing, or owned
 * by a user whose records it does not reach — comes back from a query no more
 * than a deleted one, and taken for gone, it was counted so while it stayed in
 * the org. One the session never read is not checked, and so is every one of
 * them when the read fails.
 *
 * @param stillThere - Reads the records of `refused` the org holds now.
 * @param seen - Whether the session read a record before its delete.
 */
export async function takenAlong(
  refused: readonly string[],
  stillThere: (ids: readonly string[]) => Promise<ReadonlyArray<Record<string, unknown>>>,
  seen: (id: string) => boolean,
): Promise<ReadBack> {
  if (refused.length === 0) return { gone: [], unchecked: [] };
  let rows: ReadonlyArray<Record<string, unknown>>;
  try {
    rows = await stillThere(refused);
  } catch (err: unknown) {
    return { gone: [], unchecked: [...refused], failure: extractErrorMessage(err) };
  }
  const still = new Set(rows.map((row) => recordKey(String(row.Id))));
  const missing = refused.filter((id) => !still.has(recordKey(id)));
  return { gone: missing.filter(seen), unchecked: missing.filter((id) => !seen(id)) };
}
