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
});

describe('getErrorClassification', () => {
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
