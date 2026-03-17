import { describe, it, expect } from 'vitest';

import {
  DEFAULT_BATCH_SIZES,
  DEFAULT_TIMEOUTS,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_GRAPPE_CONFIG,
  DEFAULT_MONITOR_CONFIG,
  MODULE_NAMES,
} from './defaults.js';
import type { ModuleName } from './defaults.js';

describe('DEFAULT_BATCH_SIZES', () => {
  it('should have all API modes defined', () => {
    expect(DEFAULT_BATCH_SIZES.rest).toBeDefined();
    expect(DEFAULT_BATCH_SIZES.bulk).toBeDefined();
    expect(DEFAULT_BATCH_SIZES.composite).toBeDefined();
    expect(DEFAULT_BATCH_SIZES.auto).toBeDefined();
  });

  it('should have all values as positive numbers', () => {
    for (const [key, value] of Object.entries(DEFAULT_BATCH_SIZES)) {
      expect(typeof value, `${key} should be a number`).toBe('number');
      expect(value, `${key} should be positive`).toBeGreaterThan(0);
    }
  });

  it('should have rest batch size of 200', () => {
    expect(DEFAULT_BATCH_SIZES.rest).toBe(200);
  });

  it('should have composite batch size of 25', () => {
    expect(DEFAULT_BATCH_SIZES.composite).toBe(25);
  });
});

describe('DEFAULT_TIMEOUTS', () => {
  it('should have all timeout values defined', () => {
    expect(DEFAULT_TIMEOUTS.connection).toBeDefined();
    expect(DEFAULT_TIMEOUTS.request).toBeDefined();
    expect(DEFAULT_TIMEOUTS.bulkJob).toBeDefined();
    expect(DEFAULT_TIMEOUTS.healthProbe).toBeDefined();
    expect(DEFAULT_TIMEOUTS.tokenRefresh).toBeDefined();
  });

  it('should have all values as positive numbers', () => {
    for (const [key, value] of Object.entries(DEFAULT_TIMEOUTS)) {
      expect(typeof value, `${key} should be a number`).toBe('number');
      expect(value, `${key} should be positive`).toBeGreaterThan(0);
    }
  });

  it('should have bulk job timeout greater than request timeout', () => {
    expect(DEFAULT_TIMEOUTS.bulkJob).toBeGreaterThan(DEFAULT_TIMEOUTS.request);
  });

  it('should have connection timeout of 30 seconds', () => {
    expect(DEFAULT_TIMEOUTS.connection).toBe(30_000);
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
    expect(DEFAULT_RETRY_CONFIG.maxDelay).toBeGreaterThan(
      DEFAULT_RETRY_CONFIG.initialDelay,
    );
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

  it('should have valid strategy value', () => {
    expect(DEFAULT_GRAPPE_CONFIG.strategy).toBe('by_volume');
  });

  it('should have checkpointing enabled by default', () => {
    expect(DEFAULT_GRAPPE_CONFIG.checkpointing).toBe(true);
  });

  it('should have valid back pressure configuration', () => {
    const bp = DEFAULT_GRAPPE_CONFIG.backPressure;
    expect(bp.enabled).toBe(true);
    expect(bp.maxQueueDepth).toBeGreaterThan(0);
    expect(bp.highWaterMark).toBeGreaterThan(bp.lowWaterMark);
    expect(bp.strategy).toBe('pause');
    expect(bp.monitoringInterval).toBeGreaterThan(0);
  });

  it('should have grappeSize less than autoActivateThreshold', () => {
    expect(DEFAULT_GRAPPE_CONFIG.grappeSize).toBeLessThan(
      DEFAULT_GRAPPE_CONFIG.autoActivateThreshold,
    );
  });
});

describe('DEFAULT_MONITOR_CONFIG', () => {
  it('should have all monitor values defined', () => {
    expect(DEFAULT_MONITOR_CONFIG.refreshInterval).toBeDefined();
    expect(DEFAULT_MONITOR_CONFIG.alertCooldownMinutes).toBeDefined();
    expect(DEFAULT_MONITOR_CONFIG.maxHistoryDays).toBeDefined();
  });

  it('should have all values as positive numbers', () => {
    for (const [key, value] of Object.entries(DEFAULT_MONITOR_CONFIG)) {
      expect(typeof value, `${key} should be a number`).toBe('number');
      expect(value, `${key} should be positive`).toBeGreaterThan(0);
    }
  });

  it('should have refresh interval of 60 seconds', () => {
    expect(DEFAULT_MONITOR_CONFIG.refreshInterval).toBe(60_000);
  });
});

describe('MODULE_NAMES', () => {
  it('should contain exactly 6 modules', () => {
    expect(MODULE_NAMES).toHaveLength(6);
  });

  it('should contain all expected module names', () => {
    const expected: ModuleName[] = [
      'seed', 'sync', 'monitor', 'compare', 'dataops', 'automation',
    ];

    for (const name of expected) {
      expect(MODULE_NAMES).toContain(name);
    }
  });

  it('should contain no duplicate entries', () => {
    const unique = new Set(MODULE_NAMES);
    expect(unique.size).toBe(MODULE_NAMES.length);
  });
});
