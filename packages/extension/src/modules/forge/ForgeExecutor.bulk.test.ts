import { describe, it, expect, vi } from 'vitest';
import type { ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import { ForgeExecutor, insertCallsIn } from './ForgeExecutor.js';
import type {
  ExecuteOptions,
  FieldInfo,
  ForgeExecutorDeps,
  InsertResult,
} from './ForgeExecutor.js';
import type { BulkRowState, BulkWriteAnswer } from './forgeBulkWrite.js';
import { ForgeRunStore, memoryRunFile } from './ForgeRunStore.js';
import { JournalPart } from './journalRecords.js';
import { BatchWriter } from './stages/BatchWriter.js';
import { IdRemapper } from './IdRemapper.js';
import { BulkApiManager } from '../../core/engine/BulkApiManager.js';
import { removeRunRecords, type RemovalOrg } from './ForgeRunRemoval.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * A run that writes through the Bulk API (`writeApi: 'auto'`) sends a write
 * of 2 000 rows or more as a job, its second pass too; every other run writes
 * by REST, as it always did. No run of the extension asks for it yet.
 */

const field = (name: string, overrides: Partial<FieldInfo> = {}): FieldInfo => ({
  name,
  queryable: true,
  createable: name !== 'Id',
  isReference: false,
  ...overrides,
});

const FIELDS: Record<string, FieldInfo[]> = {
  Account: [
    field('Id'),
    field('Name'),
    field('ParentId', { isReference: true, referenceTo: ['Account'], nillable: true }),
  ],
  Invoice__c: [field('Id'), field('Name')],
};

/** The `n`-th source id of an object whose ids begin with `prefix`. */
const src = (prefix: string, n: number): string => `${prefix}S${String(n).padStart(11, '0')}AAA`;

function node(objectApiName: string, recordCount: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount,
    fieldCount: 3,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 2,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
  };
}

function graphOf(...nodes: ForgeGraphNode[]): ForgeGraph {
  return { nodes, edges: [], totalRecords: 0, estimatedSizeMB: 0, estimatedDurationSeconds: 0 };
}

/** The answer of a job that wrote every row it was sent. */
function allWritten(records: readonly Record<string, unknown>[], prefix: string): BulkWriteAnswer {
  return {
    answers: records.map((record, i): InsertResult => ({
      id:
        typeof record['Id'] === 'string'
          ? record['Id']
          : `${prefix}T${String(i).padStart(11, '0')}AAA`,
      success: true,
      errors: [],
    })),
    rows: records.map((): BulkRowState => 'answered'),
    unmatchedIds: [],
    requests: 12,
  };
}

/**
 * A source holding `rows` by object, a target that creates what it is sent by
 * REST, and a Bulk API that writes every job it is sent.
 */
function orgs(
  rows: Record<string, Record<string, unknown>[]>,
  duplicateRuleObjects: NonNullable<ForgeExecutorDeps['duplicateRuleObjects']> = async () =>
    new Set<string>(),
) {
  let created = 0;
  const deps = {
    describeFields: vi.fn(async (_org: string, object: string) => FIELDS[object] ?? []),
    queryRecords: vi.fn(async (org: string, soql: string) => {
      if (org !== 'src') return [];
      const object = /FROM (\w+)/.exec(soql)?.[1] ?? '';
      return (rows[object] ?? []).map((row) => ({ ...row }));
    }),
    insertRecords: vi.fn(async (_org: string, object: string, sent: Record<string, unknown>[]) =>
      sent.map((): InsertResult => ({
        id: `${object.slice(0, 3)}R${String(created++).padStart(11, '0')}AAA`,
        success: true,
        errors: [],
      })),
    ),
    updateRecords: vi.fn(async (_org: string, _object: string, sent: Record<string, unknown>[]) =>
      sent.map((row) => ({ id: String(row['Id']), success: true, errors: [] })),
    ),
    bulkWriteRecords: vi.fn<NonNullable<ForgeExecutorDeps['bulkWriteRecords']>>(
      async (_org, object, _operation, records) => allWritten(records, object.slice(0, 3)),
    ),
    duplicateRuleObjects: vi.fn(duplicateRuleObjects),
  } satisfies ForgeExecutorDeps;
  return { executor: new ForgeExecutor(deps), deps };
}

const invoices = (n: number): Record<string, unknown>[] =>
  Array.from({ length: n }, (_, i) => ({ Id: src('a01', i), Name: `INV-${i}` }));

const BULK: ExecuteOptions = { writeApi: 'auto' };

