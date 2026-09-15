import { describe, it, expect } from 'vitest';
import { SF_ERROR_CLASSIFICATIONS } from '@sandforge/shared';
import { hasKnownResolution, knownErrorCodes, resolveKnownError } from './errorKnowledgeBase.js';

describe('errorKnowledgeBase', () => {
  it('answers every Salesforce error code SandForge classifies', () => {
    // The classifier and the table are two lists of the same codes. A code
    // the engine knows how to retry but the table cannot explain would reach
    // the model — or, with AI off, the user with no hint at all.
    const unanswered = Object.keys(SF_ERROR_CLASSIFICATIONS).filter(
      (code) => !hasKnownResolution(code),
    );

    expect(unanswered).toEqual([]);
  });

  it('answers a known code with a curated resolution', () => {
    const resolution = resolveKnownError({
      errorCode: 'UNABLE_TO_LOCK_ROW',
      message: 'unable to obtain exclusive access to this record',
    });

    expect(resolution?.explanation).toContain('Another transaction is currently locking');
    expect(resolution?.suggestions[0]?.description).toBe(
      'Wait a moment and retry. Row locks are usually transient.',
    );
    expect(resolution?.confidence).toBe(0.95);
  });

  it('has no answer for a code outside the table', () => {
    expect(hasKnownResolution('SOMETHING_WE_HAVE_NEVER_SEEN')).toBe(false);
    expect(
      resolveKnownError({ errorCode: 'SOMETHING_WE_HAVE_NEVER_SEEN', message: 'odd' }),
    ).toBeUndefined();
  });

  it('does not read inherited object keys as error codes', () => {
    expect(hasKnownResolution('constructor')).toBe(false);
    expect(resolveKnownError({ errorCode: 'toString', message: '' })).toBeUndefined();
  });

  it('gives every entry a suggestion and a documentation link', () => {
    const codes = knownErrorCodes();
    expect(codes.length).toBeGreaterThanOrEqual(Object.keys(SF_ERROR_CLASSIFICATIONS).length);

    for (const code of codes) {
      const resolution = resolveKnownError({ errorCode: code, message: `${code} test` });
      expect(resolution?.suggestions.length, code).toBeGreaterThan(0);
      expect(resolution?.relatedDocs.length, code).toBeGreaterThan(0);
    }
  });

  it('names the affected fields and object in the explanation', () => {
    const resolution = resolveKnownError({
      errorCode: 'REQUIRED_FIELD_MISSING',
      message: 'Missing fields',
      fields: ['Name', 'Email'],
      objectName: 'Contact',
    });

    expect(resolution?.explanation).toContain('Name, Email');
    expect(resolution?.explanation).toContain('Contact');
  });

  it('adds a batch-size suggestion when the batch is above 200', () => {
    const resolution = resolveKnownError(
      { errorCode: 'UNABLE_TO_LOCK_ROW', message: 'lock contention' },
      { batchSize: 500 },
    );

    const contextual = resolution?.suggestions.find(
      (s) => s.action === 'reduce_batch_size' && s.description.includes('500'),
    );
    expect(contextual).toBeDefined();
  });
});
