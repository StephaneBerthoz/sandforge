import { describe, it, expect, vi } from 'vitest';
import {
  overwriteBackupIdOf,
  storeOverwriteBackup,
  syncOverwriteKeeper,
  type OverwriteBackup,
} from './syncOverwrites';
import type { TargetWriteFields } from './targetWriteFields';

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const A1 = fakeId('001', 1);
const A2 = fakeId('001', 2);
const A3 = fakeId('001', 3);
const BACKUP = 'sync-before-run-1';

/** The target's accounts, as a query of them by Id or by external id answers. */
const HELD: Array<Record<string, unknown>> = [
  { Id: A1, Ext__c: 'K-1', Name: 'Before 1', Phone: '+33 1 00 00 00 01', Fax: null },
  { Id: A2, Ext__c: 'K-2', Name: 'Before 2', Phone: null, Fax: '+33 1 00 00 00 02' },
  { Id: A3, Ext__c: 'K-3', Name: 'Before 3', Phone: null, Fax: null },
];

/** A target that reads `SELECT <columns> FROM Account WHERE <key> IN (…)` over {@link HELD}. */
function target() {
  const statements: string[] = [];
  const query = vi.fn(async (soql: string) => {
    statements.push(soql);
    const match = /^SELECT (.+) FROM Account WHERE (\w+) IN \((.*)\)$/.exec(soql);
    if (!match) throw new Error(`not a statement the target reads: ${soql}`);
    const [, columns, key, list] = match;
    const wanted = list.split(', ').map((quoted) => quoted.slice(1, -1).toLowerCase());
    return HELD.filter((row) =>
      wanted.some((value) =>
        key === 'Id'
          ? String(row.Id).slice(0, 15).toLowerCase() === value.slice(0, 15)
          : String(row[key]).toLowerCase() === value,
      ),
    ).map((row) => Object.fromEntries(columns.split(', ').map((column) => [column, row[column]])));
  });
  return { statements, query };
}

/** A backup that keeps in memory what it is given, and the recorder's lines. */
function keeping() {
  const kept: Array<{ objectApiName: string; records: Array<Record<string, unknown>> }> = [];
  const backup: OverwriteBackup = {
    id: BACKUP,
    keep: vi.fn(async (objectApiName: string, records: ReadonlyArray<Record<string, unknown>>) => {
      kept.push({ objectApiName, records: records.map((record) => ({ ...record })) });
    }),
  };
  const lines: string[] = [];
  const recorder = {
    overwriting: vi.fn((object: string, backupId: string, ids: readonly string[]) =>
      lines.push(`overwriting ${object} ${backupId} ${ids.join(',')}`),
    ),
    overwrote: vi.fn((object: string, notWritten: readonly string[]) =>
      lines.push(`overwrote ${object} not written: ${notWritten.join(',')}`),
    ),
    flush: vi.fn(async () => undefined as string | undefined),
  };
  return { kept, backup, lines, recorder };
}

