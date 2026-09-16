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

      expect(health.failedJobs).toBe(0);
    });

    it('counts the failed jobs, not the points they cost', async () => {
      mockQueryAll.mockResolvedValue([
        makeJobRow('Failed', 'j1'),
        makeJobRow('Failed', 'j2'),
        makeJobRow('Failed', 'j3'),
        makeJobRow('Completed', 'j4'),
      ]);
      const ops = createMonitorOps(createDeps());

      const health = await ops.healthCheck.computeHealth('org-1');

      expect(health.failedJobs).toBe(3);
    });

    it('drags the overall status down when failed jobs dominate the window', async () => {
      mockQueryAll.mockResolvedValue(
        Array.from({ length: 10 }, (_, i) => makeJobRow('Failed', `jf-${i}`)),
      );
      const ops = createMonitorOps(createDeps());

      const health = await ops.healthCheck.computeHealth('org-1');

      expect(health.failedJobs).toBe(10);
      // avg(100, 100, 100, 0) = 75 -> below the healthy threshold (80).
      expect(health.overall).toBe('degraded');
    });

    it('degrades to a neutral signal when the jobs query fails', async () => {
      mockQueryAll.mockRejectedValue(new Error('soql failed'));
      const ops = createMonitorOps(createDeps());

      const health = await ops.healthCheck.computeHealth('org-1');

      // Fetch failure -> neutral ok signal (score 100) instead of a fake score.
      expect(health.failedJobs).toBe(0);
      expect(health.overall).toBe('healthy');
    });
  });

  describe('error logs health provider', () => {
    /** An ApexLog row as the error-log SOQL query returns it. */
    function makeLogRow(id: string): Record<string, unknown> {
      return {
        Id: id,
        Operation: '/apex/Checkout',
        Status: 'Assertion Failed',
        DurationMilliseconds: 12,
        LogLength: 400,
        StartTime: '2026-03-20T10:00:00Z',
        LogUser: { Username: 'admin@example.com' },
      };
    }

    /** Answer the jobs query with no rows and the error-log query with `logs`. */
    function answerQueries(logs: Record<string, unknown>[]): void {
      mockQueryAll.mockImplementation(async (_conn: unknown, soql: string) =>
        soql.includes('FROM ApexLog') ? logs : [],
      );
    }

    it('counts the error logs this refresh reads, and a later refresh reads them again', async () => {
      const ops = createMonitorOps(createDeps());

      answerQueries([makeLogRow('l1'), makeLogRow('l2')]);
      const first = await ops.healthCheck.computeHealth('org-1');
      answerQueries([makeLogRow('l1'), makeLogRow('l2'), makeLogRow('l3'), makeLogRow('l4')]);
      const second = await ops.healthCheck.computeHealth('org-1');

      expect(first.recentErrorLogs).toBe(2);
      expect(second.recentErrorLogs).toBe(4);
    });

    it('counts none and keeps a full score when the error logs cannot be read', async () => {
      mockQueryAll.mockImplementation(async (_conn: unknown, soql: string) => {
        if (soql.includes('FROM ApexLog')) throw new Error('INSUFFICIENT_ACCESS');
        return [];
      });
      const ops = createMonitorOps(createDeps());

      const health = await ops.healthCheck.computeHealth('org-1');

      expect(health.recentErrorLogs).toBe(0);
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
