/**
 * Many reads of one org in few API requests: the data API's `/composite`
 * resource carries several queries and describes in one call, each answered
 * on its own.
 *
 * What it takes was asked of a scratch org and a Developer Edition org, both
 * answering alike:
 *
 * - at most five of a call's subrequests may be a query, a `queryAll` or the
 *   next page of a cursor. The sixth is not run: it answers
 *   `PROCESSING_HALTED` ("Limit number of query or Collections in Rest
 *   Operations reached.") while the call itself answers 200, so a halted
 *   query is told from its own answer, never from the call's;
 * - twenty-five subrequests at most, whatever they are: five queries and
 *   twenty describes passed, and a call of twenty-six was refused whole
 *   (`LIMIT_EXCEEDED`, "The request can’t contain more than 25 operations.");
 * - one call costs the org one of its daily API requests, whatever it holds:
 *   forty calls of five queries took 37 to 53 requests off the day, not 200,
 *   and a whole window 189 for the 190 calls sent. A read is budgeted by its
 *   calls, never by its subrequests;
 * - a describe asked with `If-Modified-Since` answers 304 with no body when
 *   the object has not changed since.
 *
 * Cursors. A user was said to hold at most ten open query cursors. Over REST,
 * the org showed no such limit: with 150 open, the oldest one, untouched,
 * still read its next page, and the cursors a composite opens outlive the
 * call. So nothing here counts cursors. A read still drains the cursors it
 * opened together before it opens others (`orgStreams.ts`): pages are written
 * to disk as they arrive and a cursor left idle can expire, and neither may
 * depend on how many objects a checkpoint holds.
 *
 * Page size. `Sforce-Query-Options: batchSize` holds only for the page of the
 * request that carries it: the next pages of the same cursor came back with
 * 2,000 rows, then 1,972. Nothing here asks for a size, and nothing reads one
 * into a page: a cursor is followed by its `nextRecordsUrl` until the org says
 * it is done.
 *
 * The one-call route. Each query can also go in a call of its own, through
 * the connection's `query` and `queryMore`. It is taken when the org will not
 * take a composite — it refuses the call whole with its own words, answers
 * with something that is no composite answer, or runs none of the queries a
 * call holds — and kept for the rest of the read: a read that cannot go five
 * at a time still goes, one at a time. A call that never reached the org (the
 * connection dropped) is no such answer: the reads it carried fail with it,
 * as a single call's would.
 */

import type { Connection } from 'jsforce';
import * as z from 'zod';
import { sanitizeSoqlObjectName } from '@sandforge/shared';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import type { QueryPage } from '../forge/queryAllPages.js';

/**
 * Query, `queryAll` and next-page subrequests one composite runs, first pages
 * and next pages together: the sixth is halted.
 */
export const QUERIES_PER_COMPOSITE = 5;

/**
 * Subrequests one composite holds, its queries among them: twenty-five
 * describes alone, or twenty-five less the queries beside them.
 */
export const SUBREQUESTS_PER_COMPOSITE = 25;

/** A row of a query's answer, as the org gives it. */
export type OrgRow = Record<string, unknown>;

/** One page of a query, and the count of the rows the whole query selects. */
export interface CountedPage extends QueryPage<OrgRow> {
  /** `SELECT COUNT()` answers with this and no rows. */
  totalSize?: number;
}

/** What a describe came to: the org's answer, or that nothing changed since the date asked. */
export type DescribeAnswer = { body: unknown } | { notModified: true };

/**
 * What the reads need of a connection to an org: its API version, the
 * composite call, and the one-call route.
 */
export interface CompositeQueryConnection {
  /** The API version the connection speaks: `66.0`. */
  version: string;
  request(request: {
    method: 'GET' | 'POST';
    url: string;
    body?: string;
    headers?: Record<string, string>;
  }): Promise<unknown>;
  query(soql: string, options?: { scanAll?: boolean }): Promise<CountedPage>;
  queryMore(nextRecordsUrl: string): Promise<CountedPage>;
}

/** A jsforce connection, as the reads need it. */
export function compositeConnectionOf(conn: Connection): CompositeQueryConnection {
  return {
    get version() {
      return conn.version;
    },
    request: async (request) => await conn.request<unknown>(request),
    query: async (soql, options) =>
      await conn.query<OrgRow>(soql, { scanAll: options?.scanAll === true }),
    queryMore: async (nextRecordsUrl) => await conn.queryMore<OrgRow>(nextRecordsUrl),
  };
}

