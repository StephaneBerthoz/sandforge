import { describe, it, expect, vi } from 'vitest';
import type { ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import { parseSoql, selectFrom } from '../../test/memorySoql.js';
import { ForgeExecutor } from './ForgeExecutor.js';
import type {
  ExecuteOptions,
  ExecutionSummary,
  FieldInfo,
  ForgeExecutorDeps,
  ForgeProgressEvent,
  InsertResult,
  UpdateResult,
} from './ForgeExecutor.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * A call the target's automation refuses for a Salesforce limit. A trigger
 * that runs a query per record refuses every row of a call large enough —
 * "SSC_TRG_Provenance: execution of BeforeInsert caused by:
 * System.LimitException: Too many SOQL queries: 101" — and takes the same
 * rows in smaller calls. The run sends them again smaller, within the calls
 * it allows itself (one set of sizes and one allowance for the run, shared by
 * its writer and its second pass), says on the object's line how many went
 * smaller, and names the trigger and the limit among its notes.
 */

type Row = Record<string, unknown>;

const OBJECT = 'Provenance__c';

/** What the trigger answers a call too large for it, for a row of `object`. */
function limitMessage(event: 'Insert' | 'Update'): string {
  return (
    `CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: SSC_TRG_Provenance: execution of Before${event}\n\n` +
    'caused by: System.LimitException: Too many SOQL queries: 101\n\n' +
    'Trigger.SSC_TRG_Provenance: line 12, column 1'
  );
}

/** The `n`-th source id of the object. */
const src = (n: number): string => `a02S${String(n).padStart(11, '0')}AAA`;

const field = (name: string, overrides: Partial<FieldInfo> = {}): FieldInfo => ({
  name,
  queryable: true,
  createable: name !== 'Id',
  updateable: name !== 'Id',
  isReference: false,
  ...overrides,
});

const FIELDS: FieldInfo[] = [field('Id'), field('Name')];

function node(recordCount: number): ForgeGraphNode {
  return {
    objectApiName: OBJECT,
    recordCount,
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
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
  };
}

function graphOf(rows: readonly Row[]): ForgeGraph {
  return {
    nodes: [node(rows.length)],
    edges: [],
    totalRecords: rows.length,
    estimatedSizeMB: 0,
    estimatedDurationSeconds: 0,
  };
}

/** `n` provenances, as the source holds them. */
function provenances(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({ Id: src(i), Name: `Provenance ${i}` }));
}

/**
 * A source holding `rows`, and a target whose trigger refuses, for a limit,
 * every row of an insert call past `most` rows.
 */
function orgs(rows: readonly Row[], most: number) {
  let created = 0;
  const deps = {
    describeFields: vi.fn(async () => FIELDS),
    queryRecords: vi.fn(async (org: string, soql: string) => {
      if (org !== 'src') return [];
      const statement = parseSoql(soql);
      const selected = selectFrom(statement.object === OBJECT ? [...rows] : [], statement);
      if (statement.columns === null) return [{ expr0: selected.length }];
      const columns = statement.columns;
      return selected.map((row) =>
        Object.fromEntries(columns.map((name) => [name, row[name] ?? null])),
      );
    }),
    insertRecords: vi.fn(
      async (_org: string, _object: string, list: Row[]): Promise<InsertResult[]> =>
        list.map((): InsertResult => {
          if (list.length > most) {
            const message = limitMessage('Insert');
            return {
              id: '',
              success: false,
              errors: [message],
              errorDetails: [
                { statusCode: 'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY', message, fields: [] },
              ],
            };
          }
          return { id: `a02T${String(created++).padStart(11, '0')}AAA`, success: true, errors: [] };
        }),
    ),
    updateRecords: vi.fn(
      async (_org: string, _object: string, list: Row[]): Promise<UpdateResult[]> =>
        list.map((row) => ({ id: String(row['Id']), success: true, errors: [] })),
    ),
  } satisfies ForgeExecutorDeps;
  return { executor: new ForgeExecutor(deps), deps };
}

/** Run the provenances over the orgs above, and what came of it. */
async function run(rows: readonly Row[], most: number, options: ExecuteOptions = {}) {
  const fake = orgs(rows, most);
  const events: ForgeProgressEvent[] = [];
  const summary = await fake.executor.execute(
    graphOf(rows),
    'src',
    'tgt',
    (event) => events.push(event),
    options,
  );
  const calls = fake.deps.insertRecords.mock.calls.map((call) => call[2].length);
  return { ...fake, events, summary, calls };
}

/** The run's note of the object sent in smaller calls. */
function smallerNote(summary: ExecutionSummary) {
  return summary.errors.find(
    (report) => report.objectApiName === OBJECT && report.stage === 'scope',
  );
}

/** The line that ends the object. */
function endOf(events: readonly ForgeProgressEvent[]): string {
  return (
    events
      .filter((e) => e.objectName === OBJECT && (e.status === 'done' || e.status === 'error'))
      .at(-1)?.message ?? ''
  );
}

