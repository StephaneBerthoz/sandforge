import { describe, it, expect } from 'vitest';
import { WriteCancelledError } from './WriteCancelledError.js';

describe('WriteCancelledError', () => {
  it('names the object whose write the cancel stopped, and says nothing of it was written', () => {
    const error = new WriteCancelledError('Contact');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('WriteCancelledError');
    expect(error.objectApiName).toBe('Contact');
    expect(error.message).toBe(
      'The write of Contact was cancelled before any of its records was written.',
    );
  });

  it('is told apart from any other error a write can throw', () => {
    const errors: unknown[] = [new WriteCancelledError('Account'), new Error('INVALID_SESSION_ID')];

    expect(errors.map((e) => e instanceof WriteCancelledError)).toEqual([true, false]);
  });
});
