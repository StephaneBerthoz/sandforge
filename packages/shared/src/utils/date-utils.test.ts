import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  formatDuration,
  nowISO,
  timeAgo,
  isWithinMinutes,
  estimateCompletion,
} from './date-utils.js';

describe('formatDuration', () => {
  it('should format milliseconds', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('should format seconds', () => {
    expect(formatDuration(1000)).toBe('1.0s');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(59_999)).toBe('60.0s');
  });

  it('should format minutes and seconds', () => {
    expect(formatDuration(60_000)).toBe('1m 0s');
    expect(formatDuration(90_000)).toBe('1m 30s');
    expect(formatDuration(150_000)).toBe('2m 30s');
    expect(formatDuration(3_599_999)).toBe('59m 59s');
  });

  it('should format hours and minutes', () => {
    expect(formatDuration(3_600_000)).toBe('1h 0m');
    expect(formatDuration(5_400_000)).toBe('1h 30m');
    expect(formatDuration(7_200_000)).toBe('2h 0m');
  });
});

describe('nowISO', () => {
  it('should return a valid ISO string', () => {
    const result = nowISO();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('should return a date close to the current time', () => {
    const before = Date.now();
    const iso = nowISO();
    const after = Date.now();
    const isoTime = new Date(iso).getTime();
    expect(isoTime).toBeGreaterThanOrEqual(before);
    expect(isoTime).toBeLessThanOrEqual(after);
  });
});

describe('timeAgo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-20T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return "just now" for less than 60 seconds', () => {
    expect(timeAgo('2026-02-20T11:59:30.000Z')).toBe('just now');
    expect(timeAgo('2026-02-20T11:59:59.999Z')).toBe('just now');
  });

  it('should return minutes ago', () => {
    expect(timeAgo('2026-02-20T11:59:00.000Z')).toBe('1 minute ago');
    expect(timeAgo('2026-02-20T11:55:00.000Z')).toBe('5 minutes ago');
    expect(timeAgo('2026-02-20T11:30:00.000Z')).toBe('30 minutes ago');
  });

  it('should return hours ago', () => {
    expect(timeAgo('2026-02-20T11:00:00.000Z')).toBe('1 hour ago');
    expect(timeAgo('2026-02-20T09:00:00.000Z')).toBe('3 hours ago');
  });

  it('should return days ago', () => {
    expect(timeAgo('2026-02-19T12:00:00.000Z')).toBe('1 day ago');
    expect(timeAgo('2026-02-17T12:00:00.000Z')).toBe('3 days ago');
  });

  it('should return "unknown" for an unparseable date', () => {
    expect(timeAgo('garbage')).toBe('unknown');
    expect(timeAgo('')).toBe('unknown');
  });
});

describe('isWithinMinutes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-20T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return true for dates within the time window', () => {
    expect(isWithinMinutes('2026-02-20T11:55:00.000Z', 5)).toBe(true);
    expect(isWithinMinutes('2026-02-20T11:59:59.000Z', 5)).toBe(true);
  });

  it('should return true at the exact boundary', () => {
    expect(isWithinMinutes('2026-02-20T11:55:00.000Z', 5)).toBe(true);
  });

  it('should return false for dates outside the time window', () => {
    expect(isWithinMinutes('2026-02-20T11:54:59.000Z', 5)).toBe(false);
    expect(isWithinMinutes('2026-02-20T10:00:00.000Z', 5)).toBe(false);
  });

  it('should handle large minute values', () => {
    expect(isWithinMinutes('2026-02-19T12:00:00.000Z', 1440)).toBe(true);
    expect(isWithinMinutes('2026-02-19T11:59:59.000Z', 1440)).toBe(false);
  });
});

describe('estimateCompletion', () => {
  it('should estimate remaining time based on current rate', () => {
    // 50 of 100 done in 10s => 10s remaining
    expect(estimateCompletion(50, 100, 10_000)).toBe(10_000);
  });

  it('should estimate for partially complete work', () => {
    // 25 of 100 done in 5s => 15s remaining
    expect(estimateCompletion(25, 100, 5_000)).toBe(15_000);
  });

  it('should return 0 when all work is done', () => {
    expect(estimateCompletion(100, 100, 5_000)).toBe(0);
  });

  it('should return undefined when no records processed', () => {
    expect(estimateCompletion(0, 100, 5_000)).toBeUndefined();
  });

  it('should return undefined when total is 0', () => {
    expect(estimateCompletion(0, 0, 5_000)).toBeUndefined();
  });

  it('should return undefined when no time has elapsed', () => {
    expect(estimateCompletion(50, 100, 0)).toBeUndefined();
  });

  it('should return 0 when processed exceeds total', () => {
    expect(estimateCompletion(150, 100, 5_000)).toBe(0);
  });
});