describe('ForgeExecutor, a call the target’s automation refuses for a Salesforce limit', () => {
  it('sends the rows again smaller, fails none, says so on the line of the object and names the trigger among the notes', async () => {
    const { summary, events, calls } = await run(provenances(116), 100);

    expect(summary.successCount).toBe(116);
    expect(summary.failedCount).toBe(0);
    expect(calls).toEqual([116, 58, 58]);
    expect(endOf(events)).toContain(
      ", 116 sent 58 at a time after the target's automation hit a Salesforce limit",
    );
    expect(smallerNote(summary)).toEqual({
      objectApiName: OBJECT,
      stage: 'scope',
      failedCount: 0,
      attemptedCount: 116,
      samples: [
        {
          recordSummary: 'Provenance__c: 116 records sent 58 at a time',
          messages: [
            'SSC_TRG_Provenance (before insert) hit Too many SOQL queries on calls of 116: 2 calls more.',
          ],
        },
      ],
    });
    // No failure's code: the results would explain the note as one.
    expect(JSON.stringify(summary.errors)).not.toContain('CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY');
  });

  it('says nothing of smaller calls when none were made', async () => {
    const { summary, events, calls } = await run(provenances(116), 200);

    expect(calls).toEqual([116]);
    expect(summary.failedCount).toBe(0);
    expect(endOf(events)).not.toContain('at a time');
    expect(smallerNote(summary)).toBeUndefined();
  });

  it('takes the smaller calls it allows itself from its input: none, and the rows refused stay refused, with a note', async () => {
    const { summary, calls } = await run(provenances(116), 100, { splitAllowance: 0 });

    expect(calls).toEqual([116]);
    expect(summary.successCount).toBe(0);
    expect(summary.failedCount).toBe(116);
    expect(smallerNote(summary)?.samples).toEqual([
      {
        recordSummary: 'Provenance__c: 116 records refused for a Salesforce limit',
        messages: [
          'SSC_TRG_Provenance (before insert) hit Too many SOQL queries on a call of 116.',
          '116 not sent in smaller calls: what the org has left today allowed the run none.',
        ],
      },
    ]);
  });

  it('takes the smaller calls its gate allows it over those of its input, before its first write', async () => {
    const beforeWrite = vi.fn(async () => ({ splitAllowance: 0 }));

    const { summary, calls } = await run(provenances(116), 100, {
      splitAllowance: 2_000,
      beforeWrite,
    });

    expect(beforeWrite).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([116]);
    expect(summary.failedCount).toBe(116);
  });

  it('sends smaller the lookups of its second pass a call was refused for, and notes them apart', async () => {
    // Each provenance points at the next, written after it: its lookup goes
    // in the second pass, whose trigger takes one update a call.
    const rows = provenances(3).map((row, i) => ({
      ...row,
      Parent__c: i < 2 ? src(i + 1) : null,
    }));
    const fake = orgs(rows, 200);
    fake.deps.describeFields.mockResolvedValue([
      ...FIELDS,
      field('Parent__c', { isReference: true, referenceTo: [OBJECT], nillable: true }),
    ]);
    fake.deps.updateRecords.mockImplementation(async (_org, _object, list) =>
      list.map((row) => {
        if (list.length === 1) return { id: String(row['Id']), success: true, errors: [] };
        const message = limitMessage('Update');
        return { id: '', success: false, errors: [message] };
      }),
    );

    const summary = await fake.executor.execute(graphOf(rows), 'src', 'tgt', () => {}, {});

    expect(fake.deps.updateRecords.mock.calls.map((call) => call[2].length)).toEqual([2, 1, 1]);
    expect(summary.errors.filter((report) => report.objectApiName === '__pass2__')).toEqual([]);
    expect(smallerNote(summary)?.samples).toEqual([
      {
        recordSummary: 'Provenance__c: 2 lookup updates sent 1 at a time',
        messages: [
          'SSC_TRG_Provenance (before update) hit Too many SOQL queries on calls of 2: 2 calls more.',
        ],
      },
    ]);
  });

  it('notes no smaller calls for an object a cancel stopped before any of them', async () => {
    const rows = provenances(116);
    const fake = orgs(rows, 100);
    const refuse = fake.deps.insertRecords.getMockImplementation();
    // The run is paused while the call the trigger refuses is under way, its
    // halves cut and paid for but held at their checkpoint; read so, then
    // cancelled, none of them is ever sent.
    fake.deps.insertRecords.mockImplementation(async (org, object, list) => {
      fake.executor.pause();
      return refuse ? refuse(org, object, list) : [];
    });

    const ended = fake.executor
      .execute(graphOf(rows), 'src', 'tgt', () => {}, {})
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(fake.deps.insertRecords).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const summary = fake.executor.summarySoFar();
    fake.executor.abort();
    await ended;

    expect(fake.deps.insertRecords.mock.calls.map((call) => call[2].length)).toEqual([116]);
    expect(summary).toBeDefined();
    if (!summary) return;
    expect(smallerNote(summary)).toBeUndefined();
    expect(JSON.stringify(summary.errors)).not.toContain('0 records refused');
  });

  it('keeps the smaller calls of its input when its gate answers nothing of them', async () => {
    const { summary, calls } = await run(provenances(116), 100, {
      beforeWrite: vi.fn(async () => undefined),
    });

    expect(calls).toEqual([116, 58, 58]);
    expect(summary.failedCount).toBe(0);
  });
});
