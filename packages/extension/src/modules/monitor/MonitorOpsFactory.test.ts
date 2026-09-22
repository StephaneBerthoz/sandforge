import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMonitorOps } from './MonitorOpsFactory.js';
import type { MonitorOpsFactoryDeps } from './MonitorOpsFactory.js';
import type { Connection } from 'jsforce';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';

const mockQueryAll = vi.hoisted(() => vi.fn());
const mockQueryAllBounded = vi.hoisted(() => vi.fn());
const mockCheckApiLimits = vi.hoisted(() => vi.fn());

vi.mock('../../core/common/soqlQueryHelper.js', () => ({
  queryAll: mockQueryAll,
  queryAllBounded: mockQueryAllBounded,
}));

vi.mock('../../core/common/sforceLimitParser.js', () => ({
  checkApiLimits: mockCheckApiLimits,
}));

/** Limits an org reports as unused: the two the health check reads, at 0%. */
const IDLE_LIMITS = {
  DailyApiRequests: { Max: 100_000, Remaining: 100_000 },
  DataStorageMB: { Max: 1_000, Remaining: 1_000 },
};

/** A ConfigStore that keeps what it is given, as the extension's does. */
function realConfigStore(): ConfigStore {
  const store = new ConfigStore(new InMemoryConfigStoreBackend());
  store.initialize();
  return store;
}

