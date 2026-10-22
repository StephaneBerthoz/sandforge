import { describe, it, expect, vi } from 'vitest';
import {
  inPagesOf,
  pagesOfStatement,
  readingInColumnGroups,
  type PagedReadDeps,
  type SourceRow,
} from './PagedRows.js';
import { MAX_STATEMENT_URI_CHARS, uriLength } from '../../../core/common/wideRead.js';

async function* from<T>(pages: T[][]): AsyncGenerator<T[]> {
  for (const page of pages) yield page;
}

async function all<T>(pages: AsyncIterable<T[]>): Promise<T[][]> {
  const taken: T[][] = [];
  for await (const page of pages) taken.push(page);
  return taken;
}

const rows = (count: number, offset = 0): SourceRow[] =>
  Array.from({ length: count }, (_, i) => ({ Id: `r${i + offset}` }));

describe('the pages of a read', () => {
  it('cuts the pages the source gives to the size asked, the last one shorter', async () => {
    const pages = await all(inPagesOf(from([rows(5, 0), rows(4, 5)]), 2));
    expect(pages.map((page) => page.length)).toEqual([2, 2, 2, 2, 1]);
    expect(pages.flat()).toEqual(rows(9));
  });

  it('gives the pages as the source gave them without a size, leaving out the empty ones after the first', async () => {
    const pages = await all(inPagesOf(from([rows(3), [], rows(2, 3)])));
    expect(pages).toEqual([rows(3), rows(2, 3)]);
  });

  it('gives one empty page for a source that had no row', async () => {
    expect(await all(inPagesOf(from<SourceRow>([[], []]), 2))).toEqual([[]]);
    expect(await all(inPagesOf(from<SourceRow>([])))).toEqual([[]]);
  });

  it('asks the source for a page only once the pages before are taken', async () => {
    const asked: number[] = [];
    async function* source(): AsyncGenerator<SourceRow[]> {
      for (let i = 0; i < 3; i++) {
        asked.push(i);
        yield rows(4, i * 4);
      }
    }
    const pages = inPagesOf(source(), 4);
    await pages.next();
    expect(asked).toEqual([0]);
    await pages.next();
    expect(asked).toEqual([0, 1]);
  });

  it("reads through the deps' cursor when they give one, and never reads the statement whole", async () => {
    const queryRecords = vi.fn(async () => rows(10));
    const queryPages = vi.fn(() => from([rows(3), rows(3, 3)]));
    const pages = await all(
      pagesOfStatement({ queryPages, queryRecords }, 'src', 'SELECT Id FROM Account', 2),
    );
    expect(pages.map((page) => page.length)).toEqual([2, 2, 2]);
    expect(queryPages).toHaveBeenCalledWith('src', 'SELECT Id FROM Account');
    expect(queryRecords).not.toHaveBeenCalled();
  });

  it('reads the statement whole and cuts it when the deps give no cursor, saying a bound stopped it', async () => {
    const onTruncated = vi.fn();
    const queryRecords = vi.fn(async (_org: string, _soql: string, truncated?: () => void) => {
      truncated?.();
      return rows(5);
    });
    const pages = await all(
      pagesOfStatement({ queryRecords }, 'src', 'SELECT Id FROM Account', 2, onTruncated),
    );
    expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
    expect(onTruncated).toHaveBeenCalledTimes(1);
  });
});

describe('reads of a statement too wide for one query', () => {
  const fields = [
    'Id',
    ...Array.from({ length: 900 }, (_, i) => `Customer_Field_${String(i).padStart(4, '0')}__c`),
  ];
  const wide = `SELECT ${fields.join(', ')} FROM Account WHERE Name != 'x'`;
  const idOf = (n: number): string => `001${String(n).padStart(12, '0')}AAA`;

  /** An org of 40 accounts that refuses a URI past what Salesforce takes and answers the fields named. */
  function org() {
    const sent: string[] = [];
    const answer = (soql: string): SourceRow[] => {
      sent.push(soql);
      if (uriLength(soql) > 15_400)
        throw new Error('ERROR_HTTP_431: Request Header Fields Too Large');
      const named = /^SELECT (.+?) FROM /.exec(soql)?.[1].split(', ') ?? [];
      const ids = new Set([...soql.matchAll(/'(001\d{12}AAA)'/g)].map((m) => m[1]));
      return Array.from({ length: 40 }, (_, n) => idOf(n + 1))
        .filter((id) => ids.size === 0 || ids.has(id))
        .map((id) => Object.fromEntries(named.map((field) => [field, field === 'Id' ? id : 'v'])));
    };
    return { sent, answer };
  }

  it('reads them in column groups, every statement within the URI, every row with every field', async () => {
    const source = org();
    const onTruncated = vi.fn();
    const deps = readingInColumnGroups<PagedReadDeps>({
      queryRecords: vi.fn(async (_org: string, soql: string) => source.answer(soql)),
    });

    const rows = await deps.queryRecords('src', wide, onTruncated);

    expect(rows).toHaveLength(40);
    expect(Object.keys(rows[39])).toHaveLength(fields.length);
    expect(source.sent.length).toBeGreaterThan(1);
    for (const soql of source.sent) {
      expect(uriLength(soql)).toBeLessThanOrEqual(MAX_STATEMENT_URI_CHARS);
    }
    expect(source.sent[0]).toMatch(/ WHERE Name != 'x'$/);
  });

  it('gives each page of a cursor every field', async () => {
    const source = org();
    const deps = readingInColumnGroups<PagedReadDeps>({
      queryRecords: async (_org, soql) => source.answer(soql),
      queryPages: (_org, soql) =>
        from([source.answer(soql).slice(0, 25), source.answer(soql).slice(25)]),
    });

    const pages = await all(pagesOfStatement(deps, 'src', wide));

    expect(pages.map((page) => page.length)).toEqual([25, 15]);
    expect(pages.flat().every((row) => Object.keys(row).length === fields.length)).toBe(true);
    for (const soql of source.sent) {
      expect(uriLength(soql)).toBeLessThanOrEqual(MAX_STATEMENT_URI_CHARS);
    }
  });

  it('hands a statement that fits to the deps as it was given, and the deps swapped since are the ones called', async () => {
    const first = vi.fn(async () => rows(1));
    const given: PagedReadDeps = { queryRecords: first };
    const deps = readingInColumnGroups(given);
    const onTruncated = vi.fn();

    await deps.queryRecords('src', 'SELECT Id FROM Account', onTruncated);
    expect(first).toHaveBeenCalledWith('src', 'SELECT Id FROM Account', onTruncated);
    expect(deps.queryPages).toBeUndefined();

    const swapped = vi.fn(async () => rows(2));
    given.queryRecords = swapped;
    expect(await deps.queryRecords('src', 'SELECT Id FROM Account')).toHaveLength(2);
    expect(swapped).toHaveBeenCalledWith('src', 'SELECT Id FROM Account');
  });
});