describe('ForgeExecutor, writes sent as Bulk API jobs', () => {
  it('sends no job unless the run writes through the Bulk API, and asks nothing of the target’s duplicate rules', async () => {
    const { executor, deps } = orgs({ Invoice__c: invoices(2_500) });

    const summary = await executor.execute(graphOf(node('Invoice__c', 2_500)), 'src', 'tgt', () => {
      /* progress */
    });

    expect(deps.bulkWriteRecords).not.toHaveBeenCalled();
    expect(deps.duplicateRuleObjects).not.toHaveBeenCalled();
    expect(deps.insertRecords).toHaveBeenCalledTimes(13);
    expect(summary.successCount).toBe(2_500);
  });

  it('sends a write of 2 000 rows or more as a job, on a job limiter of the run’s own, and the target’s duplicate rules read once', async () => {
    const { executor, deps } = orgs({ Invoice__c: invoices(2_500) });

    const summary = await executor.execute(
      graphOf(node('Invoice__c', 2_500)),
      'src',
      'tgt',
      () => {
        /* progress */
      },
      BULK,
    );

    expect(deps.duplicateRuleObjects).toHaveBeenCalledWith('tgt');
    expect(deps.insertRecords).not.toHaveBeenCalled();
    expect(deps.bulkWriteRecords).toHaveBeenCalledTimes(1);
    const [org, object, operation, records, options] = deps.bulkWriteRecords.mock.calls[0];
    expect([org, object, operation, records.length]).toEqual([
      'tgt',
      'Invoice__c',
      'insert',
      2_500,
    ]);
    expect(options.bulkManager.maxConcurrentJobs).toBe(1);
    expect(summary.successCount).toBe(2_500);

    // Each run its own limiter.
    await executor.execute(
      graphOf(node('Invoice__c', 2_500)),
      'src',
      'tgt',
      () => {
        /* progress */
      },
      BULK,
    );
    expect(deps.bulkWriteRecords.mock.calls[1][4].bulkManager).not.toBe(options.bulkManager);
  });

  it('writes by REST an object the target’s duplicate rules may watch, when the target will not say which', async () => {
    const accounts = Array.from({ length: 2_000 }, (_, i) => ({
      Id: src('001', i),
      Name: `Acme ${i}`,
      ParentId: null,
    }));
    const { executor, deps } = orgs({ Account: accounts }, async () => undefined);

    await executor.execute(
      graphOf(node('Account', 2_000)),
      'src',
      'tgt',
      () => {
        /* progress */
      },
      BULK,
    );

    expect(deps.bulkWriteRecords).not.toHaveBeenCalled();
    expect(deps.insertRecords).toHaveBeenCalledTimes(10);
  });

  it('sends no job on a simulation', async () => {
    const { executor, deps } = orgs({ Invoice__c: invoices(2_500) });

    const summary = await executor.execute(
      graphOf(node('Invoice__c', 2_500)),
      'src',
      'tgt',
      () => {
        /* progress */
      },
      { ...BULK, dryRun: true },
    );

    expect(deps.bulkWriteRecords).not.toHaveBeenCalled();
    expect(deps.insertRecords).not.toHaveBeenCalled();
    // Nor does it ask the target which objects its rules watch: a dry run of
    // a run that sends jobs reads no more of the target than one that does not.
    expect(deps.duplicateRuleObjects).not.toHaveBeenCalled();
    expect(summary.wouldInsertCount).toBe(2_500);
  });

  it('sends no job on a simulation whose second pass owes 2 000 updates, nor any update', async () => {
    const accounts = Array.from({ length: 2_001 }, (_, i) => ({
      Id: src('001', i),
      Name: `Acme ${i}`,
      ParentId: i === 0 ? null : src('001', 0),
    }));
    const { executor, deps } = orgs({ Account: accounts });

    await executor.execute(
      graphOf(node('Account', 2_001)),
      'src',
      'tgt',
      () => {
        /* progress */
      },
      { ...BULK, dryRun: true },
    );

    expect(deps.bulkWriteRecords).not.toHaveBeenCalled();
    expect(deps.updateRecords).not.toHaveBeenCalled();
  });

  it('aborts the job under way when the run is cancelled', async () => {
    let signal: AbortSignal | undefined;
    const { executor, deps } = orgs({ Invoice__c: invoices(2_500) });
    deps.bulkWriteRecords.mockImplementation(
      async (_org, _object, _operation, _records, options) => {
        signal = options.signal;
        executor.abort();
        return { answers: [], rows: [], unmatchedIds: [], aborted: true, requests: 2 };
      },
    );

    await expect(
      executor.execute(
        graphOf(node('Invoice__c', 2_500)),
        'src',
        'tgt',
        () => {
          /* progress */
        },
        BULK,
      ),
    ).rejects.toThrow(/aborted/i);
    expect(signal?.aborted).toBe(true);
    expect(deps.insertRecords).not.toHaveBeenCalled();
  });

  it('sends the second pass of an object owing 2 000 updates or more as a job', async () => {
    // Every account under the first: written in one job, their lookup at it
    // owed to the second pass.
    const accounts = Array.from({ length: 2_001 }, (_, i) => ({
      Id: src('001', i),
      Name: `Acme ${i}`,
      ParentId: i === 0 ? null : src('001', 0),
    }));
    const { executor, deps } = orgs({ Account: accounts });

    await executor.execute(
      graphOf(node('Account', 2_001)),
      'src',
      'tgt',
      () => {
        /* progress */
      },
      BULK,
    );

    const operations = deps.bulkWriteRecords.mock.calls.map((c) => [c[1], c[2], c[3].length]);
    expect(operations).toEqual([
      ['Account', 'insert', 2_001],
      ['Account', 'update', 2_000],
    ]);
    expect(deps.updateRecords).not.toHaveBeenCalled();
  });
});

