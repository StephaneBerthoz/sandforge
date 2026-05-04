import { describe, it, expect } from 'vitest';

import { SF_ERROR_CLASSIFICATIONS, getErrorClassification } from './error-codes.js';

describe('SF_ERROR_CLASSIFICATIONS', () => {
  it('should have at least 10 error codes defined', () => {
    expect(Object.keys(SF_ERROR_CLASSIFICATIONS).length).toBeGreaterThanOrEqual(10);
  });

  it('should have retryable errors with a delay value', () => {
    for (const [code, classification] of Object.entries(SF_ERROR_CLASSIFICATIONS)) {
      if (classification.retryable) {
        expect(
          classification.delay,
          `Retryable error ${code} should have a delay defined`,
        ).toBeDefined();
      }
    }
  });

  it('should have retryable errors with a strategy', () => {
    for (const [code, classification] of Object.entries(SF_ERROR_CLASSIFICATIONS)) {
      if (classification.retryable) {
        expect(
          classification.strategy,
          `Retryable error ${code} should have a strategy defined`,
        ).toBeDefined();
      }
    }
  });

  it('should classify UNABLE_TO_LOCK_ROW as retryable with exponential backoff', () => {
    const classification = SF_ERROR_CLASSIFICATIONS['UNABLE_TO_LOCK_ROW'];
    expect(classification.retryable).toBe(true);
    expect(classification.strategy).toBe('exponential');
    expect(classification.delay).toBe(2000);
  });

  it('should classify INVALID_SESSION_ID as retryable with reauth strategy', () => {
    const classification = SF_ERROR_CLASSIFICATIONS['INVALID_SESSION_ID'];
    expect(classification.retryable).toBe(true);
    expect(classification.strategy).toBe('reauth_then_retry');
  });

  it('should classify INVALID_FIELD as non-retryable schema error', () => {
    const classification = SF_ERROR_CLASSIFICATIONS['INVALID_FIELD'];
    expect(classification.retryable).toBe(false);
    expect(classification.category).toBe('schema');
  });

  it('should classify DUPLICATE_VALUE with suggestUpsert flag', () => {
    const classification = SF_ERROR_CLASSIFICATIONS['DUPLICATE_VALUE'];
    expect(classification.retryable).toBe(false);
    expect(classification.suggestUpsert).toBe(true);
  });

  it('should classify STRING_TOO_LONG with suggestTruncate flag', () => {
    const classification = SF_ERROR_CLASSIFICATIONS['STRING_TOO_LONG'];
    expect(classification.retryable).toBe(false);
    expect(classification.suggestTruncate).toBe(true);
  });

  it('should classify STORAGE_LIMIT_EXCEEDED with blockAll flag', () => {
    const classification = SF_ERROR_CLASSIFICATIONS['STORAGE_LIMIT_EXCEEDED'];
    expect(classification.retryable).toBe(false);
    expect(classification.blockAll).toBe(true);
  });

  it('should classify INSUFFICIENT_ACCESS_OR_READONLY as permission error', () => {
    const classification = SF_ERROR_CLASSIFICATIONS['INSUFFICIENT_ACCESS_OR_READONLY'];
    expect(classification.retryable).toBe(false);
    expect(classification.category).toBe('permission');
  });
});

describe('getErrorClassification', () => {
  it('should return correct classification for known error codes', () => {
    const classification = getErrorClassification('UNABLE_TO_LOCK_ROW');
    expect(classification.retryable).toBe(true);
    expect(classification.strategy).toBe('exponential');
  });

  it('should return default non-retryable classification for unknown error codes', () => {
    const classification = getErrorClassification('COMPLETELY_UNKNOWN_ERROR');
    expect(classification.retryable).toBe(false);
    expect(classification.category).toBe('unknown');
  });

  it('should return default classification for empty string', () => {
    const classification = getErrorClassification('');
    expect(classification.retryable).toBe(false);
    expect(classification.category).toBe('unknown');
  });

  it('should return the same result as direct map access for known codes', () => {
    for (const code of Object.keys(SF_ERROR_CLASSIFICATIONS)) {
      expect(getErrorClassification(code)).toEqual(SF_ERROR_CLASSIFICATIONS[code]);
    }
  });
});
