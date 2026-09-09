import { describe, it, expect, vi } from 'vitest';

import {
  FORGE_QUERY_MAX_PAGES,
  FORGE_QUERY_MAX_RECORDS,
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

  it('follows the cursor across pages and concatenates in order (PERF-02)', async () => {
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

describe('objectOfQuery', () => {
  it('reads the object name without echoing the query', () => {
    expect(objectOfQuery('SELECT Id, Name FROM Account WHERE Email = 42')).toBe('Account');
    expect(objectOfQuery('select id from my_custom__c where x=1')).toBe('my_custom__c');
  });

  it('falls back to a placeholder rather than logging the query', () => {
    expect(objectOfQuery('not a query')).toBe('unknown object');
  });
});
