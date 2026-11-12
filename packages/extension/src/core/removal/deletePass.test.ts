import { describe, expect, it, vi } from 'vitest';

import type { MemoryChild } from '../../test/memoryRemovalOrg.js';
import { MemoryRestoreOrg } from '../../test/memoryRestoreOrg.js';
import {
  HARD_DELETE_NOT_ENABLED,
  HARD_DELETE_UNAVAILABLE,
  LOCK_RESENDS,
  type BulkDeleteAnswer,
} from './deleteRecords.js';
import { deletePass, type PassRecords } from './deletePass.js';
import { recycleBinOf } from './recycleBin.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * A pass that empties whole objects, on the memory org that holds to what
 * Salesforce was seen to do: a child deleted on its own, then its parent,
 * stays in the recycle bin for good (F41); a child taken along comes back
 * with its parent only (P7); an activated order refuses its delete and its
 * account's until it is a draft again (P8); a restricted lookup refuses the
 * delete of what it names while its record lives (G1); a hardDelete job is
 * refused at its creation to a user without Bulk API Hard Delete, and what it
 * deletes still reads deleted through queryAll, never to come back (probes of
 * 12/11).
 */

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

/** The org's words when it refuses a hardDelete job, as asked live. */
const NO_HARD_DELETE =
  'hardDelete operation requires special user profile permission, please contact your system administrator';

