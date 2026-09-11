import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MonitorOpsHandler } from './MonitorOpsHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import type { BaseMessage } from '@sandforge/shared';
import { inboundRequest } from '../../test/mockFactories.js';

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
    const msg: InboundRequest = inboundRequest({
      id: '1',
      type: 'unknown:type',
      timestamp: Date.now(),
    });
    const result = await handler.handle(msg);
    expect(result).toBe(false);
  });

  it('handles monitor:live-operations and response includes correlationId', async () => {
    const msg: InboundRequest = inboundRequest({
      id: 'req-mon-2',
      type: 'monitor:live-operations',
      timestamp: Date.now(),
    });

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      correlationId?: string;
      payload: { operations: unknown[] };
    };
    expect(response.type).toBe('monitor:live-operations:response');
    expect(response.correlationId).toBe('req-mon-2');
    expect(response.payload.operations).toEqual([]);
  });

  it('reports monitor:health-score failure on monitor:error, correlated', async () => {
    // getJsforceConnection is unconfigured, so the handler takes its error
    // path. That is the contract under test: a failure must land on the domain
    // error channel, correlated to the request — not on the :response channel,
    // where the webview reads the success shape and silently renders an empty
    // state instead of the failure.
    const msg: InboundRequest & { payload: { orgId: string } } = inboundRequest({
      id: 'req-health-1',
      type: 'monitor:health-score',
      timestamp: Date.now(),
      payload: { orgId: 'org-1' },
    });

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage;
    expect(response.type).toBe('monitor:error');
  });

  it('reports monitor:storage failure on monitor:error, correlated', async () => {
    const msg: InboundRequest & { payload: { orgId: string } } = inboundRequest({
      id: 'req-storage-1',
      type: 'monitor:storage',
      timestamp: Date.now(),
      payload: { orgId: 'org-1' },
    });

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage;
    expect(response.type).toBe('monitor:error');
  });

  it('reports monitor:deployments failure on monitor:error, correlated', async () => {
    const msg: InboundRequest & { payload: { orgId: string } } = inboundRequest({
      id: 'req-deploy-1',
      type: 'monitor:deployments',
      timestamp: Date.now(),
      payload: { orgId: 'org-1' },
    });

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage;
    expect(response.type).toBe('monitor:error');
  });

  it('reports monitor:api-usage failure on monitor:error, correlated', async () => {
    const msg: InboundRequest & { payload: { orgId: string } } = inboundRequest({
      id: 'req-api-1',
      type: 'monitor:api-usage',
      timestamp: Date.now(),
      payload: { orgId: 'org-1' },
    });

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage;
    expect(response.type).toBe('monitor:error');
  });

  it('handles monitor:refresh error path with typed error response', async () => {
    mockGetJsforceConnection.mockRejectedValue(new Error('connection failed'));

    const msg: InboundRequest & { payload: { orgId: string } } = inboundRequest({
      id: 'req-mon-3',
      type: 'monitor:refresh',
      timestamp: Date.now(),
      payload: { orgId: 'org-1' },
    });

    await handler.handle(msg);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { message: string };
    };
    expect(response.type).toBe('monitor:error');
    expect(response.payload.message).toBe('connection failed');
    // Correlated so a second Monitor panel can drop the stale error.
    expect(response.correlationId).toBe('req-mon-3');
  });

  it('emits monitor:error (not a silent hang) when the org call stalls past the bound', async () => {
    vi.useFakeTimers();
    try {
      // Org call never resolves: the 25 s bound must fire before the webview
      // 30 s bridge timeout so the user gets a real error message.
      mockGetJsforceConnection.mockReturnValue(new Promise(() => {}));

      const msg: InboundRequest & { payload: { orgId: string } } = inboundRequest({
        id: 'req-mon-timeout',
        type: 'monitor:refresh',
        timestamp: Date.now(),
        payload: { orgId: 'org-1' },
      });

      const handlePromise = handler.handle(msg);
      await vi.advanceTimersByTimeAsync(25_000);
      await handlePromise;

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      expect(postToWebview).toHaveBeenCalledTimes(1);

      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { message: string };
      };
      expect(response.type).toBe('monitor:error');
      expect(response.payload.message).toContain('monitor:refresh');
      expect(response.payload.message).toContain('timed out');
      // Correlated so a second Monitor panel can drop the stale error.
      expect(response.correlationId).toBe('req-mon-timeout');
    } finally {
      vi.useRealTimers();
    }
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

      const healthMsg: InboundRequest & { payload: { orgId: string } } = inboundRequest({
        id: 'cache-1',
        type: 'monitor:health-score',
        timestamp: Date.now(),
        payload: { orgId: 'org-cache' },
      });

      const apiMsg: InboundRequest & { payload: { orgId: string } } = inboundRequest({
        id: 'cache-2',
        type: 'monitor:api-usage',
        timestamp: Date.now(),
        payload: { orgId: 'org-cache' },
      });

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
      const msg: InboundRequest & { payload: { orgId: string } } = inboundRequest({
        id: 'req-limits-new',
        type: 'monitor:api-usage',
        timestamp: Date.now(),
        payload: { orgId: 'org-limits' },
      });

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
      const msg: InboundRequest & { payload: { orgId: string } } = inboundRequest({
        id: 'req-limits-count',
        type: 'monitor:api-usage',
        timestamp: Date.now(),
        payload: { orgId: 'org-limits' },
      });

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
        {
          Id: 'log-1',
          Operation: 'Trigger',
          Status: 'Fatal Error',
          DurationMilliseconds: 100,
          LogLength: 500,
          StartTime: '2026-03-20T10:00:00Z',
          LogUser: { Username: 'admin@test.com' },
        },
        {
          Id: 'log-2',
          Operation: 'VF Page',
          Status: 'Exception',
          DurationMilliseconds: 200,
          LogLength: 800,
          StartTime: '2026-03-20T11:00:00Z',
          LogUser: null,
        },
      ]);

      const msg: InboundRequest & { payload: { orgId: string } } = inboundRequest({
        id: 'req-err-1',
        type: 'monitor:error-logs',
        timestamp: Date.now(),
        payload: { orgId: 'org-err' },
      });

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      expect(postToWebview).toHaveBeenCalledTimes(1);

      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        correlationId?: string;
        payload: {
          success: boolean;
          errors: unknown[];
          totalCount: number;
          errorsByType: unknown[];
        };
      };
      expect(response.type).toBe('monitor:error-logs:response');
      expect(response.correlationId).toBe('req-err-1');
      expect(response.payload.success).toBe(true);
      expect(response.payload.errors).toHaveLength(2);
      expect(response.payload.totalCount).toBe(2);
      expect(response.payload.errorsByType).toBeInstanceOf(Array);
    });

    it('handles monitor:error-logs error and sends handler error', async () => {
      mockGetJsforceConnection.mockRejectedValue(new Error('auth failed'));

      const msg: InboundRequest & { payload: { orgId: string } } = inboundRequest({
        id: 'req-err-2',
        type: 'monitor:error-logs',
        timestamp: Date.now(),
        payload: { orgId: 'org-err' },
      });

      await handler.handle(msg);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      expect(postToWebview).toHaveBeenCalledTimes(1);

      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        correlationId?: string;
        payload: { message: string };
      };
      // The failure must reach the domain error channel: posted on
      // :response it would be read as a success payload and render as an
      // empty log list, indistinguishable from an org with no errors.
      expect(response.type).toBe('monitor:error');
      expect(response.correlationId).toBe('req-err-2');
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
        {
          Id: 'sess-1',
          UsersId: 'u-1',
          LoginType: 'Application',
          SessionType: 'UI',
          CreatedDate: '2026-03-20T09:00:00Z',
          SourceIp: '10.0.0.1',
        },
        {
          Id: 'sess-2',
          UsersId: 'u-2',
          LoginType: 'API',
          SessionType: 'API',
          CreatedDate: '2026-03-20T09:30:00Z',
          SourceIp: '10.0.0.2',
        },
        {
          Id: 'sess-3',
          UsersId: 'u-1',
          LoginType: 'Application',
          SessionType: 'UI',
          CreatedDate: '2026-03-20T10:00:00Z',
          SourceIp: '10.0.0.1',
        },
      ]);

      const msg: InboundRequest & { payload: { orgId: string } } = inboundRequest({
        id: 'req-sess-1',
        type: 'monitor:sessions',
        timestamp: Date.now(),
        payload: { orgId: 'org-sess' },
      });

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        correlationId?: string;
        payload: {
          success: boolean;
          sessions: unknown[];
          activeUserCount: number;
        };
      };
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
        {
          Id: 'apex-1',
          Operation: 'BatchApex',
          Status: 'Success',
          DurationMilliseconds: 3000,
          LogLength: 50000,
          StartTime: '2026-03-20T08:00:00Z',
          LogUser: { Username: 'dev@test.com' },
        },
        {
          Id: 'apex-2',
          Operation: 'Trigger',
          Status: 'Success',
          DurationMilliseconds: 6000,
          LogLength: 80000,
          StartTime: '2026-03-20T09:00:00Z',
          LogUser: { Username: 'admin@test.com' },
        },
      ]);

      const msg: InboundRequest & { payload: { orgId: string } } = inboundRequest({
        id: 'req-apex-1',
        type: 'monitor:apex-insights',
        timestamp: Date.now(),
        payload: { orgId: 'org-apex' },
      });

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        correlationId?: string;
        payload: {
          success: boolean;
          analyses: unknown[];
          topIssues: unknown[];
        };
      };
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
        {
          Id: 'sbx-1',
          SandboxName: 'dev1',
          Status: 'Processing',
          CreatedDate: '2026-03-20T07:00:00Z',
          Description: 'Production',
        },
        {
          Id: 'sbx-2',
          SandboxName: 'qa1',
          Status: 'Completed',
          CreatedDate: '2026-03-19T12:00:00Z',
          Description: null,
        },
      ]);

      const msg: InboundRequest & { payload: { orgId: string } } = inboundRequest({
        id: 'req-sbx-1',
        type: 'monitor:sandbox-refresh',
        timestamp: Date.now(),
        payload: { orgId: 'org-sbx' },
      });

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        correlationId?: string;
        payload: {
          success: boolean;
          refreshes: unknown[];
          inProgress: boolean;
        };
      };
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

      const newTypes = [
        'monitor:error-logs',
        'monitor:sessions',
        'monitor:apex-insights',
        'monitor:sandbox-refresh',
      ];
      for (const type of newTypes) {
        const msg: InboundRequest & { payload: { orgId: string } } = inboundRequest({
          id: `check-${type}`,
          type,
          timestamp: Date.now(),
          payload: { orgId: 'org-check' },
        });
        const result = await handler.handle(msg);
        expect(result).toBe(true);
      }
    });
  });

  describe('WIRE-05: handleRefresh includes orgHealthStatus', () => {
    it('handleRefresh includes orgHealthStatus in response', async () => {
      const fakeConn = {
        request: vi.fn().mockResolvedValue(FAKE_LIMITS),
        identity: vi.fn().mockResolvedValue({
          instance_name: 'NA99',
          last_login_date: '2026-03-20T00:00:00Z',
        }),
        query: vi.fn().mockResolvedValue({
          totalSize: 10,
          done: true,
          records: [
            {
              Name: 'TestOrg',
              Id: '00Dtest',
              OrganizationType: 'Developer Edition',
              NamespacePrefix: null,
              CreatedDate: '2026-01-01',
            },
          ],
        }),
        version: '62.0',
        limitInfo: { apiUsage: { used: 100, limit: 15000 } },
        sobject: vi.fn().mockReturnValue({ update: vi.fn().mockResolvedValue({}) }),
      };
      mockGetJsforceConnection.mockResolvedValue(fakeConn);
      mockQueryAll.mockResolvedValue([
        {
          Id: 'job1',
          JobType: 'BatchApex',
          Status: 'Completed',
          NumberOfErrors: 0,
          CreatedDate: '2026-03-20',
          CreatedById: 'user1',
        },
      ]);
      (deps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockReturnValue({
        alias: 'TestOrg',
        orgType: 'Developer',
        metadata: { edition: 'Developer Edition' },
      });

      const msg: InboundRequest & { payload: { orgId: string } } = inboundRequest({
        id: 'req-refresh-health',
        type: 'monitor:refresh',
        timestamp: Date.now(),
        payload: { orgId: 'org-health' },
      });

      await handler.handle(msg);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      expect(postToWebview).toHaveBeenCalledTimes(1);

      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { orgHealthStatus?: { orgId: string; overall: string } };
      };
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
          records: [
            {
              Name: 'TestOrg',
              Id: '00Dtest',
              OrganizationType: 'Developer Edition',
              NamespacePrefix: null,
              CreatedDate: '2026-01-01',
            },
          ],
        }),
        version: '62.0',
        limitInfo: { apiUsage: { used: 100, limit: 15000 } },
        sobject: vi.fn().mockReturnValue({ update: vi.fn().mockResolvedValue({}) }),
      });
      mockQueryAll.mockImplementation(() =>
        Promise.resolve([
          {
            Id: 'job1',
            JobType: 'BatchApex',
            Status: 'Completed',
            NumberOfErrors: 0,
            CreatedDate: '2026-03-20',
            CreatedById: 'user1',
          },
        ]),
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

      const refreshMsg1: InboundRequest & { payload: { orgId: string } } = inboundRequest({
        id: 'refresh-1',
        type: 'monitor:refresh',
        timestamp: Date.now(),
        payload: { orgId: 'org-info-test' },
      });

      const refreshMsg2: InboundRequest & { payload: { orgId: string } } = inboundRequest({
        id: 'refresh-2',
        type: 'monitor:refresh',
        timestamp: Date.now(),
        payload: { orgId: 'org-info-test' },
      });

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

  describe('ALERT-01: AlertEngine integration', () => {
    it('constructor seeds default alert definitions when no persisted definitions exist', () => {
      const localDeps = createMockDeps();
      new MonitorOpsHandler(localDeps);

      // The constructor should have called configStore.set to persist default definitions
      const setCalls = (localDeps.configStore.set as ReturnType<typeof vi.fn>).mock.calls;
      const defSaveCall = setCalls.find((c: unknown[]) => c[0] === 'alert:state:definitions');
      expect(defSaveCall).toBeDefined();
    });

    it('handleRefresh evaluates alerts for each limit', async () => {
      // Set up fake limits with API at 95% usage (should trigger alert)
      const highUsageLimits = {
        ...FAKE_LIMITS,
        DailyApiRequests: { Max: 15000, Remaining: 750 }, // 95% used
      };
      const fakeConn = {
        request: vi.fn().mockResolvedValue(highUsageLimits),
        identity: vi.fn().mockResolvedValue({
          instance_name: 'NA99',
          last_login_date: '2026-03-20T00:00:00Z',
        }),
        query: vi.fn().mockResolvedValue({
          totalSize: 10,
          done: true,
          records: [
            {
              Name: 'TestOrg',
              Id: '00Dtest',
              OrganizationType: 'Developer Edition',
              NamespacePrefix: null,
              CreatedDate: '2026-01-01',
            },
          ],
        }),
        version: '62.0',
        limitInfo: { apiUsage: { used: 14250, limit: 15000 } },
        sobject: vi.fn().mockReturnValue({ update: vi.fn().mockResolvedValue({}) }),
      };
      mockGetJsforceConnection.mockResolvedValue(fakeConn);
      mockQueryAll.mockResolvedValue([]);
      (deps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockReturnValue({
        alias: 'TestOrg',
        orgType: 'Developer',
        metadata: { edition: 'Developer Edition' },
      });

      const msg: InboundRequest & { payload: { orgId: string } } = inboundRequest({
        id: 'req-alert-refresh',
        type: 'monitor:refresh',
        timestamp: Date.now(),
        payload: { orgId: 'org-alert' },
      });

      await handler.handle(msg);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      // Should have at least the monitor:data response + notification for the alert
      const types = postToWebview.mock.calls.map((c: unknown[]) => (c[0] as BaseMessage).type);
      expect(types).toContain('monitor:data');
      // Notification sent for the triggered critical alert
      expect(types).toContain('notification');
    });
  });

  describe('ALERT-02: monitor:alerts handler', () => {
    it('handles monitor:alerts and returns alerts:result with alerts and history', async () => {
      const msg: InboundRequest = inboundRequest({
        id: 'req-alerts-1',
        type: 'monitor:alerts',
        timestamp: Date.now(),
      });

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const calls = postToWebview.mock.calls.filter(
        (c: unknown[]) => (c[0] as BaseMessage).type === 'monitor:alerts:result',
      );
      expect(calls).toHaveLength(1);

      const response = calls[0][0] as BaseMessage & {
        correlationId?: string;
        payload: { alerts: unknown[]; history: unknown[] };
      };
      expect(response.correlationId).toBe('req-alerts-1');
      expect(response.payload.alerts).toBeInstanceOf(Array);
      expect(response.payload.history).toBeInstanceOf(Array);
    });
  });

  describe('ALERT-03: monitor:alert:acknowledge handler', () => {
    it('handles monitor:alert:acknowledge and responds with success', async () => {
      const msg: InboundRequest & { payload: { alertId: string } } = inboundRequest({
        id: 'req-ack-1',
        type: 'monitor:alert:acknowledge',
        timestamp: Date.now(),
        payload: { alertId: 'alert-1' },
      });

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const calls = postToWebview.mock.calls.filter(
        (c: unknown[]) => (c[0] as BaseMessage).type === 'monitor:alert:acknowledge:response',
      );
      expect(calls).toHaveLength(1);

      const response = calls[0][0] as BaseMessage & {
        payload: { success: boolean };
      };
      expect(response.payload.success).toBe(true);
    });
  });

  describe('ALERT-04: monitor:alert:dismiss handler', () => {
    it('handles monitor:alert:dismiss and responds with success', async () => {
      const msg: InboundRequest & { payload: { alertId: string } } = inboundRequest({
        id: 'req-dismiss-1',
        type: 'monitor:alert:dismiss',
        timestamp: Date.now(),
        payload: { alertId: 'alert-1' },
      });

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const calls = postToWebview.mock.calls.filter(
        (c: unknown[]) => (c[0] as BaseMessage).type === 'monitor:alert:dismiss:response',
      );
      expect(calls).toHaveLength(1);

      const response = calls[0][0] as BaseMessage & {
        payload: { success: boolean };
      };
      expect(response.payload.success).toBe(true);
    });
  });

  describe('ALERT-05: MONITOR_TYPES includes alert types', () => {
    it('handles all three alert message types', async () => {
      const alertTypes = ['monitor:alerts', 'monitor:alert:acknowledge', 'monitor:alert:dismiss'];
      for (const type of alertTypes) {
        const msg: InboundRequest & { payload: { alertId?: string } } = inboundRequest({
          id: `check-${type}`,
          type,
          timestamp: Date.now(),
          payload: { alertId: 'alert-1' },
        });
        const result = await handler.handle(msg);
        expect(result).toBe(true);
      }
    });
  });

  describe('payload validation', () => {
    it('rejects monitor:abort-job with a malformed jobId', async () => {
      const msg = inboundRequest({
        id: 'bad-job',
        type: 'monitor:abort-job',
        timestamp: Date.now(),
        payload: { orgId: 'org-1', jobId: 'not a job id' },
      } as unknown as import('@sandforge/shared').BaseMessage);

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const errMsg = postToWebview.mock.calls[0][0] as {
        type: string;
        payload: { code: string };
      };
      expect(errMsg.type).toBe('monitor:error');
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
    });

    it('rejects monitor:refresh without orgId', async () => {
      const msg = inboundRequest({
        id: 'bad-refresh',
        type: 'monitor:refresh',
        timestamp: Date.now(),
        payload: {},
      } as unknown as import('@sandforge/shared').BaseMessage);

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const errMsg = postToWebview.mock.calls[0][0] as {
        payload: { code: string };
      };
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
    });
  });

  describe('PERF-07: one AsyncApexJob query per refresh tick', () => {
    /** One recent job row, shaped as the AsyncApexJob SOQL reads it. */
    const JOB_ROW = {
      Id: '707x00000000001',
      JobType: 'BatchApex',
      Status: 'Failed',
      NumberOfErrors: 3,
      CreatedDate: '2026-03-20T10:00:00Z',
      CreatedById: '005x00000000001',
    };

    /**
     * The module-level `queryAll` mock swallows the connection, which is where
     * the duplicate is visible. This implementation mirrors the real helper --
     * one `conn.query`, then its records -- so every SOQL the refresh runs is
     * counted on the connection.
     */
    function routeQueryAllThroughConnection(): void {
      mockQueryAll.mockImplementation(
        async (conn: { query: (soql: string) => Promise<unknown> }, soql: string) => {
          const result = (await conn.query(soql)) as { records: unknown[] };
          return result.records;
        },
      );
    }

    function createFakeConn(): { query: ReturnType<typeof vi.fn> } & Record<string, unknown> {
      const query = vi.fn((soql: string) => {
        if (soql.includes('FROM AsyncApexJob')) {
          return Promise.resolve({
            done: true,
            totalSize: 1,
            records: [JOB_ROW],
          });
        }
        if (soql.includes('FROM Organization')) {
          return Promise.resolve({
            done: true,
            totalSize: 1,
            records: [
              {
                Name: 'TestOrg',
                Id: '00Dtest',
                OrganizationType: 'Developer Edition',
                NamespacePrefix: null,
                CreatedDate: '2026-01-01',
              },
            ],
          });
        }
        return Promise.resolve({ done: true, totalSize: 0, records: [] });
      });
      return {
        query,
        request: vi.fn().mockResolvedValue(FAKE_LIMITS),
        identity: vi.fn().mockResolvedValue({
          instance_name: 'NA99',
          last_login_date: '2026-03-20T00:00:00Z',
        }),
        version: '62.0',
        limitInfo: { apiUsage: { used: 100, limit: 15000 } },
      };
    }

    /**
     * The refresh payload and the health check's jobs signal read the same
     * AsyncApexJob window. Asking the org for it twice is a third of the tick's
     * API calls spent on data already in hand -- on the very tool whose job is
     * to warn about the API budget.
     */
    it('asks the org for the job list once, not once per consumer', async () => {
      routeQueryAllThroughConnection();
      const fakeConn = createFakeConn();
      mockGetJsforceConnection.mockResolvedValue(fakeConn);

      const localDeps = createMockDeps();
      (localDeps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockReturnValue({
        alias: 'TestOrg',
        orgType: 'Developer',
        metadata: { edition: 'Developer Edition' },
      });
      const localHandler = new MonitorOpsHandler(localDeps);

      await localHandler.handle(
        inboundRequest({
          id: 'perf-07',
          type: 'monitor:refresh',
          timestamp: Date.now(),
          payload: { orgId: 'org-perf-07' },
        } as BaseMessage),
      );

      const jobQueries = fakeConn.query.mock.calls.filter((c: unknown[]) =>
        String(c[0]).includes('FROM AsyncApexJob'),
      );
      expect(jobQueries).toHaveLength(1);
    });

    /** The saved call must not cost the health check its jobs signal. */
    it('still scores the failed job in orgHealthStatus from the reused rows', async () => {
      routeQueryAllThroughConnection();
      mockGetJsforceConnection.mockResolvedValue(createFakeConn());

      const localDeps = createMockDeps();
      (localDeps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockReturnValue({
        alias: 'TestOrg',
        orgType: 'Developer',
        metadata: { edition: 'Developer Edition' },
      });
      const localHandler = new MonitorOpsHandler(localDeps);

      await localHandler.handle(
        inboundRequest({
          id: 'perf-07-signal',
          type: 'monitor:refresh',
          timestamp: Date.now(),
          payload: { orgId: 'org-perf-07-signal' },
        } as BaseMessage),
      );

      const postToWebview = localDeps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const data = postToWebview.mock.calls
        .map(
          (c: unknown[]) =>
            c[0] as BaseMessage & {
              payload: { orgHealthStatus?: { activeJobs: number } };
            },
        )
        .find((m) => m.type === 'monitor:data');
      expect(data).toBeDefined();
      // jobsProvider: score 100 - failed * 10 = 90, surfaced as activeJobs 10.
      // A cache miss would have re-queried and scored the same, so this only
      // guards against the reuse handing the provider an empty result set.
      expect(data?.payload.orgHealthStatus?.activeJobs).toBe(10);
    });
  });

  describe('EXT-09: a refresh that outlives its bound', () => {
    /** The handler's refresh bound, kept below the webview's 30 s bridge timeout. */
    const MONITOR_REFRESH_BOUND_MS = 25_000;

    /**
     * Past the 25 s bound the request already carries a monitor:error and the
     * webview has closed the correlation: a late monitor:data is dropped on
     * arrival, leaving a permanent error banner on a refresh that worked.
     * The handler must stop at the bound instead of finishing the tick and
     * posting a reply nobody can receive.
     */
    it('posts no second reply and stops calling the org once the bound has fired', async () => {
      vi.useFakeTimers();
      try {
        const fakeConn = {
          request: vi.fn().mockResolvedValue(FAKE_LIMITS),
          identity: vi.fn().mockResolvedValue({
            instance_name: 'NA99',
            last_login_date: '2026-03-20T00:00:00Z',
          }),
          query: vi.fn().mockResolvedValue({ done: true, totalSize: 0, records: [] }),
          version: '62.0',
          limitInfo: { apiUsage: { used: 100, limit: 15000 } },
        };
        mockGetJsforceConnection.mockResolvedValue(fakeConn);
        // The refresh's own job query lands one second after the bound has
        // fired; every later query (org info, then the health check's own job
        // read) is instant, so the abandoned continuation runs to its end.
        let jobQueryCount = 0;
        mockQueryAll.mockImplementation((_conn: unknown, soql: string) => {
          if (!String(soql).includes('FROM AsyncApexJob')) return Promise.resolve([]);
          jobQueryCount += 1;
          return jobQueryCount === 1
            ? new Promise((resolve) => setTimeout(() => resolve([]), 26_000))
            : Promise.resolve([]);
        });

        const localDeps = createMockDeps();
        (localDeps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockReturnValue({
          alias: 'TestOrg',
          orgType: 'Developer',
          metadata: { edition: 'Developer Edition' },
        });
        const localHandler = new MonitorOpsHandler(localDeps);

        const handlePromise = localHandler.handle(
          inboundRequest({
            id: 'req-ext-09',
            type: 'monitor:refresh',
            timestamp: Date.now(),
            payload: { orgId: 'org-ext-09' },
          } as BaseMessage),
        );

        await vi.advanceTimersByTimeAsync(MONITOR_REFRESH_BOUND_MS);
        await handlePromise;

        const postToWebview = localDeps.broker.postToWebview as ReturnType<typeof vi.fn>;
        expect(postToWebview).toHaveBeenCalledTimes(1);
        expect((postToWebview.mock.calls[0][0] as BaseMessage).type).toBe('monitor:error');
        const orgCallsAtBound = mockQueryAll.mock.calls.length;

        // The slow query now resolves. Everything after it is spent on a
        // request that is already closed.
        await vi.advanceTimersByTimeAsync(5_000);
        // Drain the abandoned continuation: it is a long await chain (org info,
        // then the four health providers) with no timers left in it.
        for (let i = 0; i < 100; i += 1) {
          await Promise.resolve();
        }

        expect(postToWebview).toHaveBeenCalledTimes(1);
        expect(mockQueryAll.mock.calls.length).toBe(orgCallsAtBound);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  /* ------------------------------------------------------------------ */
  /* Job insights — the producer behind the critical-alert band          */
  /* ------------------------------------------------------------------ */

  describe('monitor:data job insights', () => {
    /** One AsyncApexJob row, as the monitor refresh's SOQL reads it. */
    interface JobRow {
      Id: string;
      JobType: string;
      Status: string;
      NumberOfErrors: number;
      JobItemsProcessed: number;
      TotalJobItems: number | null;
      CreatedDate: string;
      CreatedById: string;
    }

    interface Insight {
      type: string;
      severity: string;
      title: string;
      detail: string;
      affectedJobs: string[];
      recommendation: string;
    }

    interface RefreshPayload {
      jobInsights?: Insight[];
      jobs: Array<Record<string, unknown>>;
    }

    /** Fixed origin for every scenario, so each minute offset is exact. */
    const T0 = Date.parse('2026-09-01T08:00:00Z');

    /** ISO timestamp `minutes` after {@link T0} (negative: before it). */
    function at(minutes: number): string {
      return new Date(T0 + minutes * 60_000).toISOString();
    }

    function jobRow(over: Partial<JobRow> = {}): JobRow {
      return {
        Id: '707x00000000000',
        JobType: 'BatchApex',
        Status: 'Completed',
        NumberOfErrors: 0,
        JobItemsProcessed: 0,
        TotalJobItems: 0,
        CreatedDate: at(0),
        CreatedById: '005x00000000001',
        ...over,
      };
    }

    const stuckIds = (payload: RefreshPayload): string[] =>
      (payload.jobInsights ?? []).filter((i) => i.type === 'stuck').map((i) => i.affectedJobs[0]);

    const critical = (payload: RefreshPayload): Insight[] =>
      (payload.jobInsights ?? []).filter((i) => i.severity === 'critical');

    const unfinished = (payload: RefreshPayload): Insight | undefined =>
      (payload.jobInsights ?? []).find((i) => i.type === 'long_running');

    /**
     * One handler watching one org across several refreshes, the way the
     * Monitor page's refresh button and auto-refresh drive it. Only `Date` is
     * faked, so each refresh happens at the minute the scenario names while
     * the refresh bound's real timer is left alone. Every SOQL goes through
     * the connection, the level the shared job-query reuse acts on.
     */
    function watchOrg(): {
      refreshAt: (minute: number, rows: JobRow[]) => Promise<RefreshPayload>;
      jobSoql: () => string[];
    } {
      let rows: JobRow[] = [];
      const query = vi.fn((soql: string) => {
        if (soql.includes('FROM AsyncApexJob')) {
          return Promise.resolve({ done: true, totalSize: rows.length, records: rows });
        }
        if (soql.includes('FROM Organization')) {
          return Promise.resolve({
            done: true,
            totalSize: 1,
            records: [
              {
                Name: 'TestOrg',
                Id: '00Dtest',
                OrganizationType: 'Developer Edition',
                NamespacePrefix: null,
                CreatedDate: '2026-01-01',
              },
            ],
          });
        }
        return Promise.resolve({ done: true, totalSize: 0, records: [] });
      });
      mockGetJsforceConnection.mockResolvedValue({
        query,
        request: vi.fn().mockResolvedValue(FAKE_LIMITS),
        identity: vi.fn().mockResolvedValue({
          instance_name: 'NA99',
          last_login_date: '2026-03-20T00:00:00Z',
        }),
        version: '62.0',
        limitInfo: { apiUsage: { used: 100, limit: 15000 } },
      });
      mockQueryAll.mockImplementation(
        async (conn: { query: (soql: string) => Promise<unknown> }, soql: string) => {
          const result = (await conn.query(soql)) as { records: unknown[] };
          return result.records;
        },
      );

      const localDeps = createMockDeps();
      (localDeps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockReturnValue({
        alias: 'TestOrg',
        orgType: 'Developer',
        metadata: { edition: 'Developer Edition' },
      });
      const localHandler = new MonitorOpsHandler(localDeps);
      const postToWebview = localDeps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const dataReplies = (): RefreshPayload[] =>
        postToWebview.mock.calls
          .map((c: unknown[]) => c[0] as BaseMessage & { payload: RefreshPayload })
          .filter((m) => m.type === 'monitor:data')
          .map((m) => m.payload);
      let tick = 0;

      return {
        async refreshAt(minute, nextRows) {
          rows = nextRows;
          vi.setSystemTime(T0 + minute * 60_000);
          const before = dataReplies().length;
          tick += 1;
          await localHandler.handle(
            inboundRequest({
              id: `req-insights-${tick}`,
              type: 'monitor:refresh',
              timestamp: Date.now(),
              payload: { orgId: 'org-insights' },
            } as BaseMessage),
          );
          const replies = dataReplies();
          expect(replies).toHaveLength(before + 1);
          return replies[replies.length - 1];
        },
        jobSoql: () =>
          query.mock.calls
            .map((c: unknown[]) => String(c[0]))
            .filter((soql) => soql.includes('FROM AsyncApexJob')),
      };
    }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(T0);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    /**
     * An absent field and an empty array read the same in the webview only if
     * the producer never emits one of them. It always emits the array: `[]` is
     * the scan's verdict, `undefined` would mean nobody scanned.
     */
    it('emits an insights array even when the org ran no jobs at all', async () => {
      const payload = await watchOrg().refreshAt(0, []);

      expect(payload.jobs).toHaveLength(0);
      expect(payload.jobInsights).toBeInstanceOf(Array);
      expect(payload.jobInsights).toHaveLength(0);
    });

    /** Healthy jobs earn silence — but a silence that was computed. */
    it('says nothing about a window of healthy jobs', async () => {
      const payload = await watchOrg().refreshAt(0, [
        jobRow({ Id: '707x1', Status: 'Completed', CreatedDate: at(-90) }),
        jobRow({ Id: '707x2', Status: 'Completed', CreatedDate: at(-40) }),
        // In flight for 5 minutes, first sighting: nothing to say yet.
        jobRow({
          Id: '707x3',
          Status: 'Processing',
          JobItemsProcessed: 2,
          TotalJobItems: 10,
          CreatedDate: at(-5),
        }),
        // One isolated failure is an incident, not a pattern.
        jobRow({ Id: '707x4', Status: 'Failed', NumberOfErrors: 1, CreatedDate: at(-20) }),
      ]);

      expect(payload.jobs).toHaveLength(4);
      expect(payload.jobInsights).toEqual([]);
      // The batch counters feed the insights only: the jobs contract the page
      // reads keeps its shape.
      expect(Object.keys(payload.jobs[0]).sort()).toEqual([
        'createdBy',
        'createdDate',
        'failedRecords',
        'id',
        'jobType',
        'status',
      ]);
    });

    /**
     * Under the repeat threshold nothing fires. Paired with the test below,
     * this is what makes the threshold load-bearing: neutralise it (drop it to
     * 1, or count any failure) and this test goes red.
     */
    it('stays silent at two failures of the same job type', async () => {
      const payload = await watchOrg().refreshAt(0, [
        jobRow({ Id: '707x1', JobType: 'BatchApex', Status: 'Failed', NumberOfErrors: 2 }),
        jobRow({ Id: '707x2', JobType: 'BatchApex', Status: 'Failed', NumberOfErrors: 1 }),
        jobRow({ Id: '707x3', JobType: 'Queueable', Status: 'Failed', NumberOfErrors: 1 }),
      ]);

      expect(payload.jobInsights).toEqual([]);
    });

    /** Three failures of one job type is a pattern, not bad luck. */
    it('flags three failures of the same job type as a repeated failure', async () => {
      const payload = await watchOrg().refreshAt(0, [
        jobRow({ Id: '707x1', JobType: 'BatchApex', Status: 'Failed', NumberOfErrors: 4 }),
        jobRow({ Id: '707x2', JobType: 'BatchApex', Status: 'Failed', NumberOfErrors: 2 }),
        // Completed, but with failed batch executions inside: still a failure.
        jobRow({ Id: '707x3', JobType: 'BatchApex', Status: 'Completed', NumberOfErrors: 7 }),
        jobRow({ Id: '707x4', JobType: 'Queueable', Status: 'Completed', NumberOfErrors: 0 }),
      ]);

      const repeated = payload.jobInsights?.find((i) => i.type === 'frequent_failures');
      expect(repeated).toBeDefined();
      expect(repeated!.severity).toBe('critical');
      expect(repeated!.affectedJobs).toEqual(['707x1', '707x2', '707x3']);
      expect(repeated!.title).toContain('BatchApex');
      expect(repeated!.detail).toContain('4');
    });

    /**
     * A user-aborted job is a decision, not a failure to report back. The rows
     * carry a non-zero NumberOfErrors on purpose: with zero, the error-count
     * check would drop them on its own and the Aborted guard would be
     * untested.
     */
    it('does not count aborted jobs as failures, even aborted jobs that logged errors', async () => {
      const payload = await watchOrg().refreshAt(0, [
        jobRow({ Id: '707x1', JobType: 'BatchApex', Status: 'Aborted', NumberOfErrors: 2 }),
        jobRow({ Id: '707x2', JobType: 'BatchApex', Status: 'Aborted', NumberOfErrors: 5 }),
        jobRow({ Id: '707x3', JobType: 'BatchApex', Status: 'Aborted', NumberOfErrors: 1 }),
      ]);

      expect(payload.jobInsights).toEqual([]);
    });

    /**
     * Three hours since submission, seen once. Nothing here says the job
     * stopped moving: CreatedDate counts every minute spent queued, and a big
     * batch legitimately runs for hours. Unfinished is all it is.
     */
    it('does not call a job stuck on its age alone', async () => {
      const payload = await watchOrg().refreshAt(0, [
        jobRow({
          Id: '707xOLD',
          Status: 'Processing',
          JobItemsProcessed: 3,
          TotalJobItems: 10,
          CreatedDate: at(-190),
        }),
      ]);

      expect(critical(payload)).toEqual([]);
      expect(unfinished(payload)?.severity).toBe('warning');
      expect(unfinished(payload)?.affectedJobs).toEqual(['707xOLD']);
    });

    /**
     * The one proof of a stall a snapshot window can give: the batch counter
     * only ever goes up, so the same value at two sightings an hour apart
     * means no batch completed in between.
     */
    it('calls a batch stuck once its batch counter has not moved across an hour of watching', async () => {
      const org = watchOrg();
      const row = jobRow({
        Id: '707xSTALL',
        Status: 'Processing',
        JobItemsProcessed: 3,
        TotalJobItems: 10,
        CreatedDate: at(-20),
      });

      await org.refreshAt(0, [row]);
      const justUnder = await org.refreshAt(59, [row]);
      expect(stuckIds(justUnder)).toEqual([]);

      const past = await org.refreshAt(61, [row]);
      const stuck = (past.jobInsights ?? []).filter((i) => i.type === 'stuck');
      expect(stuck).toHaveLength(1);
      expect(stuck[0].severity).toBe('critical');
      expect(stuck[0].affectedJobs).toEqual(['707xSTALL']);
      expect(stuck[0].detail).toContain('3 of 10');
      expect(stuck[0].detail).toContain('1h01m');
    });

    /** Five hours in Processing, and it moved while watched: healthy volume. */
    it('never calls a batch that is still moving stuck, however old', async () => {
      const org = watchOrg();
      const row = (done: number): JobRow =>
        jobRow({
          Id: '707xBIG',
          Status: 'Processing',
          JobItemsProcessed: done,
          TotalJobItems: 400,
          CreatedDate: at(-300),
        });

      await org.refreshAt(0, [row(3)]);
      const later = await org.refreshAt(61, [row(9)]);

      expect(later.jobInsights).toEqual([]);
    });

    it('restarts the stall clock every time the counter moves', async () => {
      const org = watchOrg();
      const row = (done: number): JobRow =>
        jobRow({
          Id: '707xSLOW',
          Status: 'Processing',
          JobItemsProcessed: done,
          TotalJobItems: 10,
          CreatedDate: at(-5),
        });

      await org.refreshAt(0, [row(3)]);
      await org.refreshAt(40, [row(4)]);
      // Still at 4 for 59 minutes (since minute 40), 99 minutes since first seen.
      const stillUnder = await org.refreshAt(99, [row(4)]);
      expect(stuckIds(stillUnder)).toEqual([]);

      const stillPast = await org.refreshAt(101, [row(4)]);
      expect(stuckIds(stillPast)).toEqual(['707xSLOW']);
    });

    /**
     * Rows arrive as the SOQL sorts them, newest submission first. The page's
     * red band lists stalls in the order given, so the longest stall must come
     * first whatever order the org returned the rows in.
     */
    it('lists stalled batches longest stall first, whatever order the query returns them in', async () => {
      const org = watchOrg();
      const window = (a: number, b: number, c: number): JobRow[] => [
        jobRow({
          Id: '707xA',
          Status: 'Processing',
          JobItemsProcessed: a,
          TotalJobItems: 50,
          CreatedDate: at(-10),
        }),
        jobRow({
          Id: '707xB',
          Status: 'Processing',
          JobItemsProcessed: b,
          TotalJobItems: 50,
          CreatedDate: at(-30),
        }),
        jobRow({
          Id: '707xC',
          Status: 'Processing',
          JobItemsProcessed: c,
          TotalJobItems: 50,
          CreatedDate: at(-50),
        }),
      ];

      await org.refreshAt(0, window(1, 1, 1));
      await org.refreshAt(10, window(2, 1, 1)); // A moves
      await org.refreshAt(20, window(2, 1, 2)); // C moves
      const payload = await org.refreshAt(85, window(2, 1, 2));

      // Unchanged for: B 85m, A 75m, C 65m. Neither the row order (A, B, C)
      // nor the submission order (C, B, A) produces this sequence.
      expect(stuckIds(payload)).toEqual(['707xB', '707xA', '707xC']);
    });

    /** Preparing runs the start method: no batch counter exists yet to watch. */
    it('gives a batch still in Preparing a warning past the age bound, never an abort', async () => {
      const org = watchOrg();
      const row = jobRow({
        Id: '707xPREP',
        Status: 'Preparing',
        JobItemsProcessed: 0,
        TotalJobItems: null,
        CreatedDate: at(-120),
      });

      await org.refreshAt(0, [row]);
      const payload = await org.refreshAt(90, [row]);

      expect(critical(payload)).toEqual([]);
      expect(unfinished(payload)?.affectedJobs).toEqual(['707xPREP']);
    });

    /** Queued is a wait for the platform to start the job: a counter that never started is no stall. */
    it('does not call a batch stuck before it is processing', async () => {
      const org = watchOrg();
      const row = jobRow({
        Id: '707xWAIT',
        Status: 'Queued',
        JobItemsProcessed: 0,
        TotalJobItems: 10,
        CreatedDate: at(-5),
      });

      await org.refreshAt(0, [row]);
      const payload = await org.refreshAt(61, [row]);

      expect(stuckIds(payload)).toEqual([]);
    });

    /** A Queueable reports no batches: its stillness is not evidence of anything. */
    it('never calls a job without batch counters stuck, only unfinished', async () => {
      const org = watchOrg();
      const row = jobRow({
        Id: '707xQ',
        JobType: 'Queueable',
        Status: 'Processing',
        CreatedDate: at(-30),
      });

      await org.refreshAt(0, [row]);
      const payload = await org.refreshAt(180, [row]);

      expect(critical(payload)).toEqual([]);
      expect(unfinished(payload)?.affectedJobs).toEqual(['707xQ']);
    });

    /** Every batch processed: the counter cannot move again, so its stillness proves nothing. */
    it('does not call a batch stuck once every batch is processed', async () => {
      const org = watchOrg();
      const row = (done: number): JobRow =>
        jobRow({
          Id: '707xFIN',
          Status: 'Processing',
          JobItemsProcessed: done,
          TotalJobItems: 10,
          CreatedDate: at(-5),
        });

      await org.refreshAt(0, [row(9)]);
      await org.refreshAt(5, [row(10)]); // the last batch completes
      const payload = await org.refreshAt(70, [row(10)]);

      expect(stuckIds(payload)).toEqual([]);
      // It moved, but 65 minutes ago, and it has not finished 75 minutes after
      // submission: an old movement no longer counts as progress, so the job is
      // reported as unfinished.
      expect(unfinished(payload)?.affectedJobs).toEqual(['707xFIN']);
    });

    /**
     * A scheduled job sits in Queued until its cron fires — days, for a weekly
     * schedule. Flagging it would put an Abort button on a healthy schedule.
     */
    it('never flags a scheduled job waiting for its fire time', async () => {
      const org = watchOrg();
      const row = jobRow({
        Id: '707xSCHED',
        JobType: 'ScheduledApex',
        Status: 'Queued',
        CreatedDate: at(-3 * 24 * 60),
      });

      await org.refreshAt(0, [row]);
      const payload = await org.refreshAt(120, [row]);

      expect(payload.jobInsights).toEqual([]);
    });

    it('makes no claim about job types whose lifecycle it does not model', async () => {
      const org = watchOrg();
      const rows = [
        jobRow({
          Id: '707xWORKER',
          JobType: 'BatchApexWorker',
          Status: 'Processing',
          JobItemsProcessed: 1,
          TotalJobItems: 5,
          CreatedDate: at(-300),
        }),
        jobRow({
          Id: '707xTEST',
          JobType: 'TestRequest',
          Status: 'Processing',
          CreatedDate: at(-300),
        }),
        jobRow({
          Id: '707xSHARE',
          JobType: 'SharingRecalculation',
          Status: 'Processing',
          CreatedDate: at(-300),
        }),
      ];

      await org.refreshAt(0, rows);
      const payload = await org.refreshAt(120, rows);

      expect(payload.jobInsights).toEqual([]);
    });

    /** Holding is a wait for a flex-queue slot, not work that stopped. */
    it('does not flag a job parked in the flex queue', async () => {
      const org = watchOrg();
      const row = jobRow({ Id: '707xHOLD', Status: 'Holding', CreatedDate: at(-240) });

      await org.refreshAt(0, [row]);
      const payload = await org.refreshAt(120, [row]);

      expect(payload.jobInsights).toEqual([]);
    });

    /**
     * The counters cost no call: they are two more columns of the query the
     * tick already makes, and the health check's own job read is still served
     * from those rows. The field list is parsed, not substring-matched.
     */
    it('reads the batch counters in the one AsyncApexJob query the tick already makes', async () => {
      const org = watchOrg();
      await org.refreshAt(0, [
        jobRow({ Id: '707xONE', Status: 'Processing', JobItemsProcessed: 1, TotalJobItems: 4 }),
      ]);

      const soql = org.jobSoql();
      expect(soql).toHaveLength(1);
      const selected = /^\s*SELECT\s+(.+?)\s+FROM\s+AsyncApexJob\b/i
        .exec(soql[0])?.[1]
        .split(',')
        .map((field) => field.trim());
      expect(selected).toEqual(expect.arrayContaining(['JobItemsProcessed', 'TotalJobItems']));
    });
  });
});
