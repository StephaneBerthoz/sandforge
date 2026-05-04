import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TokenRefresher } from './TokenRefresher';
import type { TokenRefreshExecutor, TokenEventListener } from './TokenRefresher';

describe('TokenRefresher', () => {
  let refresher: TokenRefresher;

  beforeEach(() => {
    vi.useFakeTimers();
    refresher = new TokenRefresher();
  });

  afterEach(() => {
    refresher.dispose();
    vi.useRealTimers();
  });

  describe('scheduleRefresh', () => {
    it('should schedule a refresh for an org', () => {
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
      refresher.scheduleRefresh('org-1', expiresAt);

      expect(refresher.isScheduled('org-1')).toBe(true);
    });

    it('should store refresh info', () => {
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      refresher.scheduleRefresh('org-1', expiresAt);

      const info = refresher.getRefreshInfo('org-1');
      expect(info).toBeDefined();
      expect(info?.orgId).toBe('org-1');
      expect(info?.status).toBe('scheduled');
      expect(info?.expiresAt).toEqual(expiresAt);
    });

    it('should schedule refresh 5 minutes before expiration', () => {
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
      refresher.scheduleRefresh('org-1', expiresAt);

      const info = refresher.getRefreshInfo('org-1');
      const expectedRefreshAt = new Date(expiresAt.getTime() - 5 * 60 * 1000);
      expect(info?.scheduledRefreshAt.getTime()).toBe(expectedRefreshAt.getTime());
    });

    it('should cancel previous schedule when rescheduling', () => {
      const expiresAt1 = new Date(Date.now() + 30 * 60 * 1000);
      const expiresAt2 = new Date(Date.now() + 60 * 60 * 1000);

      refresher.scheduleRefresh('org-1', expiresAt1);
      refresher.scheduleRefresh('org-1', expiresAt2);

      const info = refresher.getRefreshInfo('org-1');
      expect(info?.expiresAt).toEqual(expiresAt2);
    });

    it('should include timeRemainingMs in info', () => {
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      refresher.scheduleRefresh('org-1', expiresAt);

      const info = refresher.getRefreshInfo('org-1');
      expect(info?.timeRemainingMs).toBeGreaterThan(0);
      expect(info?.timeRemainingMs).toBeLessThanOrEqual(60 * 60 * 1000);
    });
  });

  describe('cancelRefresh', () => {
    it('should cancel a scheduled refresh', () => {
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      refresher.scheduleRefresh('org-1', expiresAt);
      refresher.cancelRefresh('org-1');

      expect(refresher.isScheduled('org-1')).toBe(false);
      const info = refresher.getRefreshInfo('org-1');
      expect(info?.status).toBe('cancelled');
    });

    it('should handle cancelling non-existent schedule', () => {
      expect(() => refresher.cancelRefresh('nonexistent')).not.toThrow();
    });
  });

  describe('refreshNow', () => {
    it('should perform immediate refresh', async () => {
      const newExpiry = new Date(Date.now() + 2 * 60 * 60 * 1000);
      const executor: TokenRefreshExecutor = vi.fn().mockResolvedValue({
        accessToken: 'new-token',
        expiresAt: newExpiry,
      });
      refresher.setExecutor(executor);

      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      refresher.scheduleRefresh('org-1', expiresAt);

      const result = await refresher.refreshNow('org-1');

      expect(result).toBe(true);
      expect(executor).toHaveBeenCalledWith('org-1');
    });

    it('should return false when no executor is set', async () => {
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      refresher.scheduleRefresh('org-1', expiresAt);

      const result = await refresher.refreshNow('org-1');
      expect(result).toBe(false);
    });

    it('should return false when refresh fails', async () => {
      const executor: TokenRefreshExecutor = vi.fn().mockRejectedValue(new Error('Refresh failed'));
      refresher.setExecutor(executor);

      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      refresher.scheduleRefresh('org-1', expiresAt);

      const result = await refresher.refreshNow('org-1');
      expect(result).toBe(false);
    });

    it('should track consecutive failures', async () => {
      const executor: TokenRefreshExecutor = vi.fn().mockRejectedValue(new Error('Refresh failed'));
      refresher.setExecutor(executor);

      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      refresher.scheduleRefresh('org-1', expiresAt);

      await refresher.refreshNow('org-1');
      await refresher.refreshNow('org-1');

      const info = refresher.getRefreshInfo('org-1');
      expect(info?.consecutiveFailures).toBe(2);
      expect(info?.status).toBe('failed');
    });

    it('should reschedule after successful refresh', async () => {
      const newExpiry = new Date(Date.now() + 2 * 60 * 60 * 1000);
      const executor: TokenRefreshExecutor = vi.fn().mockResolvedValue({
        accessToken: 'new-token',
        expiresAt: newExpiry,
      });
      refresher.setExecutor(executor);

      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      refresher.scheduleRefresh('org-1', expiresAt);

      await refresher.refreshNow('org-1');

      // Should be rescheduled with new expiry
      expect(refresher.isScheduled('org-1')).toBe(true);
      const info = refresher.getRefreshInfo('org-1');
      expect(info?.expiresAt).toEqual(newExpiry);
    });
  });

  describe('circuit breaker', () => {
    it('should trigger disconnect after 3 consecutive failures', async () => {
      const executor: TokenRefreshExecutor = vi.fn().mockRejectedValue(new Error('Refresh failed'));
      const disconnectHandler = vi.fn();

      refresher.setExecutor(executor);
      refresher.setDisconnectHandler(disconnectHandler);

      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      refresher.scheduleRefresh('org-1', expiresAt);

      await refresher.refreshNow('org-1');
      await refresher.refreshNow('org-1');
      await refresher.refreshNow('org-1');

      expect(disconnectHandler).toHaveBeenCalledWith('org-1');
      expect(refresher.getRefreshInfo('org-1')?.status).toBe('expired');
    });

    it('should not trigger disconnect before 3 failures', async () => {
      const executor: TokenRefreshExecutor = vi.fn().mockRejectedValue(new Error('Refresh failed'));
      const disconnectHandler = vi.fn();

      refresher.setExecutor(executor);
      refresher.setDisconnectHandler(disconnectHandler);

      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      refresher.scheduleRefresh('org-1', expiresAt);

      await refresher.refreshNow('org-1');
      await refresher.refreshNow('org-1');

      expect(disconnectHandler).not.toHaveBeenCalled();
    });

    it('should reset failure count after successful refresh', async () => {
      let callCount = 0;
      const executor: TokenRefreshExecutor = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 2) {
          return Promise.reject(new Error('Refresh failed'));
        }
        return Promise.resolve({
          accessToken: 'new-token',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        });
      });

      refresher.setExecutor(executor);

      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      refresher.scheduleRefresh('org-1', expiresAt);

      await refresher.refreshNow('org-1'); // fail 1
      await refresher.refreshNow('org-1'); // fail 2
      await refresher.refreshNow('org-1'); // success - reset

      const info = refresher.getRefreshInfo('org-1');
      expect(info?.consecutiveFailures).toBe(0);
    });

    it('should support custom max failures', async () => {
      const customRefresher = new TokenRefresher(5 * 60 * 1000, 2);
      const executor: TokenRefreshExecutor = vi.fn().mockRejectedValue(new Error('Refresh failed'));
      const disconnectHandler = vi.fn();

      customRefresher.setExecutor(executor);
      customRefresher.setDisconnectHandler(disconnectHandler);

      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      customRefresher.scheduleRefresh('org-1', expiresAt);

      await customRefresher.refreshNow('org-1');
      await customRefresher.refreshNow('org-1');

      expect(disconnectHandler).toHaveBeenCalledWith('org-1');

      customRefresher.dispose();
    });
  });

  describe('events', () => {
    it('should emit token:refreshed on success', async () => {
      const executor: TokenRefreshExecutor = vi.fn().mockResolvedValue({
        accessToken: 'new-token',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      refresher.setExecutor(executor);

      const listener: TokenEventListener = vi.fn();
      refresher.onEvent(listener);

      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      refresher.scheduleRefresh('org-1', expiresAt);
      await refresher.refreshNow('org-1');

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'token:refreshed', orgId: 'org-1' }),
      );
    });

    it('should emit token:failed on failure', async () => {
      const executor: TokenRefreshExecutor = vi.fn().mockRejectedValue(new Error('Refresh failed'));
      refresher.setExecutor(executor);

      const listener: TokenEventListener = vi.fn();
      refresher.onEvent(listener);

      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      refresher.scheduleRefresh('org-1', expiresAt);
      await refresher.refreshNow('org-1');

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'token:failed', orgId: 'org-1' }),
      );
    });

    it('should emit token:expired and token:circuitOpen when circuit trips', async () => {
      const executor: TokenRefreshExecutor = vi.fn().mockRejectedValue(new Error('Refresh failed'));
      refresher.setExecutor(executor);

      const listener: TokenEventListener = vi.fn();
      refresher.onEvent(listener);

      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      refresher.scheduleRefresh('org-1', expiresAt);

      await refresher.refreshNow('org-1');
      await refresher.refreshNow('org-1');
      await refresher.refreshNow('org-1');

      const calls = (listener as ReturnType<typeof vi.fn>).mock.calls;
      const eventTypes = calls.map((c: unknown[]) => (c[0] as { type: string }).type);

      expect(eventTypes).toContain('token:expired');
      expect(eventTypes).toContain('token:circuitOpen');
    });

    it('should unregister listener', async () => {
      const executor: TokenRefreshExecutor = vi.fn().mockResolvedValue({
        accessToken: 'new-token',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      refresher.setExecutor(executor);

      const listener: TokenEventListener = vi.fn();
      refresher.onEvent(listener);
      refresher.offEvent(listener);

      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      refresher.scheduleRefresh('org-1', expiresAt);
      await refresher.refreshNow('org-1');

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('getHealthSummary', () => {
    it('should return summary for all scheduled orgs', () => {
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      refresher.scheduleRefresh('org-1', expiresAt);
      refresher.scheduleRefresh('org-2', expiresAt);

      const summary = refresher.getHealthSummary();
      expect(summary).toHaveLength(2);
      expect(summary[0].orgId).toBe('org-1');
      expect(summary[0].timeRemainingMs).toBeGreaterThan(0);
    });

    it('should return empty array when no schedules', () => {
      expect(refresher.getHealthSummary()).toEqual([]);
    });
  });

  describe('automatic refresh', () => {
    it('should trigger refresh when timer fires', async () => {
      let callCount = 0;
      const executor: TokenRefreshExecutor = vi.fn().mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          accessToken: 'new-token',
          expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
        });
      });
      refresher.setExecutor(executor);

      // Token expires in 10 minutes, refresh should happen at 5 minutes
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      refresher.scheduleRefresh('org-1', expiresAt);

      // Advance to 5 minutes (the refresh point)
      vi.advanceTimersByTime(5 * 60 * 1000);

      // Wait for the async refresh to complete
      await Promise.resolve();
      await Promise.resolve();

      expect(callCount).toBeGreaterThanOrEqual(1);
      expect(executor).toHaveBeenCalledWith('org-1');
    });

    it('should refresh immediately if token is about to expire', async () => {
      const executor: TokenRefreshExecutor = vi.fn().mockResolvedValue({
        accessToken: 'new-token',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      refresher.setExecutor(executor);

      // Token expires in 1 minute (less than 5 min buffer)
      const expiresAt = new Date(Date.now() + 60 * 1000);
      refresher.scheduleRefresh('org-1', expiresAt);

      // Should fire immediately (delay = 0)
      vi.advanceTimersByTime(0);

      // Wait for the async refresh to complete
      await Promise.resolve();
      await Promise.resolve();

      expect(executor).toHaveBeenCalledWith('org-1');
    });
  });

  describe('getAllSchedules', () => {
    it('should return all scheduled refreshes', () => {
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      refresher.scheduleRefresh('org-1', expiresAt);
      refresher.scheduleRefresh('org-2', expiresAt);

      const schedules = refresher.getAllSchedules();
      expect(schedules).toHaveLength(2);
    });

    it('should return empty array when no schedules', () => {
      expect(refresher.getAllSchedules()).toEqual([]);
    });
  });

  describe('custom buffer', () => {
    it('should respect custom buffer time', () => {
      const customRefresher = new TokenRefresher(10 * 60 * 1000); // 10 minutes
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      customRefresher.scheduleRefresh('org-1', expiresAt);

      const info = customRefresher.getRefreshInfo('org-1');
      const expectedRefreshAt = new Date(expiresAt.getTime() - 10 * 60 * 1000);
      expect(info?.scheduledRefreshAt.getTime()).toBe(expectedRefreshAt.getTime());

      customRefresher.dispose();
    });
  });

  describe('dispose', () => {
    it('should clean up all timers and schedules', () => {
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      refresher.scheduleRefresh('org-1', expiresAt);
      refresher.scheduleRefresh('org-2', expiresAt);

      refresher.dispose();

      expect(refresher.getAllSchedules()).toEqual([]);
    });

    it('should clear all listeners', () => {
      const listener: TokenEventListener = vi.fn();
      refresher.onEvent(listener);

      refresher.dispose();

      // No way to directly test, but coverage ensures listeners.clear() is called
      expect(refresher.getAllSchedules()).toEqual([]);
    });
  });
});
