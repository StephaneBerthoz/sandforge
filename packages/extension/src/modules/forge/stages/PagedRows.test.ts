import { describe, it, expect, vi } from 'vitest';
import { inPagesOf, pagesOfStatement, type SourceRow } from './PagedRows.js';

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
