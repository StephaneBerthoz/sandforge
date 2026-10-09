import { z } from 'zod';
import {
  canonicalRecordId,
  saveErrorDetail,
  toSaveOutcomes,
  type SaveErrorDetail,
  type SaveOutcome,
} from '../../../core/common/existingRecordMatch.js';
import type { RehearsedRow } from './RehearsalWriter.js';
import { ancestorsOf, type RowFamily } from './rehearsalSample.js';

/** Collections requests one composite call may hold. */
export const COLLECTIONS_PER_CALL = 5;

/** Subrequests one composite call may hold, its Collections requests among them. */
export const SUBREQUESTS_PER_CALL = 25;

/** Rows one Collections request creates. */
export const ROWS_PER_COLLECTION = 200;

/**
 * Objects one Collections request may mix: it creates its rows in chunks of
 * one object each, and takes ten chunks at most. Its rows are sorted by
 * object, so each object is one chunk.
 */
export const OBJECTS_PER_COLLECTION = 10;

/** The status code a subrequest answers with when an earlier one failed and the call stopped. */
const PROCESSING_HALTED = 'PROCESSING_HALTED';

/**
 * A field no object has: the forced update sets it, so that it fails even on
 * a record that existed, on top of the id that names none.
 */
const NO_SUCH_FIELD = 'SandForge_Rehearsal_Rollback__c';

/** One Collections request of a call: rows of one level, created together. */
export interface PlannedCollection {
  /** How far its rows are from the rows that name none ({@link RowFamily.levels}). */
  level: number;
  /** Its rows, by `seq`, sorted by object. */
  seqs: number[];
}

/** One composite call: its Collections requests in order, then the update that fails. */
export interface PlannedCall {
  collections: PlannedCollection[];
}

/**
 * One update a call sends after its Collections requests and before the
 * update that rolls it back: the record it updates, and every record its
 * values name, are rows the call creates.
 */
export interface PlannedUpdate {
  /** The update's own place among the run's updates, for its verdict. */
  seq: number;
  objectApiName: string;
  /** The row of the call whose record it updates, by `seq`. */
  rowSeq: number;
  /** What it sets. A placeholder of a row of the call goes as that row's new id. */
  fields: Record<string, unknown>;
}

/** How many updates a call of `collections` Collections requests has room for. */
export function updatesRoomOf(collections: number): number {
  return Math.max(0, SUBREQUESTS_PER_CALL - collections - 1);
}

/** The calls that judge some rows, and the rows no call can hold with what they need. */
export interface CallPlan {
  calls: PlannedCall[];
  /** By `seq`: rows whose parents are more, or deeper, than one call holds. */
  beyond: number[];
}

/** The Collections requests the rows of one level take, at most 200 rows and ten objects each. */
function collectionsOfLevel(
  level: number,
  seqs: Iterable<number>,
  bySeq: ReadonlyMap<number, RehearsedRow>,
): PlannedCollection[] {
  const rows = [...seqs]
    .flatMap((seq) => {
      const row = bySeq.get(seq);
      return row ? [row] : [];
    })
    .sort((a, b) => a.objectApiName.localeCompare(b.objectApiName) || a.seq - b.seq);
  const collections: PlannedCollection[] = [];
  let current: PlannedCollection | undefined;
  let objects = new Set<string>();
  for (const row of rows) {
    const newObject = !objects.has(row.objectApiName);
    if (
      !current ||
      current.seqs.length >= ROWS_PER_COLLECTION ||
      (newObject && objects.size >= OBJECTS_PER_COLLECTION)
    ) {
      current = { level, seqs: [] };
      objects = new Set();
      collections.push(current);
    }
    current.seqs.push(row.seq);
    objects.add(row.objectApiName);
  }
  return collections;
}

/** The Collections requests a call's rows take, level by level. */
function collectionsOf(
  byLevel: ReadonlyMap<number, ReadonlySet<number>>,
  bySeq: ReadonlyMap<number, RehearsedRow>,
): PlannedCollection[] {
  return [...byLevel.keys()]
    .sort((a, b) => a - b)
    .flatMap((level) => collectionsOfLevel(level, byLevel.get(level) ?? [], bySeq));
}

