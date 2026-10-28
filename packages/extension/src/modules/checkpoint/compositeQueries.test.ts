import { getEventListeners } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Connection } from 'jsforce';
import { compositeOrg, orgError, stampedRows, type FakeOrgCall } from '../../test/compositeOrg.js';
import {
  OrgReadStopped,
  QUERIES_PER_COMPOSITE,
  SUBREQUESTS_PER_COMPOSITE,
  compositeBody,
  compositeConnectionOf,
  compositeReader,
  nextPagePath,
  type CompositeLane,
  type CompositeQueryConnection,
  type CountedPage,
} from './compositeQueries.js';

const T = '2026-10-20T10:00:00Z';
const OBJECTS = ['Account', 'Contact', 'Opportunity', 'Case', 'Lead', 'Task', 'Event'];

/** An org holding `rows` records of each object. */
function orgOf(rows: number, options: Parameters<typeof compositeOrg>[0] = {}) {
  return compositeOrg({
    tables: Object.fromEntries(OBJECTS.map((object) => [object, stampedRows(object, rows, T)])),
    ...options,
  });
}

/** The composites of `calls`, each as its subrequests. */
function composites(calls: readonly FakeOrgCall[]): string[][] {
  return calls.flatMap((call) => (call.kind === 'composite' ? [call.subrequests] : []));
}

/** The query and next-page subrequests of a composite. */
function queriesOf(subrequests: readonly string[]): string[] {
  return subrequests.filter((sub) => !sub.startsWith('describe:'));
}

/** Every page of `soql` read through `lane`, then the lane closed. */
async function drain(
  lane: CompositeLane,
  soql: string,
  scanAll = false,
  /** What the read does with a page before it asks the next: write it to disk, say. */
  between: () => Promise<void> = async () => undefined,
): Promise<CountedPage[]> {
  const pages: CountedPage[] = [];
  try {
    let page = await lane.query(soql, { scanAll });
    pages.push(page);
    while (!page.done && page.nextRecordsUrl) {
      await between();
      page = await lane.queryMore(page.nextRecordsUrl);
      pages.push(page);
    }
    return pages;
  } finally {
    lane.close();
  }
}

/** Rows of `pages` in all. */
const rowsOf = (pages: readonly CountedPage[]): number =>
  pages.reduce((sum, page) => sum + page.records.length, 0);

describe('compositeBody', () => {
  it('writes queries as query or queryAll subrequests, next pages as given, and describes with their headers', () => {
    const body = compositeBody(
      '66.0',
      [
        { kind: 'first', soql: 'SELECT Id FROM Account', scanAll: false },
        { kind: 'first', soql: 'SELECT Id FROM Account WHERE IsDeleted = true', scanAll: true },
        { kind: 'next', path: '/services/data/v66.0/query/01gX-2000' },
      ],
      [{ path: 'sobjects/Account/describe', headers: { 'If-Modified-Since': 'x' } }],
    );

    expect(body).toEqual({
      allOrNone: false,
      compositeRequest: [
        {
          method: 'GET',
          url: '/services/data/v66.0/query?q=SELECT%20Id%20FROM%20Account',
          referenceId: 'q0',
        },
        {
          method: 'GET',
          url: `/services/data/v66.0/queryAll?q=${encodeURIComponent('SELECT Id FROM Account WHERE IsDeleted = true')}`,
          referenceId: 'q1',
        },
        { method: 'GET', url: '/services/data/v66.0/query/01gX-2000', referenceId: 'q2' },
        {
          method: 'GET',
          url: '/services/data/v66.0/sobjects/Account/describe',
          referenceId: 'd0',
          httpHeaders: { 'If-Modified-Since': 'x' },
        },
      ],
    });
  });

  it('refuses a sixth query and a twenty-sixth subrequest before anything is sent', () => {
    const query = { kind: 'first' as const, soql: 'SELECT Id FROM Account', scanAll: false };
    const describe = { path: 'sobjects/Account/describe' };

    expect(() => compositeBody('66.0', Array(6).fill(query), [])).toThrow(/runs 5 queries, not 6/);
    expect(() => compositeBody('66.0', [query], Array(25).fill(describe))).toThrow(
      /holds 25 subrequests, not 26/,
    );
    expect(() =>
      compositeBody('66.0', Array(5).fill(query), Array(20).fill(describe)),
    ).not.toThrow();
  });
});

