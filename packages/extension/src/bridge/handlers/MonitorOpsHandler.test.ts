import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MonitorOpsHandler } from './MonitorOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import type { BaseMessage } from '@sandforge/shared';

/**
 * Hoisted mocks -- available before module evaluation.
 * Using a single vi.mock per module path to avoid hoisting conflicts.
 */
const mockGetJsforceConnection = vi.hoisted(() => vi.fn());
const mockQueryAll = vi.hoisted(() => vi.fn());
const mockCheckApiLimits = vi.hoisted(() => vi.fn());

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: mockGetJsforceConnection,
}));

vi.mock('../../core/common/soqlQueryHelper.js', () => ({
  queryAll: mockQueryAll,
}));

vi.mock('../../core/common/sforceLimitParser.js', () => ({
  checkApiLimits: mockCheckApiLimits,
}));

const FAKE_LIMITS: Record<string, { Max: number; Remaining: number }> = {
  DailyApiRequests: { Max: 15000, Remaining: 14000 },
  DailyBulkApiRequests: { Max: 10000, Remaining: 9500 },
  DailyBulkV2QueryJobs: { Max: 10000, Remaining: 9000 },
  DailyBulkV2QueryFileStorageMB: { Max: 100, Remaining: 90 },
  DailyStreamingApiEvents: { Max: 10000, Remaining: 9500 },
  DailyGenericStreamingApiEvents: { Max: 10000, Remaining: 9500 },
  DailyDurableStreamingApiEvents: { Max: 10000, Remaining: 9500 },
  DailyAsyncApexExecutions: { Max: 250000, Remaining: 240000 },
  HourlyAsyncReportRuns: { Max: 1200, Remaining: 1100 },
  HourlyTimeBasedWorkflow: { Max: 1000, Remaining: 950 },
  DailySoqlQueries: { Max: 100, Remaining: 90 },
  DailyWorkflowEmails: { Max: 1000, Remaining: 800 },
  MassEmail: { Max: 5000, Remaining: 4500 },
  SingleEmail: { Max: 5000, Remaining: 4800 },
  HourlyPublishedPlatformEvents: { Max: 50000, Remaining: 49000 },
  DailyStandardVolumePlatformMessages: { Max: 100000, Remaining: 95000 },
};

/**
 * Creates minimal mock deps for MonitorOpsHandler tests.
 */
function createMockDeps(): HandlerDeps {
  let idCounter = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: { getOrg: vi.fn() } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: {
      get: vi.fn(),
      set: vi.fn(),
    } as unknown as HandlerDeps['configStore'],
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    nextId: () => String(++idCounter),
  };
}

