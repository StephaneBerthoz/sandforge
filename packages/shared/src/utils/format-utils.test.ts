import { describe, it, expect } from 'vitest';

import {
  formatBytes,
  formatNumber,
  formatPercent,
  formatRate,
  progressBar,
} from './format-utils.js';

describe('formatBytes', () => {
  it('should format 0 bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('should format bytes', () => {
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('should format kilobytes', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('should format megabytes', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(10 * 1024 * 1024)).toBe('10.0 MB');
  });

  it('should format gigabytes', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
  });

  it('should format terabytes', () => {
    expect(formatBytes(1024 * 1024 * 1024 * 1024)).toBe('1.0 TB');
  });
});

describe('formatBytes edge cases', () => {
  it('should handle negative values', () => {
    expect(formatBytes(-1024)).toBe('-1.0 KB');
  });
  it('should handle very large values without crashing', () => {
    const result = formatBytes(1e18);
    expect(result).toMatch(/TB$/);
  });
  it('should return N/A for NaN', () => {
    expect(formatBytes(NaN)).toBe('N/A');
  });
  it('should return N/A for Infinity', () => {
    expect(formatBytes(Infinity)).toBe('N/A');
    expect(formatBytes(-Infinity)).toBe('N/A');
  });
});

describe('formatNumber', () => {
  it('should format small numbers without separators', () => {
    expect(formatNumber(0)).toBe('0');
    expect(formatNumber(999)).toBe('999');
  });

  it('should format thousands with commas', () => {
    expect(formatNumber(1000)).toBe('1,000');
    expect(formatNumber(1_234_567)).toBe('1,234,567');
  });

  it('should format negative numbers', () => {
    expect(formatNumber(-1000)).toBe('-1,000');
  });
});

describe('formatPercent', () => {
  it('should format with default 1 decimal place', () => {
    expect(formatPercent(50)).toBe('50.0%');
    expect(formatPercent(99.5)).toBe('99.5%');
  });

  it('should format with specified decimal places', () => {
    expect(formatPercent(33.333, 2)).toBe('33.33%');
    expect(formatPercent(100, 0)).toBe('100%');
  });

  it('should format 0 percent', () => {
    expect(formatPercent(0)).toBe('0.0%');
  });
});

describe('formatRate', () => {
  it('should format low rates as whole numbers', () => {
    expect(formatRate(50)).toBe('50/s');
    expect(formatRate(999)).toBe('999/s');
  });

  it('should round low rates', () => {
    expect(formatRate(50.7)).toBe('51/s');
  });

  it('should format high rates with K suffix', () => {
    expect(formatRate(1000)).toBe('1.0K/s');
    expect(formatRate(2500)).toBe('2.5K/s');
    expect(formatRate(15000)).toBe('15.0K/s');
  });
});

describe('progressBar', () => {
  it('should show empty bar at 0%', () => {
    const bar = progressBar(0, 10);
    expect(bar).toBe('\u2591'.repeat(10));
  });

  it('should show full bar at 100%', () => {
    const bar = progressBar(100, 10);
    expect(bar).toBe('\u2588'.repeat(10));
  });

  it('should show half-filled bar at 50%', () => {
    const bar = progressBar(50, 10);
    expect(bar).toBe('\u2588'.repeat(5) + '\u2591'.repeat(5));
  });

  it('should use default width of 20', () => {
    const bar = progressBar(50);
    expect(bar).toHaveLength(20);
    expect(bar).toBe('\u2588'.repeat(10) + '\u2591'.repeat(10));
  });

  it('should handle 25% correctly', () => {
    const bar = progressBar(25, 20);
    expect(bar).toBe('\u2588'.repeat(5) + '\u2591'.repeat(15));
  });
});

describe('progressBar edge cases', () => {
  it('should clamp values above 100% to a full bar', () => {
    const bar = progressBar(150, 10);
    expect(bar).toBe('\u2588'.repeat(10));
  });

  it('should clamp negative values to an empty bar', () => {
    const bar = progressBar(-20, 10);
    expect(bar).toBe('\u2591'.repeat(10));
  });

  it('should treat non-finite values as 0%', () => {
    const bar = progressBar(NaN, 10);
    expect(bar).toBe('\u2591'.repeat(10));
  });
});