/**
 * Pack the rows to judge into calls, each row with every row it names in the
 * same call, in an earlier request than its own: the records it needs are
 * created first, in the same transaction, and rolled back with it. A row
 * already in a call as another's parent is judged there. The deepest rows go
 * first, so their parents fill the calls they share.
 *
 * @param toJudge - The rows that still want a verdict.
 */
export function planCalls(toJudge: readonly RehearsedRow[], family: RowFamily): CallPlan {
  const level = (seq: number): number => family.levels.get(seq) ?? 0;
  const order = [...toJudge].sort((a, b) => level(b.seq) - level(a.seq) || a.seq - b.seq);
  const calls: PlannedCall[] = [];
  const beyond: number[] = [];
  const placed = new Set<number>();
  let current = new Map<number, Set<number>>();
  const withFamily = (
    byLevel: ReadonlyMap<number, ReadonlySet<number>>,
    members: readonly number[],
  ): Map<number, Set<number>> => {
    const next = new Map([...byLevel].map(([l, seqs]) => [l, new Set(seqs)]));
    for (const seq of members) {
      const at = next.get(level(seq)) ?? new Set<number>();
      at.add(seq);
      next.set(level(seq), at);
    }
    return next;
  };
  const fits = (byLevel: ReadonlyMap<number, ReadonlySet<number>>): boolean =>
    collectionsOf(byLevel, family.bySeq).length <= COLLECTIONS_PER_CALL;
  for (const row of order) {
    if (placed.has(row.seq)) continue;
    const members = [row.seq, ...ancestorsOf(row.seq, family)];
    const alone = withFamily(new Map(), members);
    if (!fits(alone)) {
      beyond.push(row.seq);
      continue;
    }
    const together = withFamily(current, members);
    if (fits(together)) {
      current = together;
    } else {
      calls.push({ collections: collectionsOf(current, family.bySeq) });
      current = alone;
    }
    for (const seq of members) placed.add(seq);
  }
  if (current.size > 0) calls.push({ collections: collectionsOf(current, family.bySeq) });
  return { calls, beyond: beyond.sort((a, b) => a - b) };
}

/** One subrequest of a composite call. */
export interface CompositeSubrequest {
  method: 'POST' | 'PATCH';
  url: string;
  referenceId: string;
  body: unknown;
  httpHeaders?: Record<string, string>;
}

/** The body of `POST /composite`. */
export interface CompositeRequestBody {
  allOrNone: true;
  /**
   * Run the subrequests in the order sent. Left to the platform, it ran
   * those that name no other first: in a live trap org, the update that
   * rolls the call back ran before two of the call's updates, which were
   * never tried, and its own refusal answered in the place of the first of
   * them. A verdict is read from where a subrequest stands against the one
   * the call stopped at; out of order, that says nothing.
   */
  collateSubrequests: false;
  compositeRequest: CompositeSubrequest[];
}

/** The reference id of a call's `index`-th Collections request. */
function collectionRef(index: number): string {
  return `rows${index}`;
}

/** The reference id of a call's `index`-th update. */
function updateRef(index: number): string {
  return `update${index}`;
}

/** The reference id of the update that ends a call, and fails. */
const ROLLBACK_REF = 'rollback';

/**
 * The composite request of a call, all or none: each Collections request
 * creates its rows one by one (`allOrNone: false` inside, so each row gets
 * its own verdict), a lookup to a row of an earlier request reads that row's
 * new id from its answer (`@{rowsN[i].id}`); then each update the run makes
 * after its inserts of a record the call creates, one subrequest each, its
 * record and the records its values name read the same way; and the call
 * ends on an update of a record that does not exist, which fails. One
 * subrequest failing rolls back every write of the call: either a row or an
 * update is refused and the call stops there, or every write is made and the
 * last update fails on its own. The subrequests run in the order sent
 * ({@link CompositeRequestBody.collateSubrequests}).
 *
 * @param apiPath - The target's REST API path, `/services/data/vXX.X`.
 * @param headers - The headers of a Forge write, sent with each Collections
 *   request and each update, as the run sends them with its updates. Only
 *   there does a subrequest read them: in a trap org, the duplicate header
 *   sent with the composite call alone left an Alert rule refusing a twin
 *   the run would have written, and sent with the Collections request it let
 *   it through (the trap kit's probe 14).
 * @param rowOf - The row a value stands for, when it is a placeholder.
 * @param updates - The updates the call sends after its inserts.
 * @throws When a row or an update names a record the run creates that the
 *   call does not hold, or the call would hold more subrequests than one may.
 */
