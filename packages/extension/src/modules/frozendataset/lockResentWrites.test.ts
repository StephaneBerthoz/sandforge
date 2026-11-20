import { describe, expect, it } from 'vitest';
import type { OperationOutcome } from '../sync/DataSync.js';
import { LockResentWrites } from './lockResentWrites.js';

const LOCKED: OperationOutcome = {
  success: false,
  errors: [
    'UNABLE_TO_LOCK_ROW: unable to obtain exclusive access to this record — sent again 3 times, ' +
      'waiting longer each time: the target still could not lock a record the write needed',
  ],
};
const WRITTEN: OperationOutcome = { success: true, errors: [] };
const REFUSED: OperationOutcome = {
  success: false,
  errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: an order needs a product'],
};

/** `outcome`, as the writer hands back one it sent again `times` times. */
const sentAgain = (outcome: OperationOutcome, times = 1): OperationOutcome => ({
  ...outcome,
  lockResends: times,
});

const nothingPurged = () => false;

describe('LockResentWrites', () => {
  it('says nothing of writes no lock held', () => {
    const met = new LockResentWrites();
    met.updated('Order', [WRITTEN, REFUSED]);
    met.deleted('Account', ['001000000000001AAA'], [WRITTEN]);

    expect(met.list(nothingPurged)).toEqual([]);
  });

  it('counts each update sent again on its own, written, still locked, or refused for another reason', () => {
    const met = new LockResentWrites();
    met.updated('Order', [sentAgain(WRITTEN), WRITTEN, sentAgain(LOCKED, 3)]);
    // The same order's status, after its link: another write, refused otherwise.
    met.updated('Order', [sentAgain(REFUSED, 2)]);

    expect(met.list(nothingPurged)).toEqual([
      { objectApiName: 'Order', write: 'update', rows: 3, written: 1, stillLocked: 1 },
    ]);
  });

  it("counts a record of the purge once, by the purge's last word on it", () => {
    const met = new LockResentWrites();
    const first = '001000000000001AAA';
    const second = '001000000000002AAA';
    met.deleted('Account', [first, second], [sentAgain(LOCKED, 3), sentAgain(LOCKED, 3)]);
    // Sent once more when the rest had gone: the first went at once.
    met.deleted('Account', [first, second], [WRITTEN, sentAgain(LOCKED, 3)]);

    expect(met.list((_object, id) => id === first)).toEqual([
      { objectApiName: 'Account', write: 'delete', rows: 2, written: 1, stillLocked: 1 },
    ]);
  });

  it('reads a record of the purge by its first fifteen characters, as the purge does', () => {
    const met = new LockResentWrites();
    met.deleted('Account', ['001000000000001AAA'], [sentAgain(LOCKED, 3)]);
    met.deleted('Account', ['001000000000001'], [WRITTEN]);

    expect(met.list(() => true)).toEqual([
      { objectApiName: 'Account', write: 'delete', rows: 1, written: 1, stillLocked: 0 },
    ]);
  });

  it('keeps a record the purge took along deleted, whatever its delete answered', () => {
    const met = new LockResentWrites();
    met.deleted('Contact', ['003000000000001AAA'], [sentAgain(LOCKED, 3)]);

    expect(met.list(() => true)).toEqual([
      { objectApiName: 'Contact', write: 'delete', rows: 1, written: 1, stillLocked: 0 },
    ]);
  });

  it('lists them per object and write, in the order the load met them', () => {
    const met = new LockResentWrites();
    met.deleted('Contact', ['003000000000001AAA'], [sentAgain(WRITTEN)]);
    met.updated('Order', [sentAgain(WRITTEN)]);
    met.updated('Contact', [sentAgain(WRITTEN)]);
    met.deleted('Account', ['001000000000001AAA'], [sentAgain(WRITTEN)]);

    expect(
      met.list(() => true).map(({ objectApiName, write }) => `${write} ${objectApiName}`),
    ).toEqual(['delete Contact', 'update Order', 'update Contact', 'delete Account']);
  });
});
