import { describe, it, expect } from 'vitest';
import { MONITOR_PERIOD_MAP, MONITOR_KEY_LIMITS } from './monitor.js';

describe('MONITOR_PERIOD_MAP', () => {
  it('maps 1h to 3600000 ms', () => {
    expect(MONITOR_PERIOD_MAP['1h']).toBe(3_600_000);
  });

  it('maps 6h to 21600000 ms', () => {
    expect(MONITOR_PERIOD_MAP['6h']).toBe(21_600_000);
  });

  it('maps 24h to 86400000 ms', () => {
    expect(MONITOR_PERIOD_MAP['24h']).toBe(86_400_000);
  });

  it('maps 7d to 604800000 ms', () => {
    expect(MONITOR_PERIOD_MAP['7d']).toBe(604_800_000);
  });

  it('returns undefined for unknown periods', () => {
    expect(MONITOR_PERIOD_MAP['30d']).toBeUndefined();
  });
});

describe('MONITOR_KEY_LIMITS', () => {
  it('contains the expected limit names', () => {
    expect(MONITOR_KEY_LIMITS).toEqual([
      'DailyApiRequests',
      'DataStorageMB',
      'DailySoqlQueries',
      'DailyDmlStatements',
      'DailyAsyncApexExecutions',
    ]);
  });

  it('has exactly 5 entries', () => {
    expect(MONITOR_KEY_LIMITS).toHaveLength(5);
  });
});