export function compositeBody(
  call: PlannedCall,
  family: Pick<RowFamily, 'bySeq'>,
  rowOf: (value: unknown) => RehearsedRow | undefined,
  apiPath: string,
  headers: Readonly<Record<string, string>>,
  updates: readonly PlannedUpdate[] = [],
): CompositeRequestBody {
  if (updates.length > updatesRoomOf(call.collections.length)) {
    throw new Error(
      `A rehearsal call of ${call.collections.length} Collections request(s) has no room for ` +
        `${updates.length} update(s): a call holds ${SUBREQUESTS_PER_CALL} subrequests`,
    );
  }
  const at = new Map<number, string>();
  call.collections.forEach((collection, index) =>
    collection.seqs.forEach((seq, position) =>
      at.set(seq, `@{${collectionRef(index)}[${position}].id}`),
    ),
  );
  const rowsOf = (collection: PlannedCollection): RehearsedRow[] =>
    collection.seqs.map((seq) => {
      const row = family.bySeq.get(seq);
      if (!row) throw new Error(`Row ${seq} is not among the rows the run creates`);
      return row;
    });
  const compositeRequest: CompositeSubrequest[] = call.collections.map((collection, index) => ({
    method: 'POST',
    url: `${apiPath}/composite/sobjects`,
    referenceId: collectionRef(index),
    body: {
      allOrNone: false,
      records: rowsOf(collection).map((row) => {
        const record: Record<string, unknown> = { attributes: { type: row.objectApiName } };
        for (const [field, value] of Object.entries(row.fields)) {
          if (field === 'attributes' || field === 'Id') continue;
          const parent = rowOf(value);
          if (!parent) {
            record[field] = value;
            continue;
          }
          const reference = at.get(parent.seq);
          if (reference === undefined) {
            throw new Error(
              `${row.objectApiName} row ${row.seq} names a record the run creates that its call does not hold`,
            );
          }
          record[field] = reference;
        }
        return record;
      }),
    },
    httpHeaders: { ...headers },
  }));
  updates.forEach((update, index) => {
    const record = at.get(update.rowSeq);
    if (record === undefined) {
      throw new Error(
        `An update of ${update.objectApiName} names a record its call does not create`,
      );
    }
    const body: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(update.fields)) {
      if (field === 'attributes' || field === 'Id') continue;
      const parent = rowOf(value);
      if (!parent) {
        body[field] = value;
        continue;
      }
      const reference = at.get(parent.seq);
      if (reference === undefined) {
        throw new Error(
          `An update of ${update.objectApiName} names a record the run creates that its call does not hold`,
        );
      }
      body[field] = reference;
    }
    compositeRequest.push({
      method: 'PATCH',
      url: `${apiPath}/sobjects/${update.objectApiName}/${record}`,
      referenceId: updateRef(index),
      body,
      httpHeaders: { ...headers },
    });
  });
  const first = call.collections[0]?.seqs[0];
  const firstRow = first === undefined ? undefined : family.bySeq.get(first);
  if (!firstRow) throw new Error('A rehearsal call holds no row');
  compositeRequest.push({
    method: 'PATCH',
    url: `${apiPath}/sobjects/${firstRow.objectApiName}/${noSuchRecord(firstRow.placeholderId)}`,
    referenceId: ROLLBACK_REF,
    body: { [NO_SUCH_FIELD]: true },
  });
  return { allOrNone: true, collateSubrequests: false, compositeRequest };
}

/**
 * An id of the object no record holds: its key prefix, then a record number
 * of zero, which no org gives.
 */
function noSuchRecord(placeholder: string): string {
  return canonicalRecordId(`${placeholder.slice(0, 3)}000000000000`) ?? '000000000000000AAA';
}

