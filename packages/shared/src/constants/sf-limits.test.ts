import { describe, it, expect } from 'vitest';

import { SF_LIMITS } from './sf-limits.js';
import type { SfLimitKey } from './sf-limits.js';

describe('SF_LIMITS', () => {
  it('should have no undefined values', () => {
    for (const [key, value] of Object.entries(SF_LIMITS)) {
      expect(value, `${key} should not be undefined`).toBeDefined();
    }
  });

  it('should have all numeric limits as positive numbers', () => {
    const numericKeys = Object.keys(SF_LIMITS).filter(
      (key) => key !== 'DEFAULT_API_VERSION',
    ) as SfLimitKey[];

    for (const key of numericKeys) {
      const value = SF_LIMITS[key];
      expect(typeof value, `${key} should be a number`).toBe('number');
      expect(value, `${key} should be positive`).toBeGreaterThan(0);
    }
  });

  it('should have DEFAULT_API_VERSION as a valid version string', () => {
    expect(typeof SF_LIMITS.DEFAULT_API_VERSION).toBe('string');
    expect(SF_LIMITS.DEFAULT_API_VERSION).toMatch(/^\d+\.\d+$/);
  });

  it('should have correct REST API batch size', () => {
    expect(SF_LIMITS.REST_API_BATCH_SIZE).toBe(200);
  });

  it('should have correct Composite API limits', () => {
    expect(SF_LIMITS.COMPOSITE_BATCH_SIZE).toBe(25);
    expect(SF_LIMITS.COMPOSITE_MAX_SUBREQUESTS).toBe(25);
  });

  it('should have correct Bulk API limits', () => {
    expect(SF_LIMITS.BULK_API_MAX_RECORDS).toBe(150_000_000);
    expect(SF_LIMITS.BULK_API_MAX_CONCURRENT_JOBS).toBe(100);
    expect(SF_LIMITS.BULK_API_MAX_BATCH_SIZE_BYTES).toBe(10 * 1024 * 1024);
  });

  it('should have correct SOQL limits', () => {
    expect(SF_LIMITS.SOQL_MAX_LENGTH).toBe(100_000);
    expect(SF_LIMITS.SOQL_MAX_RECORDS).toBe(50_000);
    expect(SF_LIMITS.SOQL_MAX_IN_VALUES).toBe(4000);
    expect(SF_LIMITS.SOQL_MAX_OFFSET).toBe(2000);
  });

  it('should satisfy SfLimitKey type constraint', () => {
    const key: SfLimitKey = 'REST_API_BATCH_SIZE';
    expect(SF_LIMITS[key]).toBe(200);
  });
});
