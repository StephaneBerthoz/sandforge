import { describe, expect, it, vi } from 'vitest';
import type { SyncObjectConfig } from '@sandforge/shared';
import { heldBackOf, sourceFieldOf } from './syncHeldBack.js';
import type { WriteLookup } from './syncWriteOrder.js';

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

function objectOf(objectApiName: string, over: Partial<SyncObjectConfig> = {}): SyncObjectConfig {
  return {
    objectApiName,
    operation: 'insert',
    fieldMappings: [],
    transformRules: [],
    excludedFields: [],
    addOnFields: [],
    batchSize: 200,
    insertOrder: 0,
    ...over,
  };
}

/** The source: two accounts, a contact under each and one under an account the run does not read. */
const SOURCE: Record<string, Array<Record<string, unknown>>> = {
  Account: [{ Id: fakeId('001', 1) }, { Id: fakeId('001', 2) }],
  Contact: [
    { Id: fakeId('003', 1), AccountId: fakeId('001', 1) },
    { Id: fakeId('003', 2), AccountId: fakeId('001', 2) },
    { Id: fakeId('003', 3), AccountId: fakeId('001', 9) },
    { Id: fakeId('003', 4), AccountId: null },
  ],
};

const LOOKUPS = new Map<string, WriteLookup[]>([
  ['Contact', [{ field: 'AccountId', referenceTo: ['Account'] }]],
]);

/** A read of the source, as the run reads each object, kept to say what was read. */
function reader(source = SOURCE) {
  return vi.fn(async (objectConfig: SyncObjectConfig) => source[objectConfig.objectApiName] ?? []);
}

describe('sourceFieldOf', () => {
  it('names the field a lookup is sent from: its own, or the one a direct or rename mapping takes there', () => {
    expect(sourceFieldOf(objectOf('Contact'), 'AccountId')).toBe('AccountId');
    expect(
      sourceFieldOf(
        objectOf('Contact', {
          fieldMappings: [
            { sourceField: 'Old_Account__c', targetField: 'AccountId', type: 'rename' },
          ],
        }),
        'accountid',
      ),
    ).toBe('Old_Account__c');
  });

  it('names none for a lookup the configuration sets or a rule changes: no source id goes in it', () => {
    expect(
      sourceFieldOf(
        objectOf('Contact', {
          addOnFields: [
            { fieldApiName: 'AccountId', value: fakeId('001', 5), overwriteExisting: true },
          ],
        }),
        'AccountId',
      ),
    ).toBeUndefined();
    expect(
      sourceFieldOf(
        objectOf('Contact', {
          transformRules: [{ type: 'default_value', field: 'AccountId', config: {} }],
        }),
        'AccountId',
      ),
    ).toBeUndefined();
    expect(
      sourceFieldOf(
        objectOf('Contact', {
          fieldMappings: [{ sourceField: 'AccountId', targetField: 'AccountId', type: 'constant' }],
        }),
        'AccountId',
      ),
    ).toBeUndefined();
  });
});

describe('heldBackOf', () => {
  it('holds back the rows whose lookup names a record of an object left out, and no other', async () => {
    const read = reader();

    const held = await heldBackOf({
      ordered: [objectOf('Account', { operation: 'upsert' }), objectOf('Contact')],
      lookups: LOOKUPS,
      leftOut: new Set(['Account']),
      read,
    });

    expect([...held.values()]).toEqual([
      { objectApiName: 'Contact', rows: 2, parent: 'Account', field: 'AccountId' },
    ]);
  });

  it('lets a row go whose record an earlier run copied: the copy stands in for it, as the run names it', async () => {
    const held = await heldBackOf({
      ordered: [objectOf('Account'), objectOf('Contact')],
      lookups: LOOKUPS,
      leftOut: new Set(['Account']),
      earlier: new Map([[fakeId('001', 1).slice(0, 15), fakeId('001', 501)]]),
      read: reader(),
    });

    expect(held.get('Contact')?.rows).toBe(1);
  });

  it('leaves out of its count the rows an earlier run copied, which the run leaves as they are', async () => {
    const held = await heldBackOf({
      ordered: [objectOf('Account'), objectOf('Contact')],
      lookups: LOOKUPS,
      leftOut: new Set(['Account']),
      copied: new Map([['Contact', new Set([fakeId('003', 2).slice(0, 15)])]]),
      read: reader(),
    });

    expect(held.get('Contact')?.rows).toBe(1);
  });

  it('holds nothing back of an object left out that creates nothing: its rows name records the target holds', async () => {
    const read = reader();

    const held = await heldBackOf({
      ordered: [objectOf('Account', { operation: 'update' }), objectOf('Contact')],
      lookups: LOOKUPS,
      leftOut: new Set(['Account']),
      read,
    });

    expect(held.size).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });

  it('reads nothing of an object whose write carries no lookup at one left out', async () => {
    const read = reader();

    const held = await heldBackOf({
      ordered: [objectOf('Contact'), objectOf('Account')],
      lookups: new Map(),
      leftOut: new Set(['Contact']),
      read,
    });

    expect(held.size).toBe(0);
    expect(read.mock.calls.map(([objectConfig]) => objectConfig.objectApiName)).toEqual([
      'Contact',
    ]);
  });

  it('holds nothing back of an object written before the one left out, as the run sends it', async () => {
    // Written before the accounts, as a cycle of lookups may order them, the
    // contacts name none the run has refused yet.
    const held = await heldBackOf({
      ordered: [objectOf('Contact'), objectOf('Account')],
      lookups: LOOKUPS,
      leftOut: new Set(['Account']),
      read: reader(),
    });

    expect(held.size).toBe(0);
  });
});