/** What one Collections request of a call came to. */
export type CollectionAnswer =
  /** Stopped, or its body lost: the call stopped at another subrequest. */
  | { kind: 'halted' }
  /** Each row's verdict, index-aligned with its rows. */
  | { kind: 'rows'; outcomes: SaveOutcome[] }
  /** Refused whole, before any row: each row gets these errors. */
  | { kind: 'refused'; errors: SaveErrorDetail[] };

/** What one update of a call came to. */
export type UpdateAnswer =
  /** Stopped, or its answer lost: the call stopped at another subrequest. */
  | { kind: 'halted' }
  /** Made: the call stopped after it, or failed on its closing update. */
  | { kind: 'saved' }
  /** Refused, with the platform's errors. */
  | { kind: 'refused'; errors: SaveErrorDetail[] };

/** What a composite call came to. */
export type CallAnswer =
  | { kind: 'rolled_back'; collections: CollectionAnswer[]; updates: UpdateAnswer[] }
  /**
   * The closing update did not fail, so the call was committed: the records
   * it created are in the target. `ids` are those its answer names.
   */
  | { kind: 'not_rolled_back'; ids: string[] };

const subresponseSchema = z
  .object({ body: z.unknown(), httpStatusCode: z.number(), referenceId: z.string().optional() })
  .loose();
const compositeAnswerSchema = z.object({ compositeResponse: z.array(subresponseSchema) }).loose();
const errorBodySchema = z.array(
  z.object({ errorCode: z.string().optional(), statusCode: z.string().optional() }).loose(),
);
const saveResultsSchema = z.array(z.object({ success: z.boolean() }).loose());

type Subresponse = z.infer<typeof subresponseSchema>;

/** Whether a subrequest was stopped because another failed: its body is lost. */
function halted(sub: Subresponse): boolean {
  const errors = errorBodySchema.safeParse(sub.body);
  return (
    sub.httpStatusCode >= 400 &&
    errors.success &&
    errors.data.length > 0 &&
    errors.data.every((e) => (e.errorCode ?? e.statusCode) === PROCESSING_HALTED)
  );
}

/**
 * Read a composite call's answer, collection by collection, then update by
 * update.
 *
 * The call stops at the first subrequest that fails. A Collections request
 * one of whose rows was refused answers with every row's verdict; one that
 * passed whole before the stop loses its body, and reads as stopped. An
 * update refused answers with its errors; one made before the stop reads as
 * stopped too. When every write was made, each reads as stopped and the
 * closing update fails on its own: every row and update would have saved. A
 * closing update that did not fail means no subrequest did, and nothing was
 * rolled back.
 *
 * @param updates - How many updates the call sent after its Collections requests.
 * @throws When the answer is not a composite answer of this call.
 */
