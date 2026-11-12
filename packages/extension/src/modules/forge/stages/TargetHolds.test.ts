import { describe, it, expect, vi } from 'vitest';
import {
  INACTIVE_OWNER_PERMISSION_SOQL,
  KNOWN_IDS_BOUND,
  idsTheTargetLacks,
  inactiveMappedOwners,
  inactiveOwnersOf,
  writesInactiveOwners,
  writesInactiveOwnersOnce,
} from './TargetHolds.js';

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

describe('the users the target holds inactive', () => {
  /*
   * A sandbox made from a production holds the production's users, its
   * inactive ones inactive: it refuses a record such a user owns, and every
   * record under it then fails for want of its parent.
   */
  const INACTIVE = '005000000000003AAA';

  /** A target that holds the users given, `active` saying of each whether it is. */
  function targetWithUsers(users: Record<string, boolean | undefined>, queues: string[] = []) {
    return vi.fn(async (soql: string): Promise<Array<Record<string, unknown>>> => {
      const ids = soql.includes(' FROM Group ') ? queues : Object.keys(users);
      return ids
        .filter((id) => soql.includes(`'${id}'`) || soql.includes(`'${id.slice(0, 15)}'`))
        .map((Id) =>
          soql.startsWith('SELECT Id, IsActive') && users[Id] !== undefined
            ? { Id, IsActive: users[Id] }
            : { Id },
        );
    });
  }

  it('asks a user with its IsActive and a queue without it, when told to', async () => {
    const query = targetWithUsers({ [INACTIVE]: false }, [QUEUE]);
    const inactive = new Set<string>();

    await idsTheTargetLacks({
      lookups: [{ name: 'OwnerId', referenceTo: ['Group', 'User'] }],
      rows: [{ OwnerId: QUEUE }, { OwnerId: INACTIVE }],
      known: new Map(),
      inactive,
      query,
    });

    expect(query.mock.calls.map(([soql]) => soql.split(' WHERE')[0])).toEqual([
      'SELECT Id FROM Group',
      'SELECT Id, IsActive FROM User',
    ]);
    expect(query.mock.calls[1][0]).toMatch(/^SELECT Id, IsActive FROM User WHERE Id IN \(/);
    expect(inactive.has(QUEUE)).toBe(false);
  });

  it('asks a user without its IsActive when not told to, as before', async () => {
    const query = targetWithUsers({ [INACTIVE]: false });

    await idsTheTargetLacks({
      lookups: [{ name: 'OwnerId', referenceTo: ['User'] }],
      rows: [{ OwnerId: INACTIVE }],
      known: new Map(),
      query,
    });

    expect(query.mock.calls[0][0]).toMatch(/^SELECT Id FROM User WHERE Id IN \(/);
  });

  it('finds a user inactive only when the target answers exactly false: a user held so is one it holds, not one it lacks', async () => {
    const query = targetWithUsers({
      [INACTIVE]: false,
      [TARGET_USER]: true,
      [SOURCE_USER]: undefined,
    });
    const known = new Map<string, boolean>();
    const inactive = new Set<string>();

    const lacking = await idsTheTargetLacks({
      lookups: [{ name: 'OwnerId', referenceTo: ['User'] }],
      rows: [{ OwnerId: INACTIVE }, { OwnerId: TARGET_USER }, { OwnerId: SOURCE_USER }],
      known,
      inactive,
      query,
    });

    expect(lacking.size).toBe(0);
    expect(known.get(INACTIVE)).toBe(true);
    expect(inactive.has(INACTIVE)).toBe(true);
    // An answer that says nothing of the field is an active user's.
    expect(inactive.has(SOURCE_USER)).toBe(false);
    expect(inactive.has(TARGET_USER)).toBe(false);
  });

  it('keeps the inactive user under the form the row carries it in, the target answering in another', async () => {
    const short = INACTIVE.slice(0, 15);
    const inactive = new Set<string>();

    await idsTheTargetLacks({
      lookups: [{ name: 'OwnerId', referenceTo: ['User'] }],
      rows: [{ OwnerId: short }],
      known: new Map(),
      inactive,
      query: vi.fn(async () => [{ Id: INACTIVE, IsActive: false }]),
    });

    expect(inactive.has(short)).toBe(true);
    expect(inactive.has(INACTIVE)).toBe(true);
  });

  it('says a user first met on another lookup inactive as an owner, without asking again', async () => {
    const query = targetWithUsers({ [INACTIVE]: false });
    const known = new Map<string, boolean>();
    const inactive = new Set<string>();

    await idsTheTargetLacks({
      lookups: [{ name: 'Approver__c', referenceTo: ['User'] }],
      rows: [{ Approver__c: INACTIVE }],
      known,
      inactive,
      query,
    });
    await idsTheTargetLacks({
      lookups: [{ name: 'OwnerId', referenceTo: ['User'] }],
      rows: [{ OwnerId: INACTIVE }],
      known,
      inactive,
      query,
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(inactiveOwnersOf([{ OwnerId: INACTIVE }], inactive)).toEqual(new Set([INACTIVE]));
  });

  it('keeps an inactive user when the answers it keeps are at their bound', async () => {
    const known = new Map<string, boolean>(
      Array.from({ length: KNOWN_IDS_BOUND }, (_, n) => [
        `a0K${String(n).padStart(15, '0')}`,
        true,
      ]),
    );
    const inactive = new Set<string>();

    await idsTheTargetLacks({
      lookups: [{ name: 'OwnerId', referenceTo: ['User'] }],
      rows: [{ OwnerId: INACTIVE }],
      known,
      inactive,
      query: targetWithUsers({ [INACTIVE]: false }),
    });

    expect(known.has(INACTIVE)).toBe(false);
    expect(inactive.has(INACTIVE)).toBe(true);
  });

  it('finds none inactive when the target refuses the read of its users, and asks it no more', async () => {
    const refused = new Set<string>();
    const inactive = new Set<string>();

    const lacking = await idsTheTargetLacks({
      lookups: [{ name: 'OwnerId', referenceTo: ['User'] }],
      rows: [{ OwnerId: INACTIVE }],
      known: new Map(),
      refused,
      inactive,
      query: vi.fn(async (): Promise<Array<Record<string, unknown>>> => {
        throw new Error('INSUFFICIENT_ACCESS');
      }),
    });

    expect(lacking.size).toBe(0);
    expect(inactive.size).toBe(0);
    expect([...refused]).toEqual(['User']);
  });

  describe('inactiveOwnersOf', () => {
    it('names the owners held inactive, never one mapped to a user of the target nor an active one', () => {
      const MAPPED = '005000000000004AAA';
      const owners = inactiveOwnersOf(
        [
          { OwnerId: INACTIVE },
          { OwnerId: MAPPED },
          { OwnerId: TARGET_USER },
          { OwnerId: null },
          { Name: 'no owner' },
          { OwnerId: INACTIVE },
        ],
        new Set([INACTIVE, MAPPED]),
        { [MAPPED]: TARGET_USER },
      );

      expect([...owners]).toEqual([INACTIVE]);
    });
  });

  describe('writesInactiveOwners', () => {
    it('reads Update Records with Inactive Owners of the user the run writes as', async () => {
      const query = vi.fn(async () => [{ PermissionsUpdateWithInactiveOwner: true }]);

      expect(await writesInactiveOwners(query)).toBe(true);
      expect(query).toHaveBeenCalledWith(INACTIVE_OWNER_PERMISSION_SOQL);
      expect(INACTIVE_OWNER_PERMISSION_SOQL).toBe(
        'SELECT PermissionsUpdateWithInactiveOwner FROM UserPermissionAccess',
      );
    });

    it('takes an org that will not say for one where the user may not', async () => {
      expect(
        await writesInactiveOwners(
          vi.fn(async () => [{ PermissionsUpdateWithInactiveOwner: false }]),
        ),
      ).toBe(false);
      expect(await writesInactiveOwners(vi.fn(async () => []))).toBe(false);
      expect(
        await writesInactiveOwners(
          vi.fn(async (): Promise<Array<Record<string, unknown>>> => {
            // The org's setting off, as an org has it by default: the field
            // is not there to read.
            throw new Error(
              "INVALID_FIELD: No such column 'PermissionsUpdateWithInactiveOwner' on entity 'UserPermissionAccess'",
            );
          }),
        ),
      ).toBe(false);
    });

    it('asks once, however many times it is answered', async () => {
      const query = vi.fn(async () => [{ PermissionsUpdateWithInactiveOwner: true }]);
      const writes = writesInactiveOwnersOnce(query);

      expect(query).not.toHaveBeenCalled();
      expect(await writes()).toBe(true);
      expect(await writes()).toBe(true);
      expect(query).toHaveBeenCalledTimes(1);
    });
  });
});

describe('inactiveMappedOwners', () => {
  const INACTIVE = '005000000000003AAA';
  const OTHER_SOURCE = '005000000000005AAA';

  /** A target holding `users`: each with its name and whether it is active. */
  function targetWithNamedUsers(users: Record<string, { name?: string; active?: boolean }>) {
    return vi.fn(async (soql: string): Promise<Array<Record<string, unknown>>> =>
      Object.entries(users)
        .filter(([id]) => soql.includes(`'${id}'`) || soql.includes(`'${id.slice(0, 15)}'`))
        .map(([Id, { name, active }]) => ({
          Id,
          ...(name !== undefined ? { Name: name } : {}),
          ...(active !== undefined ? { IsActive: active } : {}),
        })),
    );
  }

  it('names each user a mapping gives that the target holds inactive, with the source owners mapped to it', async () => {
    const query = targetWithNamedUsers({
      [INACTIVE]: { name: 'Former Admin', active: false },
      [TARGET_USER]: { name: 'Current Admin', active: true },
    });

    const inactive = await inactiveMappedOwners(
      {
        [SOURCE_USER]: INACTIVE.slice(0, 15),
        [OTHER_SOURCE]: INACTIVE.slice(0, 15),
        '005000000000006AAA': TARGET_USER,
      },
      query,
    );

    expect(inactive).toEqual([
      {
        user: INACTIVE.slice(0, 15),
        name: 'Former Admin',
        sources: [SOURCE_USER, OTHER_SOURCE],
      },
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toMatch(/^SELECT Id, Name, IsActive FROM User WHERE Id IN \(/);
  });

  it('asks nothing of a run that maps no owner, and finds none inactive', async () => {
    const query = targetWithNamedUsers({});

    expect(await inactiveMappedOwners({}, query)).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('finds none inactive in an answer that says nothing of the field, nor of a user the target lacks', async () => {
    const query = targetWithNamedUsers({ [INACTIVE]: { name: 'Former Admin' } });

    expect(
      await inactiveMappedOwners(
        { [SOURCE_USER]: INACTIVE, [OTHER_SOURCE]: '005000000000009AAA' },
        query,
      ),
    ).toEqual([]);
  });

  it('finds none inactive when the target refuses the read: the rows then go mapped', async () => {
    const query = vi.fn(async (): Promise<Array<Record<string, unknown>>> => {
      throw new Error('INSUFFICIENT_ACCESS');
    });

    expect(await inactiveMappedOwners({ [SOURCE_USER]: INACTIVE }, query)).toEqual([]);
  });
});
