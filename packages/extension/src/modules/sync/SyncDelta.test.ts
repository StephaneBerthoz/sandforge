import { describe, it, expect, vi } from 'vitest';
import type { SyncConfig, SyncObjectConfig } from '@sandforge/shared';
import {
  DELTA_OVERLAP_MS,
  changedSinceLiteral,
  deletionKeyOf,
  deletionNotes,
  deltaOutcomeOf,
  orgDateTime,
  orgDeltaReads,
  planObjectRead,
  readDeltaState,
  scopeFingerprint,
  soqlDateTimeOf,
  sourceReadWhere,
  tallyDeletions,
  type SyncDeltaReads,
  type SyncWatermark,
} from './SyncDelta.js';

const FP_PATTERN = /^[0-9a-f]{64}$/;

function account(overrides: Partial<SyncObjectConfig> = {}): SyncObjectConfig {
  return {
    objectApiName: 'Account',
    operation: 'upsert',
    externalIdField: 'Ext_Id__c',
    fieldMappings: [],
    transformRules: [],
    excludedFields: [],
    addOnFields: [],
    batchSize: 200,
    insertOrder: 0,
    ...overrides,
  };
}

const CONFIG: Pick<SyncConfig, 'sourceOrgId' | 'targetOrgId' | 'direction' | 'conflictStrategy'> = {
  sourceOrgId: 'src-org',
  targetOrgId: 'tgt-org',
  direction: 'source_to_target',
  conflictStrategy: 'source_wins',
};

function watermark(overrides: Partial<SyncWatermark> = {}): SyncWatermark {
  return {
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    objectApiName: 'Account',
    watermark: '2026-10-13T09:00:00.000Z',
    fingerprint: scopeFingerprint(CONFIG, account()),
    recordedAt: '2026-10-13T09:01:00.000Z',
    ...overrides,
  };
}

describe('readDeltaState', () => {
  it('reads nothing stored as no watermark', () => {
    expect(readDeltaState(undefined)).toEqual({ kind: 'none' });
  });

  it('reads stored watermarks that match the schema', () => {
    const state = { version: 1, entries: [watermark()] };
    expect(readDeltaState(state)).toEqual({ kind: 'stored', state });
  });

  it.each([
    ['a watermark that is not a date', { version: 1, entries: [watermark({ watermark: 'soon' })] }],
    [
      'a fingerprint that is not a hash',
      { version: 1, entries: [watermark({ fingerprint: 'x' })] },
    ],
    ['an unknown version', { version: 2, entries: [] }],
    ['a list where an object was expected', [watermark()]],
  ])('reads %s as unreadable, never half used', (_, raw) => {
    expect(readDeltaState(raw)).toMatchObject({ kind: 'unreadable' });
  });
});

describe('scopeFingerprint', () => {
  it('is a hash that does not depend on the order keys were written in', () => {
    const a = scopeFingerprint(CONFIG, account({ where: "Type = 'A'" }));
    const reordered = Object.fromEntries(
      Object.entries(account({ where: "Type = 'A'" })).reverse(),
    ) as unknown as SyncObjectConfig;
    expect(a).toMatch(FP_PATTERN);
    expect(scopeFingerprint(CONFIG, reordered)).toBe(a);
  });

  it.each<[string, Partial<SyncObjectConfig>]>([
    ['the filter', { where: "Type = 'B'" }],
    ['the operation', { operation: 'update' }],
    ['the key', { externalIdField: 'Other_Key__c' }],
    [
      'a mapping',
      { fieldMappings: [{ sourceField: 'Name', targetField: 'Name', type: 'direct' }] },
    ],
    ['a transform', { transformRules: [{ type: 'trim', config: {} }] }],
    [
      'an add-on',
      { addOnFields: [{ fieldApiName: 'Origin__c', value: 'x', overwriteExisting: true }] },
    ],
  ])('changes with %s', (_, change) => {
    expect(scopeFingerprint(CONFIG, account(change))).not.toBe(scopeFingerprint(CONFIG, account()));
  });

  it('changes with the conflict strategy of the run', () => {
    expect(scopeFingerprint({ ...CONFIG, conflictStrategy: 'target_wins' }, account())).not.toBe(
      scopeFingerprint(CONFIG, account()),
    );
  });

  it('changes when the files are turned on, so the records a delta read would pass over have theirs copied', () => {
    const files = { maxFileSizeMB: 10, maxRunMB: 100 };
    expect(scopeFingerprint({ ...CONFIG, files }, account())).not.toBe(
      scopeFingerprint(CONFIG, account()),
    );
    // A cap is no change of scope: a file past it is read again by a later run.
    expect(scopeFingerprint({ ...CONFIG, files: { ...files, maxRunMB: 5 } }, account())).toBe(
      scopeFingerprint({ ...CONFIG, files }, account()),
    );
  });

  it('reads an empty filter or key box as none, and ignores the read order', () => {
    const base = scopeFingerprint(CONFIG, account({ externalIdField: 'Ext_Id__c' }));
    expect(scopeFingerprint(CONFIG, account({ where: '  ' }))).toBe(base);
    expect(scopeFingerprint(CONFIG, account({ orderBy: 'Name ASC' }))).toBe(base);
  });
});

