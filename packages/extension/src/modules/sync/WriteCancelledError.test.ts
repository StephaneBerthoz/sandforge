import { describe, it, expect } from 'vitest';
import { WriteCancelledError } from './WriteCancelledError.js';

describe('WriteCancelledError', () => {
  it('names the object whose write the cancel stopped, and says nothing of it was written', () => {
    const error = new WriteCancelledError('Contact');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('WriteCancelledError');
    expect(error.objectApiName).toBe('Contact');
    expect(error.written).toEqual([]);
    expect(error.message).toBe(
      'The write of Contact was cancelled before any of its records was written.',
    );
  });

  it('carries what a write stopped between two batches wrote, and says how many were sent', () => {
    const written = [
      { id: '003000000000001AAA', success: true, errors: [] },
      { success: false, errors: ['REQUIRED_FIELD_MISSING: LastName'] },
    ];

    const error = new WriteCancelledError('Contact', written);

    expect(error.written).toBe(written);
    expect(error.notes).toEqual([]);
    expect(error.message).toBe(
      'The write of Contact was cancelled after 2 of its records were sent.',
    );
  });

  it('carries what the write said of the records it wrote', () => {
    const note =
      '1 record(s) written without Key_Contact__c: the lookup held an id from the source org ' +
      'that the target does not have.';

    const error = new WriteCancelledError(
      'Account',
      [{ id: '001000000000001AAA', success: true, errors: [] }],
      [note],
    );

    expect(error.notes).toEqual([note]);
  });

  it('is told apart from any other error a write can throw', () => {
    const errors: unknown[] = [new WriteCancelledError('Account'), new Error('INVALID_SESSION_ID')];

    expect(errors.map((e) => e instanceof WriteCancelledError)).toEqual([true, false]);
  });
});