describe('nextPagePath', () => {
  it('takes the path of the next page jsforce gives whole, and the path the org gives as it is', () => {
    expect(
      nextPagePath('https://example.my.salesforce.com/services/data/v66.0/query/01gAB-2000'),
    ).toBe('/services/data/v66.0/query/01gAB-2000');
    expect(nextPagePath('/services/data/v66.0/queryAll/01gAB-4000')).toBe(
      '/services/data/v66.0/queryAll/01gAB-4000',
    );
  });

  it('refuses what is no next page of a query', () => {
    expect(() => nextPagePath('/services/data/v66.0/sobjects/Account/001')).toThrow(
      /Not the next page/,
    );
    expect(() => nextPagePath('/services/data/v66.0/query/01g?q=x')).toThrow(/Not the next page/);
  });
});

describe('compositeReader: five queries a call', () => {
  it('sends seven reads in two calls, never more than five queries in one', async () => {
    const org = orgOf(3);
    const reader = compositeReader(org.conn);

    const pages = await Promise.all(
      OBJECTS.map((object) => drain(reader.lane(), `SELECT Id FROM ${object}`)),
    );

    expect(pages.map(rowsOf)).toEqual(OBJECTS.map(() => 3));
    expect(composites(org.calls).map((subs) => queriesOf(subs).length)).toEqual([5, 2]);
    expect(reader.calls()).toBe(2);
  });

  it('counts next pages among the five: the cursors of reads run together advance a page each a call', async () => {
    const org = orgOf(10, { pageSize: (page) => (page === 0 ? 4 : 3) });
    const reader = compositeReader(org.conn);

    const pages = await Promise.all(
      OBJECTS.slice(0, 5).map((object) => drain(reader.lane(), `SELECT Id FROM ${object}`)),
    );

    // 4 + 3 + 3 rows: a first page, then two next pages, five cursors each time.
    expect(pages.map(rowsOf)).toEqual([10, 10, 10, 10, 10]);
    expect(composites(org.calls).map((subs) => subs.map((sub) => sub.split(':')[0]))).toEqual([
      ['query', 'query', 'query', 'query', 'query'],
      ['next', 'next', 'next', 'next', 'next'],
      ['next', 'next', 'next', 'next', 'next'],
    ]);
  });

  it('waits for every open read to ask its next page, however long each takes over the page before', async () => {
    const org = orgOf(10, { pageSize: (page) => (page === 0 ? 4 : 3) });
    const reader = compositeReader(org.conn);
    const pause = (ms: number) => () => new Promise<void>((resolve) => setTimeout(resolve, ms));

    const pages = await Promise.all(
      OBJECTS.slice(0, 5).map((object, index) =>
        drain(reader.lane(), `SELECT Id FROM ${object}`, false, pause(index * 4)),
      ),
    );

    expect(pages.map(rowsOf)).toEqual([10, 10, 10, 10, 10]);
    expect(composites(org.calls).map((subs) => queriesOf(subs).length)).toEqual([5, 5, 5]);
  });

  it('never assumes a page size: pages of 2,000, then 1,972, then 7 rows are read whole', async () => {
    const sizes = [2_000, 1_972, 7];
    const org = compositeOrg({
      tables: { Contact: stampedRows('Contact', 3_979, T) },
      pageSize: (page) => sizes[page] ?? 0,
    });
    const reader = compositeReader(org.conn);

    const pages = await drain(reader.lane(), 'SELECT Id FROM Contact');

    expect(pages.map((page) => page.records.length)).toEqual(sizes);
    expect(pages.at(-1)?.done).toBe(true);
  });

  it('sends a query the org halted again, within a call that holds no more queries than the org ran', async () => {
    // An org that runs three queries a composite, though it documents five:
    // the fourth and fifth answer PROCESSING_HALTED while the call answers 200.
    const org = orgOf(3, { queriesPerComposite: 3 });
    const reader = compositeReader(org.conn);

    const pages = await Promise.all(
      OBJECTS.map((object) => drain(reader.lane(), `SELECT Id FROM ${object}`)),
    );

    expect(pages.map(rowsOf)).toEqual(OBJECTS.map(() => 3));
    const sent = composites(org.calls).map((subs) => queriesOf(subs).length);
    expect(sent[0]).toBe(5);
    expect(sent.slice(1).every((count) => count <= 3)).toBe(true);
  });

  it('reads one call a query when the org runs none of the queries of a composite', async () => {
    const org = orgOf(3, { queriesPerComposite: 0 });
    const reader = compositeReader(org.conn);

    const pages = await Promise.all(
      OBJECTS.slice(0, 2).map((object) => drain(reader.lane(), `SELECT Id FROM ${object}`)),
    );

    expect(pages.map(rowsOf)).toEqual([3, 3]);
    expect(org.calls.map((call) => call.kind)).toEqual(['composite', 'query', 'query']);
  });

  it('fails the read of a query the org refused, alone, with the org’s words', async () => {
    const org = orgOf(3);
    const reader = compositeReader(org.conn);

    const [good, bad] = await Promise.allSettled([
      drain(reader.lane(), 'SELECT Id FROM Account'),
      drain(reader.lane(), 'SELECT Id FROM NoSuchObject__c'),
    ]);

    expect(good.status).toBe('fulfilled');
    expect(bad).toMatchObject({
      status: 'rejected',
      reason: { message: expect.stringMatching(/^INVALID_TYPE: sObject type 'NoSuchObject__c'/) },
    });
    expect(reader.calls()).toBe(1);
  });

  it('fails a read whose cursor the org released, with the org’s words, never ending it short', async () => {
    const org = orgOf(10, { pageSize: () => 4, cursorLimit: 1 });
    const reader = compositeReader(org.conn);

    const [first, second] = await Promise.allSettled([
      drain(reader.lane(), 'SELECT Id FROM Account'),
      drain(reader.lane(), 'SELECT Id FROM Contact'),
    ]);

    expect(first).toMatchObject({
      status: 'rejected',
      reason: { message: 'INVALID_QUERY_LOCATOR: invalid query locator' },
    });
    expect(second.status).toBe('fulfilled');
  });
});