describe('planObjectRead', () => {
  it('reads from the watermark recorded under the same scope for the same pair of orgs', () => {
    const plan = planObjectRead(CONFIG, account(), {
      kind: 'stored',
      state: { version: 1, entries: [watermark()] },
    });
    expect(plan).toEqual({
      read: 'delta',
      since: '2026-10-13T09:00:00.000Z',
      fingerprint: scopeFingerprint(CONFIG, account()),
    });
  });

  it('reads whole, saying why, in every other case', () => {
    const stored = (entries: SyncWatermark[], resetAt?: string) => ({
      kind: 'stored' as const,
      state: { version: 1 as const, entries, ...(resetAt ? { resetAt } : {}) },
    });
    expect(planObjectRead(CONFIG, account(), null)).toMatchObject({ reason: 'not_saved' });
    expect(planObjectRead(CONFIG, account(), { kind: 'none' })).toMatchObject({
      reason: 'first_run',
    });
    expect(planObjectRead(CONFIG, account(), { kind: 'unreadable', issue: 'x' })).toMatchObject({
      reason: 'unreadable',
    });
    expect(planObjectRead(CONFIG, account(), stored([]))).toMatchObject({ reason: 'first_run' });
    expect(planObjectRead(CONFIG, account(), stored([], '2026-10-13T10:00:00.000Z'))).toMatchObject(
      { reason: 'reset' },
    );
    expect(
      planObjectRead(CONFIG, account({ where: "Type = 'B'" }), stored([watermark()])),
    ).toMatchObject({ read: 'full', reason: 'scope_changed' });
    // Another target: the watermark belongs to the pair it was recorded for.
    expect(
      planObjectRead({ ...CONFIG, targetOrgId: 'other-org' }, account(), stored([watermark()])),
    ).toMatchObject({ read: 'full', reason: 'first_run' });
  });

  it('reads whole an object a removal took copies of, since its watermark counted on them', () => {
    const plan = planObjectRead(CONFIG, account(), {
      kind: 'stored',
      state: {
        version: 1,
        entries: [{ ...watermark(), removedAt: '2026-10-14T08:00:00.000Z' }],
      },
    });

    expect(plan).toMatchObject({ read: 'full', reason: 'removed' });
  });

  it('carries the newest file stamp the last run looked at, for the lookups to look past', () => {
    const plan = planObjectRead(CONFIG, account(), {
      kind: 'stored',
      state: {
        version: 1,
        entries: [{ ...watermark(), filesSeen: '2026-10-13T09:20:00.000Z' }],
      },
    });

    expect(plan).toMatchObject({ read: 'delta', filesSeen: '2026-10-13T09:20:00.000Z' });
  });
});

describe('soqlDateTimeOf', () => {
  it('writes a date the org gave as a SOQL literal of the same second', () => {
    expect(soqlDateTimeOf('2026-10-13T09:20:00.000Z')).toBe('2026-10-13T09:20:00Z');
    expect(soqlDateTimeOf('2026-10-13T09:20:00.900Z')).toBe('2026-10-13T09:20:00Z');
  });

  it('refuses what is not a date', () => {
    expect(() => soqlDateTimeOf('soon')).toThrow(/Not a date/);
  });
});

