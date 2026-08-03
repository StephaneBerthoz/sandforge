import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMonitorOps } from './MonitorOpsFactory.js';
import type { MonitorOpsFactoryDeps } from './MonitorOpsFactory.js';
import type { Connection } from 'jsforce';

const mockQueryAll = vi.hoisted(() => vi.fn());
const mockCheckApiLimits = vi.hoisted(() => vi.fn());

vi.mock('../../core/common/soqlQueryHelper.js', () => ({
  queryAll: mockQueryAll,
}));

vi.mock('../../core/common/sforceLimitParser.js', () => ({
  checkApiLimits: mockCheckApiLimits,
}));

/** Build minimal factory deps with an inert connection. */
function createDeps(overrides?: Partial<MonitorOpsFactoryDeps>): MonitorOpsFactoryDeps {
  return {
    configStore: { get: vi.fn(), set: vi.fn() } as unknown as MonitorOpsFactoryDeps['configStore'],
    log: vi.fn(),
    notify: vi.fn(),
    getConnection: vi.fn().mockResolvedValue({
      request: vi.fn().mockResolvedValue({}),
      limitInfo: undefined,
    } as unknown as Connection),
    ...overrides,
  };
}

/** A single AsyncApexJob row as returned by the jobs SOQL query. */
function makeJobRow(status: string, id = `job-${status}`): Record<string, unknown> {
  return {
    Id: id,
    JobType: 'BatchApex',
    Status: status,
    NumberOfErrors: status === 'Failed' ? 2 : 0,
    CreatedDate: '2026-03-20T10:00:00Z',
    CreatedById: 'user-1',
  };
}

describe('createMonitorOps', () => {
  beforeEach(() => {
    mockQueryAll.mockReset();
    mockCheckApiLimits.mockReset();
  });

  describe('alert definition seeding', () => {
    it('persists default alert definitions when none are stored', () => {
      const deps = createDeps();
      createMonitorOps(deps);

      const setCalls = (deps.configStore.set as ReturnType<typeof vi.fn>).mock.calls;
      const defSaveCall = setCalls.find((c: unknown[]) => c[0] === 'alert:state:definitions');
      expect(defSaveCall).toBeDefined();
    });
  });

  describe('jobs health provider (real AsyncApexJob data)', () => {
    it('scores 100 with ok status when no recent job failed', async () => {
      mockQueryAll.mockResolvedValue([
        makeJobRow('Completed', 'j1'),
        makeJobRow('Completed', 'j2'),
      ]);
      const ops = createMonitorOps(createDeps());

      const health = await ops.healthCheck.computeHealth('org-1');

      // No failed job -> score 100 -> activeJobs degradation metric is 0.
      expect(health.activeJobs).toBe(0);
    });

    it('degrades the jobs signal when jobs failed', async () => {
      mockQueryAll.mockResolvedValue([makeJobRow('Failed', 'j1'), makeJobRow('Completed', 'j2')]);
      const ops = createMonitorOps(createDeps());

      const health = await ops.healthCheck.computeHealth('org-1');

      // 1 failed job -> score 100 - 10 = 90 -> degradation metric 10.
      expect(health.activeJobs).toBe(10);
    });

    it('drags the overall status down when failed jobs dominate the window', async () => {
      mockQueryAll.mockResolvedValue(
        Array.from({ length: 10 }, (_, i) => makeJobRow('Failed', `jf-${i}`)),
      );
      const ops = createMonitorOps(createDeps());

      const health = await ops.healthCheck.computeHealth('org-1');

      // 10 failed jobs -> score 0 -> degradation metric 100.
      expect(health.activeJobs).toBe(100);
      // avg(100, 100, 100, 0) = 75 -> below the healthy threshold (80).
      expect(health.overall).toBe('degraded');
    });

    it('degrades to a neutral signal when the jobs query fails', async () => {
      mockQueryAll.mockRejectedValue(new Error('soql failed'));
      const ops = createMonitorOps(createDeps());

      const health = await ops.healthCheck.computeHealth('org-1');

      // Fetch failure -> neutral ok signal (score 100) instead of a fake score.
      expect(health.activeJobs).toBe(0);
      expect(health.overall).toBe('healthy');
    });
  });

  describe('getOrFetchLimits', () => {
    it('shares one /limits call per org within the TTL window', async () => {
      const request = vi.fn().mockResolvedValue({ DailyApiRequests: { Max: 100, Remaining: 90 } });
      const conn = { request, limitInfo: undefined } as unknown as Connection;
      const ops = createMonitorOps(createDeps());

      await ops.getOrFetchLimits('org-cache', conn);
      await ops.getOrFetchLimits('org-cache', conn);

      expect(request).toHaveBeenCalledTimes(1);
    });
  });
});