describe('compositeReader: describes beside the queries', () => {
  it('fills a call to twenty-five subrequests, twenty-five less the queries beside them', async () => {
    const org = orgOf(3, {
      tables: Object.fromEntries(
        Array.from({ length: 40 }, (_, index) => [`Obj${index}__c`, stampedRows('Obj', 1, T)]),
      ),
    });
    const reader = compositeReader(org.conn);
    const lanes = [reader.lane(), reader.lane()];

    const [answers] = await Promise.all([
      Promise.all(Array.from({ length: 40 }, (_, index) => reader.describe(`Obj${index}__c`))),
      drain(lanes[0], 'SELECT Id FROM Obj0__c'),
      drain(lanes[1], 'SELECT Id FROM Obj1__c'),
    ]);

    expect(answers).toHaveLength(40);
    const shapes = composites(org.calls).map((subs) => ({
      queries: queriesOf(subs).length,
      all: subs.length,
    }));
    expect(shapes).toEqual([
      { queries: 2, all: 25 },
      { queries: 0, all: 17 },
    ]);
    expect(shapes.every(({ all }) => all <= SUBREQUESTS_PER_COMPOSITE)).toBe(true);
  });

  it('tells a describe that did not change since the date asked, and gives the others’ answers', async () => {
    const org = compositeOrg({
      tables: { Account: [], Contact: [] },
      describedAt: { Account: '2026-10-01T00:00:00Z', Contact: '2026-10-21T00:00:00Z' },
    });
    const reader = compositeReader(org.conn);

    const [account, contact] = await Promise.all([
      reader.describe('Account', '2026-10-15T00:00:00Z'),
      reader.describe('Contact', '2026-10-15T00:00:00Z'),
    ]);

    expect(account).toEqual({ notModified: true });
    expect(contact).toEqual({ body: { name: 'Contact', fields: [] } });
    expect(reader.calls()).toBe(1);
  });

  it('fails a describe the org refused, alone, with the org’s words', async () => {
    const org = compositeOrg({ tables: { Account: [] } });
    const reader = compositeReader(org.conn);

    const [held, missing] = await Promise.allSettled([
      reader.describe('Account'),
      reader.describe('Missing__c'),
    ]);

    expect(held).toEqual({ status: 'fulfilled', value: { body: { name: 'Account', fields: [] } } });
    expect(missing).toEqual({
      status: 'rejected',
      reason: new Error('NOT_FOUND: The requested resource does not exist'),
    });
    expect(reader.calls()).toBe(1);
  });

  it('refuses a describe of what is no object name before anything is sent', async () => {
    const org = compositeOrg();
    const reader = compositeReader(org.conn);

    await expect(reader.describe('Account/../x')).rejects.toThrow(/Invalid Salesforce object/);
    await expect(reader.describe('Account', 'not a date')).rejects.toThrow(/Not a date/);
    expect(org.calls).toEqual([]);
  });
});