describe('changedSinceLiteral and sourceReadWhere', () => {
  it('starts five minutes before the watermark, rounded down to the second, as SOQL writes it', () => {
    expect(DELTA_OVERLAP_MS).toBe(300_000);
    expect(changedSinceLiteral('2026-10-13T09:00:00.750Z')).toBe('2026-10-13T08:55:00Z');
  });

  it('refuses a watermark that is not a date', () => {
    expect(() => changedSinceLiteral('yesterday')).toThrow(/Not a watermark/);
  });

  it('adds the bound before the filter and keeps the filter whole in parentheses', () => {
    expect(sourceReadWhere("Type = 'A' OR Type = 'B'", '2026-10-13T08:55:00Z')).toBe(
      "SystemModstamp > 2026-10-13T08:55:00Z AND (Type = 'A' OR Type = 'B')",
    );
    expect(sourceReadWhere(undefined, '2026-10-13T08:55:00Z')).toBe(
      'SystemModstamp > 2026-10-13T08:55:00Z',
    );
  });

  it('leaves a full read to its own filter', () => {
    expect(sourceReadWhere("Type = 'A'", undefined)).toBe("Type = 'A'");
    expect(sourceReadWhere('', undefined)).toBeUndefined();
  });

  it('refuses a filter that does more than filter, and a bound that is not a datetime', () => {
    expect(() => sourceReadWhere('Id != null LIMIT 1', '2026-10-13T08:55:00Z')).toThrow(
      /Invalid SOQL WHERE/,
    );
    expect(() => sourceReadWhere(undefined, '2026-10-13 08:55')).toThrow(/Not a SOQL datetime/);
    expect(() => sourceReadWhere(undefined, '2026-10-13T08:55:00Z OR Id != null')).toThrow(
      /Not a SOQL datetime/,
    );
  });
});

describe('orgDateTime', () => {
  it('reads the datetime the org writes as an ISO string', () => {
    expect(orgDateTime('2026-10-13T09:41:07.000+0000')).toBe('2026-10-13T09:41:07.000Z');
    expect(orgDateTime('2026-10-13T11:41:07.000+0200')).toBe('2026-10-13T09:41:07.000Z');
  });

  it('answers null for anything that is not one', () => {
    expect(orgDateTime(null)).toBeNull();
    expect(orgDateTime('')).toBeNull();
    expect(orgDateTime('later')).toBeNull();
  });
});

describe('orgDeltaReads', () => {
  /** A connection double recording each query with whether it read the recycle bin. */
  function connection(answer: (soql: string, scanAll: boolean) => Record<string, unknown>[]) {
    const asked: Array<{ soql: string; scanAll: boolean }> = [];
    return {
      asked,
      conn: {
        query: vi.fn(async (soql: string, options?: { scanAll?: boolean }) => {
          const scanAll = options?.scanAll === true;
          asked.push({ soql, scanAll });
          return { done: true, records: answer(soql, scanAll) };
        }),
        queryMore: vi.fn(),
      },
    };
  }

  it("takes the watermark from the org's latest SystemModstamp of the object", async () => {
    const source = connection(() => [{ SystemModstamp: '2026-10-13T09:41:07.000+0000' }]);
    const reads = orgDeltaReads(source.conn, connection(() => []).conn);

    await expect(reads.latestModstamp('Account')).resolves.toBe('2026-10-13T09:41:07.000Z');
    expect(source.asked).toEqual([
      {
        soql: 'SELECT SystemModstamp FROM Account ORDER BY SystemModstamp DESC LIMIT 1',
        scanAll: false,
      },
    ]);
  });

  it('answers no watermark for an object without records, and refuses a stamp that is no date', async () => {
    const empty = orgDeltaReads(connection(() => []).conn, connection(() => []).conn);
    await expect(empty.latestModstamp('Account')).resolves.toBeNull();
    const odd = orgDeltaReads(
      connection(() => [{ SystemModstamp: 'never' }]).conn,
      connection(() => []).conn,
    );
    await expect(odd.latestModstamp('Account')).rejects.toThrow(/not a date/);
  });

  it("reads the deleted rows from the source's recycle bin, within the bound and the filter", async () => {
    const source = connection(() => [{ Id: '001D', Ext_Id__c: 'K-1' }]);
    const reads = orgDeltaReads(source.conn, connection(() => []).conn);

    const answer = await reads.deletedRows(
      'Account',
      ['Ext_Id__c'],
      "SystemModstamp > 2026-10-13T08:55:00Z AND (Type = 'A')",
    );
    expect(answer).toEqual({ records: [{ Id: '001D', Ext_Id__c: 'K-1' }], truncated: false });
    expect(source.asked).toEqual([
      {
        soql:
          'SELECT Id, SystemModstamp, Ext_Id__c FROM Account WHERE IsDeleted = true AND ' +
          "(SystemModstamp > 2026-10-13T08:55:00Z AND (Type = 'A'))",
        scanAll: true,
      },
    ]);
  });

  it('asks the source which keys a live record still holds, and the target which ids hold each key', async () => {
    const source = connection(() => [{ Ext_Id__c: 'K-2' }]);
    const target = connection(() => [
      { Id: '001T1', Ext_Id__c: 'K-1' },
      { Id: '001T2', Ext_Id__c: 'k-3' },
      { Id: '001T3', Ext_Id__c: 'K-3' },
    ]);
    const reads = orgDeltaReads(source.conn, target.conn);

    expect([...(await reads.heldInSource('Account', 'Ext_Id__c', ['K-1', 'K-2']))]).toEqual([
      'k-2',
    ]);
    expect(source.asked[0]).toEqual({
      soql: "SELECT Ext_Id__c FROM Account WHERE Ext_Id__c IN ('K-1', 'K-2')",
      scanAll: false,
    });
    const ids = await reads.targetIdsByKey('Account', 'Ext_Id__c', ['K-1', 'K-3']);
    expect(Object.fromEntries(ids)).toEqual({ 'k-1': ['001T1'], 'k-3': ['001T2', '001T3'] });
    expect(target.asked[0].soql).toBe(
      "SELECT Id, Ext_Id__c FROM Account WHERE Ext_Id__c IN ('K-1', 'K-3')",
    );
  });

  it('stops between two lookups once the run is cancelled', async () => {
    const stop = new AbortController();
    stop.abort();
    const reads = orgDeltaReads(connection(() => []).conn, connection(() => []).conn, stop.signal);
    await expect(reads.targetIdsByKey('Account', 'Id', ['001A'])).rejects.toThrow(/cancelled/);
  });
});