/** Why a read ended before its rows: the run was stopped, by its signal. */
export class OrgReadStopped extends Error {
  constructor() {
    super('The read was stopped.');
    this.name = 'OrgReadStopped';
  }
}

/**
 * One cursor's pages, carried by the reader's composites beside other
 * cursors': the shape of a jsforce connection's `query` and `queryMore`
 * (SyncDelta's `DeltaQuerySource`), one page asked at a time.
 */
export interface CompositeLane {
  query(soql: string, options?: { scanAll?: boolean }): Promise<CountedPage>;
  queryMore(nextRecordsUrl: string): Promise<CountedPage>;
  /** The read is over: its next composites wait for it no more. */
  close(): void;
}

/** Reads of one org that share composites. */
export interface CompositeReader {
  /**
   * A lane for one cursor. A composite of queries is sent once every open
   * lane has asked its page, so the cursors of reads run together advance
   * together, a page each a call. Close it once the read ended. Between two
   * pages a read waits on nothing that goes through another lane of the same
   * reader: that lane's page would wait for this one's.
   */
  lane(): CompositeLane;
  /**
   * An object's describe, sent beside the queries of a composite, or in one of
   * twenty-five describes. Asked with `modifiedSince`, an object that has not
   * changed since answers `notModified`.
   */
  describe(objectApiName: string, modifiedSince?: string): Promise<DescribeAnswer>;
  /** Calls sent so far, composites and single calls: the requests they cost the org. */
  calls(): number;
}

/** What a page is asked for: a query's first page, or the next page of its cursor. */
type PageAsk = { kind: 'first'; soql: string; scanAll: boolean } | { kind: 'next'; path: string };

interface Settle<T> {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
}

/** A lane as the reader keeps it. */
interface LaneState {
  /** `idle` holds its last page, or has asked none yet; the queries wait for it. */
  state: 'idle' | 'pending' | 'sent';
  ask?: PageAsk;
  settle?: Settle<CountedPage>;
  /** When it asked: a page asked earlier goes first. */
  order: number;
}

/** A describe as the reader keeps it. */
interface DescribeAsk {
  path: string;
  headers?: Record<string, string>;
  settle: Settle<DescribeAnswer>;
}

/** The code the org halts a subrequest with past its limit of queries. */
const PROCESSING_HALTED = 'PROCESSING_HALTED';

/** The header a describe asks whether the object changed with. */
const IF_MODIFIED_SINCE = 'If-Modified-Since';

/** An API version as a subrequest's path carries it. */
const API_VERSION = /^\d{1,3}\.\d$/;

/** The path of a cursor's next page, as the org gives it: `/services/data/v66.0/query/01g…-2000`. */
const NEXT_PAGE_PATH = /^\/services\/data\/v\d{1,3}\.\d\/query(?:All)?\/[A-Za-z0-9-]+$/;

const pageSchema = z
  .object({
    records: z.array(z.record(z.string(), z.unknown())),
    done: z.boolean(),
    totalSize: z.number().optional(),
    nextRecordsUrl: z.string().optional(),
  })
  .loose();

const compositeAnswerSchema = z.object({
  compositeResponse: z.array(
    z.object({ body: z.unknown(), httpStatusCode: z.number(), referenceId: z.string() }).loose(),
  ),
});

const refusalBodySchema = z.array(
  z.object({ errorCode: z.string().optional(), message: z.string().optional() }).loose(),
);

/** A subrequest of a composite, as the org reads it. */
interface Subrequest {
  method: 'GET';
  url: string;
  referenceId: string;
  httpHeaders?: Record<string, string>;
}

/**
 * The body of one composite: `queries` as `q0`…, `describes` as `d0`…, each
 * answered on its own, so a subrequest the org refuses fails alone.
 *
 * @param version - The org's API version, `66.0`.
 * @throws Past {@link QUERIES_PER_COMPOSITE} queries or
 *   {@link SUBREQUESTS_PER_COMPOSITE} subrequests: the org would halt the
 *   one, refuse the call for the other.
 */
