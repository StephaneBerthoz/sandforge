import { describe, it, expect } from 'vitest';
import { MONITOR_KEY_LIMITS } from './monitor.js';

describe('MONITOR_KEY_LIMITS', () => {
  it('should contain no duplicate entries', () => {
    const unique = new Set(MONITOR_KEY_LIMITS);
    expect(unique.size).toBe(MONITOR_KEY_LIMITS.length);
  });

  it('should only contain non-empty strings', () => {
    for (const key of MONITOR_KEY_LIMITS) {
      expect(typeof key).toBe('string');
      expect(key.length).toBeGreaterThan(0);
    }
  });
});
