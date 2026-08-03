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
});
