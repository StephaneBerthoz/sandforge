import { describe, it, expect, vi } from 'vitest';
import { HealthCheck } from './HealthCheck';
import type { HealthSignal, HealthSignalProvider } from './HealthCheck';

function createSignal(overrides?: Partial<HealthSignal>): HealthSignal {
  return {
    name: 'test',
    status: 'ok',
    score: 100,
    message: 'All clear',
    ...overrides,
  };
}

describe('HealthCheck', () => {
  describe('computeHealth', () => {
    it('should aggregate signals into an OrgHealthStatus', async () => {
      const providers: HealthSignalProvider[] = [
        vi.fn().mockResolvedValue(createSignal({ name: 'apiLimits', score: 90 })),
        vi.fn().mockResolvedValue(createSignal({ name: 'storage', score: 85 })),
      ];

      const health = new HealthCheck(providers);
      const result = await health.computeHealth('org-1');

      expect(result.orgId).toBe('org-1');
      expect(result.overall).toBe('healthy');
      expect(result.lastChecked).toBeDefined();
    });

    it('should reflect degraded status when average score is between 50 and 80', async () => {
      const providers: HealthSignalProvider[] = [
        vi.fn().mockResolvedValue(createSignal({ name: 'apiLimits', score: 60, status: 'warning' })),
        vi.fn().mockResolvedValue(createSignal({ name: 'storage', score: 70, status: 'ok' })),
      ];

      const health = new HealthCheck(providers);
      const result = await health.computeHealth('org-1');

      expect(result.overall).toBe('degraded');
    });

    it('should reflect critical status when average score is below 50', async () => {
      const providers: HealthSignalProvider[] = [
        vi.fn().mockResolvedValue(createSignal({ name: 'apiLimits', score: 20, status: 'critical' })),
        vi.fn().mockResolvedValue(createSignal({ name: 'storage', score: 30, status: 'critical' })),
      ];

      const health = new HealthCheck(providers);
      const result = await health.computeHealth('org-1');

      expect(result.overall).toBe('critical');
    });

    it('should map apiLimits signal status to apiLimitsStatus', async () => {
      const providers: HealthSignalProvider[] = [
        vi.fn().mockResolvedValue(createSignal({ name: 'apiLimits', score: 60, status: 'warning' })),
      ];

      const health = new HealthCheck(providers);
      const result = await health.computeHealth('org-1');

      expect(result.apiLimitsStatus).toBe('warning');
    });

    it('should map storage signal status to storageStatus', async () => {
      const providers: HealthSignalProvider[] = [
        vi.fn().mockResolvedValue(createSignal({ name: 'storage', score: 30, status: 'critical' })),
      ];

      const health = new HealthCheck(providers);
      const result = await health.computeHealth('org-1');

      expect(result.storageStatus).toBe('critical');
    });

    it('should default to ok when signal is not provided', async () => {
      const providers: HealthSignalProvider[] = [
        vi.fn().mockResolvedValue(createSignal({ name: 'other', score: 100 })),
      ];

      const health = new HealthCheck(providers);
      const result = await health.computeHealth('org-1');

      expect(result.apiLimitsStatus).toBe('ok');
      expect(result.storageStatus).toBe('ok');
    });

    it('should handle empty providers list', async () => {
      const health = new HealthCheck([]);
      const result = await health.computeHealth('org-1');

      expect(result.overall).toBe('healthy');
    });
  });

  describe('computeScore', () => {
    it('should return 100 for empty signals', () => {
      expect(HealthCheck.computeScore([])).toBe(100);
    });

    it('should return the average score', () => {
      const signals = [
        createSignal({ score: 80 }),
        createSignal({ score: 60 }),
      ];
      expect(HealthCheck.computeScore(signals)).toBe(70);
    });

    it('should round the result', () => {
      const signals = [
        createSignal({ score: 33 }),
        createSignal({ score: 33 }),
        createSignal({ score: 34 }),
      ];
      expect(HealthCheck.computeScore(signals)).toBe(33);
    });

    it('should handle a single signal', () => {
      expect(HealthCheck.computeScore([createSignal({ score: 75 })])).toBe(75);
    });

    it('should handle all-zero scores', () => {
      const signals = [
        createSignal({ score: 0 }),
        createSignal({ score: 0 }),
      ];
      expect(HealthCheck.computeScore(signals)).toBe(0);
    });
  });

  describe('statusFromScore', () => {
    it('should return healthy for scores >= 80', () => {
      expect(HealthCheck.statusFromScore(80)).toBe('healthy');
      expect(HealthCheck.statusFromScore(100)).toBe('healthy');
      expect(HealthCheck.statusFromScore(95)).toBe('healthy');
    });

    it('should return degraded for scores >= 50 and < 80', () => {
      expect(HealthCheck.statusFromScore(50)).toBe('degraded');
      expect(HealthCheck.statusFromScore(79)).toBe('degraded');
      expect(HealthCheck.statusFromScore(65)).toBe('degraded');
    });

    it('should return critical for scores < 50', () => {
      expect(HealthCheck.statusFromScore(49)).toBe('critical');
      expect(HealthCheck.statusFromScore(0)).toBe('critical');
      expect(HealthCheck.statusFromScore(25)).toBe('critical');
    });
  });
});