const RELATIONSHIPS: Record<string, MemoryChild[]> = {
  Account: [
    { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
    { childSObject: 'Opportunity', field: 'AccountId', cascadeDelete: true },
    { childSObject: 'Order', field: 'AccountId', cascadeDelete: true },
  ],
  Pricebook2: [{ childSObject: 'Opportunity', field: 'Pricebook2Id', restrictedDelete: true }],
  Order: [{ childSObject: 'OrderItem', field: 'OrderId', cascadeDelete: true }],
};

/**
 * The memory org with the Bulk API's two delete jobs, each kept apart from
 * the deletes over REST: a `hardDelete` job refused as it is opened unless
 * the user holds Bulk API Hard Delete, and a record the org cannot lock for a
 * number of tries.
 */
class EmptiedOrg extends MemoryRestoreOrg {
  readonly rest: Array<{ objectApiName: string; ids: string[] }> = [];
  readonly jobs: Array<{
    operation: 'delete' | 'hardDelete';
    objectApiName: string;
    ids: string[];
  }> = [];
  /** Whether the user holds Bulk API Hard Delete: off by default, as on the test orgs. */
  hardDeletePermitted = false;
  /** Tries a record is refused for a lock, by id. */
  readonly locked = new Map<string, number>();

  constructor() {
    // What a hardDelete job deletes still reads deleted through queryAll, as probed live.
    super(RELATIONSHIPS, { facts: { hardDeleteInQueryAll: true } });
  }

  /** A delete as the org answers it, the records it could not lock refused, nothing of them deleted. */
  private async answered(objectApiName: string, ids: string[]): Promise<unknown[]> {
    const locked = new Set(
      ids.filter((id) => {
        const tries = this.locked.get(id) ?? 0;
        if (tries > 0) this.locked.set(id, tries - 1);
        return tries > 0;
      }),
    );
    const rest = ids.filter((id) => !locked.has(id));
    const answers =
      rest.length > 0 ? ((await super.destroy(objectApiName, rest)) as unknown[]) : [];
    return ids.map((id) =>
      locked.has(id)
        ? {
            success: false,
            errors: [
              {
                statusCode: 'UNABLE_TO_LOCK_ROW',
                message: 'unable to obtain exclusive access to this record',
              },
            ],
          }
        : answers[rest.indexOf(id)],
    );
  }

  override async destroy(objectApiName: string, ids: string[]): Promise<unknown> {
    this.rest.push({ objectApiName, ids: [...ids] });
    return this.answered(objectApiName, ids);
  }

  private async job(
    operation: 'delete' | 'hardDelete',
    objectApiName: string,
    ids: readonly string[],
  ): Promise<BulkDeleteAnswer> {
    this.jobs.push({ operation, objectApiName, ids: [...ids] });
    const answers = await this.answered(objectApiName, [...ids]);
    const rows = answers.map((answer) => {
      const row = answer as {
        success: boolean;
        errors?: Array<{ statusCode: string; message: string }>;
      };
      if (row.success) return { success: true as const };
      const [error] = row.errors ?? [];
      return { success: false as const, error: `${error?.statusCode}:${error?.message}:--` };
    });
    if (operation === 'hardDelete') {
      ids.forEach((id, at) => {
        if (rows[at].success) this.hardDelete(objectApiName, id);
      });
    }
    return { kind: 'answered', rows, requests: 7 };
  }

  async bulkDestroy(objectApiName: string, ids: readonly string[]): Promise<BulkDeleteAnswer> {
    return this.job('delete', objectApiName, ids);
  }

  async bulkHardDestroy(objectApiName: string, ids: readonly string[]): Promise<BulkDeleteAnswer> {
    if (!this.hardDeletePermitted) {
      this.jobs.push({ operation: 'hardDelete', objectApiName, ids: [] });
      return {
        kind: 'untouched',
        reason: NO_HARD_DELETE,
        code: HARD_DELETE_NOT_ENABLED,
        requests: 1,
      };
    }
    return this.job('hardDelete', objectApiName, ids);
  }

  /** Whether a deleted record comes back with an undelete, and the org's answer when it does not. */
  async comesBack(id: string): Promise<true | string> {
    const [answer] = (await this.undelete([id])) as Array<{
      success: boolean;
      errors: Array<{ message?: string }>;
    }>;
    return answer.success ? true : (answer.errors[0]?.message ?? 'refused');
  }
}

const ACCOUNT = fakeId('001', 1);
const CONTACTS = [fakeId('003', 1), fakeId('003', 2)];

/** An account and its two contacts. */
function accountWithContacts(): EmptiedOrg {
  const org = new EmptiedOrg();
  org.add('Account', { Id: ACCOUNT });
  for (const id of CONTACTS) org.add('Contact', { Id: id, AccountId: ACCOUNT });
  return org;
}

/** The records a pass deletes, in the order given, each object one page. */
function pass(...objects: Array<[string, string[]]>): PassRecords {
  return {
    objects: objects.map(([objectApiName, ids]) => ({ objectApiName, count: ids.length })),
    pages: async function* (objectApiName) {
      const ids = objects.find(([name]) => name === objectApiName)?.[1] ?? [];
      if (ids.length > 0) yield ids;
    },
  };
}

/** A wait that waits for nothing. */
const wait = async (): Promise<void> => {};

describe('deletePass, to the recycle bin', () => {
  it('deletes a parent before what its delete takes along: its children answer they are gone, and come back with it', async () => {
    const org = accountWithContacts();

    const outcome = await deletePass(org, pass(['Account', [ACCOUNT]], ['Contact', CONTACTS]), {
      mode: 'recycle',
    });

    expect(outcome).toEqual({
      hard: false,
      cancelled: false,
      objects: [
        { objectApiName: 'Account', planned: 1, deleted: 1, gone: 0, refused: 0, reasons: [] },
        { objectApiName: 'Contact', planned: 2, deleted: 0, gone: 2, refused: 0, reasons: [] },
      ],
    });
    expect(org.all('Contact')).toEqual([]);
    // Undo: the account brings its contacts back (P7).
    expect(await org.comesBack(ACCOUNT)).toBe(true);
    expect(org.all('Contact').map((row) => row.Id)).toEqual(CONTACTS);
  });

  it('keeps the order it is given: children sent first stay in the bin for good once their parent goes (F41)', async () => {
    const org = accountWithContacts();

    await deletePass(org, pass(['Contact', CONTACTS], ['Account', [ACCOUNT]]), { mode: 'recycle' });

    expect(org.rest.map((call) => call.objectApiName)).toEqual(['Contact', 'Account']);
    expect(await org.comesBack(ACCOUNT)).toBe(true);
    expect(org.all('Contact')).toEqual([]);
    expect(await org.comesBack(CONTACTS[0])).toBe('Entity is not in the recycle bin');
  });

  it('sets an activated order back to Draft before anything is deleted, then deletes it and its account (P8)', async () => {
    const org = new EmptiedOrg();
    const order = fakeId('801', 1);
    org.add('OrderStatus', { Id: 'status-draft', ApiName: 'Draft', StatusCode: 'Draft' });
    org.add('OrderStatus', { Id: 'status-live', ApiName: 'Activated', StatusCode: 'Activated' });
    org.add('Account', { Id: ACCOUNT });
    org.add('Order', { Id: order, AccountId: ACCOUNT, Status: 'Activated' });

    const outcome = await deletePass(org, pass(['Order', [order]], ['Account', [ACCOUNT]]), {
      mode: 'recycle',
    });

    expect(org.updates).toEqual([
      { objectApiName: 'Order', records: [{ Id: order, Status: 'Draft' }] },
    ]);
    expect(outcome.objects.map(({ deleted, refused }) => ({ deleted, refused }))).toEqual([
      { deleted: 1, refused: 0 },
      { deleted: 1, refused: 0 },
    ]);
  });

  it('is refused an activated order and its account when it is told not to set it to Draft', async () => {
    const org = new EmptiedOrg();
    const order = fakeId('801', 1);
    org.add('Account', { Id: ACCOUNT });
    org.add('Order', { Id: order, AccountId: ACCOUNT, Status: 'Activated' });

    const outcome = await deletePass(org, pass(['Order', [order]], ['Account', [ACCOUNT]]), {
      mode: 'recycle',
      toDraft: false,
    });

    expect(outcome.objects).toEqual([
      expect.objectContaining({
        objectApiName: 'Order',
        refused: 1,
        reasons: [
          'DELETE_FAILED: unable to modify activated order:  cannot delete order, or add or remove order products',
        ],
      }),
      expect.objectContaining({ objectApiName: 'Account', refused: 1 }),
    ]);
    expect(outcome.objects[1].reasons[0]).toMatch(/^DELETE_FAILED: .*active orders/);
  });

  it('sends again, once the rest has gone, a record the org refused while a record that went later still named it (G1)', async () => {
    const org = new EmptiedOrg();
    const book = fakeId('01s', 1);
    const opportunity = fakeId('006', 1);
    org.add('Pricebook2', { Id: book });
    org.add('Opportunity', { Id: opportunity, Pricebook2Id: book });

    const outcome = await deletePass(
      org,
      pass(['Pricebook2', [book]], ['Opportunity', [opportunity]]),
      { mode: 'recycle' },
    );

    expect(org.rest.map((call) => call.objectApiName)).toEqual([
      'Pricebook2',
      'Opportunity',
      'Pricebook2',
    ]);
    expect(outcome.objects.map(({ deleted, refused }) => ({ deleted, refused }))).toEqual([
      { deleted: 1, refused: 0 },
      { deleted: 1, refused: 0 },
    ]);
  });

  it('sends again a record the org could not lock, and says so on its object', async () => {
    const org = accountWithContacts();
    org.locked.set(CONTACTS[1], 1);

    const outcome = await deletePass(org, pass(['Contact', CONTACTS]), { mode: 'recycle', wait });

    expect(outcome.objects[0]).toEqual({
      objectApiName: 'Contact',
      planned: 2,
      deleted: 2,
      gone: 0,
      refused: 0,
      reasons: [
        `The org could not lock 1 record(s) (UNABLE_TO_LOCK_ROW), each sent again up to ${LOCK_RESENDS} times, a wait before each: 1 deleted.`,
      ],
    });
  });

  it('stops between two objects, and names the one it never reached', async () => {
    const org = accountWithContacts();
    const stop = new AbortController();

    const outcome = await deletePass(org, pass(['Contact', CONTACTS], ['Account', [ACCOUNT]]), {
      mode: 'recycle',
      signal: stop.signal,
      onSettled: () => stop.abort(),
    });

    expect(outcome.cancelled).toBe(true);
    expect(outcome.objects).toEqual([
      expect.objectContaining({ objectApiName: 'Contact', deleted: 2 }),
      expect.objectContaining({ objectApiName: 'Account', deleted: 0, notReached: 1 }),
    ]);
    expect(org.all('Account')).toHaveLength(1);
  });
});

describe('deletePass, for good', () => {
  it('deletes every record by hardDelete jobs, however few, nothing over REST, and says it deleted for good', async () => {
    const org = accountWithContacts();
    org.hardDeletePermitted = true;

    const outcome = await deletePass(org, pass(['Account', [ACCOUNT]], ['Contact', CONTACTS]), {
      mode: 'hard',
    });

    expect(outcome.hard).toBe(true);
    expect(org.rest).toEqual([]);
    expect(org.jobs.map(({ operation, objectApiName }) => [operation, objectApiName])).toEqual([
      ['hardDelete', 'Account'],
      ['hardDelete', 'Contact'],
    ]);
    expect(outcome.objects.map(({ deleted, gone }) => ({ deleted, gone }))).toEqual([
      { deleted: 1, gone: 0 },
      { deleted: 0, gone: 2 },
    ]);
  });

  it('leaves what it deleted reading deleted through queryAll, never to come back, and never said to be in the bin', async () => {
    const org = accountWithContacts();
    org.hardDeletePermitted = true;

    await deletePass(org, pass(['Account', [ACCOUNT]]), { mode: 'hard' });

    const deleted = await org.queryDeleted(
      `SELECT Id FROM Contact WHERE Id IN ('${CONTACTS[0]}', '${CONTACTS[1]}') AND IsDeleted = true`,
    );
    expect(deleted.records).toHaveLength(2);
    expect(await org.comesBack(ACCOUNT)).toBe('Entity is not in the recycle bin');
    expect(await org.comesBack(CONTACTS[0])).toBe('Entity is not in the recycle bin');
    expect(await recycleBinOf(org, 'Contact', CONTACTS, 'hard')).toEqual({
      deleted: new Set(CONTACTS.map((id) => id.slice(0, 15))),
      inBin: false,
    });
  });

  it("stops at the first job the org refuses to a user without Bulk API Hard Delete, with the org's words, nothing deleted", async () => {
    const org = accountWithContacts();

    const outcome = await deletePass(org, pass(['Account', [ACCOUNT]], ['Contact', CONTACTS]), {
      mode: 'hard',
    });

    expect(outcome.cancelled).toBe(true);
    expect(outcome.hardRefused).toContain(`${HARD_DELETE_NOT_ENABLED}: ${NO_HARD_DELETE}`);
    expect(outcome.objects.map(({ deleted, notReached }) => ({ deleted, notReached }))).toEqual([
      { deleted: 0, notReached: 1 },
      { deleted: 0, notReached: 2 },
    ]);
    expect(org.rest).toEqual([]);
    expect(org.jobs).toEqual([{ operation: 'hardDelete', objectApiName: 'Account', ids: [] }]);
    expect(org.all('Account')).toHaveLength(1);
    expect(org.all('Contact')).toHaveLength(2);
  });

  it('deletes nothing for good through an org that cannot send a hardDelete job', async () => {
    const org = accountWithContacts();
    // The org as a wrapper that knows only the delete job hands it on.
    const wrapped = {
      query: (soql: string) => org.query(soql),
      destroy: (objectApiName: string, ids: string[]) => org.destroy(objectApiName, ids),
      update: (objectApiName: string, records: Array<Record<string, unknown>>) =>
        org.update(objectApiName, records),
      bulkDestroy: (objectApiName: string, ids: readonly string[]) =>
        org.bulkDestroy(objectApiName, ids),
    };

    const outcome = await deletePass(wrapped, pass(['Account', [ACCOUNT]]), { mode: 'hard' });

    expect(outcome.hardRefused).toBe(HARD_DELETE_UNAVAILABLE);
    expect(org.rest).toEqual([]);
    expect(org.jobs).toEqual([]);
    expect(org.all('Account')).toHaveLength(1);
  });
});
