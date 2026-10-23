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
      `SELECT Id, Name, Phone, LastModifiedDate, LastModifiedById FROM Account WHERE Id IN ('${A1}', '${A2}')`,
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
      "SELECT Id, Ext__c, Name, LastModifiedDate, LastModifiedById FROM Account WHERE Ext__c IN ('k-1', 'K-NEW')",
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

    expect(statements).toEqual([
      `SELECT Id, Name, LastModifiedDate, LastModifiedById FROM Account WHERE Id IN ('${A1}')`,
    ]);
  });

  it('keeps no encrypted field the run’s user reads masked, and names it as not kept in the run’s file', async () => {
    const { statements, query } = target();
    const { kept, backup, recorder } = keeping();
    const unkept: Array<{ object: string; fields: string[] }> = [];
    const describe = async (): Promise<TargetWriteFields> => ({
      creatable: new Set(['Name', 'Tax__c']),
      references: new Set(),
      fields: [
        { name: 'Name', queryable: true, createable: true, isReference: false, type: 'string' },
        {
          name: 'Tax__c',
          queryable: true,
          createable: true,
          isReference: false,
          type: 'encryptedstring',
        },
      ],
    });
    const viewsEncrypted = vi.fn(async () => false);
    const keeper = syncOverwriteKeeper({
      query,
      backup,
      recorder: {
        ...recorder,
        unkept: (object, fields) => unkept.push({ object, fields: [...fields] }),
      },
      describe,
      viewsEncrypted,
    });

    await keeper.before('Account', 'update', [{ Id: A1, Name: 'After', Tax__c: '123-45-6789' }]);
    await keeper.before('Account', 'update', [{ Id: A2, Tax__c: '987-65-4321' }]);

    // The mask the target answers is never read as the value from before.
    expect(statements).toEqual([
      `SELECT Id, Name, LastModifiedDate, LastModifiedById FROM Account WHERE Id IN ('${A1}')`,
      `SELECT Id, LastModifiedDate, LastModifiedById FROM Account WHERE Id IN ('${A2}')`,
    ]);
    expect(kept).toEqual([{ objectApiName: 'Account', records: [{ Id: A1, Name: 'Before 1' }] }]);
    expect(unkept).toEqual([{ object: 'Account', fields: ['Tax__c'] }]);
    expect(viewsEncrypted).toHaveBeenCalledTimes(1);
  });

  it('keeps an encrypted field as any other when the run’s user reads it in clear', async () => {
    const { statements, query } = target();
    const { backup, recorder } = keeping();
    const describe = async (): Promise<TargetWriteFields> => ({
      creatable: new Set(['Phone']),
      references: new Set(),
      fields: [
        {
          name: 'Phone',
          queryable: true,
          createable: true,
          isReference: false,
          type: 'encryptedstring',
        },
      ],
    });
    const keeper = syncOverwriteKeeper({
      query,
      backup,
      recorder,
      describe,
      viewsEncrypted: async () => true,
    });

    await keeper.before('Account', 'update', [{ Id: A1, Phone: '+44 20 0000 0001' }]);

    expect(statements).toEqual([
      `SELECT Id, Phone, LastModifiedDate, LastModifiedById FROM Account WHERE Id IN ('${A1}')`,
    ]);
  });

  it('names, with the records it writes over, when each was last modified before the run first wrote it, and by whom', async () => {
    // Only the date was compared: a colleague's edit between two runs read
    // as the later run's own write.
    const COLLEAGUE = fakeId('005', 42);
    const query = vi.fn(async () => [
      {
        Id: A1,
        Name: 'Before 1',
        LastModifiedDate: '2026-10-20T09:00:00.000+0000',
        LastModifiedById: COLLEAGUE,
      },
    ]);
    const { backup, recorder } = keeping();
    const keeper = syncOverwriteKeeper({ query, backup, recorder });

    await keeper.before('Account', 'update', [{ Id: A1, Name: 'After 1' }]);
    keeper.answered('Account', 'update', [{ id: A1, success: true, errors: [] }]);
    // Written again by the run: what it finds then is its own write.
    await keeper.before('Account', 'update', [{ Id: A1, Fax: '+1' }]);

    expect(recorder.overwriting.mock.calls[0]).toEqual([
      'Account',
      BACKUP,
      [A1],
      [{ id: A1, at: '2026-10-20T09:00:00.000+0000', by: COLLEAGUE }],
    ]);
    expect(recorder.overwriting.mock.calls[1]).toEqual(['Account', BACKUP, [A1]]);
    // Nothing of the stamps goes into the backup, which a restore writes back.
    expect(vi.mocked(backup.keep).mock.calls[0][1]).toEqual([{ Id: A1, Name: 'Before 1' }]);
  });

  it('reads an object whose records have no modified stamps without them, as it read it before', async () => {
    const statements: string[] = [];
    const query = vi.fn(async (soql: string) => {
      statements.push(soql);
      if (soql.includes('LastModifiedDate')) {
        throw new Error("INVALID_FIELD: No such column 'LastModifiedDate' on entity 'Account'");
      }
      return [{ Id: A1, Name: 'Before 1' }];
    });
    const { kept, backup, recorder } = keeping();
    const keeper = syncOverwriteKeeper({ query, backup, recorder });

    expect(await keeper.before('Account', 'update', [{ Id: A1, Name: 'After 1' }])).toBeUndefined();
    await keeper.before('Account', 'update', [{ Id: A2, Name: 'After 2' }]);

    expect(statements).toEqual([
      `SELECT Id, Name, LastModifiedDate, LastModifiedById FROM Account WHERE Id IN ('${A1}')`,
      `SELECT Id, Name FROM Account WHERE Id IN ('${A1}')`,
      `SELECT Id, Name FROM Account WHERE Id IN ('${A2}')`,
    ]);
    expect(kept[0].records).toEqual([{ Id: A1, Name: 'Before 1' }]);
    expect(recorder.overwriting.mock.calls[0]).toEqual(['Account', BACKUP, [A1]]);
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
    // Said again as its first records are kept; the second, within the
    // second, waits on the throttle, and the end says them all.
    expect(order).toEqual([
      'meta backup:sync-before-run-1-x',
      'begin sync-before-run-1-x Account',
      'append Account 1',
      'meta backup:sync-before-run-1-x',
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

  it('says, partial, what a run cut short had kept: a closed window left it listed as 0 records', async () => {
    vi.useFakeTimers();
    try {
      const meta = new Map<string, { partial: boolean; totalRecords: number }>();
      const backup = storeOverwriteBackup({
        runId: 'run-cut',
        orgId: 'tgt-org',
        files: { begin: vi.fn(async () => undefined), append: vi.fn(async () => undefined) },
        meta: {
          set: (key, value) => meta.set(key, value as { partial: boolean; totalRecords: number }),
        },
      });
      const listed = () => meta.get('backup:sync-before-run-cut');

      await backup.keep('Account', [{ Id: A1, Name: 'Before 1' }]);
      expect(listed()).toMatchObject({ partial: true, totalRecords: 1 });

      await backup.keep('Account', [{ Id: A2, Name: 'Before 2' }]);
      // Within the second: put off, then said.
      expect(listed()).toMatchObject({ partial: true, totalRecords: 1 });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(listed()).toMatchObject({ partial: true, totalRecords: 2 });
      // The window closed here: no `close`, and the listing says what is kept.
    } finally {
      vi.useRealTimers();
    }
  });

  it('names a backup the DataOps store can name its files by, whatever the run id', () => {
    expect(overwriteBackupIdOf('sandforge-sync-0b1d__x')).toBe('sync-before-sandforge-sync-0b1d-x');
    expect(overwriteBackupIdOf('a'.repeat(400))).toHaveLength(200);
  });
});
