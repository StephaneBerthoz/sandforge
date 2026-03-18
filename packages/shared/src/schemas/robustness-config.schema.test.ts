import { describe, it, expect } from 'vitest';
import {
  RobustnessConfigSchema,
  DEFAULT_ROBUSTNESS_CONFIG,
} from './robustness-config.schema';

describe('RobustnessConfigSchema', () => {
  describe('default config', () => {
    it('should produce valid defaults from empty object', () => {
      const result = RobustnessConfigSchema.parse({});

      expect(result.timeouts.describeGlobal).toBe(30_000);
      expect(result.timeouts.describe).toBe(15_000);
      expect(result.timeouts.crudBatch).toBe(60_000);
      expect(result.timeouts.bulkJob).toBe(300_000);

      expect(result.retry.maxRetries).toBe(3);
      expect(result.retry.initialDelay).toBe(1000);
      expect(result.retry.maxDelay).toBe(30_000);
      expect(result.retry.backoffMultiplier).toBe(2);

      expect(result.bulk.threshold).toBe(200);
      expect(result.bulk.pollIntervalMs).toBe(5000);
      expect(result.bulk.maxConcurrentJobs).toBe(5);
    });

    it('should export DEFAULT_ROBUSTNESS_CONFIG with all defaults', () => {
      expect(DEFAULT_ROBUSTNESS_CONFIG.timeouts.describeGlobal).toBe(30_000);
      expect(DEFAULT_ROBUSTNESS_CONFIG.retry.maxRetries).toBe(3);
      expect(DEFAULT_ROBUSTNESS_CONFIG.bulk.threshold).toBe(200);
    });
  });

  describe('partial config', () => {
    it('should merge partial values with defaults', () => {
      const result = RobustnessConfigSchema.parse({
        timeouts: { describeGlobal: 60_000 },
        retry: { maxRetries: 5 },
      });

      expect(result.timeouts.describeGlobal).toBe(60_000);
      expect(result.timeouts.describe).toBe(15_000);
      expect(result.retry.maxRetries).toBe(5);
      expect(result.retry.initialDelay).toBe(1000);
      expect(result.bulk.threshold).toBe(200);
    });

    it('should accept only bulk config', () => {
      const result = RobustnessConfigSchema.parse({
        bulk: { threshold: 500, maxConcurrentJobs: 10 },
      });

      expect(result.bulk.threshold).toBe(500);
      expect(result.bulk.maxConcurrentJobs).toBe(10);
      expect(result.bulk.pollIntervalMs).toBe(5000);
    });
  });

  describe('validation - timeouts', () => {
    it('should reject timeout below minimum', () => {
      expect(() =>
        RobustnessConfigSchema.parse({
          timeouts: { describeGlobal: 1000 },
        }),
      ).toThrow();
    });

    it('should reject timeout above maximum', () => {
      expect(() =>
        RobustnessConfigSchema.parse({
          timeouts: { describeGlobal: 200_000 },
        }),
      ).toThrow();
    });

    it('should reject zero timeout', () => {
      expect(() =>
        RobustnessConfigSchema.parse({
          timeouts: { crudBatch: 0 },
        }),
      ).toThrow();
    });

    it('should reject negative timeout', () => {
      expect(() =>
        RobustnessConfigSchema.parse({
          timeouts: { describe: -1000 },
        }),
      ).toThrow();
    });
  });

  describe('validation - retry', () => {
    it('should accept maxRetries of 0 (no retries)', () => {
      const result = RobustnessConfigSchema.parse({
        retry: { maxRetries: 0 },
      });

      expect(result.retry.maxRetries).toBe(0);
    });

    it('should reject maxRetries above 10', () => {
      expect(() =>
        RobustnessConfigSchema.parse({
          retry: { maxRetries: 20 },
        }),
      ).toThrow();
    });

    it('should reject initialDelay below 100ms', () => {
      expect(() =>
        RobustnessConfigSchema.parse({
          retry: { initialDelay: 50 },
        }),
      ).toThrow();
    });

    it('should reject backoffMultiplier below 1', () => {
      expect(() =>
        RobustnessConfigSchema.parse({
          retry: { backoffMultiplier: 0.5 },
        }),
      ).toThrow();
    });

    it('should reject backoffMultiplier above 5', () => {
      expect(() =>
        RobustnessConfigSchema.parse({
          retry: { backoffMultiplier: 10 },
        }),
      ).toThrow();
    });
  });

  describe('validation - bulk', () => {
    it('should reject threshold of 0', () => {
      expect(() =>
        RobustnessConfigSchema.parse({
          bulk: { threshold: 0 },
        }),
      ).toThrow();
    });

    it('should reject threshold above 10000', () => {
      expect(() =>
        RobustnessConfigSchema.parse({
          bulk: { threshold: 50_000 },
        }),
      ).toThrow();
    });

    it('should reject pollIntervalMs below 1000', () => {
      expect(() =>
        RobustnessConfigSchema.parse({
          bulk: { pollIntervalMs: 100 },
        }),
      ).toThrow();
    });

    it('should accept maxConcurrentJobs of 1', () => {
      const result = RobustnessConfigSchema.parse({
        bulk: { maxConcurrentJobs: 1 },
      });

      expect(result.bulk.maxConcurrentJobs).toBe(1);
    });
  });

  describe('type safety', () => {
    it('should reject non-number values', () => {
      expect(() =>
        RobustnessConfigSchema.parse({
          timeouts: { describeGlobal: 'thirty seconds' },
        }),
      ).toThrow();
    });

    it('should reject non-integer for maxRetries', () => {
      expect(() =>
        RobustnessConfigSchema.parse({
          retry: { maxRetries: 2.5 },
        }),
      ).toThrow();
    });
  });
});
