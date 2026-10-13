import { describe, it, expect, vi } from 'vitest';

import {
  FORGE_CURSOR_MAX_EMPTY_PAGES,
  FORGE_QUERY_MAX_PAGES,
  FORGE_QUERY_MAX_RECORDS,
  cursorPages,
  objectOfQuery,
  queryAllPages,
  type PagedQuerySource,
  type QueryPage,
} from './queryAllPages.js';

type Row = { Id: string };

/** A source that hands out `pages` in order, then repeats the last one. */
function sourceOf(pages: QueryPage<Row>[]) {
  let i = 0;
  const next = (): Promise<QueryPage<Row>> =>
    Promise.resolve(pages[Math.min(i++, pages.length - 1)]);
  const source = {
    query: vi.fn<(soql: string) => Promise<QueryPage<Row>>>(next),
    queryMore: vi.fn<(url: string) => Promise<QueryPage<Row>>>(next),
  };
  return source satisfies PagedQuerySource<Row>;
}

/** `count` rows, ids unique across the whole run so duplicates are visible. */
const rows = (count: number, offset = 0): Row[] =>
  Array.from({ length: count }, (_, i) => ({ Id: `00${i + offset}` }));

describe('queryAllPages', () => {
  it('returns the single page when the source is already done', async () => {
    const source = sourceOf([{ records: rows(3), done: true }]);

    const result = await queryAllPages(source, 'SELECT Id FROM Account');

    expect(result.records).toHaveLength(3);
    expect(result.pages).toBe(1);
    expect(result.truncated).toBe(false);
    expect(source.queryMore).not.toHaveBeenCalled();
  });

  it('follows the cursor across pages and concatenates in order', async () => {
    // The defect: `conn.query()` returns the first page only, so a 5 000-row
    // object cloned as its first 2 000 rows and reported success.
    const source = sourceOf([
      { records: rows(2000, 0), done: false, nextRecordsUrl: '/next/1' },
      { records: rows(2000, 2000), done: false, nextRecordsUrl: '/next/2' },
      { records: rows(1000, 4000), done: true },
    ]);

    const result = await queryAllPages(source, 'SELECT Id FROM Contact');

    expect(result.records).toHaveLength(5000);
    expect(result.pages).toBe(3);
    expect(result.truncated).toBe(false);
    expect(source.queryMore).toHaveBeenCalledTimes(2);
    expect(source.queryMore).toHaveBeenNthCalledWith(1, '/next/1');
    // Every row travels exactly once.
    expect(new Set(result.records.map((r) => r.Id)).size).toBe(5000);
  });

  it('stops at the record cap and reports the truncation', async () => {
    const source = sourceOf([
      { records: rows(FORGE_QUERY_MAX_RECORDS, 0), done: false, nextRecordsUrl: '/next' },
      { records: rows(10, 90_000), done: false, nextRecordsUrl: '/next' },
    ]);

    const result = await queryAllPages(source, 'SELECT Id FROM Task');

    expect(result.records).toHaveLength(FORGE_QUERY_MAX_RECORDS);
    expect(result.truncated).toBe(true);
    // The cap is reached by page one, so no further page is fetched.
    expect(source.queryMore).not.toHaveBeenCalled();
  });

  it('terminates on a cursor that never finishes and never advances', async () => {
    // The bound the record cap alone cannot provide: empty pages forever.
    const source = sourceOf([{ records: [], done: false, nextRecordsUrl: '/loop' }]);

    const result = await queryAllPages(source, 'SELECT Id FROM Lead');

    expect(result.pages).toBe(FORGE_QUERY_MAX_PAGES);
    expect(result.records).toHaveLength(0);
    expect(result.truncated).toBe(true);
  });

  it('stops when the source withholds a cursor despite not being done', async () => {
    const source = sourceOf([{ records: rows(5), done: false }]);

    const result = await queryAllPages(source, 'SELECT Id FROM Case');

    expect(result.pages).toBe(1);
    expect(result.records).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });
});

describe('queryAllPages, bounded by the run', () => {
  it('holds no more rows than the bound the run sets, and says the read was cut', async () => {
    const source = sourceOf([
      { records: rows(3, 0), done: false, nextRecordsUrl: '/next/1' },
      { records: rows(3, 3), done: true },
    ]);

    const result = await queryAllPages(source, 'SELECT Id FROM Account', 4);

    expect(result.records).toEqual(rows(4));
    expect(result.truncated).toBe(true);
  });

  it('follows a cursor of small pages past the default page bound when the bound set needs it', async () => {
    // 600 pages of 200 rows: 120 000 rows, past the 500 pages a read of the
    // default bound takes.
    const pages: QueryPage<Row>[] = Array.from({ length: 600 }, (_, i) => ({
      records: rows(200, i * 200),
      done: i === 599,
      nextRecordsUrl: `/next/${i + 1}`,
    }));

    const result = await queryAllPages(sourceOf(pages), 'SELECT Id FROM Task', 200_000);

    expect(result.records).toHaveLength(120_000);
    expect(result.truncated).toBe(false);
  });
});

describe('cursorPages', () => {
  it('asks for the next page only once the one before is taken, and holds none of them', async () => {
    const source = sourceOf([
      { records: rows(2, 0), done: false, nextRecordsUrl: '/next/1' },
      { records: rows(2, 2), done: false, nextRecordsUrl: '/next/2' },
      { records: rows(1, 4), done: true },
    ]);

    const pages = cursorPages(source, 'SELECT Id FROM Contact ORDER BY Id');
    const first = await pages.next();
    expect(first.value).toEqual(rows(2, 0));
    // The page under way is the only one asked for.
    expect(source.queryMore).not.toHaveBeenCalled();
    const rest: Row[][] = [];
    for await (const page of pages) rest.push(page);

    expect(rest).toEqual([rows(2, 2), rows(1, 4)]);
    expect(source.queryMore).toHaveBeenCalledTimes(2);
    expect(source.queryMore).toHaveBeenNthCalledWith(2, '/next/2');
  });

  it('reads past the bound that holds every row in memory: the statement bounds it', async () => {
    const pages: QueryPage<Row>[] = Array.from({ length: 30 }, (_, i) => ({
      records: rows(2000, i * 2000),
      done: i === 29,
      nextRecordsUrl: `/next/${i + 1}`,
    }));
    let read = 0;
    for await (const page of cursorPages(sourceOf(pages), 'SELECT Id FROM Task ORDER BY Id')) {
      read += page.length;
    }
    expect(read).toBeGreaterThan(FORGE_QUERY_MAX_RECORDS);
  });

  it('stops after a run of empty pages from a cursor that never says it is done', async () => {
    const source = sourceOf([{ records: [], done: false, nextRecordsUrl: '/loop' }]);
    let pages = 0;
    for await (const page of cursorPages(source, 'SELECT Id FROM Lead')) {
      expect(page).toEqual([]);
      pages++;
    }
    expect(pages).toBe(FORGE_CURSOR_MAX_EMPTY_PAGES);
  });
});

describe('objectOfQuery', () => {
  it('reads the object name without echoing the query', () => {
    expect(objectOfQuery('SELECT Id, Name FROM Account WHERE Email = 42')).toBe('Account');
    expect(objectOfQuery('select id from my_custom__c where x=1')).toBe('my_custom__c');
  });

  it('falls back to a placeholder rather than logging the query', () => {
    expect(objectOfQuery('not a query')).toBe('unknown object');
  });
});