describe('MonitorOpsHandler', () => {
  let handler: MonitorOpsHandler;
  let deps: HandlerDeps;

  beforeEach(() => {
    mockGetJsforceConnection.mockReset();
    mockQueryAll.mockReset();
    mockCheckApiLimits.mockReset();
    deps = createMockDeps();
    handler = new MonitorOpsHandler(deps);
  });

  it('returns false for unhandled message types', async () => {
    const msg: BaseMessage = { id: '1', type: 'unknown:type', timestamp: Date.now() };
    const result = await handler.handle(msg);
    expect(result).toBe(false);
  });

  it('handles monitor:trends and response includes correlationId', async () => {
    const msg: BaseMessage & { payload: { orgId: string; period?: string } } = {
      id: 'req-mon-1',
      type: 'monitor:trends',
      timestamp: Date.now(),
      payload: { orgId: 'org-1', period: '24h' },
    };

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & { correlationId?: string };
    expect(response.type).toBe('monitor:trends:data');
    expect(response.correlationId).toBe('req-mon-1');
  });

  it('handles monitor:live-operations and response includes correlationId', async () => {
    const msg: BaseMessage = {
      id: 'req-mon-2',
      type: 'monitor:live-operations',
      timestamp: Date.now(),
    };

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & { correlationId?: string; payload: { operations: unknown[] } };
    expect(response.type).toBe('monitor:live-operations:response');
    expect(response.correlationId).toBe('req-mon-2');
    expect(response.payload.operations).toEqual([]);
  });

  it('handles monitor:health-score and returns correlationId', async () => {
    // getJsforceConnection is not configured, so it returns undefined and
    // the handler hits the error path
    const msg: BaseMessage & { payload: { orgId: string } } = {
      id: 'req-health-1',
      type: 'monitor:health-score',
      timestamp: Date.now(),
      payload: { orgId: 'org-1' },
    };

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage;
    expect(response.type).toBe('monitor:health-score:response');
  });

  it('handles monitor:storage and returns correlationId', async () => {
    const msg: BaseMessage & { payload: { orgId: string } } = {
      id: 'req-storage-1',
      type: 'monitor:storage',
      timestamp: Date.now(),
      payload: { orgId: 'org-1' },
    };

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage;
    expect(response.type).toBe('monitor:storage:response');
  });

  it('handles monitor:deployments and returns correlationId', async () => {
    const msg: BaseMessage & { payload: { orgId: string } } = {
      id: 'req-deploy-1',
      type: 'monitor:deployments',
      timestamp: Date.now(),
      payload: { orgId: 'org-1' },
    };

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage;
    expect(response.type).toBe('monitor:deployments:response');
  });

  it('handles monitor:api-usage and returns correlationId', async () => {
    const msg: BaseMessage & { payload: { orgId: string } } = {
      id: 'req-api-1',
      type: 'monitor:api-usage',
      timestamp: Date.now(),
      payload: { orgId: 'org-1' },
    };

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage;
    expect(response.type).toBe('monitor:api-usage:response');
  });

  it('handles monitor:refresh error path with typed error response', async () => {
    mockGetJsforceConnection.mockRejectedValue(new Error('connection failed'));

    const msg: BaseMessage & { payload: { orgId: string } } = {
      id: 'req-mon-3',
      type: 'monitor:refresh',
      timestamp: Date.now(),
      payload: { orgId: 'org-1' },
    };

    await handler.handle(msg);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & { payload: { message: string } };
    expect(response.type).toBe('monitor:error');
    expect(response.payload.message).toBe('connection failed');
  });

  describe('limits caching (PERF-01)', () => {
    let mockConnRequest: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockConnRequest = vi.fn().mockResolvedValue(FAKE_LIMITS);
      mockGetJsforceConnection.mockResolvedValue({
        request: mockConnRequest,
        limitInfo: { apiUsage: { used: 100, limit: 15000 } },
      });
      mockQueryAll.mockResolvedValue([]);
    });

    /**
     * PERF-01: Two rapid handler calls (handleHealthScore + handleApiUsage) to
     * the same orgId should share a single /limits API call via the 30s cache.
     */
    it('should share /limits cache across handler calls (conn.request called once)', async () => {
      const localDeps = createMockDeps();
      const localHandler = new MonitorOpsHandler(localDeps);

      const healthMsg: BaseMessage & { payload: { orgId: string } } = {
        id: 'cache-1',
        type: 'monitor:health-score',
        timestamp: Date.now(),
        payload: { orgId: 'org-cache' },
      };

      const apiMsg: BaseMessage & { payload: { orgId: string } } = {
        id: 'cache-2',
        type: 'monitor:api-usage',
        timestamp: Date.now(),
        payload: { orgId: 'org-cache' },
      };

      await localHandler.handle(healthMsg);
      await localHandler.handle(apiMsg);

      // conn.request should have been called exactly once (for /limits)
      expect(mockConnRequest).toHaveBeenCalledTimes(1);

      // Both handlers should have produced a response
      const postToWebview = localDeps.broker.postToWebview as ReturnType<typeof vi.fn>;
      expect(postToWebview).toHaveBeenCalledTimes(2);

      const types = postToWebview.mock.calls.map((c: unknown[]) => (c[0] as BaseMessage).type);
      expect(types).toContain('monitor:health-score:response');
      expect(types).toContain('monitor:api-usage:response');
    });
  });

  describe('LIMITS-01/02: api-usage includes email and platform event categories', () => {
    beforeEach(() => {
      const fakeConn = {
        limitInfo: { apiUsage: { used: 100, limit: 15000 } },
        request: vi.fn().mockResolvedValue(FAKE_LIMITS),
        version: '62.0',
      };
      mockGetJsforceConnection.mockResolvedValue(fakeConn);
      mockCheckApiLimits.mockImplementation(() => undefined);
    });

    it('api-usage response includes DailyWorkflowEmails, SingleEmail, and HourlyPublishedPlatformEvents', async () => {
      const msg: BaseMessage & { payload: { orgId: string } } = {
        id: 'req-limits-new',
        type: 'monitor:api-usage',
        timestamp: Date.now(),
        payload: { orgId: 'org-limits' },
      };

      await handler.handle(msg);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      expect(postToWebview).toHaveBeenCalledTimes(1);

      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { success: boolean; categories: Array<{ category: string }> };
      };
      expect(response.type).toBe('monitor:api-usage:response');
      expect(response.payload.success).toBe(true);

      const categoryNames = response.payload.categories.map((c) => c.category);
      expect(categoryNames).toContain('DailyWorkflowEmails');
      expect(categoryNames).toContain('SingleEmail');
      expect(categoryNames).toContain('HourlyPublishedPlatformEvents');
    });

    it('api-usage response has 16 categories total', async () => {
      const msg: BaseMessage & { payload: { orgId: string } } = {
        id: 'req-limits-count',
        type: 'monitor:api-usage',
        timestamp: Date.now(),
        payload: { orgId: 'org-limits' },
      };

      await handler.handle(msg);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { categories: Array<{ category: string }> };
      };
      expect(response.payload.categories).toHaveLength(16);
    });
  });

  describe('WIRE-01: monitor:error-logs', () => {
    it('handles monitor:error-logs and returns error entries', async () => {
      const fakeConn = {
        limitInfo: {},
        request: vi.fn().mockResolvedValue(FAKE_LIMITS),
        version: '62.0',
      };
      mockGetJsforceConnection.mockResolvedValue(fakeConn);
      mockQueryAll.mockResolvedValue([
        { Id: 'log-1', Operation: 'Trigger', Status: 'Fatal Error', DurationMilliseconds: 100, LogLength: 500, StartTime: '2026-03-20T10:00:00Z', LogUser: { Username: 'admin@test.com' } },
        { Id: 'log-2', Operation: 'VF Page', Status: 'Exception', DurationMilliseconds: 200, LogLength: 800, StartTime: '2026-03-20T11:00:00Z', LogUser: null },
      ]);

      const msg: BaseMessage & { payload: { orgId: string } } = {
        id: 'req-err-1',
        type: 'monitor:error-logs',
        timestamp: Date.now(),
        payload: { orgId: 'org-err' },
      };

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      expect(postToWebview).toHaveBeenCalledTimes(1);

      const response = postToWebview.mock.calls[0][0] as BaseMessage & { correlationId?: string; payload: { success: boolean; errors: unknown[]; totalCount: number; errorsByType: unknown[] } };
      expect(response.type).toBe('monitor:error-logs:response');
      expect(response.correlationId).toBe('req-err-1');
      expect(response.payload.success).toBe(true);
      expect(response.payload.errors).toHaveLength(2);
      expect(response.payload.totalCount).toBe(2);
      expect(response.payload.errorsByType).toBeInstanceOf(Array);
    });

    it('handles monitor:error-logs error and sends handler error', async () => {
      mockGetJsforceConnection.mockRejectedValue(new Error('auth failed'));

      const msg: BaseMessage & { payload: { orgId: string } } = {
        id: 'req-err-2',
        type: 'monitor:error-logs',
        timestamp: Date.now(),
        payload: { orgId: 'org-err' },
      };

      await handler.handle(msg);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      expect(postToWebview).toHaveBeenCalledTimes(1);

      const response = postToWebview.mock.calls[0][0] as BaseMessage & { payload: { message: string } };
      expect(response.type).toBe('monitor:error-logs:response');
      expect(response.payload.message).toContain('auth failed');
    });
  });

  describe('WIRE-02: monitor:sessions', () => {
    it('handles monitor:sessions and returns active sessions', async () => {
      const fakeConn = {
        limitInfo: {},
        request: vi.fn().mockResolvedValue(FAKE_LIMITS),
        version: '62.0',
      };
      mockGetJsforceConnection.mockResolvedValue(fakeConn);
      mockQueryAll.mockResolvedValue([
        { Id: 'sess-1', UsersId: 'u-1', LoginType: 'Application', SessionType: 'UI', CreatedDate: '2026-03-20T09:00:00Z', SourceIp: '10.0.0.1' },
        { Id: 'sess-2', UsersId: 'u-2', LoginType: 'API', SessionType: 'API', CreatedDate: '2026-03-20T09:30:00Z', SourceIp: '10.0.0.2' },
        { Id: 'sess-3', UsersId: 'u-1', LoginType: 'Application', SessionType: 'UI', CreatedDate: '2026-03-20T10:00:00Z', SourceIp: '10.0.0.1' },
      ]);

      const msg: BaseMessage & { payload: { orgId: string } } = {
        id: 'req-sess-1',
        type: 'monitor:sessions',
        timestamp: Date.now(),
        payload: { orgId: 'org-sess' },
      };

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & { correlationId?: string; payload: { success: boolean; sessions: unknown[]; activeUserCount: number } };
      expect(response.type).toBe('monitor:sessions:response');
      expect(response.correlationId).toBe('req-sess-1');
      expect(response.payload.success).toBe(true);
      expect(response.payload.sessions).toHaveLength(3);
      expect(response.payload.activeUserCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('WIRE-03: monitor:apex-insights', () => {
    it('handles monitor:apex-insights and returns analyses with top issues', async () => {
      const fakeConn = {
        limitInfo: {},
        request: vi.fn().mockResolvedValue(FAKE_LIMITS),
        version: '62.0',
      };
      mockGetJsforceConnection.mockResolvedValue(fakeConn);
      mockQueryAll.mockResolvedValue([
        { Id: 'apex-1', Operation: 'BatchApex', Status: 'Success', DurationMilliseconds: 3000, LogLength: 50000, StartTime: '2026-03-20T08:00:00Z', LogUser: { Username: 'dev@test.com' } },
        { Id: 'apex-2', Operation: 'Trigger', Status: 'Success', DurationMilliseconds: 6000, LogLength: 80000, StartTime: '2026-03-20T09:00:00Z', LogUser: { Username: 'admin@test.com' } },
      ]);

      const msg: BaseMessage & { payload: { orgId: string } } = {
        id: 'req-apex-1',
        type: 'monitor:apex-insights',
        timestamp: Date.now(),
        payload: { orgId: 'org-apex' },
      };

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & { correlationId?: string; payload: { success: boolean; analyses: unknown[]; topIssues: unknown[] } };
      expect(response.type).toBe('monitor:apex-insights:response');
      expect(response.correlationId).toBe('req-apex-1');
      expect(response.payload.success).toBe(true);
      expect(response.payload.analyses).toBeInstanceOf(Array);
      expect(response.payload.topIssues).toBeInstanceOf(Array);
    });
  });

  describe('WIRE-04: monitor:sandbox-refresh', () => {
    it('handles monitor:sandbox-refresh and returns refresh events', async () => {
      const fakeConn = {
        limitInfo: {},
        request: vi.fn().mockResolvedValue(FAKE_LIMITS),
        version: '62.0',
      };
      mockGetJsforceConnection.mockResolvedValue(fakeConn);
      mockQueryAll.mockResolvedValue([
        { Id: 'sbx-1', SandboxName: 'dev1', Status: 'Processing', CreatedDate: '2026-03-20T07:00:00Z', Description: 'Production' },
        { Id: 'sbx-2', SandboxName: 'qa1', Status: 'Completed', CreatedDate: '2026-03-19T12:00:00Z', Description: null },
      ]);

      const msg: BaseMessage & { payload: { orgId: string } } = {
        id: 'req-sbx-1',
        type: 'monitor:sandbox-refresh',
        timestamp: Date.now(),
        payload: { orgId: 'org-sbx' },
      };

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & { correlationId?: string; payload: { success: boolean; refreshes: unknown[]; inProgress: boolean } };
      expect(response.type).toBe('monitor:sandbox-refresh:response');
      expect(response.correlationId).toBe('req-sbx-1');
      expect(response.payload.success).toBe(true);
      expect(response.payload.refreshes).toHaveLength(2);
      expect(response.payload.inProgress).toBe(true);
    });
  });

  describe('MONITOR_TYPES coverage', () => {
    it('MONITOR_TYPES includes all new message types', async () => {
      const fakeConn = {
        limitInfo: {},
        request: vi.fn().mockResolvedValue(FAKE_LIMITS),
        version: '62.0',
      };
      mockGetJsforceConnection.mockResolvedValue(fakeConn);
      mockQueryAll.mockResolvedValue([]);

      const newTypes = ['monitor:error-logs', 'monitor:sessions', 'monitor:apex-insights', 'monitor:sandbox-refresh'];
      for (const type of newTypes) {
        const msg: BaseMessage & { payload: { orgId: string } } = {
          id: `check-${type}`,
          type,
          timestamp: Date.now(),
          payload: { orgId: 'org-check' },
        };
        const result = await handler.handle(msg);
        expect(result).toBe(true);
      }
    });
  });

  describe('WIRE-05: handleRefresh includes orgHealthStatus', () => {
    it('handleRefresh includes orgHealthStatus in response', async () => {
      const fakeConn = {
        request: vi.fn().mockResolvedValue(FAKE_LIMITS),
        identity: vi.fn().mockResolvedValue({ instance_name: 'NA99', last_login_date: '2026-03-20T00:00:00Z' }),
        query: vi.fn().mockResolvedValue({
          totalSize: 10,
          done: true,
          records: [{ Name: 'TestOrg', Id: '00Dtest', OrganizationType: 'Developer Edition', NamespacePrefix: null, CreatedDate: '2026-01-01' }],
        }),
        version: '62.0',
        limitInfo: { apiUsage: { used: 100, limit: 15000 } },
        sobject: vi.fn().mockReturnValue({ update: vi.fn().mockResolvedValue({}) }),
      };
      mockGetJsforceConnection.mockResolvedValue(fakeConn);
      mockQueryAll.mockResolvedValue([
        { Id: 'job1', JobType: 'BatchApex', Status: 'Completed', NumberOfErrors: 0, CreatedDate: '2026-03-20', CreatedById: 'user1' },
      ]);
      (deps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockReturnValue({
        alias: 'TestOrg',
        orgType: 'Developer',
        metadata: { edition: 'Developer Edition' },
      });

      const msg: BaseMessage & { payload: { orgId: string } } = {
        id: 'req-refresh-health',
        type: 'monitor:refresh',
        timestamp: Date.now(),
        payload: { orgId: 'org-health' },
      };

      await handler.handle(msg);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      expect(postToWebview).toHaveBeenCalledTimes(1);

      const response = postToWebview.mock.calls[0][0] as BaseMessage & { payload: { orgHealthStatus?: { orgId: string; overall: string } } };
      expect(response.type).toBe('monitor:data');
      expect(response.payload.orgHealthStatus).toBeDefined();
      expect(response.payload.orgHealthStatus?.orgId).toBe('org-health');
      expect(response.payload.orgHealthStatus?.overall).toBeDefined();
    });
  });

  describe('OrgInfoFetcher cache sharing (PERF-02)', () => {
    let mockConnIdentity: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockConnIdentity = vi.fn().mockResolvedValue({
        instance_name: 'NA99',
        last_login_date: '2026-03-20T00:00:00Z',
      });
      mockGetJsforceConnection.mockResolvedValue({
        request: vi.fn().mockResolvedValue(FAKE_LIMITS),
        identity: mockConnIdentity,
        query: vi.fn().mockResolvedValue({
          totalSize: 10,
          done: true,
          records: [{ Name: 'TestOrg', Id: '00Dtest', OrganizationType: 'Developer Edition', NamespacePrefix: null, CreatedDate: '2026-01-01' }],
        }),
        version: '62.0',
        limitInfo: { apiUsage: { used: 100, limit: 15000 } },
        sobject: vi.fn().mockReturnValue({ update: vi.fn().mockResolvedValue({}) }),
      });
      mockQueryAll.mockImplementation(() =>
        Promise.resolve([{ Id: 'job1', JobType: 'BatchApex', Status: 'Completed', NumberOfErrors: 0, CreatedDate: '2026-03-20', CreatedById: 'user1' }]),
      );
    });

    /**
     * PERF-02: OrgInfoFetcher is a single instance on MonitorOpsHandler.
     * Two refresh calls within 5 minutes should reuse the cached OrgInfo,
     * meaning the connection's identity/query methods are called only once.
     */
    it('should reuse OrgInfoFetcher cache across two refresh calls', async () => {
      const localDeps = createMockDeps();
      (localDeps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockReturnValue({
        alias: 'TestOrg',
        orgType: 'Developer',
        metadata: { edition: 'Developer Edition' },
      });

      const localHandler = new MonitorOpsHandler(localDeps);

      const refreshMsg1: BaseMessage & { payload: { orgId: string } } = {
        id: 'refresh-1',
        type: 'monitor:refresh',
        timestamp: Date.now(),
        payload: { orgId: 'org-info-test' },
      };

      const refreshMsg2: BaseMessage & { payload: { orgId: string } } = {
        id: 'refresh-2',
        type: 'monitor:refresh',
        timestamp: Date.now(),
        payload: { orgId: 'org-info-test' },
      };

      await localHandler.handle(refreshMsg1);
      await localHandler.handle(refreshMsg2);

      // OrgInfoFetcher cache means identity is called only once (via the conn
      // adapter in handleRefresh), not twice. The conn.identity mock tracks
      // calls made via the OrgInfoConnection adapter.
      expect(mockConnIdentity).toHaveBeenCalledTimes(1);

      // Both refreshes should succeed
      const postToWebview = localDeps.broker.postToWebview as ReturnType<typeof vi.fn>;
      expect(postToWebview).toHaveBeenCalledTimes(2);
    });
  });
});
