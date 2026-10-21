import { describe, it, expect, vi } from 'vitest';
import { idsTheTargetLacks } from './TargetHolds.js';

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
