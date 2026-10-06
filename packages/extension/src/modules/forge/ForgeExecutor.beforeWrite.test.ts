import { describe, it, expect, vi } from 'vitest';
import type { ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import { ForgeExecutor } from './ForgeExecutor.js';
import type {
  ExecuteOptions,
  FieldInfo,
  ForgeExecutorDeps,
  ForgeWriteBoundary,
} from './ForgeExecutor.js';
import { ForgeRunGateError, writePlanOf } from './ForgeRunGate.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * The boundary between a run's reads and its writes: every row in hand, none
 * written. A clone whose dry run said 37 records wrote 34 216 into a sandbox,
 * and nothing between the two looked at how many.
 */

/** A fake id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const ACCOUNT_ID = id('001', 1);

const field = (name: string, overrides: Partial<FieldInfo> = {}): FieldInfo => ({
  name,
  queryable: true,
  createable: name !== 'Id',
  isReference: false,
  ...overrides,
});

const FIELDS: Record<string, FieldInfo[]> = {
  Account: [field('Id'), field('Name')],
  Contact: [
    field('Id'),
    field('LastName'),
    field('AccountId', { isReference: true, referenceTo: ['Account'], nillable: true }),
  ],
};

function node(objectApiName: string, level: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 1,
    fieldCount: 3,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 2,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'rest',
  };
}

/** An account and its contacts. */
const GRAPH: ForgeGraph = {
  nodes: [node('Account', 0), node('Contact', 1)],
  edges: [
    {
      sourceObject: 'Account',
      targetObject: 'Contact',
      relationshipName: 'Contacts',
      type: 'lookup',
    },
  ],
  totalRecords: 2,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 0,
};

const ROOTED_AT_THE_ACCOUNT: ExecuteOptions = {
  rootRecordId: ACCOUNT_ID,
  rootObjectApiName: 'Account',
};

/**
 * A source holding one account and `contacts` contacts of it, and a target
 * that creates what it is sent. Each read and write is logged in `calls`, in
 * the order the run made them.
 */
function orgs(contacts: number) {
  const calls: string[] = [];
  const contactRows = Array.from({ length: contacts }, (_, i) => ({
    Id: id('003', i + 1),
    LastName: `Contact ${i + 1}`,
    AccountId: ACCOUNT_ID,
  }));
  let next = 0;
  const deps = {
    describeFields: vi.fn(async (_org: string, object: string) => FIELDS[object] ?? []),
    queryRecords: vi.fn(async (org: string, soql: string) => {
      if (org !== 'src') return [];
      if (/FROM Account\b/.test(soql)) {
        calls.push('read Account');
        return [{ Id: ACCOUNT_ID, Name: 'Acme' }];
      }
      if (/FROM Contact\b/.test(soql)) {
        calls.push('read Contact');
        return contactRows.map((row) => ({ ...row }));
      }
      return [];
    }),
    insertRecords: vi.fn(async (_org: string, object: string, rows: Record<string, unknown>[]) => {
      calls.push(`insert ${object}`);
      return rows.map(() => ({
        id: id(object === 'Account' ? '001' : '003', 900 + ++next),
        success: true,
        errors: [],
      }));
    }),
  } satisfies ForgeExecutorDeps;
  return { deps, calls };
}

/** A hook that keeps what it was handed, and notes when it was called among the run's calls. */
function watching(calls: string[]) {
  const seen: ForgeWriteBoundary[] = [];
  const beforeWrite = vi.fn(async (boundary: ForgeWriteBoundary) => {
    calls.push('beforeWrite');
    seen.push(boundary);
  });
  return { seen, beforeWrite };
}

/** Per object, how many rows a boundary held. */
const counted = (boundary: ForgeWriteBoundary | undefined): Record<string, number> =>
  Object.fromEntries((boundary?.objects ?? []).map((o) => [o.objectApiName, o.rows.length]));

describe('ForgeExecutor, before the first write', () => {
  it('hands every row of a record clone to its caller once all are read, before the first insert', async () => {
    const { deps, calls } = orgs(3);
    const { seen, beforeWrite } = watching(calls);

    const summary = await new ForgeExecutor(deps).execute(GRAPH, 'src', 'tgt', () => undefined, {
      ...ROOTED_AT_THE_ACCOUNT,
      beforeWrite,
    });

    expect(beforeWrite).toHaveBeenCalledTimes(1);
    expect(counted(seen[0])).toEqual({ Account: 1, Contact: 3 });
    expect(seen[0].dryRun).toBe(false);
    expect(calls.indexOf('beforeWrite')).toBeLessThan(calls.indexOf('insert Account'));
    expect(calls.indexOf('beforeWrite')).toBeGreaterThan(calls.lastIndexOf('read Contact'));
    expect(summary.successCount).toBe(4);
  });

  it('writes nothing when what it hands them to refuses the run, and the refusal reaches the caller', async () => {
    const { deps } = orgs(3);
    const refusal = new ForgeRunGateError('WRITE_DECLINED', 'cancelled at the confirmation');

    await expect(
      new ForgeExecutor(deps).execute(GRAPH, 'src', 'tgt', () => undefined, {
        ...ROOTED_AT_THE_ACCOUNT,
        beforeWrite: async () => {
          throw refusal;
        },
      }),
    ).rejects.toBe(refusal);
    expect(deps.insertRecords).not.toHaveBeenCalled();
  });

  it('stops a plan a hundred times the size its dry run said before any write', async () => {
    // The dry run counted 37 records; a parent added to the graph widened the
    // read of its children, and the real run held 3 700 of them.
    const { deps } = orgs(3_700);
    const expected = 37;

    await expect(
      new ForgeExecutor(deps).execute(GRAPH, 'src', 'tgt', () => undefined, {
        ...ROOTED_AT_THE_ACCOUNT,
        beforeWrite: async (boundary) => {
          const plan = writePlanOf(boundary.objects);
          if (plan.totalRows > expected * 10) {
            throw new ForgeRunGateError('MAX_TOTAL_EXCEEDED', `${plan.totalRows} records`);
          }
        },
      }),
    ).rejects.toThrow('3701 records');
    expect(deps.insertRecords).not.toHaveBeenCalled();
  });

  it('reads every table of a run of whole tables before writing any, when it has a caller to show them to', async () => {
    const { deps, calls } = orgs(2);
    const { seen, beforeWrite } = watching(calls);

    await new ForgeExecutor(deps).execute(GRAPH, 'src', 'tgt', () => undefined, { beforeWrite });

    expect(counted(seen[0])).toEqual({ Account: 1, Contact: 2 });
    expect(calls).toEqual([
      'read Account',
      'read Contact',
      'beforeWrite',
      'insert Account',
      'insert Contact',
    ]);
  });

  it('keeps the single pass of a run of whole tables that has none', async () => {
    const { deps, calls } = orgs(2);

    await new ForgeExecutor(deps).execute(GRAPH, 'src', 'tgt', () => undefined);

    expect(calls).toEqual(['read Account', 'insert Account', 'read Contact', 'insert Contact']);
  });

  it('hands a dry run its rows as a dry run, and writes nothing', async () => {
    const { deps, calls } = orgs(2);
    const { seen, beforeWrite } = watching(calls);

    await new ForgeExecutor(deps).execute(GRAPH, 'src', 'tgt', () => undefined, {
      ...ROOTED_AT_THE_ACCOUNT,
      dryRun: true,
      beforeWrite,
    });

    expect(seen[0].dryRun).toBe(true);
    expect(counted(seen[0])).toEqual({ Account: 1, Contact: 2 });
    expect(deps.insertRecords).not.toHaveBeenCalled();
  });

  it('leaves out the rows a retried run already wrote: they are linked, not written', async () => {
    const { deps, calls } = orgs(3);
    const { seen, beforeWrite } = watching(calls);

    await new ForgeExecutor(deps).execute(GRAPH, 'src', 'tgt', () => undefined, {
      ...ROOTED_AT_THE_ACCOUNT,
      writtenBefore: { [ACCOUNT_ID]: id('001', 500), [id('003', 1)]: id('003', 500) },
      beforeWrite,
    });

    expect(counted(seen[0])).toEqual({ Account: 0, Contact: 2 });
  });

  it('asks nothing of a run stopped before its writes', async () => {
    const { deps } = orgs(1);
    const executor = new ForgeExecutor(deps);
    const beforeWrite = vi.fn(async () => undefined);
    // Abort lands while the run reads: the boundary is never reached.
    deps.queryRecords.mockImplementation(async (org: string, soql: string) => {
      if (org === 'src' && /FROM Contact\b/.test(soql)) executor.abort();
      if (org === 'src' && /FROM Account\b/.test(soql)) return [{ Id: ACCOUNT_ID, Name: 'Acme' }];
      return [];
    });

    await expect(
      executor.execute(GRAPH, 'src', 'tgt', () => undefined, {
        ...ROOTED_AT_THE_ACCOUNT,
        beforeWrite,
      }),
    ).rejects.toThrow(/aborted/);
    expect(beforeWrite).not.toHaveBeenCalled();
    expect(deps.insertRecords).not.toHaveBeenCalled();
  });
});