/** Build minimal factory deps with an inert connection. */
function createDeps(overrides?: Partial<MonitorOpsFactoryDeps>): MonitorOpsFactoryDeps {
  return {
    configStore: { get: vi.fn(), set: vi.fn() } as unknown as MonitorOpsFactoryDeps['configStore'],
    log: vi.fn(),
    notify: vi.fn(),
    getConnection: vi.fn().mockResolvedValue({
      request: vi.fn().mockResolvedValue(IDLE_LIMITS),
      // An org with no error log in the day: its COUNT() answers 0.
      query: vi.fn().mockResolvedValue({ done: true, totalSize: 0, records: [] }),
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
    // A bounded read answers the rows mockQueryAll holds for its SOQL, and
    // says it stopped short only when a test says so.
    mockQueryAllBounded.mockReset();
    mockQueryAllBounded.mockImplementation(async (conn: unknown, soql: string) => ({
      records: (await mockQueryAll(conn, soql)) as unknown[],
      truncated: false,
    }));
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

    it('reports the jobs as not read when their query fails', async () => {
      mockQueryAll.mockRejectedValue(new Error('soql failed'));
      const ops = createMonitorOps(createDeps());

      const health = await ops.healthCheck.computeHealth('org-1');

      // Not zero failed jobs: none read. The score rests on what was read.
      expect(health.failedJobs).toBeNull();
      expect(health.overall).toBe('healthy');
    });

    it('is unknown when the limits cannot be read either', async () => {
      mockQueryAll.mockRejectedValue(new Error('soql failed'));
      const ops = createMonitorOps(
        createDeps({
          getConnection: vi.fn().mockResolvedValue({
            request: vi.fn().mockRejectedValue(new Error('REQUEST_LIMIT_EXCEEDED')),
            limitInfo: undefined,
          } as unknown as Connection),
        }),
      );

      const health = await ops.healthCheck.computeHealth('org-1');

      expect(health.overall).toBe('unknown');
      expect(health.apiLimitsStatus).toBe('unknown');
    });
  });

  describe('error logs health provider', () => {
    /**
     * Deps whose connection answers the day's error-log COUNT() with what
     * `count` holds at the time of the call, as the org answers `COUNT()`:
     * a total and no rows.
     */
    function depsCountingErrorLogs(count: { value: number | Error }): MonitorOpsFactoryDeps {
      const query = vi.fn(async (soql: string) => {
        if (!/^SELECT COUNT\(\) FROM ApexLog WHERE /.test(soql)) {
          throw new Error(`unexpected query: ${soql}`);
        }
        if (count.value instanceof Error) throw count.value;
        return { done: true, totalSize: count.value, records: [] };
      });
      return createDeps({
        getConnection: vi.fn().mockResolvedValue({
          request: vi.fn().mockResolvedValue(IDLE_LIMITS),
          query,
          limitInfo: undefined,
        } as unknown as Connection),
      });
    }

    it('counts the error logs of the day on every refresh', async () => {
      mockQueryAll.mockResolvedValue([]);
      const count = { value: 2 };
      const ops = createMonitorOps(depsCountingErrorLogs(count));

      const first = await ops.healthCheck.computeHealth('org-1');
      count.value = 4;
      const second = await ops.healthCheck.computeHealth('org-1');

      expect(first.recentErrorLogs).toBe(2);
      expect(second.recentErrorLogs).toBe(4);
    });

    it('counts every error log of the day, past the fifty the Error Logs panel lists', async () => {
      mockQueryAll.mockResolvedValue([]);
      const ops = createMonitorOps(depsCountingErrorLogs({ value: 312 }));

      const health = await ops.healthCheck.computeHealth('org-1');

      expect(health.recentErrorLogs).toBe(312);
      // The panel's read is not what the count comes from.
      expect(mockQueryAllBounded).not.toHaveBeenCalled();
    });

    it('reports the error logs as not read when they cannot be read', async () => {
      mockQueryAll.mockResolvedValue([]);
      const ops = createMonitorOps(
        depsCountingErrorLogs({ value: new Error('INSUFFICIENT_ACCESS') }),
      );

      const health = await ops.healthCheck.computeHealth('org-1');

      expect(health.recentErrorLogs).toBeNull();
      expect(health.overall).toBe('healthy');
    });
  });

  describe('lists that stop at a bound', () => {
    it('reads the fifty newest error logs of the day, and says when the day holds more', async () => {
      mockQueryAllBounded.mockResolvedValueOnce({ records: [], truncated: true });
      const ops = createMonitorOps(createDeps());

      await ops.errorLogMonitor.fetch('org-1');

      const [, soql, bound] = mockQueryAllBounded.mock.calls[0] as [unknown, string, number];
      expect(soql).toMatch(/FROM ApexLog WHERE .* ORDER BY StartTime DESC LIMIT 50$/);
      expect(bound).toBe(50);
      expect(ops.errorLogMonitor.isTruncated('org-1')).toBe(true);
    });

    it('reads the hundred newest sessions, and says when the org holds more', async () => {
      mockQueryAllBounded.mockResolvedValueOnce({ records: [], truncated: true });
      const ops = createMonitorOps(createDeps());

      await ops.userSessionMonitor.fetch('org-1');

      const [, soql, bound] = mockQueryAllBounded.mock.calls[0] as [unknown, string, number];
      expect(soql).toMatch(/FROM AuthSession ORDER BY CreatedDate DESC LIMIT 100$/);
      expect(bound).toBe(100);
      expect(ops.userSessionMonitor.isTruncated('org-1')).toBe(true);
    });

    it('reads as many Apex logs as it is asked for, and says when there are more', async () => {
      mockQueryAllBounded.mockResolvedValueOnce({ records: [], truncated: true });
      const ops = createMonitorOps(createDeps());

      await ops.apexLogAnalyzer.fetchAndAnalyze('org-1', 20);

      const [, soql, bound] = mockQueryAllBounded.mock.calls[0] as [unknown, string, number];
      expect(soql).toMatch(/FROM ApexLog ORDER BY StartTime DESC LIMIT 20$/);
      expect(bound).toBe(20);
      expect(ops.apexLogAnalyzer.isTruncated('org-1')).toBe(true);
    });

    it('reads the twenty newest sandbox refreshes, and says when there are more', async () => {
      mockQueryAllBounded.mockResolvedValueOnce({ records: [], truncated: true });
      const ops = createMonitorOps(createDeps());

      await ops.sandboxRefreshTracker.fetch('org-hub');

      const [, soql, bound] = mockQueryAllBounded.mock.calls[0] as [unknown, string, number];
      expect(soql).toMatch(/FROM SandboxProcess ORDER BY CreatedDate DESC LIMIT 20$/);
      expect(bound).toBe(20);
      expect(ops.sandboxRefreshTracker.isTruncated('org-hub')).toBe(true);
    });
  });

  describe('active sessions', () => {
    it('reads the login name from the session row instead of repeating its user id', async () => {
      mockQueryAll.mockResolvedValue([
        {
          Id: 'session-1',
          UsersId: '005AAA',
          Users: { Username: 'ana@example.com' },
          LoginType: 'Application',
          SessionType: 'UI',
          CreatedDate: '2026-03-20T10:00:00Z',
          SourceIp: '10.0.0.1',
        },
      ]);
      const ops = createMonitorOps(createDeps());

      const sessions = await ops.userSessionMonitor.fetch('org-1');

      expect(mockQueryAll.mock.calls[0][1]).toContain('Users.Username');
      expect(sessions[0].username).toBe('ana@example.com');
      expect(sessions[0].sessionId).toBe('session-1');
    });

    it('falls back to the user id when the row carries no login name', async () => {
      mockQueryAll.mockResolvedValue([
        {
          Id: 'session-2',
          UsersId: '005BBB',
          Users: null,
          LoginType: 'Application',
          SessionType: 'API',
          CreatedDate: '2026-03-20T10:00:00Z',
          SourceIp: '10.0.0.2',
        },
      ]);
      const ops = createMonitorOps(createDeps());

      const sessions = await ops.userSessionMonitor.fetch('org-1');

      expect(sessions[0].username).toBe('005BBB');
    });
  });

  describe('sandbox refreshes', () => {
    it('reports an org that cannot be asked as unsupported, not as empty', async () => {
      mockQueryAll.mockRejectedValue(new Error("sObject type 'SandboxProcess' is not supported."));
      const ops = createMonitorOps(createDeps());

      const events = await ops.sandboxRefreshTracker.fetch('org-sandbox');

      expect(events).toEqual([]);
      expect(ops.sandboxRefreshTracker.isSupported('org-sandbox')).toBe(false);
    });

    it('keeps an org that answered an empty list supported', async () => {
      mockQueryAll.mockResolvedValue([]);
      const ops = createMonitorOps(createDeps());

      await ops.sandboxRefreshTracker.fetch('org-hub');

      expect(ops.sandboxRefreshTracker.isSupported('org-hub')).toBe(true);
    });

    /** A SandboxProcess row in the shape the query reads it. */
    function processRow(sandboxName: string, status: string, createdDate: string) {
      return {
        Id: `0GR-${sandboxName}-${createdDate}`,
        SandboxName: sandboxName,
        Status: status,
        CreatedDate: createdDate,
        Description: null,
      };
    }

    it('hands over a refresh that completes after the first read, and none of the history', async () => {
      const onSandboxRefreshCompleted = vi.fn();
      const ops = createMonitorOps(
        createDeps({ configStore: realConfigStore(), onSandboxRefreshCompleted }),
      );
      const history = processRow('qa', 'Completed', '2026-09-01T07:00:00.000+0000');
      mockQueryAll.mockResolvedValue([
        processRow('uat', 'Processing', '2026-09-21T18:30:00.000+0000'),
        history,
      ]);
      await ops.sandboxRefreshTracker.fetch('org-prod');
      expect(onSandboxRefreshCompleted).not.toHaveBeenCalled();

      mockQueryAll.mockResolvedValue([
        processRow('uat', 'Completed', '2026-09-21T18:30:00.000+0000'),
        history,
      ]);
      await ops.sandboxRefreshTracker.fetch('org-prod');

      expect(onSandboxRefreshCompleted).toHaveBeenCalledTimes(1);
      expect(onSandboxRefreshCompleted).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: 'org-prod', sandboxName: 'uat', status: 'Completed' }),
      );
    });

    it('hands over, in a window opened later, a refresh completed while none was open', async () => {
      // The history seen is kept in the ConfigStore: a window that started
      // from nothing would take the refresh for history and say nothing.
      const configStore = realConfigStore();
      const onSandboxRefreshCompleted = vi.fn();
      const history = processRow('qa', 'Completed', '2026-09-01T07:00:00.000+0000');
      mockQueryAll.mockResolvedValue([history]);
      await createMonitorOps(createDeps({ configStore })).sandboxRefreshTracker.fetch('org-prod');

      mockQueryAll.mockResolvedValue([
        processRow('uat', 'Completed', '2026-09-21T18:30:00.000+0000'),
        history,
      ]);
      await createMonitorOps(
        createDeps({ configStore, onSandboxRefreshCompleted }),
      ).sandboxRefreshTracker.fetch('org-prod');

      expect(onSandboxRefreshCompleted).toHaveBeenCalledTimes(1);
      expect(onSandboxRefreshCompleted).toHaveBeenCalledWith(
        expect.objectContaining({ sandboxName: 'uat' }),
      );
    });
  });

  describe('forgetOrg', () => {
    it('drops the /limits reading of the org it names, and only that one', async () => {
      const request = vi.fn().mockResolvedValue({ DailyApiRequests: { Max: 100, Remaining: 90 } });
      const conn = { request, limitInfo: undefined } as unknown as Connection;
      const ops = createMonitorOps(createDeps());
      await ops.getOrFetchLimits('org-refreshed', conn);
      await ops.getOrFetchLimits('org-other', conn);

      ops.forgetOrg('org-refreshed');
      await ops.getOrFetchLimits('org-refreshed', conn);
      await ops.getOrFetchLimits('org-other', conn);

      expect(request).toHaveBeenCalledTimes(3);
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
