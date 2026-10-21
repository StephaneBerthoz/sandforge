import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v8 from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, it, expect, vi } from 'vitest';
import type { ForgeGraph } from '@sandforge/shared';
import { ForgeExecutor } from './ForgeExecutor.js';
import { ForgeRunStore, nodeRunFile } from './ForgeRunStore.js';
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
const MB = 1024 * 1024;
/**
 * The most the heap may grow, once collected, while a run of a million rows
 * goes: the journal's index of what it wrote, and a cache of a few pages.
 */
const MOST_HEAP_MB = 120;

const FIELDS: FieldInfo[] = [
  { name: 'Id', queryable: true, createable: false, isReference: false },
  { name: 'Name', queryable: true, createable: true, updateable: true, isReference: false },
];

/** The `n`-th row's id: in the order of the ids, as the run asks for them. */
const idOf = (prefix: string, n: number): string => `${prefix}${String(n).padStart(15, '0')}`;

/** A graph of one table of accounts, of a million rows. */
function graphOfAccounts(): ForgeGraph {
  return {
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
}

/**
 * Run as the extension ships, never under Stryker, whose workers it names
 * (STRYKER_MUTATOR_WORKER): instrumented, the heap holds the counters as
 * well, and a million rows through counted code took past the five minutes
 * Stryker gives its initial test run on a CI runner, failing it with no test
 * failed.
 */
const describeShipped =
  process.env['STRYKER_MUTATOR_WORKER'] === undefined ? describe : describe.skip;

describeShipped('a run of whole tables read page by page, over a million rows', () => {
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
    const graph = graphOfAccounts();
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

  /*
   * What a run keeps of what it wrote grew with the table as well: the source
   * id and target id of every record, the lookups owed to the second pass, the
   * statuses owed to the end, the ids read. Kept in the journal the run writes
   * as it goes, behind an index of fixed size per record and a cache of a few
   * pages, the run holds no id of its own past what that cache holds: measured
   * on the heap left once the garbage is collected, sampled as the run goes.
   */
  it('keeps what it wrote, owes and read in its journal, not on the heap, over a million rows with self-lookups and statuses owed', async () => {
    const ACCOUNTS = 600_000;
    const CONTRACTS = 400_000;
    v8.setFlagsFromString('--expose-gc');
    const collect = runInNewContext('gc') as () => void;
    // The heap, and the buffers outside it the index's arrays live in.
    const heapNow = (): number => {
      collect();
      const { heapUsed, arrayBuffers } = process.memoryUsage();
      return heapUsed + arrayBuffers;
    };
    // On disk, as the extension keeps it: held in memory, the journal itself
    // would be what the heap holds.
    const dir = mkdtempSync(join(tmpdir(), 'forge-journal-'));
    const journal = nodeRunFile(join(dir, 'run.ndjson'));
    const sampled = { most: 0, samples: 0, lastSampleAt: 0, writes: 0, updates: 0 };
    const sample = (): void => {
      sampled.samples++;
      sampled.most = Math.max(sampled.most, heapNow());
    };
    const rowsOf = (object: string, from: number, to: number): Array<Record<string, unknown>> =>
      Array.from({ length: to - from }, (_, i) => {
        const n = from + i;
        return object === 'Account'
          ? {
              Id: idOf('001', n),
              Name: `Account ${n}`,
              // Each names the account after it: owed to the second pass.
              ParentId: n + 1 < ACCOUNTS ? idOf('001', n + 1) : null,
            }
          : {
              Id: idOf('800', n),
              AccountId: idOf('001', n % ACCOUNTS),
              // Past Draft: written as a draft, its status owed to the end.
              Status: 'Activated',
            };
      });
    const deps: ForgeExecutorDeps = {
      describeFields: async (_org, object) =>
        object === 'Account'
          ? [
              ...FIELDS,
              {
                name: 'ParentId',
                queryable: true,
                createable: true,
                updateable: true,
                isReference: true,
                referenceTo: ['Account'],
                nillable: true,
              },
            ]
          : [
              FIELDS[0],
              {
                name: 'AccountId',
                queryable: true,
                createable: true,
                updateable: true,
                isReference: true,
                referenceTo: ['Account'],
                nillable: false,
              },
              {
                name: 'Status',
                queryable: true,
                createable: true,
                updateable: true,
                isReference: false,
                type: 'picklist',
              },
            ],
      queryRecords: async (org, soql) =>
        org === 'tgt' && soql === 'SELECT ApiName, StatusCode FROM ContractStatus'
          ? [
              { ApiName: 'Draft', StatusCode: 'Draft' },
              { ApiName: 'Activated', StatusCode: 'Activated' },
            ]
          : [],
      queryPages: (_org, soql) =>
        (async function* cursor(): AsyncGenerator<Array<Record<string, unknown>>> {
          const object = /FROM (\w+)/.exec(soql)?.[1] ?? '';
          const total = object === 'Account' ? ACCOUNTS : CONTRACTS;
          for (let at = 0; at < total; at += CURSOR_PAGE) {
            yield rowsOf(object, at, Math.min(at + CURSOR_PAGE, total));
          }
        })(),
      countRecords: async (_org, soql) => (soql.includes('FROM Account') ? ACCOUNTS : CONTRACTS),
      insertRecords: async (_org, object, rows) => {
        const results = rows.map((_, i) => ({
          id: idOf(object === 'Account' ? '0T1' : '0T8', sampled.writes + i),
          success: true,
          errors: [],
        }));
        sampled.writes += rows.length;
        if (sampled.writes - sampled.lastSampleAt >= 100_000) {
          sampled.lastSampleAt = sampled.writes;
          sample();
        }
        return results;
      },
      updateRecords: async (_org, _object, rows) => {
        sampled.updates += rows.length;
        if (sampled.updates % 100_000 < rows.length) sample();
        return rows.map((row) => ({ id: String(row['Id']), success: true, errors: [] }));
      },
    };
    const node = (objectApiName: string, recordCount: number): ForgeGraph['nodes'][number] => ({
      ...graphOfAccounts().nodes[0],
      objectApiName,
      recordCount,
    });
    const graph: ForgeGraph = {
      ...graphOfAccounts(),
      nodes: [node('Account', ACCOUNTS), node('Contract', CONTRACTS)],
      edges: [
        {
          sourceObject: 'Account',
          targetObject: 'Account',
          relationshipName: 'ChildAccounts',
          type: 'lookup',
        },
        {
          sourceObject: 'Account',
          targetObject: 'Contract',
          relationshipName: 'Contracts',
          type: 'lookup',
          required: true,
        },
      ],
      totalRecords: ACCOUNTS + CONTRACTS,
    };
    const before = heapNow();

    const store = ForgeRunStore.open(journal);
    const summary = await new ForgeExecutor(deps)
      .execute(graph, 'src', 'tgt', () => {}, {
        stream: { ceiling: ACCOUNTS, store, summaryBound: 1_000 },
      })
      .finally(() => {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      });

    expect(summary.successCount).toBe(ACCOUNTS + CONTRACTS);
    expect(summary.errors).toEqual([]);
    // Every lookup owed went in, and every status given back.
    expect(sampled.updates).toBe(ACCOUNTS - 1 + CONTRACTS);
    expect(sampled.samples).toBeGreaterThanOrEqual(15);
    // Past the bound, the summary counts the records and leaves their ids in the journal.
    expect(summary.remapCount).toBe(ACCOUNTS + CONTRACTS);
    expect(summary.remapTable).toEqual({});
    expect(summary.remapInJournal).toBe(true);
    // A million records written, a million ids read, 600 000 lookups and
    // 400 000 statuses owed: held in memory, they took several hundred MB.
    // What the run keeps of them is the journal's index, a few bytes a record.
    expect((sampled.most - before) / MB).toBeLessThan(MOST_HEAP_MB);
  }, 600_000);
});
