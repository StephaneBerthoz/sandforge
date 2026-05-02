import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MonitorOrchestrator } from './MonitorOrchestrator';
import type { MonitorDependencies, MonitorEventHandler } from './MonitorOrchestrator';
import type { OrgHealthStatus } from '@sandforge/shared';

function createMockDeps(): MonitorDependencies {
  return {
    limitsTracker: {
      fetch: vi.fn().mockResolvedValue({ orgId: 'org-1', limits: [], timestamp: '' }),
      getSnapshot: vi.fn(),
      getCriticalLimits: vi.fn().mockReturnValue([]),
      getHistory: vi.fn().mockReturnValue([]),
    } as unknown as MonitorDependencies['limitsTracker'],
    jobMonitor: {
      fetch: vi.fn().mockResolvedValue([]),
      getActiveJobs: vi.fn().mockReturnValue([]),
      getFailedJobs: vi.fn().mockReturnValue([]),
      getJobStats: vi.fn().mockReturnValue({ total: 0, active: 0, completed: 0, failed: 0 }),
    } as unknown as MonitorDependencies['jobMonitor'],
    errorLogMonitor: {
      fetch: vi.fn().mockResolvedValue([]),
      getRecentErrors: vi.fn().mockReturnValue([]),
      getErrorCount: vi.fn().mockReturnValue(0),
    } as unknown as MonitorDependencies['errorLogMonitor'],
    deploymentTracker: {
      fetch: vi.fn().mockResolvedValue([]),
      getActiveDeployments: vi.fn().mockReturnValue([]),
    } as unknown as MonitorDependencies['deploymentTracker'],
    userSessionMonitor: {
      fetch: vi.fn().mockResolvedValue([]),
      getActiveSessions: vi.fn().mockReturnValue([]),
      getActiveUserCount: vi.fn().mockReturnValue(0),
    } as unknown as MonitorDependencies['userSessionMonitor'],
    alertEngine: {
      evaluate: vi.fn(),
      getActiveAlerts: vi.fn().mockReturnValue([]),
    } as unknown as MonitorDependencies['alertEngine'],
    healthCheck: {
      computeHealth: vi.fn<(orgId: string) => Promise<OrgHealthStatus>>().mockResolvedValue({
        orgId: 'org-1',
        overall: 'healthy',
        apiLimitsStatus: 'ok',
        storageStatus: 'ok',
        activeJobs: 0,
        recentErrors: 0,
        lastChecked: '2026-01-01T00:00:00Z',
      }),
    } as unknown as MonitorDependencies['healthCheck'],
  };
}