describe('compositeReader: a query of the Tooling API', () => {
  /** A connection that answers the Tooling API's queries alone, with `answer`, keeping each URL. */
  function toolingConn(answer: (url: string) => unknown): {
    conn: CompositeQueryConnection;
    urls: string[];
  } {
    const urls: string[] = [];
    const refuse = (): Promise<CountedPage> => Promise.reject(new Error('not asked'));
    return {
      urls,
      conn: {
        version: '66.0',
        request: async ({ method, url }) => {
          urls.push(`${method} ${url}`);
          return answer(url);
        },
        query: refuse,
        queryMore: refuse,
      },
    };
  }

  it('sends it in a call of its own, to the Tooling API, counted among the calls', async () => {
    const { conn, urls } = toolingConn(() => ({
      totalSize: 1,
      done: true,
      records: [{ attributes: { type: 'FieldDefinition' }, QualifiedApiName: 'Due__c' }],
    }));
    const reader = compositeReader(conn);
    const soql =
      "SELECT QualifiedApiName FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = 'Account' AND QualifiedApiName IN ('Due__c')";

    const page = await reader.tooling(soql);

    expect(page.records).toEqual([
      { attributes: { type: 'FieldDefinition' }, QualifiedApiName: 'Due__c' },
    ]);
    expect(urls).toEqual([`GET /services/data/v66.0/tooling/query?q=${encodeURIComponent(soql)}`]);
    expect(reader.calls()).toBe(1);
  });

  it('fails with the org’s words when it refuses, or answers no page, and sends nothing once stopped', async () => {
    const refusing = toolingConn(() => {
      throw orgError('INVALID_TYPE', "sObject type 'FieldDefinition' is not supported.");
    });
    await expect(compositeReader(refusing.conn).tooling('SELECT Id FROM X')).rejects.toThrow(
      "INVALID_TYPE: sObject type 'FieldDefinition' is not supported.",
    );
    const empty = toolingConn(() => '');
    await expect(compositeReader(empty.conn).tooling('SELECT Id FROM X')).rejects.toThrow(
      /no page/,
    );
    const stopped = new AbortController();
    stopped.abort();
    const idle = toolingConn(() => ({ totalSize: 0, done: true, records: [] }));
    const reader = compositeReader(idle.conn, stopped.signal);
    await expect(reader.tooling('SELECT Id FROM X')).rejects.toBeInstanceOf(OrgReadStopped);
    expect(idle.urls).toEqual([]);
    expect(reader.calls()).toBe(0);
  });
});

describe('compositeReader: the one-call route', () => {
  it('reads one call a query, and a describe alone, when the org refuses the composite with its own words', async () => {
    const org = orgOf(10, {
      pageSize: () => 4,
      refuseComposite: orgError('API_DISABLED_FOR_ORG', 'Composite API is not enabled.'),
      describedAt: { Account: '2026-10-01T00:00:00Z' },
    });
    const reader = compositeReader(org.conn);

    const [pages, unchanged] = await Promise.all([
      drain(reader.lane(), 'SELECT Id FROM Account WHERE IsDeleted = true', true),
      reader.describe('Account', '2026-10-15T00:00:00Z'),
    ]);

    expect(rowsOf(pages)).toBe(0);
    expect(unchanged).toEqual({ notModified: true });
    expect(org.calls.map((call) => call.kind)).toEqual(['composite', 'queryAll', 'get']);
    expect(reader.calls()).toBe(3);
  });

  it('keeps to one call a query for the rest of the read, next pages of cursors a composite opened among them', async () => {
    const org = orgOf(10, { pageSize: () => 4 });
    const reader = compositeReader(org.conn);
    const lane = reader.lane();

    const first = await lane.query('SELECT Id FROM Account');
    org.calls.length = 0;
    const answer = org.conn.request;
    org.conn.request = vi.fn(async () => {
      throw orgError('REQUEST_LIMIT_EXCEEDED', 'TotalRequests Limit exceeded.');
    });
    const second = await lane.queryMore(first.nextRecordsUrl ?? '');
    org.conn.request = answer;
    const third = await lane.queryMore(second.nextRecordsUrl ?? '');
    lane.close();

    expect([first, second, third].map((page) => page.records.length)).toEqual([4, 4, 2]);
    expect(org.calls.map((call) => call.kind)).toEqual(['queryMore', 'queryMore']);
  });

  it('reads one call a query when what comes back is no composite answer', async () => {
    const org = orgOf(3, { compositeAnswer: { message: 'not a composite' } });
    const reader = compositeReader(org.conn);

    const pages = await drain(reader.lane(), 'SELECT Id FROM Account');

    expect(rowsOf(pages)).toBe(3);
    expect(org.calls.map((call) => call.kind)).toEqual(['composite', 'query']);
  });

  it('fails the reads a call carried when the call never reached the org, and sends them no other way', async () => {
    const org = orgOf(3);
    org.conn.request = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    const reader = compositeReader(org.conn);

    const settled = await Promise.allSettled([
      drain(reader.lane(), 'SELECT Id FROM Account'),
      reader.describe('Account'),
    ]);

    expect(settled).toEqual([
      { status: 'rejected', reason: new Error('socket hang up') },
      { status: 'rejected', reason: new Error('socket hang up') },
    ]);
    expect(org.calls).toEqual([]);
  });
});