export function readCompositeAnswer(raw: unknown, call: PlannedCall, updates = 0): CallAnswer {
  const parsed = compositeAnswerSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error('The target answered the rehearsal with no composite answer');
  const subs = parsed.data.compositeResponse;
  const sent = call.collections.length + updates + 1;
  const closing = subs[sent - 1];
  if (subs.length !== sent || !closing) {
    throw new Error(
      `The target answered ${subs.length} subrequests of the ${sent} the rehearsal sent`,
    );
  }
  // The platform lists the subrequests in the order it ran them: one out of
  // the order sent would have its verdict read from another's place.
  const order = [
    ...call.collections.map((_, index) => collectionRef(index)),
    ...Array.from({ length: updates }, (_, index) => updateRef(index)),
    ROLLBACK_REF,
  ];
  const misplaced = subs.findIndex(
    (sub, index) => sub.referenceId !== undefined && sub.referenceId !== order[index],
  );
  if (misplaced !== -1) {
    throw new Error(
      `The target ran the rehearsal's subrequests out of the order sent (${String(
        subs[misplaced]?.referenceId,
      )} in place of ${order[misplaced]}): no verdict can be read from it`,
    );
  }
  const collections = call.collections.map((collection, index): CollectionAnswer => {
    const sub = subs[index];
    if (halted(sub)) return { kind: 'halted' };
    const results = saveResultsSchema.safeParse(sub.body);
    if (sub.httpStatusCode < 400 && results.success) {
      if (results.data.length !== collection.seqs.length) {
        throw new Error(
          `The target answered ${results.data.length} rows of the ${collection.seqs.length} a request sent`,
        );
      }
      return { kind: 'rows', outcomes: toSaveOutcomes(sub.body, '') };
    }
    const errors = errorBodySchema.safeParse(sub.body);
    if (sub.httpStatusCode >= 400 && errors.success && errors.data.length > 0) {
      return { kind: 'refused', errors: errors.data.map(saveErrorDetail) };
    }
    throw new Error(
      `The target answered a request of the rehearsal with status ${sub.httpStatusCode}`,
    );
  });
  const updateAnswers = Array.from({ length: updates }, (_, index): UpdateAnswer => {
    const sub = subs[call.collections.length + index];
    if (halted(sub)) return { kind: 'halted' };
    if (sub.httpStatusCode < 400) return { kind: 'saved' };
    const errors = errorBodySchema.safeParse(sub.body);
    if (errors.success && errors.data.length > 0) {
      return { kind: 'refused', errors: errors.data.map(saveErrorDetail) };
    }
    throw new Error(
      `The target answered an update of the rehearsal with status ${sub.httpStatusCode}`,
    );
  });
  if (closing.httpStatusCode < 400) {
    return {
      kind: 'not_rolled_back',
      ids: collections.flatMap((answer) =>
        answer.kind === 'rows' ? answer.outcomes.filter((o) => o.success).map((o) => o.id) : [],
      ),
    };
  }
  // Stopped, the closing update says a request before it failed: one that
  // names none would have every row read as created when one was refused.
  if (
    halted(closing) &&
    stopOf(collections) === -1 &&
    !updateAnswers.some((answer) => answer.kind === 'refused')
  ) {
    throw new Error('The target stopped the rehearsal at a request whose answer names no refusal');
  }
  return { kind: 'rolled_back', collections, updates: updateAnswers };
}

/** The request a call stopped at: the first one refused whole or with a row refused; -1 for none. */
function stopOf(answer: readonly CollectionAnswer[]): number {
  return answer.findIndex(
    (collection) =>
      collection.kind === 'refused' ||
      (collection.kind === 'rows' && collection.outcomes.some((o) => !o.success)),
  );
}

/** A row's verdict, from one call. */
export type RowVerdict = { passed: true } | { passed: false; errors: SaveErrorDetail[] };

/**
 * Each row's verdict from a call's answer: every row of the requests before
 * the one the call stopped at was created; the rows of that one have their
 * own verdict; the rows after it were never tried, and get none.
 */
export function verdictsOf(call: PlannedCall, answer: CollectionAnswer[]): Map<number, RowVerdict> {
  const verdicts = new Map<number, RowVerdict>();
  const stop = stopOf(answer);
  call.collections.forEach((collection, index) => {
    if (stop !== -1 && index > stop) return;
    const own = answer[index];
    collection.seqs.forEach((seq, position) => {
      if (own.kind === 'refused') {
        verdicts.set(seq, { passed: false, errors: own.errors });
        return;
      }
      const outcome = own.kind === 'rows' ? own.outcomes[position] : undefined;
      verdicts.set(
        seq,
        outcome && !outcome.success
          ? { passed: false, errors: outcome.errorDetails ?? [] }
          : { passed: true },
      );
    });
  });
  return verdicts;
}

/**
 * Each update's verdict from a call's answer, by its `seq`: none when the
 * call stopped at a Collections request, before any update was tried; every
 * update before the one refused was made; that one has its errors; those
 * after it were never tried, and get none.
 */
export function updateVerdictsOf(
  updates: readonly PlannedUpdate[],
  answer: Extract<CallAnswer, { kind: 'rolled_back' }>,
): Map<number, RowVerdict> {
  const verdicts = new Map<number, RowVerdict>();
  if (stopOf(answer.collections) !== -1) return verdicts;
  for (const [index, update] of updates.entries()) {
    const own = answer.updates[index];
    if (own?.kind === 'refused') {
      verdicts.set(update.seq, { passed: false, errors: own.errors });
      break;
    }
    verdicts.set(update.seq, { passed: true });
  }
  return verdicts;
}