describe('deletionKeyOf', () => {
  it('ties an update by Id, and an upsert by its External ID read from the same-named field', () => {
    expect(deletionKeyOf(account({ operation: 'update', externalIdField: undefined }))).toEqual({
      sourceField: 'Id',
      keyField: 'Id',
    });
    expect(deletionKeyOf(account())).toEqual({ sourceField: 'Ext_Id__c', keyField: 'Ext_Id__c' });
  });

  it('ties an upsert through the mapping that carries a source field onto the key', () => {
    expect(
      deletionKeyOf(
        account({
          fieldMappings: [
            { sourceField: 'Name', targetField: 'Name', type: 'direct' },
            { sourceField: 'Legacy_Key__c', targetField: 'Ext_Id__c', type: 'rename' },
          ],
        }),
      ),
    ).toEqual({ sourceField: 'Legacy_Key__c', keyField: 'Ext_Id__c' });
  });

  it('ties nothing when the key is written by a constant, an add-on, or nothing at all', () => {
    expect(
      deletionKeyOf(
        account({
          fieldMappings: [{ sourceField: 'x', targetField: 'Ext_Id__c', type: 'constant' }],
        }),
      ),
    ).toMatchObject({ refused: expect.stringContaining('no source field is carried') });
    expect(
      deletionKeyOf(
        account({
          addOnFields: [{ fieldApiName: 'Ext_Id__c', value: 'A', overwriteExisting: true }],
        }),
      ),
    ).toMatchObject({ refused: expect.stringContaining('an add-on writes Ext_Id__c') });
    expect(
      deletionKeyOf(
        account({ fieldMappings: [{ sourceField: 'Name', targetField: 'Name', type: 'direct' }] }),
      ),
    ).toMatchObject({ refused: expect.stringContaining('no source field') });
    expect(deletionKeyOf(account({ operation: 'insert' }))).toMatchObject({
      refused: expect.stringContaining('finds no record by a key'),
    });
  });
});