export function compositeBody(
  version: string,
  queries: readonly PageAsk[],
  describes: ReadonlyArray<{ path: string; headers?: Record<string, string> }>,
): { allOrNone: false; compositeRequest: Subrequest[] } {
  if (!API_VERSION.test(version)) throw new Error(`Not an API version: ${version}`);
  if (queries.length > QUERIES_PER_COMPOSITE) {
    throw new Error(`A composite runs ${QUERIES_PER_COMPOSITE} queries, not ${queries.length}`);
  }
  if (queries.length + describes.length > SUBREQUESTS_PER_COMPOSITE) {
    throw new Error(
      `A composite holds ${SUBREQUESTS_PER_COMPOSITE} subrequests, not ${queries.length + describes.length}`,
    );
  }
  const api = `/services/data/v${version}`;
  return {
    allOrNone: false,
    compositeRequest: [
      ...queries.map((ask, index): Subrequest => ({
        method: 'GET',
        url:
          ask.kind === 'first'
            ? `${api}/${ask.scanAll ? 'queryAll' : 'query'}?q=${encodeURIComponent(ask.soql)}`
            : ask.path,
        referenceId: `q${index}`,
      })),
      ...describes.map(({ path, headers }, index): Subrequest => ({
        method: 'GET',
        url: `${api}/${path}`,
        referenceId: `d${index}`,
        ...(headers ? { httpHeaders: headers } : {}),
      })),
    ],
  };
}

/** What one subrequest came to. */
type SubAnswer =
  { ok: true; status: number; body: unknown } | { ok: false; refused: string; halted: boolean };

/**
 * The answers of a composite to its subrequests by reference, or undefined
 * when what came back is no composite answer.
 */
function subAnswersOf(raw: unknown): Map<string, SubAnswer> | undefined {
  const parsed = compositeAnswerSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const answers = new Map<string, SubAnswer>();
  for (const sub of parsed.data.compositeResponse) {
    if (sub.httpStatusCode < 400) {
      answers.set(sub.referenceId, { ok: true, status: sub.httpStatusCode, body: sub.body });
      continue;
    }
    const errors = refusalBodySchema.safeParse(sub.body);
    const first = errors.success ? errors.data[0] : undefined;
    answers.set(sub.referenceId, {
      ok: false,
      refused: first
        ? [first.errorCode, first.message].filter(Boolean).join(': ')
        : `status ${sub.httpStatusCode}`,
      // A composite's subrequests name none of one another, so only the
      // org's limit of queries halts one: it was not run.
      halted: first?.errorCode === PROCESSING_HALTED,
    });
  }
  return answers;
}

/** A page from a body the org answered a query with, or undefined when it is none. */
function pageOf(body: unknown): CountedPage | undefined {
  const parsed = pageSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Whether a thrown call is the org's answer — it names its refusal, as
 * jsforce gives it an `errorCode` — rather than a call that never reached it.
 */
function isOrgAnswer(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { errorCode?: unknown }).errorCode === 'string'
  );
}

/**
 * The path a cursor's next page is asked at. jsforce gives it whole, with the
 * org's host; the org gives the path alone.
 *
 * @throws When it is no next page of a query: it would go into a call as is.
 */
export function nextPagePath(nextRecordsUrl: string): string {
  const pathOnly = /^https:\/\//i.test(nextRecordsUrl)
    ? new URL(nextRecordsUrl).pathname
    : nextRecordsUrl;
  if (!NEXT_PAGE_PATH.test(pathOnly)) {
    throw new Error(`Not the next page of a query: ${nextRecordsUrl}`);
  }
  return pathOnly;
}

/**
 * Reads of the org `conn` reaches, sent in composites: each call holds
 * {@link QUERIES_PER_COMPOSITE} queries at most, and as many describes as
 * leave {@link SUBREQUESTS_PER_COMPOSITE} subrequests in all. One call is in
 * flight at a time.
 *
 * A query the org halts goes again, first, in the next call, and every call
 * after holds no more queries than the org ran of that one: an org that runs
 * fewer than it documents is read all the same. One that runs none of them,
 * or will not take the composite at all, is read one call a query.
 *
 * @param signal - The run's Stop: an asked page or describe not yet sent is
 *   given up with {@link OrgReadStopped}, and nothing is sent once it fired.
 */
