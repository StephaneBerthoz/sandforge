import { describe, it, expect } from 'vitest';
import { transformLimitsResponse } from './transformLimitsResponse.js';
import type { RawLimitsResponse } from './transformLimitsResponse.js';

describe('transformLimitsResponse', () => {
  it('transforms raw limits into ApiLimit array', () => {
    const raw: RawLimitsResponse = {
      DailyApiRequests: { Max: 100000, Remaining: 80000 },
      DataStorageMB: { Max: 500, Remaining: 400 },
    };

    const result = transformLimitsResponse(raw);

    expect(result).toEqual([
      { name: 'DailyApiRequests', max: 100000, remaining: 80000, usedPercent: 20 },
      { name: 'DataStorageMB', max: 500, remaining: 400, usedPercent: 20 },
    ]);
  });

  it('computes usedPercent as rounded integer', () => {
    const raw: RawLimitsResponse = {
      SomeLimit: { Max: 3, Remaining: 1 },
    };

    const result = transformLimitsResponse(raw);

    expect(result[0].usedPercent).toBe(67); // Math.round(66.666...) = 67
  });

  it('returns 0 usedPercent when Max is 0', () => {
    const raw: RawLimitsResponse = {
      ZeroLimit: { Max: 0, Remaining: 0 },
    };

    const result = transformLimitsResponse(raw);

    expect(result[0]).toEqual({
      name: 'ZeroLimit',
      max: 0,
      remaining: 0,
      usedPercent: 0,
    });
  });

  it('returns 100 usedPercent when fully consumed', () => {
    const raw: RawLimitsResponse = {
      FullLimit: { Max: 1000, Remaining: 0 },
    };

    const result = transformLimitsResponse(raw);

    expect(result[0].usedPercent).toBe(100);
  });

  it('returns empty array for empty input', () => {
    const result = transformLimitsResponse({});

    expect(result).toEqual([]);
  });
});