describe('compositeReader: Stop', () => {
  it('gives up what was asked and not sent, and sends nothing once stopped', async () => {
    const org = orgOf(3);
    const stop = new AbortController();
    const reader = compositeReader(org.conn, stop.signal);
    const waiting = reader.lane();
    const busy = reader.lane();

    const asked = waiting.query('SELECT Id FROM Account');
    stop.abort();

    await expect(asked).rejects.toBeInstanceOf(OrgReadStopped);
    await expect(busy.query('SELECT Id FROM Contact')).rejects.toBeInstanceOf(OrgReadStopped);
    await expect(reader.describe('Account')).rejects.toBeInstanceOf(OrgReadStopped);
    expect(org.calls).toEqual([]);
  });

  it('listens to the signal only while a read is open or a call is out, so readers made one after another under one signal leave no listener on it', async () => {
    const org = orgOf(3);
    const stop = new AbortController();
    const listeners = () => getEventListeners(stop.signal, 'abort').length;

    for (let n = 0; n < 3; n++) {
      const reader = compositeReader(org.conn, stop.signal);
      const lane = reader.lane();
      expect(listeners()).toBe(1);
      await lane.query('SELECT Id FROM Account');
      lane.close();
      await reader.describe('Account');
      // The call that answered the describe settles it before it ends.
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(listeners()).toBe(0);
    // Listening again for a read opened after the reader went idle.
    const reader = compositeReader(org.conn, stop.signal);
    const lane = reader.lane();
    const asked = lane.query('SELECT Id FROM Contact');
    stop.abort();
    await expect(asked).rejects.toBeInstanceOf(OrgReadStopped);
  });

  it('refuses a second page asked before the first came back, and any page of a closed read', async () => {
    const reader = compositeReader(orgOf(3).conn);
    const lane = reader.lane();

    const first = lane.query('SELECT Id FROM Account');
    await expect(lane.query('SELECT Id FROM Contact')).rejects.toThrow(/one page at a time/);
    await first;
    lane.close();
    await expect(lane.query('SELECT Id FROM Account')).rejects.toThrow(/closed/);
  });
});

describe('compositeConnectionOf', () => {
  it('reads through a jsforce connection: the recycle bin when asked, next pages, the composite call', async () => {
    const page = { records: [], done: true, totalSize: 0 };
    const conn = {
      version: '66.0',
      query: vi.fn(async () => page),
      queryMore: vi.fn(async () => page),
      request: vi.fn(async () => ({ compositeResponse: [] })),
    };
    const reads = compositeConnectionOf(conn as unknown as Connection);

    await reads.query('SELECT Id FROM Account', { scanAll: true });
    await reads.query('SELECT Id FROM Account');
    await reads.queryMore('/services/data/v66.0/query/01gX-2000');
    await reads.request({ method: 'POST', url: '/composite', body: '{}' });

    expect(reads.version).toBe('66.0');
    expect(conn.query.mock.calls).toEqual([
      ['SELECT Id FROM Account', { scanAll: true }],
      ['SELECT Id FROM Account', { scanAll: false }],
    ]);
    expect(conn.queryMore).toHaveBeenCalledWith('/services/data/v66.0/query/01gX-2000');
    expect(conn.request).toHaveBeenCalledWith({ method: 'POST', url: '/composite', body: '{}' });
    expect(QUERIES_PER_COMPOSITE).toBe(5);
  });
});
