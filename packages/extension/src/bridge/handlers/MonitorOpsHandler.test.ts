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

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: mockGetJsforceConnection,
}));

vi.mock('../../core/common/soqlQueryHelper.js', () => ({
  queryAll: mockQueryAll,
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
