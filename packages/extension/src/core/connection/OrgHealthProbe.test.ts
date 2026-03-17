import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OrgHealthProbe } from './OrgHealthProbe';
import type { HealthEvent, HealthCheckExecutor } from './OrgHealthProbe';

describe('OrgHealthProbe', () => {
  let probe: OrgHealthProbe;

  beforeEach(() => {
    vi.useFakeTimers();
    probe = new OrgHealthProbe();
  });

  afterEach(() => {
    probe.dispose();
    vi.useRealTimers();
  });

  describe('getHealth', () => {
    it('should return unknown status for untracked org', () => {
      const health = probe.getHealth('org-1');
      expect(health.status).toBe('unknown');
      expect(health.orgId).toBe('org-1');
    });
  });

  describe('check', () => {
    it('should mark org as healthy on successful check', async () => {
      const executor: HealthCheckExecutor = vi.fn().mockResolvedValue({ latencyMs: 150 });
      probe.setExecutor(executor);

      const health = await probe.check('org-1');

      expect(health.status).toBe('healthy');
      expect(health.latencyMs).toBe(150);
      expect(health.consecutiveFailures).toBe(0);
      expect(health.consecutiveSuccesses).toBe(1);
    });

    it('should mark org as degraded on first failure', async () => {
      const executor: HealthCheckExecutor = vi.fn().mockRejectedValue(new Error('timeout'));
      probe.setExecutor(executor);

      const health = await probe.check('org-1');

      expect(health.status).toBe('degraded');
      expect(health.consecutiveFailures).toBe(1);
    });

    it('should mark org as unreachable after 3 consecutive failures', async () => {
      const executor: HealthCheckExecutor = vi.fn().mockRejectedValue(new Error('timeout'));
      probe.setExecutor(executor);

      await probe.check('org-1');
      await probe.check('org-1');
      const health = await probe.check('org-1');

      expect(health.status).toBe('unreachable');
      expect(health.consecutiveFailures).toBe(3);
    });

    it('should reset failure count on success', async () => {
      const executor: HealthCheckExecutor = vi.fn()
        .mockRejectedValueOnce(new Error('timeout'))
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce({ latencyMs: 100 });
      probe.setExecutor(executor);

      await probe.check('org-1');
      await probe.check('org-1');
      const health = await probe.check('org-1');

      expect(health.status).toBe('healthy');
      expect(health.consecutiveFailures).toBe(0);
      expect(health.consecutiveSuccesses).toBe(1);
    });

    it('should return unknown when no executor is set', async () => {
      const health = await probe.check('org-1');
      expect(health.status).toBe('unknown');
    });
  });

  describe('events', () => {
    it('should emit checkCompleted on successful check', async () => {
      const executor: HealthCheckExecutor = vi.fn().mockResolvedValue({ latencyMs: 100 });
      probe.setExecutor(executor);

      const events: HealthEvent[] = [];
      probe.onEvent((e) => events.push(e));

      await probe.check('org-1');

      const completed = events.find((e) => e.type === 'checkCompleted');
      expect(completed).toBeDefined();
      expect(completed?.orgId).toBe('org-1');
    });

    it('should emit checkFailed on failed check', async () => {
      const executor: HealthCheckExecutor = vi.fn().mockRejectedValue(new Error('fail'));
      probe.setExecutor(executor);

      const events: HealthEvent[] = [];
      probe.onEvent((e) => events.push(e));

      await probe.check('org-1');

      const failed = events.find((e) => e.type === 'checkFailed');
      expect(failed).toBeDefined();
    });

    it('should emit statusChanged when status transitions', async () => {
      const executor: HealthCheckExecutor = vi.fn().mockResolvedValue({ latencyMs: 100 });
      probe.setExecutor(executor);

      const events: HealthEvent[] = [];
      probe.onEvent((e) => events.push(e));

      await probe.check('org-1');

      const statusChanged = events.find((e) => e.type === 'statusChanged');
      expect(statusChanged).toBeDefined();
      expect(statusChanged?.previousStatus).toBe('unknown');
      expect(statusChanged?.health.status).toBe('healthy');
    });

    it('should not emit statusChanged when status stays the same', async () => {
      const executor: HealthCheckExecutor = vi.fn().mockResolvedValue({ latencyMs: 100 });
      probe.setExecutor(executor);

      await probe.check('org-1'); // unknown -> healthy

      const events: HealthEvent[] = [];
      probe.onEvent((e) => events.push(e));

      await probe.check('org-1'); // healthy -> healthy

      const statusChanged = events.filter((e) => e.type === 'statusChanged');
      expect(statusChanged).toHaveLength(0);
    });

    it('should support removing listeners', async () => {
      const executor: HealthCheckExecutor = vi.fn().mockResolvedValue({ latencyMs: 100 });
      probe.setExecutor(executor);

      const events: HealthEvent[] = [];
      const listener = (e: HealthEvent): void => {
        events.push(e);
      };

      probe.onEvent(listener);
      probe.offEvent(listener);

      await probe.check('org-1');

      expect(events).toHaveLength(0);
    });
  });

  describe('start / stop', () => {
    it('should start probing an org', () => {
      const executor: HealthCheckExecutor = vi.fn().mockResolvedValue({ latencyMs: 100 });
      probe.setExecutor(executor);

      probe.start('org-1', 1000);

      expect(probe.isProbing('org-1')).toBe(true);
    });

    it('should stop probing an org', () => {
      const executor: HealthCheckExecutor = vi.fn().mockResolvedValue({ latencyMs: 100 });
      probe.setExecutor(executor);

      probe.start('org-1', 1000);
      probe.stop('org-1');

      expect(probe.isProbing('org-1')).toBe(false);
    });

    it('should perform immediate check on start', () => {
      const executor: HealthCheckExecutor = vi.fn().mockResolvedValue({ latencyMs: 100 });
      probe.setExecutor(executor);

      probe.start('org-1', 60_000);

      expect(executor).toHaveBeenCalledWith('org-1');
    });

    it('should perform periodic checks', () => {
      const executor: HealthCheckExecutor = vi.fn().mockResolvedValue({ latencyMs: 100 });
      probe.setExecutor(executor);

      probe.start('org-1', 1000);

      // Initial call
      expect(executor).toHaveBeenCalledTimes(1);

      // After 1 interval
      vi.advanceTimersByTime(1000);
      expect(executor).toHaveBeenCalledTimes(2);

      // After 2 intervals
      vi.advanceTimersByTime(1000);
      expect(executor).toHaveBeenCalledTimes(3);
    });

    it('should handle stopping a non-probing org gracefully', () => {
      expect(() => probe.stop('nonexistent')).not.toThrow();
    });

    it('should restart probing when start is called again', () => {
      const executor: HealthCheckExecutor = vi.fn().mockResolvedValue({ latencyMs: 100 });
      probe.setExecutor(executor);

      probe.start('org-1', 1000);
      probe.start('org-1', 2000); // restart with different interval

      expect(probe.isProbing('org-1')).toBe(true);
    });
  });

  describe('dispose', () => {
    it('should stop all probes and clear state', () => {
      const executor: HealthCheckExecutor = vi.fn().mockResolvedValue({ latencyMs: 100 });
      probe.setExecutor(executor);

      probe.start('org-1', 1000);
      probe.start('org-2', 1000);

      probe.dispose();

      expect(probe.isProbing('org-1')).toBe(false);
      expect(probe.isProbing('org-2')).toBe(false);
      expect(probe.getHealth('org-1').status).toBe('unknown');
    });
  });
});
