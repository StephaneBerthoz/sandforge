import { describe, it, expect } from 'vitest';
import {
  QUALITY_SCAN_DEFAULT_STALE_DAYS,
  QUALITY_SCAN_MAX_OBJECTS,
  QUALITY_SCAN_MAX_STALE_DAYS,
} from './data-quality.js';

describe('data-quality scan bounds', () => {
  it('starts from a staleness threshold the extension accepts', () => {
    expect(QUALITY_SCAN_DEFAULT_STALE_DAYS).toBeGreaterThanOrEqual(1);
    expect(QUALITY_SCAN_DEFAULT_STALE_DAYS).toBeLessThanOrEqual(QUALITY_SCAN_MAX_STALE_DAYS);
    expect(Number.isInteger(QUALITY_SCAN_DEFAULT_STALE_DAYS)).toBe(true);
  });

  it('lets a scan read more than one object, and a bounded number of them', () => {
    expect(QUALITY_SCAN_MAX_OBJECTS).toBeGreaterThan(1);
    expect(Number.isInteger(QUALITY_SCAN_MAX_OBJECTS)).toBe(true);
  });
});
