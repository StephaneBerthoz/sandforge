import { describe, it, expect, vi } from 'vitest';
import type { ConflictRecord, SyncObjectConfig } from '@sandforge/shared';
import {
  keyBatches,
  simulateObjectOutcome,
  simulationKey,
  soqlLiteral,
  targetKeyOf,
  targetLookup,
  type ObjectSimulationInput,
} from './SyncSimulation';

function objectConfig(overrides: Partial<SyncObjectConfig> = {}): SyncObjectConfig {
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

function input(overrides: Partial<ObjectSimulationInput> = {}): ObjectSimulationInput {
  return {
    objectConfig: objectConfig(),
    read: 0,
    records: [],
    leftOut: [],
    inTarget: new Map(),
    conflicts: [],
    unsettled: [],
    matchField: 'Ext_Id__c',
    writable: null,
    ...overrides,
  };
}

describe('targetKeyOf', () => {
  it('finds an upsert by its External ID, an update and a delete by Id, an insert by nothing', () => {
    expect(targetKeyOf(objectConfig({ operation: 'upsert' }))).toBe('Ext_Id__c');
    expect(targetKeyOf(objectConfig({ operation: 'update' }))).toBe('Id');
    expect(targetKeyOf(objectConfig({ operation: 'delete' }))).toBe('Id');
    expect(targetKeyOf(objectConfig({ operation: 'insert' }))).toBeNull();
  });
});

describe('simulationKey', () => {
  it('matches a key whatever its case, as the platform matches a text External ID', () => {
    expect(simulationKey('AbC-1')).toBe('abc-1');
    expect(simulationKey(42)).toBe('42');
  });

  it('reads an empty or missing key as none', () => {
    expect(simulationKey('')).toBeNull();
    expect(simulationKey(null)).toBeNull();
    expect(simulationKey(undefined)).toBeNull();
    expect(simulationKey({ nested: true })).toBeNull();
  });
});

describe('soqlLiteral and keyBatches', () => {
  it('quotes and escapes text, and leaves a number bare as its field compares it', () => {
    expect(soqlLiteral("O'Brien")).toBe("'O\\'Brien'");
    expect(soqlLiteral(7)).toBe('7');
    expect(soqlLiteral(true)).toBe('true');
  });

  it('keeps a lookup to two hundred keys and to a length an address carries', () => {
    const ids = Array.from({ length: 450 }, (_, i) => `001${String(i).padStart(15, '0')}`);
    const batches = keyBatches(ids);
    expect(batches.map((b) => b.length)).toEqual([181, 181, 88]);
    expect(batches.flat()).toEqual(ids);
    for (const batch of batches) {
      expect(batch.map(soqlLiteral).join(', ').length).toBeLessThanOrEqual(4_000);
    }

    const short = Array.from({ length: 450 }, (_, i) => i);
    expect(keyBatches(short).map((b) => b.length)).toEqual([200, 200, 50]);
  });
});

describe('targetLookup', () => {
  it('asks the target for the keys a few hundred at a time and answers the ones it holds', async () => {
    const query = vi.fn(async (soql: string) => ({
      done: true,
      records: soql.includes("'A-1'") ? [{ Ext_Id__c: 'a-1' }] : [],
    }));
    const lookup = targetLookup({ query, queryMore: vi.fn() });

    const held = await lookup('tgt', objectConfig(), 'Ext_Id__c', ['A-1', 'A-2']);

    expect(query).toHaveBeenCalledWith(
      "SELECT Ext_Id__c FROM Account WHERE Ext_Id__c IN ('A-1', 'A-2')",
    );
    expect([...held]).toEqual([['a-1', 1]]);
  });

  it('counts the target records each key matches, since an External ID need not be unique', async () => {
    const query = vi.fn(async () => ({
      done: true,
      records: [{ Ext_Id__c: 'A-1' }, { Ext_Id__c: 'a-1' }, { Ext_Id__c: 'A-2' }],
    }));
    const lookup = targetLookup({ query, queryMore: vi.fn() });

    const held = await lookup('tgt', objectConfig(), 'Ext_Id__c', ['A-1', 'A-2']);

    expect(held.get('a-1')).toBe(2);
    expect(held.get('a-2')).toBe(1);
  });

  it('stops between two lookups once the simulation is cancelled', async () => {
    const stop = new AbortController();
    const query = vi.fn(async () => {
      stop.abort();
      return { done: true, records: [] };
    });
    const lookup = targetLookup({ query, queryMore: vi.fn() }, stop.signal);
    const keys = Array.from({ length: 300 }, (_, i) => i);

    await expect(lookup('tgt', objectConfig(), 'Number__c', keys)).rejects.toThrow('cancelled');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('refuses a key field that is not a field name before asking anything', async () => {
    const query = vi.fn();
    const lookup = targetLookup({ query, queryMore: vi.fn() });

    await expect(lookup('tgt', objectConfig(), 'Id) OR (Name', ['x'])).rejects.toThrow(
      'Invalid Salesforce API name',
    );
    expect(query).not.toHaveBeenCalled();
  });
});

describe('simulateObjectOutcome', () => {
  it('counts every record of an insert as one the target would create', () => {
    const outcome = simulateObjectOutcome(
      input({
        objectConfig: objectConfig({ operation: 'insert', externalIdField: undefined }),
        read: 3,
        records: [{ Name: 'A' }, { Name: 'B' }, { Name: 'C' }],
      }),
    );

    expect(outcome).toMatchObject({ read: 3, insert: 3, update: 0, refused: 0, skipped: 0 });
  });

  it('splits an upsert into the records the target holds and the ones it would create', () => {
    const outcome = simulateObjectOutcome(
      input({
        read: 3,
        records: [{ Ext_Id__c: 'A-1' }, { Ext_Id__c: 'a-2' }, { Ext_Id__c: 'A-3' }],
        inTarget: new Map([
          ['a-1', 1],
          ['a-2', 1],
        ]),
      }),
    );

    expect(outcome).toMatchObject({ insert: 1, update: 2, refused: 0 });
  });

  it('counts as refused an upsert whose key matches several target records, and says why', () => {
    // Run against a target earlier copies had filled, seven keyed accounts
    // matched fifty-six: each upsert would have been refused, not updated.
    const sent = [
      { Ext_Id__c: 'A-1', Name: 'Acme' },
      { Ext_Id__c: 'A-2', Name: 'Globex' },
    ];
    const outcome = simulateObjectOutcome(
      input({
        read: 2,
        records: sent,
        unsettled: sent,
        inTarget: new Map([
          ['a-1', 3],
          ['a-2', 1],
        ]),
        conflicts: [
          {
            objectApiName: '',
            recordId: 'A-1',
            sourceValues: {},
            targetValues: {},
            conflictFields: ['Name'],
          },
        ],
      }),
    );

    expect(outcome).toMatchObject({ insert: 0, update: 1, refused: 1 });
    // Refused, it writes nothing, so its differences settle nothing.
    expect(outcome.conflicts).toBe(0);
    expect(outcome.notes).toEqual([
      '1 record(s) match more than one record of the target on Ext_Id__c: an upsert finds no single record to update, and the target refuses it.',
    ]);
  });

  it('counts an upsert record without its key as refused, and says why', () => {
    const outcome = simulateObjectOutcome(
      input({ read: 2, records: [{ Ext_Id__c: '' }, { Ext_Id__c: 'A-1' }] }),
    );

    expect(outcome).toMatchObject({ insert: 1, refused: 1 });
    expect(outcome.notes).toEqual([
      '1 record(s) carry no value in Ext_Id__c: an upsert matches on it, and the target refuses a record without one.',
    ]);
  });

  it('counts an update or a delete by an Id the target does not hold as refused', () => {
    const update = simulateObjectOutcome(
      input({
        objectConfig: objectConfig({ operation: 'update' }),
        records: [{ Id: '001A' }, { Id: '001B' }],
        inTarget: new Map([['001a', 1]]),
      }),
    );
    const del = simulateObjectOutcome(
      input({
        objectConfig: objectConfig({ operation: 'delete' }),
        records: [{ Id: '001A' }, { Id: '001B' }, {}],
        inTarget: new Map([['001b', 1]]),
      }),
    );

    expect(update).toMatchObject({ update: 1, refused: 1, delete: 0 });
    expect(update.notes[0]).toContain('an update finds no record there');
    expect(del).toMatchObject({ delete: 1, refused: 1, skipped: 1, update: 0 });
    expect(del.notes).toEqual([
      expect.stringContaining('a delete finds no record there'),
      '1 record(s) carry no Id: a delete sends ids alone, so the run leaves them out.',
    ]);
  });

  it('counts the rows left to the platform as skipped, each kind said as a run says it', () => {
    const outcome = simulateObjectOutcome(
      input({
        objectConfig: objectConfig({ objectApiName: 'FeedItem', operation: 'insert' }),
        read: 3,
        records: [{ Body: 'hello' }],
        leftOut: [
          {
            objectApiName: 'FeedItem',
            why: { rows: { field: 'Type', value: 'TrackedChange', noun: 'tracked change' } },
            count: 2,
          },
        ],
      }),
    );

    expect(outcome).toMatchObject({ read: 3, insert: 1, skipped: 2 });
    expect(outcome.notes).toEqual(['2 tracked changes left out: the platform writes them itself']);
  });

  it('counts a conflict only on a field the run writes, and names those fields', () => {
    const conflicts: ConflictRecord[] = [
      {
        objectApiName: '',
        recordId: 'A-1',
        sourceValues: {},
        targetValues: {},
        // The audit fields and the target's own id differ on every record.
        conflictFields: ['Id', 'attributes', 'LastModifiedDate', 'Phone', 'Name'],
      },
      {
        objectApiName: '',
        recordId: 'A-2',
        sourceValues: {},
        targetValues: {},
        conflictFields: ['SystemModstamp', 'Id'],
      },
      {
        objectApiName: '',
        recordId: 'A-3',
        sourceValues: {},
        targetValues: {},
        // Only the target carries it: the run does not write it.
        conflictFields: ['Description', 'Phone'],
      },
    ];
    const sent = [
      { Id: '001S1', Ext_Id__c: 'A-1', Name: 'Acme', Phone: '1', LastModifiedDate: 'x' },
      { Id: '001S2', Ext_Id__c: 'A-2', Name: 'Globex', SystemModstamp: 'y' },
      { Id: '001S3', Ext_Id__c: 'A-3', Phone: '3' },
    ];

    const outcome = simulateObjectOutcome(
      input({
        records: sent,
        unsettled: sent,
        inTarget: new Map([
          ['a-1', 1],
          ['a-2', 1],
          ['a-3', 1],
        ]),
        conflicts,
        writable: new Set(['Name', 'Phone', 'Description', 'Ext_Id__c']),
      }),
    );

    expect(outcome.conflicts).toBe(2);
    expect(outcome.conflictFields).toEqual(['Phone', 'Name']);
  });

  it('takes every field the records carry as written when the target could not say', () => {
    const sent = [{ Ext_Id__c: 'A-1', Custom__c: 'x' }];
    const outcome = simulateObjectOutcome(
      input({
        records: sent,
        unsettled: sent,
        conflicts: [
          {
            objectApiName: '',
            recordId: 'A-1',
            sourceValues: {},
            targetValues: {},
            conflictFields: ['Custom__c'],
          },
        ],
      }),
    );

    expect(outcome.conflicts).toBe(1);
    expect(outcome.conflictFields).toEqual(['Custom__c']);
  });
});
