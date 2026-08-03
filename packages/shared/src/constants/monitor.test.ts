import { describe, it, expect } from 'vitest';
import { MONITOR_PERIOD_MAP, MONITOR_KEY_LIMITS } from './monitor.js';

describe('MONITOR_PERIOD_MAP', () => {
  it('should have all expected periods with positive durations', () => {
    for (const period of ['1h', '6h', '24h', '7d'] as const) {
      expect(MONITOR_PERIOD_MAP[period], `${period} should be defined`).toBeDefined();
      expect(MONITOR_PERIOD_MAP[period], `${period} should be positive`).toBeGreaterThan(0);
    }
  });

  it('should have durations coherent with each other (6h = 6 x 1h, 24h = 24 x 1h, 7d = 7 x 24h)', () => {
    expect(MONITOR_PERIOD_MAP['6h']).toBe(6 * MONITOR_PERIOD_MAP['1h']);
    expect(MONITOR_PERIOD_MAP['24h']).toBe(24 * MONITOR_PERIOD_MAP['1h']);
    expect(MONITOR_PERIOD_MAP['7d']).toBe(7 * MONITOR_PERIOD_MAP['24h']);
  });

  it('returns undefined for unknown periods', () => {
    expect(MONITOR_PERIOD_MAP['30d']).toBeUndefined();
  });
});

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
