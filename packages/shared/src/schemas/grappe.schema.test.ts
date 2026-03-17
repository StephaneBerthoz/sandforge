import { describe, it, expect } from 'vitest';

import { grappeConfigSchema, backPressureConfigSchema } from './grappe.schema.js';

describe('grappeConfigSchema', () => {
  function createValidGrappeConfig(): Record<string, unknown> {
    return {
      enabled: true,
      strategy: 'round_robin',
      backPressure: {
        enabled: true,
        strategy: 'pause',
      },
    };
  }

  it('should parse a valid grappe config with defaults', () => {
    const result = grappeConfigSchema.parse(createValidGrappeConfig());

    expect(result.enabled).toBe(true);
    expect(result.autoActivateThreshold).toBe(10000);
    expect(result.maxWorkers).toBe(4);
    expect(result.grappeSize).toBe(5000);
    expect(result.strategy).toBe('round_robin');
    expect(result.checkpointing).toBe(true);
    expect(result.isolationLevel).toBe('per_grappe');
  });

  it('should apply back-pressure defaults', () => {
    const result = grappeConfigSchema.parse(createValidGrappeConfig());

    expect(result.backPressure.maxQueueDepth).toBe(3);
    expect(result.backPressure.highWaterMark).toBe(80);
    expect(result.backPressure.lowWaterMark).toBe(60);
    expect(result.backPressure.monitoringInterval).toBe(5000);
  });

  it('should preserve explicit values over defaults', () => {
    const result = grappeConfigSchema.parse({
      enabled: false,
      autoActivateThreshold: 50000,
      maxWorkers: 8,
      grappeSize: 2000,
      strategy: 'by_hash',
      backPressure: {
        enabled: true,
        maxQueueDepth: 10,
        highWaterMark: 90,
        lowWaterMark: 40,
        strategy: 'throttle',
        monitoringInterval: 1000,
      },
      checkpointing: false,
      isolationLevel: 'per_object',
    });

    expect(result.enabled).toBe(false);
    expect(result.autoActivateThreshold).toBe(50000);
    expect(result.maxWorkers).toBe(8);
    expect(result.grappeSize).toBe(2000);
    expect(result.strategy).toBe('by_hash');
    expect(result.checkpointing).toBe(false);
    expect(result.isolationLevel).toBe('per_object');
    expect(result.backPressure.maxQueueDepth).toBe(10);
    expect(result.backPressure.highWaterMark).toBe(90);
  });

  it('should accept all valid partition strategies', () => {
    const strategies = [
      'round_robin', 'by_record_type', 'by_parent',
      'by_date_range', 'by_hash', 'by_volume', 'dependency_aware',
    ] as const;

    for (const strategy of strategies) {
      const result = grappeConfigSchema.parse({ ...createValidGrappeConfig(), strategy });

      expect(result.strategy).toBe(strategy);
    }
  });

  it('should accept all valid isolation levels', () => {
    const levels = ['none', 'per_object', 'per_grappe'] as const;

    for (const isolationLevel of levels) {
      const result = grappeConfigSchema.parse({ ...createValidGrappeConfig(), isolationLevel });

      expect(result.isolationLevel).toBe(isolationLevel);
    }
  });

  it('should reject maxWorkers below 1', () => {
    expect(() =>
      grappeConfigSchema.parse({ ...createValidGrappeConfig(), maxWorkers: 0 }),
    ).toThrow();
  });

  it('should reject maxWorkers above 8', () => {
    expect(() =>
      grappeConfigSchema.parse({ ...createValidGrappeConfig(), maxWorkers: 9 }),
    ).toThrow();
  });

  it('should reject non-positive grappeSize', () => {
    expect(() =>
      grappeConfigSchema.parse({ ...createValidGrappeConfig(), grappeSize: 0 }),
    ).toThrow();
  });

  it('should reject non-positive autoActivateThreshold', () => {
    expect(() =>
      grappeConfigSchema.parse({ ...createValidGrappeConfig(), autoActivateThreshold: 0 }),
    ).toThrow();
  });

  it('should reject invalid strategy', () => {
    expect(() =>
      grappeConfigSchema.parse({ ...createValidGrappeConfig(), strategy: 'unknown' }),
    ).toThrow();
  });

  it('should reject missing required fields', () => {
    expect(() => grappeConfigSchema.parse({})).toThrow();
    expect(() => grappeConfigSchema.parse({ enabled: true })).toThrow();
  });
});

describe('backPressureConfigSchema', () => {
  it('should parse with defaults', () => {
    const result = backPressureConfigSchema.parse({
      enabled: true,
      strategy: 'pause',
    });

    expect(result.enabled).toBe(true);
    expect(result.maxQueueDepth).toBe(3);
    expect(result.highWaterMark).toBe(80);
    expect(result.lowWaterMark).toBe(60);
    expect(result.strategy).toBe('pause');
    expect(result.monitoringInterval).toBe(5000);
  });

  it('should accept all valid back-pressure strategies', () => {
    const strategies = ['pause', 'throttle', 'drop_priority'] as const;

    for (const strategy of strategies) {
      const result = backPressureConfigSchema.parse({
        enabled: false,
        strategy,
      });

      expect(result.strategy).toBe(strategy);
    }
  });

  it('should reject highWaterMark above 100', () => {
    expect(() =>
      backPressureConfigSchema.parse({
        enabled: true,
        strategy: 'pause',
        highWaterMark: 101,
      }),
    ).toThrow();
  });

  it('should reject negative lowWaterMark', () => {
    expect(() =>
      backPressureConfigSchema.parse({
        enabled: true,
        strategy: 'pause',
        lowWaterMark: -1,
      }),
    ).toThrow();
  });

  it('should reject non-positive maxQueueDepth', () => {
    expect(() =>
      backPressureConfigSchema.parse({
        enabled: true,
        strategy: 'pause',
        maxQueueDepth: 0,
      }),
    ).toThrow();
  });

  it('should reject non-positive monitoringInterval', () => {
    expect(() =>
      backPressureConfigSchema.parse({
        enabled: true,
        strategy: 'pause',
        monitoringInterval: 0,
      }),
    ).toThrow();
  });

  it('should accept boundary values for watermarks', () => {
    const result = backPressureConfigSchema.parse({
      enabled: true,
      strategy: 'throttle',
      highWaterMark: 100,
      lowWaterMark: 0,
    });

    expect(result.highWaterMark).toBe(100);
    expect(result.lowWaterMark).toBe(0);
  });
});

describe('backPressureConfigSchema refinement', () => {
  it('should reject lowWaterMark >= highWaterMark', () => {
    const result = backPressureConfigSchema.safeParse({
      enabled: true,
      maxQueueDepth: 3,
      highWaterMark: 10,
      lowWaterMark: 90,
      strategy: 'pause',
      monitoringInterval: 5000,
    });
    expect(result.success).toBe(false);
  });
  it('should accept valid watermark order', () => {
    const result = backPressureConfigSchema.safeParse({
      enabled: true,
      maxQueueDepth: 3,
      highWaterMark: 80,
      lowWaterMark: 60,
      strategy: 'pause',
      monitoringInterval: 5000,
    });
    expect(result.success).toBe(true);
  });
});