export function compositeReader(
  conn: CompositeQueryConnection,
  signal?: AbortSignal,
): CompositeReader {
  const lanes = new Set<LaneState>();
  const describes: DescribeAsk[] = [];
  let queryRoom = QUERIES_PER_COMPOSITE;
  let route: 'composite' | 'single' = 'composite';
  let inFlight = false;
  let scheduled = false;
  let ticket = 0;
  let sent = 0;
  // The reader listens to `signal` only while it has a read open or a call
  // out: an operation that makes a reader per read under one signal would
  // otherwise leave a listener on it for each.
  let listening = false;

  const stopAll = (): void => {
    for (const lane of lanes) {
      if (lane.state !== 'pending') continue;
      lane.state = 'idle';
      lane.settle?.reject(new OrgReadStopped());
    }
    for (const ask of describes.splice(0)) ask.settle.reject(new OrgReadStopped());
  };

  const schedule = (): void => {
    if (scheduled) return;
    scheduled = true;
    // A microtask later, so that describes asked together go together.
    queueMicrotask(() => {
      scheduled = false;
      void pump();
    });
  };

  const answerLane = (lane: LaneState, outcome: CountedPage | Error): void => {
    lane.state = 'idle';
    const settle = lane.settle;
    lane.ask = undefined;
    lane.settle = undefined;
    if (outcome instanceof Error) settle?.reject(outcome);
    else settle?.resolve(outcome);
  };

  const sendComposite = async (queries: LaneState[], asks: DescribeAsk[]): Promise<void> => {
    const body = compositeBody(
      conn.version,
      queries.map((lane) => lane.ask as PageAsk),
      asks,
    );
    let raw: unknown;
    sent++;
    try {
      raw = await conn.request({
        method: 'POST',
        url: '/composite',
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err: unknown) {
      if (isOrgAnswer(err)) {
        // The org will not take the call: what it carried goes again, alone.
        route = 'single';
        for (const lane of queries) lane.state = 'pending';
        describes.unshift(...asks);
        return;
      }
      const reason = new Error(extractErrorMessage(err));
      for (const lane of queries) answerLane(lane, reason);
      for (const ask of asks) ask.settle.reject(reason);
      return;
    }
    const answers = subAnswersOf(raw);
    if (!answers) {
      route = 'single';
      for (const lane of queries) lane.state = 'pending';
      describes.unshift(...asks);
      return;
    }
    let halted = 0;
    queries.forEach((lane, index) => {
      const answer = answers.get(`q${index}`);
      if (answer && !answer.ok && answer.halted) {
        halted++;
        lane.state = 'pending';
        return;
      }
      if (!answer) {
        answerLane(lane, new Error('The org gave no answer to this query of the composite'));
        return;
      }
      if (!answer.ok) {
        answerLane(lane, new Error(answer.refused));
        return;
      }
      const page = pageOf(answer.body);
      answerLane(
        lane,
        page ?? new Error(`The org answered a query with status ${answer.status} and no page`),
      );
    });
    if (halted > 0) {
      const ran = queries.length - halted;
      if (ran === 0) route = 'single';
      else queryRoom = Math.min(queryRoom, ran);
    }
    // Describes do not count toward the org's limit of queries: one it did
    // not run is refused like any other, never sent again.
    asks.forEach((ask, index) => {
      const answer = answers.get(`d${index}`);
      if (!answer) {
        ask.settle.reject(new Error('The org gave no answer to this describe of the composite'));
      } else if (!answer.ok) {
        ask.settle.reject(new Error(answer.refused));
      } else {
        ask.settle.resolve(answer.status === 304 ? { notModified: true } : { body: answer.body });
      }
    });
  };

  const sendAlone = async (queries: LaneState[], asks: DescribeAsk[]): Promise<void> => {
    for (const lane of queries) {
      const ask = lane.ask as PageAsk;
      sent++;
      try {
        const page =
          ask.kind === 'first'
            ? await conn.query(ask.soql, { scanAll: ask.scanAll })
            : await conn.queryMore(ask.path);
        answerLane(lane, pageOf(page) ?? new Error('The org answered a query with no page'));
      } catch (err: unknown) {
        answerLane(lane, new Error(extractErrorMessage(err)));
      }
    }
    for (const ask of asks) {
      sent++;
      try {
        const body = await conn.request({
          method: 'GET',
          url: `/services/data/v${conn.version}/${ask.path}`,
          ...(ask.headers ? { headers: ask.headers } : {}),
        });
        // Asked alone, a describe that did not change answers with no body.
        const unchanged =
          ask.headers?.[IF_MODIFIED_SINCE] !== undefined &&
          (body === undefined || body === null || body === '');
        ask.settle.resolve(unchanged ? { notModified: true } : { body });
      } catch (err: unknown) {
        ask.settle.reject(new Error(extractErrorMessage(err)));
      }
    }
  };

  const pump = async (): Promise<void> => {
    if (inFlight) return;
    if (signal?.aborted) {
      stopAll();
      return;
    }
    const open = [...lanes];
    const waiting = open
      .filter((lane) => lane.state === 'pending')
      .sort((a, b) => a.order - b.order);
    // Queries wait for every open lane to have asked: the cursors of reads
    // run together then advance together, a page each a call. Describes go
    // at once, with whatever queries have asked.
    const lanesReady = waiting.length > 0 && !open.some((lane) => lane.state === 'idle');
    if (!lanesReady && describes.length === 0) return;
    const queries = waiting.slice(0, queryRoom);
    const asks = describes.splice(0, SUBREQUESTS_PER_COMPOSITE - queries.length);
    if (queries.length === 0 && asks.length === 0) return;
    for (const lane of queries) lane.state = 'sent';
    inFlight = true;
    try {
      if (route === 'composite') await sendComposite(queries, asks);
      else await sendAlone(queries, asks);
    } catch (err: unknown) {
      // Nothing was sent: the call could not even be written.
      const reason = new Error(extractErrorMessage(err));
      for (const lane of queries) if (lane.state === 'sent') answerLane(lane, reason);
      for (const ask of asks) ask.settle.reject(reason);
    } finally {
      inFlight = false;
      schedule();
      unlistenWhenIdle();
    }
  };
  const onAbort = (): void => {
    listening = false;
    schedule();
  };
  const listen = (): void => {
    if (listening || signal === undefined || signal.aborted) return;
    signal.addEventListener('abort', onAbort, { once: true });
    listening = true;
  };
  const unlistenWhenIdle = (): void => {
    if (!listening || inFlight || lanes.size > 0 || describes.length > 0) return;
    signal?.removeEventListener('abort', onAbort);
    listening = false;
  };

  const ask = (state: LaneState, page: PageAsk): Promise<CountedPage> => {
    if (!lanes.has(state)) return Promise.reject(new Error('This read is closed.'));
    if (state.state !== 'idle') {
      return Promise.reject(new Error('A read asks one page at a time.'));
    }
    if (signal?.aborted) return Promise.reject(new OrgReadStopped());
    return new Promise<CountedPage>((resolve, reject) => {
      state.ask = page;
      state.settle = { resolve, reject };
      state.state = 'pending';
      state.order = ++ticket;
      schedule();
    });
  };

  return {
    lane() {
      const state: LaneState = { state: 'idle', order: 0 };
      lanes.add(state);
      listen();
      return {
        query: (soql, options) =>
          ask(state, { kind: 'first', soql, scanAll: options?.scanAll === true }),
        queryMore: (nextRecordsUrl) => {
          let path: string;
          try {
            path = nextPagePath(nextRecordsUrl);
          } catch (err: unknown) {
            return Promise.reject(err instanceof Error ? err : new Error(String(err)));
          }
          return ask(state, { kind: 'next', path });
        },
        close() {
          if (!lanes.delete(state)) return;
          if (state.state === 'pending') answerLane(state, new Error('This read is closed.'));
          schedule();
          unlistenWhenIdle();
        },
      };
    },

    describe(objectApiName, modifiedSince) {
      if (signal?.aborted) return Promise.reject(new OrgReadStopped());
      return new Promise<DescribeAnswer>((resolve, reject) => {
        const object = sanitizeSoqlObjectName(objectApiName);
        let headers: Record<string, string> | undefined;
        if (modifiedSince !== undefined) {
          const at = Date.parse(modifiedSince);
          if (!Number.isFinite(at)) throw new Error(`Not a date: ${modifiedSince}`);
          headers = { [IF_MODIFIED_SINCE]: new Date(at).toUTCString() };
        }
        listen();
        describes.push({
          path: `sobjects/${object}/describe`,
          ...(headers ? { headers } : {}),
          settle: { resolve, reject },
        });
        schedule();
      });
    },

    calls: () => sent,
  };
}
