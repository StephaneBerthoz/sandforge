import { describe, it, expect, vi } from 'vitest';
import type { ForgeGraph } from '@sandforge/shared';
import { ForgeExecutor } from './ForgeExecutor.js';
import type { FieldInfo, ForgeExecutorDeps } from './ForgeExecutor.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * A table of a million rows through a run read and written page by page,
 * against a source that makes each page as it is asked for it: what the run
 * holds of the rows at any time is the page it is writing and what is left of
 * the cursor's page, never the table.
 */

const ROWS = 1_000_000;
/** Rows a page of the source's cursor holds, as an org answers. */
const CURSOR_PAGE = 2_000;

const FIELDS: FieldInfo[] = [
  { name: 'Id', queryable: true, createable: false, isReference: false },
  { name: 'Name', queryable: true, createable: true, updateable: true, isReference: false },
];

/** The `n`-th row's id: in the order of the ids, as the run asks for them. */
const idOf = (prefix: string, n: number): string => `${prefix}${String(n).padStart(15, '0')}`;

describe('a run of whole tables read page by page, over a million rows', () => {
  it('holds a page of rows at a time, never the table, and writes every row', async () => {
    const flow = { handedOut: 0, written: 0, mostAhead: 0, pagesMade: 0 };
    const deps: ForgeExecutorDeps = {
      describeFields: async () => FIELDS,
      queryRecords: async () => [],
      // Each page made as it is asked for, from the ids alone: no array of
      // every row exists anywhere.
      queryPages: (_org, soql) =>
        (async function* cursor(): AsyncGenerator<Array<Record<string, unknown>>> {
          expect(soql).toBe('SELECT Id, Name FROM Account ORDER BY Id LIMIT 1000001');
          for (let at = 0; at < ROWS; at += CURSOR_PAGE) {
            const page = Array.from({ length: Math.min(CURSOR_PAGE, ROWS - at) }, (_, i) => ({
              Id: idOf('001', at + i),
              Name: `Account ${at + i}`,
            }));
            flow.pagesMade++;
            flow.handedOut += page.length;
            flow.mostAhead = Math.max(flow.mostAhead, flow.handedOut - flow.written);
            yield page;
          }
        })(),
      countRecords: async () => ROWS,
      insertRecords: async (_org, _object, rows) => {
        const results = rows.map((_, i) => ({
          id: idOf('00T', flow.written + i),
          success: true,
          errors: [],
        }));
        flow.written += rows.length;
        return results;
      },
    };
    const graph: ForgeGraph = {
      nodes: [
        {
          objectApiName: 'Account',
          recordCount: ROWS,
          fieldCount: 2,
          status: 'idle',
          progress: 0,
          included: true,
          piiFields: [],
          anonymizeFields: [],
          level: 0,
          successCount: 0,
          failureCount: 0,
          errors: [],
          createableFieldCount: 1,
          estimatedSizeMB: 0,
          estimatedApiCalls: 0,
          batchStrategy: 'rest',
        },
      ],
      edges: [],
      totalRecords: ROWS,
      estimatedSizeMB: 0,
      estimatedDurationSeconds: 0,
    };
    const counted: number[] = [];

    const summary = await new ForgeExecutor(deps).execute(graph, 'src', 'tgt', () => {}, {
      beforeWrite: async ({ objects }) => {
        counted.push(...objects.map((object) => object.counted?.rows ?? object.rows.length));
      },
      stream: { ceiling: ROWS },
    });

    expect(counted).toEqual([ROWS]);
    expect(summary.successCount).toBe(ROWS);
    expect(summary.truncatedObjects).toEqual([]);
    expect(flow.pagesMade).toBe(ROWS / CURSOR_PAGE);
    // Rows handed out by the source and not yet sent to the target, at most:
    // one page of the cursor — the run writes each before it asks for the next.
    expect(flow.mostAhead).toBeLessThanOrEqual(CURSOR_PAGE);
  }, 600_000);
});
