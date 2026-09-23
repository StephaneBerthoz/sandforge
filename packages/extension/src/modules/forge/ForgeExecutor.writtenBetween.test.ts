import { describe, it, expect, vi } from 'vitest';
import type { ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import { ForgeExecutor } from './ForgeExecutor.js';
import type { ExecuteOptions, FieldInfo, ForgeExecutorDeps } from './ForgeExecutor.js';
import { partialSummaryOf } from './interruptedRun.js';
import { selectRows, type FakeRow } from '../../test/fakeSoql.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** A fake id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const ACCOUNT = id('001', 1);
const CONTACT = id('003', 1);

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
    field('AccountId', { isReference: true, referenceTo: ['Account'] }),
  ],
};

function node(objectApiName: string): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 1,
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

const GRAPH: ForgeGraph = {
  nodes: [node('Account'), node('Contact')],
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

const SOURCE: Record<string, FakeRow[]> = {
  Account: [{ Id: ACCOUNT, Name: 'Root' }],
  Contact: [{ Id: CONTACT, LastName: 'Key', AccountId: ACCOUNT }],
};

/**
 * A target that dates what it writes by its own clock, whatever this
 * machine's says: the account at 10:00:05, the contact at 10:00:06, and the
 * account touched again at 10:00:08 by what the run did after it.
 */
function fakeOrgs(options: { refuseDates?: boolean } = {}) {
  const target: Record<string, FakeRow[]> = { Account: [], Contact: [] };
  const dates: Record<string, { CreatedDate: string; LastModifiedDate: string }> = {
    Account: {
      CreatedDate: '2026-09-20T10:00:05.000+0000',
      LastModifiedDate: '2026-09-20T10:00:08.000+0000',
    },
    Contact: {
      CreatedDate: '2026-09-20T10:00:06.000+0000',
      LastModifiedDate: '2026-09-20T10:00:06.000+0000',
    },
  };
  let next = 0;
  const deps = {
    describeFields: vi.fn(async (_org: string, object: string) => FIELDS[object] ?? [field('Id')]),
    queryRecords: vi.fn(async (org: string, soql: string) => {
      if (org === 'src') return selectRows(SOURCE, soql);
      if (options.refuseDates) throw new Error('INSUFFICIENT_ACCESS: read refused');
      return selectRows(target, soql);
    }),
    insertRecords: vi.fn(async (_org: string, object: string, rows: Record<string, unknown>[]) =>
      rows.map(() => {
        const created = id(object === 'Account' ? '001' : '003', 900 + ++next);
        target[object].push({ Id: created, ...dates[object] });
        return { id: created, success: true, errors: [] };
      }),
    ),
  } satisfies ForgeExecutorDeps;
  return { deps, target, dates };
}

const SCOPED: ExecuteOptions = { rootRecordId: ACCOUNT, rootObjectApiName: 'Account' };

describe('ForgeExecutor, the dates the target gave the run', () => {
  it('reads them back from the records it created: the first creation and the last stamp it left', async () => {
    const { deps } = fakeOrgs();

    const summary = await new ForgeExecutor(deps).execute(
      GRAPH,
      'src',
      'tgt',
      () => undefined,
      SCOPED,
    );

    expect(summary.writtenBetween).toEqual({
      first: '2026-09-20T10:00:05.000Z',
      last: '2026-09-20T10:00:08.000Z',
    });
  });

  it('reads them for a run stopped part way, which is removed by them too', async () => {
    const { deps, target, dates } = fakeOrgs();
    const executor = new ForgeExecutor(deps);
    // Stopped once the account is written, before the contact.
    deps.insertRecords.mockImplementationOnce(async (_org, _object, rows) => {
      executor.abort();
      target.Account.push({ Id: id('001', 950), ...dates.Account });
      return rows.map(() => ({ id: id('001', 950), success: true, errors: [] }));
    });
    let stopped: unknown;

    await executor
      .execute(GRAPH, 'src', 'tgt', () => undefined, SCOPED)
      .catch((err: unknown) => {
        stopped = err;
      });

    expect(partialSummaryOf(stopped)?.createdByObject).toEqual([
      { objectApiName: 'Account', sourceIds: [ACCOUNT] },
    ]);
    expect(partialSummaryOf(stopped)?.writtenBetween).toEqual({
      first: '2026-09-20T10:00:05.000Z',
      last: '2026-09-20T10:00:08.000Z',
    });
  });

  it('leaves a dry run undated: it wrote nothing', async () => {
    const { deps } = fakeOrgs();

    const summary = await new ForgeExecutor(deps).execute(GRAPH, 'src', 'tgt', () => undefined, {
      ...SCOPED,
      dryRun: true,
    });

    expect(summary.writtenBetween).toBeUndefined();
    expect(deps.queryRecords.mock.calls.some(([org]) => org === 'tgt')).toBe(false);
  });

  it('leaves the run undated, and written all the same, when the target will not say', async () => {
    const { deps } = fakeOrgs({ refuseDates: true });

    const summary = await new ForgeExecutor(deps).execute(
      GRAPH,
      'src',
      'tgt',
      () => undefined,
      SCOPED,
    );

    expect(summary.successCount).toBe(2);
    expect(summary.writtenBetween).toBeUndefined();
  });
});
