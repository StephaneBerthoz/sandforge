import { describe, it, expect } from 'vitest';

import {
  DEFAULT_BATCH_SIZES,
  DEFAULT_TIMEOUTS,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_GRAPPE_CONFIG,
  DEFAULT_MONITOR_CONFIG,
  MODULE_NAMES,
} from './defaults.js';

describe('DEFAULT_BATCH_SIZES', () => {
  it('should have all API modes defined with positive values', () => {
    for (const mode of ['rest', 'bulk', 'composite', 'auto'] as const) {
      expect(DEFAULT_BATCH_SIZES[mode], `${mode} should be defined`).toBeDefined();
    }
    for (const [key, value] of Object.entries(DEFAULT_BATCH_SIZES)) {
      expect(typeof value, `${key} should be a number`).toBe('number');
      expect(value, `${key} should be positive`).toBeGreaterThan(0);
    }
  });
});

describe('DEFAULT_TIMEOUTS', () => {
  it('should have all timeout values defined and positive', () => {
    for (const key of [
      'connection',
      'request',
      'bulkJob',
      'healthProbe',
      'tokenRefresh',
    ] as const) {
      expect(DEFAULT_TIMEOUTS[key], `${key} should be defined`).toBeDefined();
    }
    for (const [key, value] of Object.entries(DEFAULT_TIMEOUTS)) {
      expect(typeof value, `${key} should be a number`).toBe('number');
      expect(value, `${key} should be positive`).toBeGreaterThan(0);
    }
  });

  it('should have bulk job timeout greater than request timeout', () => {
    expect(DEFAULT_TIMEOUTS.bulkJob).toBeGreaterThan(DEFAULT_TIMEOUTS.request);
  });
});

describe('DEFAULT_RETRY_CONFIG', () => {
  it('should have all retry values defined', () => {
    expect(DEFAULT_RETRY_CONFIG.maxRetries).toBeDefined();
    expect(DEFAULT_RETRY_CONFIG.initialDelay).toBeDefined();
    expect(DEFAULT_RETRY_CONFIG.maxDelay).toBeDefined();
    expect(DEFAULT_RETRY_CONFIG.backoffMultiplier).toBeDefined();
  });

  it('should have maxRetries as a positive integer', () => {
    expect(DEFAULT_RETRY_CONFIG.maxRetries).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_RETRY_CONFIG.maxRetries)).toBe(true);
  });

  it('should have maxDelay greater than initialDelay', () => {
    expect(DEFAULT_RETRY_CONFIG.maxDelay).toBeGreaterThan(DEFAULT_RETRY_CONFIG.initialDelay);
  });

  it('should have backoff multiplier greater than 1', () => {
    expect(DEFAULT_RETRY_CONFIG.backoffMultiplier).toBeGreaterThan(1);
  });
});

describe('DEFAULT_GRAPPE_CONFIG', () => {
  it('should have all grappe values defined', () => {
    expect(DEFAULT_GRAPPE_CONFIG.autoActivateThreshold).toBeDefined();
    expect(DEFAULT_GRAPPE_CONFIG.maxWorkers).toBeDefined();
    expect(DEFAULT_GRAPPE_CONFIG.grappeSize).toBeDefined();
    expect(DEFAULT_GRAPPE_CONFIG.strategy).toBeDefined();
    expect(DEFAULT_GRAPPE_CONFIG.checkpointing).toBeDefined();
    expect(DEFAULT_GRAPPE_CONFIG.isolationLevel).toBeDefined();
  });

  it('should have coherent back pressure watermarks', () => {
    const bp = DEFAULT_GRAPPE_CONFIG.backPressure;
    expect(bp.maxQueueDepth).toBeGreaterThan(0);
    expect(bp.highWaterMark).toBeGreaterThan(bp.lowWaterMark);
    expect(bp.monitoringInterval).toBeGreaterThan(0);
  });

  it('should have grappeSize less than autoActivateThreshold', () => {
    expect(DEFAULT_GRAPPE_CONFIG.grappeSize).toBeLessThan(
      DEFAULT_GRAPPE_CONFIG.autoActivateThreshold,
    );
  });
});

describe('DEFAULT_MONITOR_CONFIG', () => {
  it('should have all monitor values defined and positive', () => {
    expect(DEFAULT_MONITOR_CONFIG.refreshInterval).toBeDefined();
    expect(DEFAULT_MONITOR_CONFIG.alertCooldownMinutes).toBeDefined();
    expect(DEFAULT_MONITOR_CONFIG.maxHistoryDays).toBeDefined();
    for (const [key, value] of Object.entries(DEFAULT_MONITOR_CONFIG)) {
      expect(typeof value, `${key} should be a number`).toBe('number');
      expect(value, `${key} should be positive`).toBeGreaterThan(0);
    }
  });
});

describe('MODULE_NAMES', () => {
  it('should contain no duplicate entries', () => {
    const unique = new Set(MODULE_NAMES);
    expect(unique.size).toBe(MODULE_NAMES.length);
  });
});