describe('tallyDeletions', () => {
  /** Reads answering from fixed rows: deleted in the source, live in the source, held by the target. */
  function reads(
    deleted: Record<string, unknown>[],
    live: string[],
    target: Record<string, string[]>,
  ): SyncDeltaReads & { asked: string[] } {
    const asked: string[] = [];
    return {
      asked,
      latestModstamp: vi.fn(),
      deletedRows: vi.fn(async () => ({ records: deleted, truncated: false })),
      heldInSource: vi.fn(
        async (_o: string, _f: string, values: readonly (string | number | boolean)[]) => {
          asked.push(`live ${values.join(',')}`);
          return new Set(live.filter((v) => values.includes(v)).map((v) => v.toLowerCase()));
        },
      ),
      targetIdsByKey: vi.fn(
        async (_o: string, _f: string, keys: readonly (string | number | boolean)[]) => {
          asked.push(`target ${keys.join(',')}`);
          return new Map(
            Object.entries(target).filter(([k]) =>
              keys.map((x) => String(x).toLowerCase()).includes(k),
            ),
          );
        },
      ),
    };
  }
  const key = { sourceField: 'Ext_Id__c', keyField: 'Ext_Id__c' };
  const asWritten = (row: Record<string, unknown>) => row.Ext_Id__c;

  it('deletes only a target record that alone holds the key of a record the source no longer has', async () => {
    const r = reads(
      [
        { Id: '001A', Ext_Id__c: 'K-1' },
        { Id: '001B', Ext_Id__c: 'K-2' },
        { Id: '001C', Ext_Id__c: 'K-3' },
        { Id: '001D', Ext_Id__c: null },
        { Id: '001E', Ext_Id__c: 'K-5' },
      ],
      // Deleted and created again under the same key.
      ['K-2'],
      { 'k-1': ['001T1'], 'k-3': ['001T3', '001T4'] },
    );

    const tally = await tallyDeletions(r, account(), key, 'SystemModstamp > x', asWritten);

    expect(tally).toEqual({
      ids: ['001T1'],
      read: 5,
      stillInSource: 1,
      ambiguous: 1,
      noKey: 1,
      truncated: false,
    });
    // The target is asked only for the keys no live source record holds.
    expect(r.asked).toEqual(['live K-1,K-2,K-3,K-5', 'target K-1,K-3,K-5']);
  });

  it('ties by the key as the write computes it, and asks the source by the value it holds', async () => {
    const r = reads([{ Id: '001A', Ext_Id__c: 'k-1' }], [], { 'pre-k-1': ['001T1'] });

    const tally = await tallyDeletions(
      r,
      account(),
      key,
      'SystemModstamp > x',
      (row) => `PRE-${String(row.Ext_Id__c)}`,
    );

    expect(tally.ids).toEqual(['001T1']);
    expect(r.asked).toEqual(['live k-1', 'target PRE-k-1']);
  });

  it('never asks whether an Id is live: a deleted Id cannot be', async () => {
    const r = reads([{ Id: '001A' }], [], { '001a': ['001A'] });

    const tally = await tallyDeletions(
      r,
      account({ operation: 'update' }),
      { sourceField: 'Id', keyField: 'Id' },
      'SystemModstamp > x',
      (row) => row.Id,
    );

    expect(tally.ids).toEqual(['001A']);
    expect(r.heldInSource).not.toHaveBeenCalled();
  });

  it('says what it left alone, and that a read cut short is finished by the next run', () => {
    expect(
      deletionNotes(
        { ids: [], read: 4, stillInSource: 1, ambiguous: 1, noKey: 1, truncated: true },
        'Ext_Id__c',
      ),
    ).toEqual([
      expect.stringContaining('share their Ext_Id__c with a record the source still holds'),
      expect.stringContaining('match more than one target record on Ext_Id__c'),
      expect.stringContaining('carry no Ext_Id__c'),
      expect.stringContaining('read by the next run'),
    ]);
  });
});

describe('deltaOutcomeOf', () => {
  it('says a delta read since its watermark, and a full read with its reason', () => {
    const fingerprint = 'f'.repeat(64);
    expect(
      deltaOutcomeOf(
        { read: 'delta', since: '2026-10-13T09:00:00.000Z', fingerprint },
        3,
        { deleted: 1, deleteFailed: 0 },
        '2026-10-13T10:00:00.000Z',
      ),
    ).toEqual({
      read: 'delta',
      since: '2026-10-13T09:00:00.000Z',
      changed: 3,
      deletionsChecked: true,
      deleted: 1,
      deleteFailed: 0,
      recorded: '2026-10-13T10:00:00.000Z',
    });
    expect(deltaOutcomeOf({ read: 'full', reason: 'scope_changed', fingerprint }, 12)).toEqual({
      read: 'full',
      reason: 'scope_changed',
      changed: 12,
      deletionsChecked: false,
      deleted: 0,
      deleteFailed: 0,
    });
  });
});
