import { describe, expect, it, vi } from 'vitest';

import { MemoryRestoreOrg } from '../../test/memoryRestoreOrg.js';
import {
  backToDraft,
  namedDraftNote,
  putBackStatuses,
  setBackToDraftOf,
} from './recordsToDraft.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * An activated order refuses its delete until it is a draft again (P8, live):
 * set back to Draft before the deletes, and given its status back when it
 * stays.
 */

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const ORDERS = [fakeId('801', 1), fakeId('801', 2), fakeId('801', 3)];

/** Three orders: two activated, one a draft already. */
function orders(): MemoryRestoreOrg {
  const org = new MemoryRestoreOrg({});
  org.add('OrderStatus', { Id: 'status-draft', ApiName: 'Draft', StatusCode: 'Draft' });
  org.add('OrderStatus', { Id: 'status-live', ApiName: 'Activated', StatusCode: 'Activated' });
  org.add('Order', { Id: ORDERS[0], Status: 'Activated' });
  org.add('Order', { Id: ORDERS[1], Status: 'Activated' });
  org.add('Order', { Id: ORDERS[2], Status: 'Draft' });
  return org;
}

const pages = {
  pages: async function* (objectApiName: string) {
    if (objectApiName === 'Order') yield ORDERS;
  },
};

describe('backToDraft', () => {
  it('sets the records past Draft to Draft, and hands each back with the status it had', async () => {
    const org = orders();

    const { drafted, cancelled } = await backToDraft(
      org,
      [{ objectApiName: 'Order' }],
      pages,
      () => true,
      () => false,
      async () => new Set(),
    );

    expect(cancelled).toBe(false);
    expect(drafted).toEqual([
      { objectApiName: 'Order', id: ORDERS[0], draft: 'Draft', status: 'Activated' },
      { objectApiName: 'Order', id: ORDERS[1], draft: 'Draft', status: 'Activated' },
    ]);
    expect(org.all('Order').map((row) => row.Status)).toEqual(['Draft', 'Draft', 'Draft']);
  });

  it('leaves as it is a record that does not go, and one that records staying hold', async () => {
    const org = orders();

    const { drafted } = await backToDraft(
      org,
      [{ objectApiName: 'Order' }],
      pages,
      (_object, id) => id !== ORDERS[0],
      () => false,
      async () => new Set([ORDERS[1].slice(0, 15)]),
    );

    expect(drafted).toEqual([]);
    expect(org.updates).toEqual([]);
  });

  it('sets nothing once stopped', async () => {
    const org = orders();

    const outcome = await backToDraft(
      org,
      [{ objectApiName: 'Order' }],
      pages,
      () => true,
      () => true,
      async () => new Set(),
    );

    expect(outcome).toEqual({ drafted: [], cancelled: true });
    expect(org.updates).toEqual([]);
  });

  it('names the objects whose records past Draft go back to it: an order, never a contract the org deletes as it stands', () => {
    expect(setBackToDraftOf(['Account', 'Order', 'Contract'])).toEqual(['Order']);
  });
});

describe('putBackStatuses', () => {
  it('gives a record left in Draft its status back and says so; one the org refuses stays in Draft, with why', async () => {
    const org = orders();
    const { drafted } = await backToDraft(
      org,
      [{ objectApiName: 'Order' }],
      pages,
      () => true,
      () => false,
      async () => new Set(),
    );
    org.refuseUpdate.set(ORDERS[1], { statusCode: 'UNABLE_TO_LOCK_ROW', message: 'locked' });
    const notes: Array<[string, string, boolean]> = [];
    const named: string[] = [];

    await putBackStatuses(org, drafted, {
      note: (objectApiName, reason, failed, record) => {
        notes.push([objectApiName, reason, failed]);
        named.push(namedDraftNote(objectApiName, reason, record, drafted));
      },
    });

    // Each record said by its id, the status it had in the words.
    expect(named).toEqual([
      `Order ${ORDERS[0]}: Status set to Draft for the delete, then back to Activated.`,
      `Order ${ORDERS[1]}: Status set to Draft for the delete, and left there: the org refused Activated back — UNABLE_TO_LOCK_ROW: locked`,
    ]);
    // Said of the object as a whole — its records not read back —, each set to Draft is named.
    expect(namedDraftNote('Order', 'Not read back.', undefined, drafted.slice(0, 2))).toBe(
      `Order: Not read back. Set to Draft, with the status each had: ${ORDERS[0]} (Activated), ${ORDERS[1]} (Activated).`,
    );

    expect(org.all('Order').map((row) => row.Status)).toEqual(['Activated', 'Draft', 'Draft']);
    expect(notes).toEqual([
      ['Order', 'Status set to Draft for the delete, then back to Activated.', false],
      [
        'Order',
        'Status set to Draft for the delete, and left there: the org refused Activated back — UNABLE_TO_LOCK_ROW: locked',
        true,
      ],
    ]);
  });
});
