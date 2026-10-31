import { describe, it, expect, vi } from 'vitest';
import { KNOWN_IDS_BOUND, idsTheTargetLacks } from './TargetHolds.js';

const SOURCE_USER = '005000000000001AAA';
const TARGET_USER = '005000000000002AAA';
const QUEUE = '00G000000000001AAA';

/** A target that holds the ids given, and answers each statement from them. */
function targetHolding(...held: string[]) {
  return vi.fn(async (soql: string) =>
    held.filter((id) => soql.includes(`'${id}'`)).map((Id) => ({ Id })),
  );
}

describe('idsTheTargetLacks', () => {
  it('finds the owner a row names that the target holds no user of, and the one it holds', async () => {
    const query = targetHolding(TARGET_USER);
    const known = new Map<string, boolean>();

    const lacking = await idsTheTargetLacks({
      lookups: [{ name: 'OwnerId', referenceTo: ['User'] }],
      rows: [{ OwnerId: SOURCE_USER }, { OwnerId: TARGET_USER }],
      known,
      query,
    });

    expect([...lacking]).toEqual([SOURCE_USER]);
    expect(known.get(TARGET_USER)).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toMatch(/^SELECT Id FROM User WHERE Id IN \(/);
  });

  it('asks each id once a run, of every object its lookup can name', async () => {
    const query = targetHolding(QUEUE);
    const known = new Map<string, boolean>();
    const question = {
      lookups: [{ name: 'OwnerId', referenceTo: ['Group', 'User'] }],
      rows: [{ OwnerId: QUEUE }, { OwnerId: SOURCE_USER }],
      known,
      query,
    };

    await idsTheTargetLacks(question);
    const again = await idsTheTargetLacks(question);

    expect([...again]).toEqual([SOURCE_USER]);
    expect(query.mock.calls.map(([soql]) => soql.split(' WHERE')[0])).toEqual([
      'SELECT Id FROM Group',
      'SELECT Id FROM User',
    ]);
  });

  it('never asks about a lookup at an object a clone creates, the record type, or an owner mapped to a target user', async () => {
    const query = targetHolding();

    const lacking = await idsTheTargetLacks({
      lookups: [
        { name: 'AccountId', referenceTo: ['Account'] },
        { name: 'RecordTypeId', referenceTo: ['RecordType'] },
        { name: 'OwnerId', referenceTo: ['User'] },
      ],
      rows: [
        {
          AccountId: '001000000000001AAA',
          RecordTypeId: '012000000000001AAA',
          OwnerId: SOURCE_USER,
        },
      ],
      ownerMappings: { [SOURCE_USER]: TARGET_USER },
      known: new Map(),
      query,
    });

    expect(lacking.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('carries an id the target could not be asked about, as before', async () => {
    const lacking = await idsTheTargetLacks({
      lookups: [{ name: 'OwnerId', referenceTo: ['User'] }],
      rows: [{ OwnerId: SOURCE_USER }],
      known: new Map(),
      query: vi.fn(async () => {
        throw new Error('INVALID_TYPE');
      }),
    });

    expect(lacking.size).toBe(0);
  });

  describe('a lookup at an object outside the run', () => {
    const HELD = '001000000000001AAA';
    const GONE = '001000000000002AAA';
    const WRITTEN = '001000000000003AAA';
    /** The run writes contacts and cases; accounts are outside it. */
    const outsideTheRun = (object: string): boolean => object !== 'Contact' && object !== 'Case';

    it('asks the target about the one object it names, and finds the id it lacks', async () => {
      const query = targetHolding(HELD);

      const lacking = await idsTheTargetLacks({
        lookups: [
          { name: 'AccountId', referenceTo: ['Account'] },
          { name: 'ReportsToId', referenceTo: ['Contact'] },
        ],
        rows: [
          { AccountId: HELD, ReportsToId: '003000000000001AAA' },
          { AccountId: GONE, ReportsToId: null },
        ],
        outsideTheRun,
        known: new Map(),
        query,
      });

      expect([...lacking]).toEqual([GONE]);
      expect(query.mock.calls.map(([soql]) => soql)).toEqual([
        `SELECT Id FROM Account WHERE Id IN ('${HELD}', '${GONE}')`,
      ]);
    });

    it('never asks about a lookup that can name several objects, nor an id the run has a counterpart for', async () => {
      const query = targetHolding();

      const lacking = await idsTheTargetLacks({
        lookups: [
          { name: 'WhatId', referenceTo: ['Account', 'Opportunity'] },
          { name: 'AccountId', referenceTo: ['Account'] },
        ],
        rows: [{ WhatId: GONE, AccountId: WRITTEN }],
        outsideTheRun,
        mapped: (id) => id === WRITTEN,
        known: new Map(),
        query,
      });

      expect(lacking.size).toBe(0);
      expect(query).not.toHaveBeenCalled();
    });

    it('asks the ids two hundred a read', async () => {
      const ids = Array.from({ length: 201 }, (_, n) => `001${String(n).padStart(12, '0')}AAA`);
      const query = targetHolding();

      const lacking = await idsTheTargetLacks({
        lookups: [{ name: 'AccountId', referenceTo: ['Account'] }],
        rows: ids.map((AccountId) => ({ AccountId })),
        outsideTheRun,
        known: new Map(),
        query,
      });

      expect(lacking.size).toBe(201);
      expect(query.mock.calls.map(([soql]) => soql.split("', '").length)).toEqual([200, 1]);
    });

    it('keeps no more answers than its bound, and still says which ids of the rows the target lacks', async () => {
      const known = new Map<string, boolean>(
        Array.from({ length: KNOWN_IDS_BOUND }, (_, n) => [
          `a0K${String(n).padStart(15, '0')}`,
          true,
        ]),
      );

      const lacking = await idsTheTargetLacks({
        lookups: [{ name: 'AccountId', referenceTo: ['Account'] }],
        rows: [{ AccountId: HELD }, { AccountId: GONE }],
        outsideTheRun,
        known,
        query: targetHolding(HELD),
      });

      expect([...lacking]).toEqual([GONE]);
      expect(known.size).toBe(KNOWN_IDS_BOUND);
      expect(known.has(GONE)).toBe(false);
    });

    it('asks an object the target refused a read of no more in the run, and carries its ids', async () => {
      const refused = new Set<string>();
      const query = vi.fn(async (): Promise<Array<Record<string, unknown>>> => {
        throw new Error("INVALID_TYPE: sObject type 'Account' is not supported.");
      });
      const question = {
        lookups: [{ name: 'AccountId', referenceTo: ['Account'] }],
        outsideTheRun,
        known: new Map<string, boolean>(),
        refused,
        query,
      };

      const first = await idsTheTargetLacks({ ...question, rows: [{ AccountId: HELD }] });
      const second = await idsTheTargetLacks({ ...question, rows: [{ AccountId: GONE }] });

      expect([...first, ...second]).toEqual([]);
      expect([...refused]).toEqual(['Account']);
      expect(query).toHaveBeenCalledTimes(1);
    });
  });

  it('matches an 18-character id the row holds to the 15 the target answers with', async () => {
    const lacking = await idsTheTargetLacks({
      lookups: [{ name: 'OwnerId', referenceTo: ['User'] }],
      rows: [{ OwnerId: TARGET_USER }],
      known: new Map(),
      query: vi.fn(async () => [{ Id: TARGET_USER.slice(0, 15) }]),
    });

    expect(lacking.size).toBe(0);
  });
});