describe('MonitorOrchestrator', () => {
  let orchestrator: MonitorOrchestrator;
  let deps: MonitorDependencies;

  beforeEach(() => {
    deps = createMockDeps();
    orchestrator = new MonitorOrchestrator(deps);
  });

  describe('start', () => {
    it('should fetch data from all sub-services', async () => {
      await orchestrator.start('org-1');

      expect(deps.limitsTracker.fetch).toHaveBeenCalledWith('org-1');
      expect(deps.jobMonitor.fetch).toHaveBeenCalledWith('org-1');
      expect(deps.errorLogMonitor.fetch).toHaveBeenCalledWith('org-1');
      expect(deps.deploymentTracker.fetch).toHaveBeenCalledWith('org-1');
      expect(deps.userSessionMonitor.fetch).toHaveBeenCalledWith('org-1');
    });

    it('should compute health status', async () => {
      await orchestrator.start('org-1');
      expect(deps.healthCheck.computeHealth).toHaveBeenCalledWith('org-1');
    });

    it('should mark the org as active', async () => {
      await orchestrator.start('org-1');
      expect(orchestrator.isActive('org-1')).toBe(true);
    });

    it('should not re-start if already active', async () => {
      await orchestrator.start('org-1');
      await orchestrator.start('org-1');

      expect(deps.limitsTracker.fetch).toHaveBeenCalledTimes(1);
    });

    it('should emit a started event', async () => {
      const handler = vi.fn();
      orchestrator.on('started', handler);

      await orchestrator.start('org-1');

      expect(handler).toHaveBeenCalledWith('started', { orgId: 'org-1' });
    });
  });

  describe('stop', () => {
    it('should mark the org as inactive', async () => {
      await orchestrator.start('org-1');
      orchestrator.stop('org-1');

      expect(orchestrator.isActive('org-1')).toBe(false);
    });

    it('should emit a stopped event', async () => {
      const handler = vi.fn();
      orchestrator.on('stopped', handler);

      await orchestrator.start('org-1');
      orchestrator.stop('org-1');

      expect(handler).toHaveBeenCalledWith('stopped', { orgId: 'org-1' });
    });

    it('should not emit if org was not active', () => {
      const handler = vi.fn();
      orchestrator.on('stopped', handler);

      orchestrator.stop('org-1');

      expect(handler).not.toHaveBeenCalled();
    });

    it('should clear cached health status', async () => {
      await orchestrator.start('org-1');
      orchestrator.stop('org-1');

      const health = orchestrator.getHealthStatus('org-1');
      expect(health.overall).toBe('healthy');
    });
  });

  describe('getHealthStatus', () => {
    it('should return cached health status after start', async () => {
      await orchestrator.start('org-1');
      const status = orchestrator.getHealthStatus('org-1');

      expect(status.orgId).toBe('org-1');
      expect(status.overall).toBe('healthy');
    });

    it('should return a default healthy status for unknown org', () => {
      const status = orchestrator.getHealthStatus('unknown');

      expect(status.orgId).toBe('unknown');
      expect(status.overall).toBe('healthy');
    });
  });

  describe('getHealthScore', () => {
    it('should return 100 for a perfectly healthy org', async () => {
      await orchestrator.start('org-1');
      const score = orchestrator.getHealthScore('org-1');
      expect(score).toBe(100);
    });

    it('should deduct points for warning apiLimitsStatus', async () => {
      vi.mocked(deps.healthCheck.computeHealth).mockResolvedValue({
        orgId: 'org-1',
        overall: 'degraded',
        apiLimitsStatus: 'warning',
        storageStatus: 'ok',
        activeJobs: 0,
        recentErrors: 0,
        lastChecked: '2026-01-01T00:00:00Z',
      });

      await orchestrator.start('org-1');
      const score = orchestrator.getHealthScore('org-1');

      expect(score).toBe(85);
    });

    it('should deduct points for critical apiLimitsStatus', async () => {
      vi.mocked(deps.healthCheck.computeHealth).mockResolvedValue({
        orgId: 'org-1',
        overall: 'critical',
        apiLimitsStatus: 'critical',
        storageStatus: 'ok',
        activeJobs: 0,
        recentErrors: 0,
        lastChecked: '2026-01-01T00:00:00Z',
      });

      await orchestrator.start('org-1');
      const score = orchestrator.getHealthScore('org-1');

      expect(score).toBe(65);
    });

    it('should deduct points for active jobs', async () => {
      vi.mocked(deps.healthCheck.computeHealth).mockResolvedValue({
        orgId: 'org-1',
        overall: 'healthy',
        apiLimitsStatus: 'ok',
        storageStatus: 'ok',
        activeJobs: 5,
        recentErrors: 0,
        lastChecked: '2026-01-01T00:00:00Z',
      });

      await orchestrator.start('org-1');
      const score = orchestrator.getHealthScore('org-1');

      expect(score).toBe(90);
    });

    it('should deduct points for recent errors', async () => {
      vi.mocked(deps.healthCheck.computeHealth).mockResolvedValue({
        orgId: 'org-1',
        overall: 'healthy',
        apiLimitsStatus: 'ok',
        storageStatus: 'ok',
        activeJobs: 0,
        recentErrors: 3,
        lastChecked: '2026-01-01T00:00:00Z',
      });

      await orchestrator.start('org-1');
      const score = orchestrator.getHealthScore('org-1');

      expect(score).toBe(91);
    });

    it('should never return below 0', async () => {
      vi.mocked(deps.healthCheck.computeHealth).mockResolvedValue({
        orgId: 'org-1',
        overall: 'critical',
        apiLimitsStatus: 'critical',
        storageStatus: 'critical',
        activeJobs: 100,
        recentErrors: 100,
        lastChecked: '2026-01-01T00:00:00Z',
      });

      await orchestrator.start('org-1');
      const score = orchestrator.getHealthScore('org-1');

      expect(score).toBeGreaterThanOrEqual(0);
    });
  });

  describe('on / off', () => {
    it('should register and invoke event handlers', async () => {
      const handler = vi.fn();
      orchestrator.on('started', handler);

      await orchestrator.start('org-1');

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('should stop invoking handler after off', async () => {
      const handler: MonitorEventHandler = vi.fn();
      orchestrator.on('started', handler);
      orchestrator.off('started', handler);

      await orchestrator.start('org-1');

      expect(handler).not.toHaveBeenCalled();
    });

    it('should support multiple handlers for the same event', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      orchestrator.on('started', handler1);
      orchestrator.on('started', handler2);

      await orchestrator.start('org-1');

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it('should not throw when removing a handler that was never added', () => {
      const handler = vi.fn();
      expect(() => orchestrator.off('started', handler)).not.toThrow();
    });
  });

  describe('isActive', () => {
    it('should return false for orgs that have not been started', () => {
      expect(orchestrator.isActive('org-1')).toBe(false);
    });

    it('should return true for started orgs', async () => {
      await orchestrator.start('org-1');
      expect(orchestrator.isActive('org-1')).toBe(true);
    });

    it('should return false after stopping', async () => {
      await orchestrator.start('org-1');
      orchestrator.stop('org-1');
      expect(orchestrator.isActive('org-1')).toBe(false);
    });
  });

  describe('metricBus singleton (Phase 03 Plan 03-01)', () => {
    it('exposes a public readonly MetricBus instance', () => {
      expect(orchestrator.metricBus).toBeDefined();
      // emit/subscribe surface present
      expect(typeof orchestrator.metricBus.emit).toBe('function');
      expect(typeof orchestrator.metricBus.subscribe).toBe('function');
      expect(typeof orchestrator.metricBus.dispose).toBe('function');
    });

    it('lets a probe emit through the bus and a subscriber receive it', () => {
      const handler = vi.fn();
      const unsubscribe = orchestrator.metricBus.subscribe('monitor:metric', handler);
      const ok = orchestrator.metricBus.emit('monitor:metric', {
        ts: '2026-05-02T10:00:00.000Z',
        seriesId: 'limits.api',
        orgId: 'org-1',
        value: 42,
      });
      expect(ok).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);
      unsubscribe();
    });

    it('dispose() releases the bus (subsequent subscribers still work — fresh bus is owned by next instance)', () => {
      const handler = vi.fn();
      orchestrator.metricBus.subscribe('monitor:metric', handler);
      orchestrator.dispose();
      // Post-dispose: previously-registered handler is detached.
      orchestrator.metricBus.emit('monitor:metric', {
        ts: '2026-05-02T10:00:00.000Z',
        seriesId: 'limits.api',
        orgId: 'org-1',
        value: 42,
      });
      expect(handler).not.toHaveBeenCalled();
    });
  });
});
