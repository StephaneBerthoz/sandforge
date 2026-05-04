import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseSforceLimitInfo, checkApiLimits } from './sforceLimitParser';

vi.mock('../../logger.js', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('parseSforceLimitInfo', () => {
  it('should return undefined when limitInfo is undefined', () => {
    expect(parseSforceLimitInfo(undefined)).toBeUndefined();
  });

  it('should return undefined when apiUsage is undefined', () => {
    expect(parseSforceLimitInfo({})).toBeUndefined();
  });

  it('should parse valid limit info', () => {
    const result = parseSforceLimitInfo({
      apiUsage: { used: 5000, limit: 100000 },
    });
    expect(result).toEqual({
      apiUsage: 5000,
      apiLimit: 100000,
      usagePercent: 5,
    });
  });

  it('should handle zero limit without division by zero', () => {
    const result = parseSforceLimitInfo({
      apiUsage: { used: 0, limit: 0 },
    });
    expect(result).toEqual({
      apiUsage: 0,
      apiLimit: 0,
      usagePercent: 0,
    });
  });

  it('should round usage percentage', () => {
    const result = parseSforceLimitInfo({
      apiUsage: { used: 333, limit: 1000 },
    });
    expect(result?.usagePercent).toBe(33);
  });

  it('should handle high usage', () => {
    const result = parseSforceLimitInfo({
      apiUsage: { used: 99500, limit: 100000 },
    });
    expect(result?.usagePercent).toBe(100);
  });
});

describe('checkApiLimits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return undefined for missing limitInfo', () => {
    expect(checkApiLimits(undefined, 'test')).toBeUndefined();
  });

  it('should return parsed info for normal usage', () => {
    const result = checkApiLimits({ apiUsage: { used: 100, limit: 100000 } }, 'test-operation');
    expect(result?.usagePercent).toBe(0);
  });

  it('should return parsed info at warning threshold', () => {
    const result = checkApiLimits({ apiUsage: { used: 80000, limit: 100000 } }, 'bulk-query');
    expect(result?.usagePercent).toBe(80);
  });

  it('should return parsed info at critical threshold', () => {
    const result = checkApiLimits({ apiUsage: { used: 96000, limit: 100000 } }, 'bulk-insert');
    expect(result?.usagePercent).toBe(96);
  });

  it('should accept custom thresholds', () => {
    const result = checkApiLimits({ apiUsage: { used: 50000, limit: 100000 } }, 'custom', 40, 60);
    expect(result?.usagePercent).toBe(50);
  });
});