describe('syncOverwriteKeeper', () => {
  it('reads by Id the fields an update writes, keeps them before it goes, and names the records it wrote over', async () => {
    const { statements, query } = target();
    const { kept, backup, lines, recorder } = keeping();
    const keeper = syncOverwriteKeeper({ query, backup, recorder });
    const rows = [
      { Id: A1, Name: 'After 1', Phone: '+44 20 0000 0001' },
      { Id: A2, Name: 'After 2' },
    ];

    expect(await keeper.before('Account', 'update', rows)).toBeUndefined();
    keeper.answered('Account', 'update', [
      { id: A1, success: true, errors: [] },
      { id: A2, success: false, errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: no'] },
    ]);

    expect(statements).toEqual([
      `SELECT Id, Name, Phone FROM Account WHERE Id IN ('${A1}', '${A2}')`,
    ]);
    // Each record with the fields its row writes, as the target held them.
    expect(kept).toEqual([
      {
        objectApiName: 'Account',
        records: [
          { Id: A1, Name: 'Before 1', Phone: '+33 1 00 00 00 01' },
          { Id: A2, Name: 'Before 2' },
        ],
      },
    ]);
    expect(lines).toEqual([
      `overwriting Account ${BACKUP} ${A1},${A2}`,
      `overwrote Account not written: ${A2}`,
    ]);
    // On disk before the call goes.
    expect(recorder.flush).toHaveBeenCalledTimes(1);
  });

  it('keeps, of an upsert, only the records the target holds under its key, whatever its case', async () => {
    const { statements, query } = target();
    const { kept, backup, lines, recorder } = keeping();
    const keeper = syncOverwriteKeeper({ query, backup, recorder });
    const rows = [
      { Ext__c: 'k-1', Name: 'After 1' },
      { Ext__c: 'K-NEW', Name: 'Created' },
    ];

    await keeper.before('Account', 'upsert', rows, 'Ext__c');
    keeper.answered('Account', 'upsert', [
      { id: A1, success: true, errors: [], created: false },
      { id: fakeId('001', 9), success: true, errors: [], created: true },
    ]);

    expect(statements).toEqual([
      "SELECT Id, Ext__c, Name FROM Account WHERE Ext__c IN ('k-1', 'K-NEW')",
    ]);
    expect(kept).toEqual([{ objectApiName: 'Account', records: [{ Id: A1, Name: 'Before 1' }] }]);
    expect(lines).toEqual([
      `overwriting Account ${BACKUP} ${A1}`,
      'overwrote Account not written: ',
    ]);
  });

  it('keeps each field of a record once, as it was before the run first wrote it', async () => {
    const { query } = target();
    const { kept, backup, lines, recorder } = keeping();
    const keeper = syncOverwriteKeeper({ query, backup, recorder });

    await keeper.before('Account', 'update', [{ Id: A1, Name: 'After 1' }]);
    keeper.answered('Account', 'update', [{ id: A1, success: true, errors: [] }]);
    // A second pass sets a lookup, and writes the name again: only the new field is kept.
    await keeper.before('Account', 'update', [{ Id: A1, Name: 'After 1', Fax: '+1' }]);
    keeper.answered('Account', 'update', [{ id: A1, success: true, errors: [] }]);
    // A third call writing only what was kept names nothing.
    await keeper.before('Account', 'update', [{ Id: A1, Name: 'After 1' }]);
    keeper.answered('Account', 'update', [{ id: A1, success: true, errors: [] }]);

    expect(kept.map((entry) => entry.records)).toEqual([
      [{ Id: A1, Name: 'Before 1' }],
      [{ Id: A1, Fax: null }],
    ]);
    expect(lines).toHaveLength(4);
  });

  it('names again a record a refused call did not write, once its rows go again without a field', async () => {
    // The target refused the owner: the rows went again without it, and the
    // call that wrote them is the one that wrote over the record.
    const { query } = target();
    const { kept, backup, lines, recorder } = keeping();
    const keeper = syncOverwriteKeeper({ query, backup, recorder });

    await keeper.before('Account', 'update', [{ Id: A1, Name: 'After 1', Phone: '+1' }]);
    keeper.answered('Account', 'update', [
      { success: false, errors: ['INVALID_CROSS_REFERENCE_KEY: invalid cross reference id'] },
    ]);
    await keeper.before('Account', 'update', [{ Id: A1, Name: 'After 1' }]);
    keeper.answered('Account', 'update', [{ id: A1, success: true, errors: [] }]);

    expect(lines).toEqual([
      `overwriting Account ${BACKUP} ${A1}`,
      `overwrote Account not written: ${A1}`,
      `overwriting Account ${BACKUP} ${A1}`,
      'overwrote Account not written: ',
    ]);
    // The backup holds the name already, as it was: the refused call wrote nothing.
    expect(kept.map((entry) => entry.records)).toEqual([
      [{ Id: A1, Name: 'Before 1', Phone: '+33 1 00 00 00 01' }],
    ]);
  });

  it('keeps nothing of a record the run created itself, which its removal deletes', async () => {
    const { query } = target();
    const { kept, backup, recorder } = keeping();
    const keeper = syncOverwriteKeeper({ query, backup, recorder });

    keeper.answered('Account', 'insert', [{ id: A3, success: true, errors: [] }]);
    await keeper.before('Account', 'update', [{ Id: A3, Name: 'Its lookup set' }]);

    expect(kept).toEqual([]);
    expect(recorder.overwriting).not.toHaveBeenCalled();
  });

  it('answers why a call must not go when what it writes over cannot be read, and names nothing', async () => {
    const { backup, recorder } = keeping();
    const keeper = syncOverwriteKeeper({
      query: async () => {
        throw new Error('REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.');
      },
      backup,
      recorder,
    });

    const refusal = await keeper.before('Account', 'update', [{ Id: A1, Name: 'After 1' }]);

    expect(refusal).toBe(
      'What these 1 Account record(s) would write over in the target could not be read and kept ' +
        'first (REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.), so none of them was ' +
        'written: a run writes over nothing it cannot put back.',
    );
    expect(backup.keep).not.toHaveBeenCalled();
    expect(recorder.overwriting).not.toHaveBeenCalled();
  });

  it('answers why a call must not go when the run’s file could not name what it writes over', async () => {
    const { query } = target();
    const { backup, recorder } = keeping();
    recorder.flush.mockResolvedValue('ENOSPC: no space left on device');
    const keeper = syncOverwriteKeeper({ query, backup, recorder });

    const refusal = await keeper.before('Account', 'update', [{ Id: A1, Name: 'After 1' }]);

    expect(refusal).toContain("the run's file could not be written: ENOSPC");
  });

  it('reads no field holding a file’s content, and asks nothing of an insert or of a row with no key', async () => {
    const { statements, query } = target();
    const { backup, recorder } = keeping();
    const describe = async (): Promise<TargetWriteFields> => ({
      creatable: new Set(['Name', 'Body']),
      references: new Set(),
      fields: [
        { name: 'Name', queryable: true, createable: true, isReference: false, type: 'string' },
        { name: 'Body', queryable: true, createable: true, isReference: false, type: 'base64' },
      ],
    });
    const keeper = syncOverwriteKeeper({ query, backup, recorder, describe });

    await keeper.before('Account', 'insert', [{ Name: 'New' }]);
    await keeper.before('Account', 'upsert', [{ Name: 'No key' }], 'Ext__c');
    await keeper.before('Account', 'update', [{ Id: A1, Name: 'After', Body: 'QUJD' }]);

    expect(statements).toEqual([`SELECT Id, Name FROM Account WHERE Id IN ('${A1}')`]);
  });
});

describe('storeOverwriteBackup', () => {
  it('lists itself as a backup of the target before its first records, and says how many it holds once the run ends', async () => {
    const order: string[] = [];
    const meta = new Map<string, unknown>();
    const files = {
      begin: vi.fn(async (operationId: string, objectApiName: string) => {
        order.push(`begin ${operationId} ${objectApiName}`);
      }),
      append: vi.fn(
        async (_operationId: string, objectApiName: string, records: readonly unknown[]) => {
          order.push(`append ${objectApiName} ${records.length}`);
        },
      ),
    };
    const backup = storeOverwriteBackup({
      runId: 'run:1/x',
      orgId: 'tgt-org',
      organizationId: '00D000000000001AAA',
      files,
      meta: {
        set: (key, value) => {
          order.push(`meta ${key}`);
          meta.set(key, value);
        },
      },
      now: () => new Date('2026-10-22T08:00:00.000Z'),
    });

    await backup.keep('Account', [{ Id: A1, Name: 'Before 1' }]);
    await backup.keep('Account', [{ Id: A2, Name: 'Before 2' }]);
    backup.close();

    expect(backup.id).toBe('sync-before-run-1-x');
    expect(order).toEqual([
      'meta backup:sync-before-run-1-x',
      'begin sync-before-run-1-x Account',
      'append Account 1',
      'append Account 1',
      'meta backup:sync-before-run-1-x',
    ]);
    expect(meta.get('backup:sync-before-run-1-x')).toEqual({
      operationId: 'sync-before-run-1-x',
      orgId: 'tgt-org',
      organizationId: '00D000000000001AAA',
      objects: [{ objectApiName: 'Account', recordCount: 2, truncated: false }],
      partial: false,
      timestamp: '2026-10-22T08:00:00.000Z',
      totalRecords: 2,
      origin: 'sync',
      runId: 'run:1/x',
    });
  });

  it('names a backup the DataOps store can name its files by, whatever the run id', () => {
    expect(overwriteBackupIdOf('sandforge-sync-0b1d__x')).toBe('sync-before-sandforge-sync-0b1d-x');
    expect(overwriteBackupIdOf('a'.repeat(400))).toHaveLength(200);
  });
});
