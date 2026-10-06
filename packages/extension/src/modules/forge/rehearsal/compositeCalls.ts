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
  compositeRequest: CompositeSubrequest[];
}

/** The reference id of a call's `index`-th Collections request. */
function collectionRef(index: number): string {
  return `rows${index}`;
}

/**
 * The composite request of a call, all or none: each Collections request
 * creates its rows one by one (`allOrNone: false` inside, so each row gets
 * its own verdict), a lookup to a row of an earlier request reads that row's
 * new id from its answer (`@{rowsN[i].id}`), and the call ends on an update
 * of a record that does not exist, which fails. One subrequest failing rolls
 * back every write of the call: either a row is refused and the call stops at
 * its request, or every row is created and the update fails on its own.
 *
 * @param apiPath - The target's REST API path, `/services/data/vXX.X`.
 * @param headers - The headers of a Forge write, sent with each Collections request.
 * @param rowOf - The row a value stands for, when it is a placeholder.
 * @throws When a row names a record the run creates that the call does not hold.
 */
export function compositeBody(
  call: PlannedCall,
  family: Pick<RowFamily, 'bySeq'>,
  rowOf: (value: unknown) => RehearsedRow | undefined,
  apiPath: string,
  headers: Readonly<Record<string, string>>,
): CompositeRequestBody {
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
  const first = call.collections[0]?.seqs[0];
  const firstRow = first === undefined ? undefined : family.bySeq.get(first);
  if (!firstRow) throw new Error('A rehearsal call holds no row');
  compositeRequest.push({
    method: 'PATCH',
    url: `${apiPath}/sobjects/${firstRow.objectApiName}/${noSuchRecord(firstRow.placeholderId)}`,
    referenceId: 'rollback',
    body: { [NO_SUCH_FIELD]: true },
  });
  return { allOrNone: true, compositeRequest };
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

/** What a composite call came to. */
export type CallAnswer =
  | { kind: 'rolled_back'; collections: CollectionAnswer[] }
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
 * Read a composite call's answer, collection by collection.
 *
 * The call stops at the first subrequest that fails. A Collections request
 * one of whose rows was refused answers with every row's verdict; one that
 * passed whole before the stop loses its body, and reads as stopped. When
 * every row was created, each Collections request reads as stopped and the
 * closing update fails on its own: every row would have saved. A closing
 * update that did not fail means no subrequest did, and nothing was rolled
 * back.
 *
 * @throws When the answer is not a composite answer of this call.
 */
export function readCompositeAnswer(raw: unknown, call: PlannedCall): CallAnswer {
  const parsed = compositeAnswerSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error('The target answered the rehearsal with no composite answer');
  const subs = parsed.data.compositeResponse;
  const closing = subs[call.collections.length];
  if (subs.length !== call.collections.length + 1 || !closing) {
    throw new Error(
      `The target answered ${subs.length} subrequests of the ${call.collections.length + 1} the rehearsal sent`,
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
  if (halted(closing) && stopOf(collections) === -1) {
    throw new Error('The target stopped the rehearsal at a request whose answer names no refusal');
  }
  return { kind: 'rolled_back', collections };
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
