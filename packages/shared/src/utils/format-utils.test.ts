import { describe, it, expect } from 'vitest';

import {
  formatNumber,
  formatDuration,
  formatFileSize,
  formatDurationSec,
  formatElapsed,
  formatSizeMB,
} from './format-utils.js';

describe('formatNumber', () => {
  it('should format small numbers without separators', () => {
    expect(formatNumber(0, 'en-US')).toBe('0');
    expect(formatNumber(999, 'en-US')).toBe('999');
  });

  it('should format thousands with locale grouping', () => {
    expect(formatNumber(1000, 'en-US')).toBe('1,000');
    expect(formatNumber(1_234_567, 'en-US')).toBe('1,234,567');
  });

  it('should format decimals', () => {
    expect(formatNumber(1234.56, 'en-US')).toBe('1,234.56');
  });

  it('should format negative numbers', () => {
    expect(formatNumber(-1000, 'en-US')).toBe('-1,000');
  });

  it('should return "0" for NaN', () => {
    expect(formatNumber(NaN)).toBe('0');
  });

  it('should return "0" for Infinity', () => {
    expect(formatNumber(Infinity)).toBe('0');
    expect(formatNumber(-Infinity)).toBe('0');
  });
});

describe('formatDuration', () => {
  it('should format hours and minutes', () => {
    expect(formatDuration(2 * 3_600_000 + 14 * 60_000)).toBe('2h 14min');
  });

  it('should format hours only', () => {
    expect(formatDuration(3_600_000)).toBe('1h');
  });

  it('should format minutes and seconds', () => {
    expect(formatDuration(3 * 60_000 + 30_000)).toBe('3min 30s');
  });

  it('should format minutes only', () => {
    expect(formatDuration(5 * 60_000)).toBe('5min');
  });

  it('should format seconds', () => {
    expect(formatDuration(3_000)).toBe('3s');
  });

  it('should format milliseconds', () => {
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('should return "0ms" for zero', () => {
    expect(formatDuration(0)).toBe('0ms');
  });

  it('should return "0ms" for NaN / non-finite', () => {
    expect(formatDuration(NaN)).toBe('0ms');
    expect(formatDuration(Infinity)).toBe('0ms');
  });

  it('should return "0ms" for negative values', () => {
    expect(formatDuration(-1000)).toBe('0ms');
  });
});

describe('formatFileSize', () => {
  it('should format bytes', () => {
    expect(formatFileSize(1)).toBe('1 B');
    expect(formatFileSize(500)).toBe('500 B');
  });

  it('should format kilobytes', () => {
    expect(formatFileSize(1024)).toBe('1 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
  });

  it('should format megabytes with one decimal', () => {
    expect(formatFileSize(1.2 * 1024 * 1024)).toBe('1.2 MB');
    expect(formatFileSize(10 * 1024 * 1024)).toBe('10 MB');
  });

  it('should format gigabytes', () => {
    expect(formatFileSize(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB');
  });

  it('should clamp very large values to terabytes', () => {
    expect(formatFileSize(1e18)).toMatch(/TB$/);
  });

  it('should return "0 B" for zero', () => {
    expect(formatFileSize(0)).toBe('0 B');
  });

  it('should return "0 B" for NaN / non-finite', () => {
    expect(formatFileSize(NaN)).toBe('0 B');
    expect(formatFileSize(Infinity)).toBe('0 B');
  });

  it('should return "0 B" for negative values', () => {
    expect(formatFileSize(-100)).toBe('0 B');
  });
});

describe('formatDurationSec', () => {
  it('should wrap formatDuration (seconds → ms)', () => {
    expect(formatDurationSec(3)).toBe('3s');
    expect(formatDurationSec(330)).toBe('5min 30s');
    expect(formatDurationSec(8_040)).toBe('2h 14min');
  });

  it('should return "0ms" for invalid values', () => {
    expect(formatDurationSec(0)).toBe('0ms');
    expect(formatDurationSec(-5)).toBe('0ms');
    expect(formatDurationSec(NaN)).toBe('0ms');
  });
});

describe('formatElapsed', () => {
  it('should format as MM:SS', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(5)).toBe('00:05');
    expect(formatElapsed(125)).toBe('02:05');
  });

  it('should include hours when present', () => {
    expect(formatElapsed(3_600)).toBe('1:00:00');
    expect(formatElapsed(5_405)).toBe('1:30:05');
  });

  it('should truncate fractional seconds', () => {
    expect(formatElapsed(125.9)).toBe('02:05');
  });

  it('should return "00:00" for NaN / non-finite / negative', () => {
    expect(formatElapsed(NaN)).toBe('00:00');
    expect(formatElapsed(Infinity)).toBe('00:00');
    expect(formatElapsed(-10)).toBe('00:00');
  });
});

describe('formatSizeMB', () => {
  it('should format sub-megabyte sizes as KB', () => {
    expect(formatSizeMB(0.5)).toBe('512 KB');
  });

  it('should format megabytes with one decimal', () => {
    expect(formatSizeMB(1)).toBe('1.0 MB');
    expect(formatSizeMB(3.5)).toBe('3.5 MB');
  });

  it('should format gigabytes above 1024 MB', () => {
    expect(formatSizeMB(1024)).toBe('1.0 GB');
    expect(formatSizeMB(1228.8)).toBe('1.2 GB');
  });

  it('should format zero as "0 KB" (sub-megabyte branch)', () => {
    expect(formatSizeMB(0)).toBe('0 KB');
  });

  it('should return "0 MB" for NaN / negative', () => {
    expect(formatSizeMB(NaN)).toBe('0 MB');
    expect(formatSizeMB(-1)).toBe('0 MB');
  });
});
