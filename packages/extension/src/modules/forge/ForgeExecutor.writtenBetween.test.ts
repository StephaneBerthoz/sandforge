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

/** The audit dates a source record carries, from long before any run. */
const SOURCE_AUDIT_DATES = {
  CreatedDate: '2019-05-01T08:00:00.000+0000',
  LastModifiedDate: '2019-06-01T08:00:00.000+0000',
};

/**
 * A target that dates what it writes by its own clock, whatever this
 * machine's says: the account at 10:00:05, the contact at 10:00:06, and the
 * account touched again at 10:00:08 by what the run did after it.
 *
 * @param options.refuseDates - Every read of the target is refused.
 * @param options.refuseDatesOf - Only a read of this object's dates is refused.
 * @param options.auditDates - Both orgs let the run's user set a record's
 *   audit dates: the describes call them createable, and the target keeps the
 *   ones a record is written with, its system stamp still dating the write.
 * @param options.stampOnlyOf - This object keeps no `LastModifiedDate`, only
 *   a system stamp, which the platform set at 10:00:09.
 */
function fakeOrgs(
  options: {
    refuseDates?: boolean;
    refuseDatesOf?: string;
    auditDates?: boolean;
    stampOnlyOf?: string;
  } = {},
) {
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
  const source: Record<string, FakeRow[]> = options.auditDates
    ? Object.fromEntries(
        Object.entries(SOURCE).map(([object, rows]) => [
          object,
          rows.map((row) => ({ ...row, ...SOURCE_AUDIT_DATES })),
        ]),
      )
    : SOURCE;
  const auditFields = options.auditDates
    ? [field('CreatedDate', { type: 'datetime' }), field('LastModifiedDate', { type: 'datetime' })]
    : [];
  let next = 0;
  const deps = {
    describeFields: vi.fn(async (_org: string, object: string) => [
      ...(FIELDS[object] ?? [field('Id')]),
      ...auditFields,
    ]),
    queryRecords: vi.fn(async (org: string, soql: string) => {
      if (org === 'src') return selectRows(source, soql);
      if (options.refuseDates) throw new Error('INSUFFICIENT_ACCESS: read refused');
      if (
        options.refuseDatesOf &&
        new RegExp(
          `^SELECT Id, .*\\b(CreatedDate|SystemModstamp)\\b.* FROM ${options.refuseDatesOf} `,
        ).test(soql)
      ) {
        throw new Error('REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.');
      }
      if (
        options.stampOnlyOf &&
        new RegExp(`^SELECT .*\\bLastModifiedDate\\b.* FROM ${options.stampOnlyOf} `).test(soql)
      ) {
        throw new Error(
          `INVALID_FIELD: No such column 'LastModifiedDate' on entity '${options.stampOnlyOf}'`,
        );
      }
      return selectRows(target, soql);
    }),
    insertRecords: vi.fn(async (_org: string, object: string, rows: Record<string, unknown>[]) =>
      rows.map((row) => {
        const created = id(object === 'Account' ? '001' : '003', 900 + ++next);
        const written = dates[object];
        target[object].push(
          object === options.stampOnlyOf
            ? {
                Id: created,
                CreatedDate: written.CreatedDate,
                SystemModstamp: '2026-09-20T10:00:09.000+0000',
              }
            : {
                Id: created,
                ...written,
                ...(options.auditDates
                  ? {
                      CreatedDate: String(row['CreatedDate']),
                      LastModifiedDate: String(row['LastModifiedDate']),
                      SystemModstamp: written.CreatedDate,
                    }
                  : {}),
              },
        );
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

  it('leaves the run undated when the dates of one object it wrote could not be read', async () => {
    // Dated by the contact alone, the run ended at 10:00:06, before the stamp
    // it left on the account at 10:00:08: a removal would read the account as
    // changed since the run, and keep it.
    const { deps } = fakeOrgs({ refuseDatesOf: 'Account' });

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

  it('dates the records of an object that keeps no modified date by their system stamp', async () => {
    // An email message's relations keep a creation date and a system stamp,
    // and no LastModifiedDate: read by it, the run went undated.
    const { deps } = fakeOrgs({ stampOnlyOf: 'Contact' });

    const summary = await new ForgeExecutor(deps).execute(
      GRAPH,
      'src',
      'tgt',
      () => undefined,
      SCOPED,
    );

    expect(summary.writtenBetween).toEqual({
      first: '2026-09-20T10:00:05.000Z',
      last: '2026-09-20T10:00:09.000Z',
    });
  });

  it('dates the run by the target, not by the audit dates it copied from the source', async () => {
    // Both orgs let the run's user set audit fields: the clone writes the
    // source's creation date, years before the run, and only the system stamp
    // says when the target took the record.
    const { deps, target } = fakeOrgs({ auditDates: true });

    const summary = await new ForgeExecutor(deps).execute(
      GRAPH,
      'src',
      'tgt',
      () => undefined,
      SCOPED,
    );

    expect(target.Account[0]).toMatchObject({ CreatedDate: SOURCE_AUDIT_DATES.CreatedDate });
    expect(summary.writtenBetween).toEqual({
      first: '2026-09-20T10:00:05.000Z',
      last: '2026-09-20T10:00:06.000Z',
    });
  });
});