describe('a job’s records in the run’s journal, and its removal', () => {
  /** The target's ids, as a job's results give them. */
  const tgt = (n: number): string => `003T${String(n).padStart(11, '0')}AAA`;
  const JOB = '750000000000001AAA';

  /**
   * Write `n` contacts as one job through the run's journal (`insertCallsIn`),
   * the job answering each row with a record of its own and writing one more
   * record no row could be matched to.
   */
  async function writtenAsAJob(n: number) {
    const file = memoryRunFile(
      `${JSON.stringify({ run: { journalId: 'j', targetOrgId: 'tgt', startedAt: '2026-11-12T08:00:00.000Z' } })}\n`,
    );
    const store = ForgeRunStore.open(file);
    store.beginPart(new Date('2026-11-12T08:00:00.000Z'));
    const remapper = new IdRemapper(store);
    const bulkWriteRecords = vi.fn<NonNullable<ForgeExecutorDeps['bulkWriteRecords']>>(
      async (_org, _object, _op, records, options) => {
        options.onOpened?.(JOB);
        return {
          answers: records.map((_, i): InsertResult => ({ id: tgt(i), success: true, errors: [] })),
          rows: records.map((): BulkRowState => 'answered'),
          unmatchedIds: [tgt(n)],
          jobId: JOB,
          requests: 12,
        };
      },
    );
    const contacts = Array.from({ length: n }, (_, i) => ({
      Id: src('003', i),
      LastName: `C${i}`,
    }));
    await new BatchWriter({ insertRecords: vi.fn(), bulkWriteRecords }).writeNode({
      node: { ...node('Contact', n) },
      records: contacts.map(({ LastName }) => ({ LastName })),
      cleanedRecords: contacts.map((row) => ({
        source: row,
        cleaned: { LastName: row.LastName },
        nullifiedFks: [],
      })),
      fieldInfos: [field('Id'), field('LastName')],
      creatableFields: new Set(['LastName']),
      upsertMode: 'off',
      targetOrgId: 'tgt',
      remapper,
      calls: insertCallsIn(store),
      bulk: {
        signal: new AbortController().signal,
        restOnly: new Set(),
        bulkUnsupported: new Set(),
        manager: new BulkApiManager(1),
      },
      waitIfPaused: async () => undefined,
      onProgress: () => undefined,
    });
    store.close();
    return file;
  }

  /** The target, every record there unchanged since the run, every delete taken. */
  function target(): RemovalOrg & { deleted: string[] } {
    const deleted: string[] = [];
    return {
      deleted,
      query: async (soql: string) => {
        const list = /WHERE Id IN \((.*)\)$/.exec(soql)?.[1];
        if (!list) return { totalSize: 0, records: [] };
        const records = list.split(', ').map((quoted) => ({
          Id: quoted.slice(1, -1),
          CreatedDate: '2026-11-12T08:00:01.000+0000',
          LastModifiedDate: '2026-11-12T08:00:01.000+0000',
        }));
        return { totalSize: records.length, records };
      },
      destroy: async (_object: string, ids: string[]) => {
        deleted.push(...ids);
        return ids.map((id) => ({ id, success: true, errors: [] }));
      },
      update: async () => [],
      describe: async (name: string) => ({ name, label: name, fields: [], childRelationships: [] }),
      describeGlobal: async () => ({ sobjects: [] }),
      serverTime: async () => '2026-11-12T10:00:00.000Z',
      userId: async () => '005000000000001AAA',
      queryDeleted: async () => ({ records: [] }),
    };
  }

  it('keeps the job’s id and what it wrote under no row, and its removal takes those records with the rows’ own', async () => {
    const file = await writtenAsAJob(2_000);

    const lines = file
      .text()
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown);
    expect(lines).toContainEqual(['n', 'Contact', [tgt(2_000)]]);
    expect(lines.filter((line) => Array.isArray(line) && line[0] === 'j')).toEqual([
      ['j', expect.any(String), JOB],
    ]);

    const records = JournalPart.read(file, 0)?.runRecords();
    if (!records) throw new Error('not read');
    // What the sweep reads as the run's: never a record its automation made.
    expect(records.has(tgt(2_000).slice(0, 15))).toBe(true);
    const org = target();
    await removeRunRecords(org, records, {
      runStartedAt: new Date('2026-11-12T08:00:00.000Z'),
      runEndedAt: new Date('2026-11-12T09:00:00.000Z'),
      includeChanged: false,
    });
    expect(org.deleted).toHaveLength(2_001);
    expect(org.deleted).toContain(tgt(2_000));
  });
});
