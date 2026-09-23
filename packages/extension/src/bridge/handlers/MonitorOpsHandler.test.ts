import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { MonitorOpsHandler } from './MonitorOpsHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import type { BaseMessage } from '@sandforge/shared';
import type * as vscode from 'vscode';
import { inboundRequest } from '../../test/mockFactories.js';
import { ExternalBrowserAdapter } from '../../adapters/browser/ExternalBrowserAdapter.js';

/**
 * Hoisted mocks -- available before module evaluation.
 * Using a single vi.mock per module path to avoid hoisting conflicts.
 */
const mockGetJsforceConnection = vi.hoisted(() => vi.fn());
const mockQueryAll = vi.hoisted(() => vi.fn());
const mockQueryAllBounded = vi.hoisted(() => vi.fn());
const mockCheckApiLimits = vi.hoisted(() => vi.fn());

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: mockGetJsforceConnection,
}));

vi.mock('../../core/common/soqlQueryHelper.js', () => ({
  queryAll: mockQueryAll,
  queryAllBounded: mockQueryAllBounded,
}));

vi.mock('../../core/common/sforceLimitParser.js', () => ({
  checkApiLimits: mockCheckApiLimits,
}));

/**
 * Limits under the names a v62.0 `/limits` answers with. This table used to
 * carry `DailyBulkApiRequests`, `DailySoqlQueries` and
 * `DailyStandardVolumePlatformMessages`, names no org returns, which is how the
 * API usage panel could look for them without a test noticing.
 */
const FAKE_LIMITS: Record<string, { Max: number; Remaining: number }> = {
  DailyApiRequests: { Max: 15000, Remaining: 14000 },
  DailyBulkApiBatches: { Max: 15000, Remaining: 14250 },
  DailyBulkV2QueryJobs: { Max: 10000, Remaining: 9000 },
  DailyBulkV2QueryFileStorageMB: { Max: 100, Remaining: 90 },
  DailyStreamingApiEvents: { Max: 10000, Remaining: 9500 },
  DailyGenericStreamingApiEvents: { Max: 10000, Remaining: 9500 },
  DailyDurableStreamingApiEvents: { Max: 10000, Remaining: 9500 },
  DailyAsyncApexExecutions: { Max: 250000, Remaining: 240000 },
  HourlyAsyncReportRuns: { Max: 1200, Remaining: 1100 },
  HourlyTimeBasedWorkflow: { Max: 1000, Remaining: 950 },
  DailyWorkflowEmails: { Max: 1000, Remaining: 800 },
  MassEmail: { Max: 5000, Remaining: 4500 },
  SingleEmail: { Max: 5000, Remaining: 4800 },
  HourlyPublishedPlatformEvents: { Max: 50000, Remaining: 49000 },
  DailyStandardVolumePlatformEvents: { Max: 100000, Remaining: 95000 },
};

/** The tail of what `/services/data` answers: the versions the org serves, oldest first. */
const SERVED_API_VERSIONS = [
  { label: "Summer '26", url: '/services/data/v67.0', version: '67.0' },
  { label: "Winter '27", url: '/services/data/v68.0', version: '68.0' },
  { label: 'Latest Release', url: '/services/data/latest', version: '68.0' },
];

/**
 * A connection's `request`, answering the two REST reads a refresh makes:
 * `/services/data` with the versions the org serves, anything else (the
 * `/limits` call) with `limits`.
 */
function orgRequest(limits: unknown = FAKE_LIMITS): ReturnType<typeof vi.fn> {
  return vi.fn((url: string) =>
    Promise.resolve(url === '/services/data' ? SERVED_API_VERSIONS : limits),
  );
}

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
    // A bounded read answers the rows mockQueryAll holds for its SOQL, and
    // says it stopped short only when a test says so.
    mockQueryAllBounded.mockReset();
    mockQueryAllBounded.mockImplementation(async (conn: unknown, soql: string) => ({
      records: (await mockQueryAll(conn, soql)) as unknown[],
      truncated: false,
    }));
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

  it('does not claim monitor:start or monitor:health-score, which no page sends', async () => {
    for (const type of ['monitor:start', 'monitor:health-score']) {
      const msg: InboundRequest = inboundRequest({
        id: `req-${type}`,
        type,
        timestamp: Date.now(),
      });
      expect(await handler.handle(msg)).toBe(false);
    }
    expect(deps.broker.postToWebview).not.toHaveBeenCalled();
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

  describe('limits caching', () => {
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
     * Two rapid monitor:api-usage calls to the same orgId should share a
     * single /limits API call via the 30s cache.
     */
    it('should share /limits cache across handler calls (conn.request called once)', async () => {
      const localDeps = createMockDeps();
      const localHandler = new MonitorOpsHandler(localDeps);

      const firstMsg: InboundRequest & { payload: { orgId: string } } = inboundRequest({
        id: 'cache-1',
        type: 'monitor:api-usage',
        timestamp: Date.now(),
        payload: { orgId: 'org-cache' },
      });

      const apiMsg: InboundRequest & { payload: { orgId: string } } = inboundRequest({
        id: 'cache-2',
        type: 'monitor:api-usage',
        timestamp: Date.now(),
        payload: { orgId: 'org-cache' },
      });

      await localHandler.handle(firstMsg);
      await localHandler.handle(apiMsg);

      // conn.request should have been called exactly once (for /limits)
      expect(mockConnRequest).toHaveBeenCalledTimes(1);

      // Both handlers should have produced a response
      const postToWebview = localDeps.broker.postToWebview as ReturnType<typeof vi.fn>;
      expect(postToWebview).toHaveBeenCalledTimes(2);

      const types = postToWebview.mock.calls.map((c: unknown[]) => (c[0] as BaseMessage).type);
      expect(types).toEqual(['monitor:api-usage:response', 'monitor:api-usage:response']);
    });
  });

  describe('api-usage includes email and platform event categories', () => {
    beforeEach(() => {
      const fakeConn = {
        limitInfo: { apiUsage: { used: 100, limit: 15000 } },
        request: orgRequest(),
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

    it('api-usage response has one category per limit it names', async () => {
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
      expect(response.payload.categories).toHaveLength(15);
    });

    it('shows the Bulk API batches and standard-volume platform events an org reports', async () => {
      // Under the names the org answers with. Run against real orgs, the panel
      // listed 13 categories: it asked for DailyBulkApiRequests, the name the
      // Bulk API batch limit had before API 49.0, and never showed the limit
      // every Bulk API load counts against.
      await handler.handle(
        inboundRequest({
          id: 'req-limits-bulk',
          type: 'monitor:api-usage',
          timestamp: Date.now(),
          payload: { orgId: 'org-limits' },
        }),
      );

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { categories: Array<{ category: string; used: number; max: number }> };
      };
      expect(response.payload.categories).toContainEqual(
        expect.objectContaining({ category: 'DailyBulkApiBatches', used: 750, max: 15000 }),
      );
      expect(response.payload.categories.map((c) => c.category)).toContain(
        'DailyStandardVolumePlatformEvents',
      );
    });
  });

  describe('monitor:storage', () => {
    /**
     * An org as it answers the two reads a storage breakdown needs. Its
     * EntityDefinition refuses RecordCount the way every org does: the column
     * does not exist, and a mock that returned rows for it is how a query that
     * failed on every real org passed every test.
     */
    function orgWithRecordCounts(counts: Array<{ name: string; count: number }>) {
      const labels: Record<string, string> = {
        Account: 'Compte',
        Contact: 'Contact',
        Invoice__c: 'Facture',
      };
      mockQueryAll.mockImplementation((_conn: unknown, soql: string) => {
        if (/FROM EntityDefinition/.test(soql) && /\bRecordCount\b/.test(soql)) {
          return Promise.reject(
            new Error("INVALID_FIELD: No such column 'RecordCount' on entity 'EntityDefinition'."),
          );
        }
        const names = [...soql.matchAll(/'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
        return Promise.resolve(
          names
            .filter((name) => labels[name] !== undefined)
            .map((name) => ({ QualifiedApiName: name, Label: labels[name] })),
        );
      });
      const request = vi.fn((url: string) =>
        /\/limits\/recordCount$/.test(url)
          ? Promise.resolve({ sObjects: counts })
          : Promise.reject(new Error(`NOT_FOUND: ${url}`)),
      );
      mockGetJsforceConnection.mockResolvedValue({ request, limitInfo: undefined });
      return request;
    }

    async function askForStorage(): Promise<
      BaseMessage & {
        payload: {
          objects: Array<{ objectName: string; label: string; recordCount: number }>;
          totalRecords: number;
          message?: string;
        };
      }
    > {
      await handler.handle(
        inboundRequest({
          id: 'req-storage-counts',
          type: 'monitor:storage',
          timestamp: Date.now(),
          payload: { orgId: 'org-1' },
        }),
      );
      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      return postToWebview.mock.calls[0][0] as Awaited<ReturnType<typeof askForStorage>>;
    }

    it("lists the objects holding the most records, with the org's own counts and labels", async () => {
      orgWithRecordCounts([
        { name: 'Contact', count: 1200 },
        { name: 'Account', count: 5400 },
        { name: 'Invoice__c', count: 300 },
        { name: 'Lead', count: 0 },
      ]);

      const response = await askForStorage();

      expect(response.type).toBe('monitor:storage:response');
      expect(response.payload.objects).toEqual([
        { objectName: 'Account', label: 'Compte', recordCount: 5400 },
        { objectName: 'Contact', label: 'Contact', recordCount: 1200 },
        { objectName: 'Invoice__c', label: 'Facture', recordCount: 300 },
      ]);
    });

    it('lists twenty objects and totals every object the org counted', async () => {
      // The panel heads the list with "N total records". A sum of the twenty
      // rows it shows would be a total of nothing the org has.
      const counts = Array.from({ length: 25 }, (_, i) => ({ name: `Obj${i}__c`, count: 100 + i }));
      orgWithRecordCounts(counts);

      const response = await askForStorage();

      expect(response.payload.objects).toHaveLength(20);
      expect(response.payload.objects[0]).toMatchObject({
        objectName: 'Obj24__c',
        recordCount: 124,
      });
      expect(response.payload.totalRecords).toBe(counts.reduce((sum, o) => sum + o.count, 0));
    });
  });

  describe('monitor:error-logs', () => {
    it('handles monitor:error-logs and returns error entries', async () => {
      const fakeConn = {
        limitInfo: {},
        request: orgRequest(),
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

  describe('monitor:sessions', () => {
    it('handles monitor:sessions and returns active sessions', async () => {
      const fakeConn = {
        limitInfo: {},
        request: orgRequest(),
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

  describe('monitor:apex-insights', () => {
    it('handles monitor:apex-insights and returns analyses with top issues', async () => {
      const fakeConn = {
        limitInfo: {},
        request: orgRequest(),
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

  describe('monitor:sandbox-refresh', () => {
    it('handles monitor:sandbox-refresh and returns refresh events', async () => {
      const fakeConn = {
        limitInfo: {},
        request: orgRequest(),
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
      expect((response.payload as { supported?: boolean }).supported).toBe(true);
    });

    it('tells the panel an org that cannot query SandboxProcess is unsupported', async () => {
      mockGetJsforceConnection.mockResolvedValue({
        limitInfo: {},
        request: orgRequest(),
        version: '62.0',
      });
      mockQueryAll.mockRejectedValue(new Error("sObject type 'SandboxProcess' is not supported."));

      await handler.handle(
        inboundRequest({
          id: 'req-sbx-2',
          type: 'monitor:sandbox-refresh',
          timestamp: Date.now(),
          payload: { orgId: 'org-sandbox-only' },
        }),
      );

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { success: boolean; supported?: boolean; refreshes: unknown[] };
      };
      expect(response.type).toBe('monitor:sandbox-refresh:response');
      expect(response.payload.success).toBe(true);
      expect(response.payload.supported).toBe(false);
      expect(response.payload.refreshes).toEqual([]);
    });
  });

  /**
   * Every Monitor list reads a bounded number of rows, newest first. The
   * sessions and error logs used to stop at a LIMIT in their query without a
   * word, and the counts drawn from them (active users, errors per type)
   * stopped there too. Each answer now says when its list came back full.
   */
  describe('lists that stop at a bound', () => {
    function ask(type: string): Promise<boolean> {
      return handler.handle(
        inboundRequest({
          id: `req-${type}`,
          type,
          timestamp: Date.now(),
          payload: { orgId: 'org-1' },
        }),
      );
    }

    function answer(): BaseMessage & { payload: Record<string, unknown> } {
      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      return postToWebview.mock.calls[0][0] as BaseMessage & { payload: Record<string, unknown> };
    }

    beforeEach(() => {
      mockGetJsforceConnection.mockResolvedValue({
        request: orgRequest(),
        query: vi.fn().mockResolvedValue({ done: true, totalSize: 0, records: [] }),
        limitInfo: {},
        version: '62.0',
      });
      mockQueryAll.mockResolvedValue([]);
    });

    it.each([
      ['monitor:sessions', 'monitor:sessions:response', 'FROM AuthSession'],
      ['monitor:error-logs', 'monitor:error-logs:response', 'FROM ApexLog WHERE'],
      ['monitor:apex-insights', 'monitor:apex-insights:response', 'FROM ApexLog ORDER BY'],
      ['monitor:sandbox-refresh', 'monitor:sandbox-refresh:response', 'FROM SandboxProcess'],
    ])('%s says when its list came back full', async (type, responseType, from) => {
      mockQueryAllBounded.mockImplementation(async (_conn: unknown, soql: string) => ({
        records: [],
        truncated: soql.includes(from),
      }));

      await ask(type);

      expect(answer().type).toBe(responseType);
      expect(answer().payload.truncated).toBe(true);
    });

    it.each([
      ['monitor:sessions'],
      ['monitor:error-logs'],
      ['monitor:apex-insights'],
      ['monitor:sandbox-refresh'],
    ])('%s says nothing was left out when its list is complete', async (type) => {
      await ask(type);

      expect(answer().payload.truncated).toBe(false);
    });

    it('says when the deployment list came back full, and not before', async () => {
      const deployment = (i: number): Record<string, unknown> => ({
        Id: `0Af00000000000${String(i).padStart(2, '0')}`,
        Status: 'Succeeded',
        StartDate: '2026-09-22T16:05:27.000+0000',
        CompletedDate: '2026-09-22T16:06:02.000+0000',
        CreatedBy: { Name: 'Admin' },
        NumberComponentsTotal: 3,
        NumberComponentErrors: 0,
      });
      const toolingQuery = vi.fn((soql: string) => {
        const limit = Number(/LIMIT (\d+)$/.exec(soql)?.[1] ?? Infinity);
        // An org with 26 deployments on record, answering the LIMIT it is given.
        const rows = Array.from({ length: Math.min(26, limit) }, (_, i) => deployment(i));
        return Promise.resolve({ done: true, totalSize: rows.length, records: rows });
      });
      mockGetJsforceConnection.mockResolvedValue({
        tooling: { query: toolingQuery },
        limitInfo: {},
      });

      await ask('monitor:deployments');

      expect(answer().type).toBe('monitor:deployments:response');
      expect(answer().payload.deployments).toHaveLength(20);
      expect(answer().payload.truncated).toBe(true);

      (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mockClear();
      toolingQuery.mockResolvedValueOnce({
        done: true,
        totalSize: 3,
        records: [0, 1, 2].map(deployment),
      });
      await ask('monitor:deployments');

      expect(answer().payload.truncated).toBe(false);
    });

    it('says how many objects the org counted, of which the twenty holding the most are listed', async () => {
      const counts = Array.from({ length: 25 }, (_, i) => ({ name: `Obj${i}__c`, count: 100 + i }));
      mockGetJsforceConnection.mockResolvedValue({
        request: vi.fn().mockResolvedValue({ sObjects: [...counts, { name: 'Lead', count: 0 }] }),
        limitInfo: {},
      });

      await ask('monitor:storage');

      expect(answer().type).toBe('monitor:storage:response');
      expect(answer().payload.objects).toHaveLength(20);
      // Objects holding at least one record: the empty one is not among them.
      expect(answer().payload.objectCount).toBe(25);
    });

    it('says when the recent-job window came back full', async () => {
      const job = (i: number): Record<string, unknown> => ({
        Id: `707000000000${String(i).padStart(3, '0')}`,
        JobType: 'Queueable',
        Status: 'Completed',
        NumberOfErrors: 0,
        CreatedDate: '2026-09-22T10:00:00Z',
        CreatedById: '005000000000001',
      });
      (deps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockReturnValue({
        alias: 'SRC',
        orgType: 'Sandbox',
        metadata: { edition: 'Enterprise Edition' },
      });
      mockQueryAll.mockImplementation(async (_conn: unknown, soql: string) =>
        soql.includes('FROM AsyncApexJob') ? Array.from({ length: 50 }, (_, i) => job(i)) : [],
      );

      await ask('monitor:refresh');
      expect(answer().type).toBe('monitor:data');
      expect(answer().payload.jobsTruncated).toBe(true);

      (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mockClear();
      mockQueryAll.mockImplementation(async (_conn: unknown, soql: string) =>
        soql.includes('FROM AsyncApexJob') ? [job(1), job(2)] : [],
      );
      await ask('monitor:refresh');

      expect(answer().payload.jobsTruncated).toBe(false);
    });
  });

  describe('MONITOR_TYPES coverage', () => {
    it('MONITOR_TYPES includes all new message types', async () => {
      const fakeConn = {
        limitInfo: {},
        request: orgRequest(),
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

  describe('handleRefresh includes orgHealthStatus', () => {
    it('handleRefresh includes orgHealthStatus in response', async () => {
      const fakeConn = {
        request: orgRequest(),
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

  describe('org info of a refresh', () => {
    /**
     * The identity URL answers with the keys below and nothing else: no
     * instance_name, no last_login_date.
     */
    const IDENTITY = {
      id: 'https://login.salesforce.com/id/00D000000000001AAA/005000000000001AAA',
      user_id: '005000000000001AAA',
      organization_id: '00D000000000001AAA',
      username: 'admin@example.com',
      display_name: 'Admin',
      urls: {},
      active: true,
      user_type: 'STANDARD',
      language: 'en_US',
      locale: 'en_US',
      utcOffset: 0,
      last_modified_date: '2026-01-01T00:00:00.000+0000',
    };

    /**
     * Refresh an org whose connection speaks 62.0 while the org serves up to
     * 68.0, whose Organization row holds `organization`, and which the
     * registry holds as `registered`; answer the org info the page receives.
     */
    async function refreshOrgInfo(
      organization: Record<string, unknown>,
      registered: Record<string, unknown> | undefined,
    ): Promise<Record<string, unknown> | undefined> {
      mockGetJsforceConnection.mockResolvedValue({
        request: orgRequest(),
        identity: vi.fn().mockResolvedValue(IDENTITY),
        query: vi.fn().mockResolvedValue({ totalSize: 3, done: true, records: [] }),
        version: '62.0',
        limitInfo: undefined,
      });
      // The row answers the columns the SELECT names, as the org does.
      mockQueryAll.mockImplementation((_conn: unknown, soql: string) => {
        if (!/FROM Organization/.test(soql)) return Promise.resolve([]);
        const columns = (/SELECT (.+?) FROM/.exec(soql)?.[1] ?? '').split(',').map((c) => c.trim());
        return Promise.resolve([Object.fromEntries(columns.map((c) => [c, organization[c]]))]);
      });
      (deps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockReturnValue(registered);

      await handler.handle(
        inboundRequest({
          id: 'req-org-info',
          type: 'monitor:refresh',
          timestamp: Date.now(),
          payload: { orgId: 'org-info-row' },
        }),
      );

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { orgInfo?: Record<string, unknown> };
      };
      expect(response.type).toBe('monitor:data');
      return response.payload.orgInfo;
    }

    const ORGANIZATION: Record<string, unknown> = {
      Name: 'Acme Corp',
      Id: '00D000000000001AAA',
      OrganizationType: 'Enterprise Edition',
      InstanceName: 'EU42S',
      IsSandbox: true,
      NamespacePrefix: null,
      CreatedDate: '2026-01-01T00:00:00.000+0000',
    };

    it("takes the instance and the edition from the org's Organization row", async () => {
      // Read from the identity URL, the instance was blank on every real org
      // the Monitor was pointed at. And what an SFDX import used to store as
      // the edition was the org's name.
      const orgInfo = await refreshOrgInfo(ORGANIZATION, {
        alias: 'SRC',
        orgType: 'Sandbox',
        metadata: { edition: 'Acme Corp' },
      });

      expect(orgInfo?.instanceName).toBe('EU42S');
      expect(orgInfo?.edition).toBe('Enterprise Edition');
    });

    it("shows the newest API version the org serves, not the connection's", async () => {
      // Run against real orgs, the panel said API 62.0 about orgs on 68.0.
      const orgInfo = await refreshOrgInfo(ORGANIZATION, {
        alias: 'SRC',
        orgType: 'Sandbox',
        metadata: { edition: 'Enterprise Edition' },
      });

      expect(orgInfo?.apiVersion).toBe('68.0');
    });

    it('sends the namespace and the creation date the row holds, and no login date', async () => {
      const orgInfo = await refreshOrgInfo(
        { ...ORGANIZATION, NamespacePrefix: 'acme', CreatedDate: '2026-04-24T10:20:51.000+0000' },
        { alias: 'SRC', orgType: 'Sandbox', metadata: { edition: 'Enterprise Edition' } },
      );

      expect(orgInfo?.namespacePrefix).toBe('acme');
      expect(orgInfo?.createdDate).toBe('2026-04-24T10:20:51.000Z');
      // The identity answer carries no login date, and the refresh time
      // stood in for one: "now", on every org.
      expect(orgInfo).not.toHaveProperty('lastLoginDate');
    });

    it('types an org the registry no longer holds as Production, not as a sandbox', async () => {
      // Disconnected while the refresh ran: the type is unknown, and an
      // unknown type fails closed, as the guards read it.
      const orgInfo = await refreshOrgInfo(ORGANIZATION, undefined);

      expect(orgInfo?.type).toBe('Production');
    });
  });

  describe('OrgInfoFetcher cache sharing', () => {
    let mockConnRequest: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockConnRequest = orgRequest();
      mockGetJsforceConnection.mockResolvedValue({
        request: mockConnRequest,
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
     * OrgInfoFetcher is a single instance on MonitorOpsHandler.
     * Two refresh calls within 5 minutes should reuse the cached OrgInfo,
     * meaning the org's API versions are read only once.
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

      // OrgInfoFetcher cache means /services/data is read only once (via the
      // conn adapter in handleRefresh), not twice.
      expect(mockConnRequest.mock.calls.filter(([url]) => url === '/services/data')).toHaveLength(
        1,
      );

      // Both refreshes should succeed
      const postToWebview = localDeps.broker.postToWebview as ReturnType<typeof vi.fn>;
      expect(postToWebview).toHaveBeenCalledTimes(2);
    });
  });

  describe('AlertEngine integration', () => {
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
        request: orgRequest(highUsageLimits),
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

  describe('monitor:alerts handler', () => {
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

  describe('monitor:alert:acknowledge handler', () => {
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

  describe('monitor:alert:dismiss handler', () => {
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

  describe('MONITOR_TYPES includes alert types', () => {
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

  /**
   * The stalled-job action is a link to Setup > Apex Jobs. `AsyncApexJob` is
   * not updateable, so the former in-product abort failed on every confirm;
   * the page the link opens is where an abort works.
   */
  describe("an org's health, read for a pipeline's Pre-check", () => {
    it('reads the signals it is asked for, and only those', async () => {
      const request = orgRequest({
        DailyApiRequests: { Max: 10000, Remaining: 2800 },
        DataStorageMB: { Max: 1000, Remaining: 900 },
      });
      const query = vi.fn();
      mockGetJsforceConnection.mockResolvedValue({ request, query });

      const signals = await handler.readOrgHealth('org-1', ['apiLimits', 'storage']);

      expect(signals).toEqual([
        expect.objectContaining({
          name: 'apiLimits',
          status: 'warning',
          message: 'API usage at 72%',
          percent: 72,
        }),
        expect.objectContaining({ name: 'storage', status: 'ok', percent: 10 }),
      ]);
      // `/limits` once for both; no ApexLog count, no AsyncApexJob read.
      expect(request).toHaveBeenCalledTimes(1);
      expect(mockQueryAll).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    });

    it('answers a signal it cannot read as unknown, never with a throw', async () => {
      mockGetJsforceConnection.mockRejectedValue(new Error('No credentials for org org-1'));

      const [apiLimits] = await handler.readOrgHealth('org-1', ['apiLimits']);

      expect(apiLimits).toMatchObject({ name: 'apiLimits', status: 'unknown' });
    });
  });

  describe('monitor:open-apex-jobs', () => {
    const PAGE = 'https://acme.my.salesforce.com/lightning/setup/AsyncApexJobs/home';
    let openExternal: Mock<(target: vscode.Uri) => Thenable<boolean>>;
    let browser: ExternalBrowserAdapter;

    /** A handler with a stand-in browser, over an org store holding `org-1` (or nothing). */
    function handlerWithOrg(instanceUrl: string | undefined): MonitorOpsHandler {
      (deps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockImplementation((orgId: string) =>
        orgId === 'org-1' && instanceUrl !== undefined
          ? { id: 'org-1', alias: 'Acme', instanceUrl }
          : undefined,
      );
      return new MonitorOpsHandler(deps, browser);
    }

    function openRequest(payload: Record<string, unknown>): InboundRequest {
      return inboundRequest({
        id: 'req-apex-jobs',
        type: 'monitor:open-apex-jobs',
        timestamp: Date.now(),
        payload,
      } as BaseMessage);
    }

    function posted(): Array<BaseMessage & { payload: Record<string, unknown> }> {
      return (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls.map(
        (call: unknown[]) => call[0] as BaseMessage & { payload: Record<string, unknown> },
      );
    }

    beforeEach(() => {
      openExternal = vi.fn<(target: vscode.Uri) => Thenable<boolean>>().mockResolvedValue(true);
      browser = new ExternalBrowserAdapter({
        openExternal,
        parseUri: (value: string) => ({ toString: () => value }) as unknown as vscode.Uri,
      });
    });

    it("opens the org's Setup > Apex Jobs page, built from org state, and answers opened", async () => {
      const handler = handlerWithOrg('https://acme.my.salesforce.com');

      expect(await handler.handle(openRequest({ orgId: 'org-1' }))).toBe(true);

      expect(openExternal).toHaveBeenCalledTimes(1);
      expect(String(openExternal.mock.calls[0][0])).toBe(PAGE);
      expect(posted()).toHaveLength(1);
      expect(posted()[0]).toMatchObject({
        type: 'monitor:open-apex-jobs:response',
        correlationId: 'req-apex-jobs',
        payload: { status: 'opened' },
      });
      // A navigation: no connection is opened, nothing is written to the org.
      expect(mockGetJsforceConnection).not.toHaveBeenCalled();
    });

    it('answers status error, correlated, when VS Code does not open the page', async () => {
      openExternal.mockResolvedValue(false);
      const handler = handlerWithOrg('https://acme.my.salesforce.com');

      await handler.handle(openRequest({ orgId: 'org-1' }));

      expect(posted()).toHaveLength(1);
      const [response] = posted();
      expect(response.type).toBe('monitor:open-apex-jobs:response');
      expect(response.correlationId).toBe('req-apex-jobs');
      expect(response.payload.status).toBe('error');
      expect(response.payload.message).toEqual(expect.stringMatching(/\S/));
    });

    // The webview names an org, never an address: a URL or a path slipped into
    // the payload is refused before the org store is even read.
    it.each([
      ['a url', { orgId: 'org-1', url: 'https://attacker.example/phish' }],
      ['a path', { orgId: 'org-1', path: '/secur/logout.jsp' }],
    ])('refuses a payload carrying %s, and opens nothing', async (_label, payload) => {
      const handler = handlerWithOrg('https://acme.my.salesforce.com');

      await handler.handle(openRequest(payload));

      expect(openExternal).not.toHaveBeenCalled();
      expect(deps.orgManager.getOrg).not.toHaveBeenCalled();
      expect(posted()).toHaveLength(1);
      expect(posted()[0]).toMatchObject({
        type: 'monitor:error',
        correlationId: 'req-apex-jobs',
        payload: { code: 'INVALID_PAYLOAD' },
      });
    });

    it('refuses an instance URL the HTTPS gate rejects, and opens nothing', async () => {
      const handler = handlerWithOrg('javascript:alert(document.cookie)');

      await handler.handle(openRequest({ orgId: 'org-1' }));

      expect(openExternal).not.toHaveBeenCalled();
      expect(posted()).toHaveLength(1);
      expect(posted()[0]).toMatchObject({
        type: 'monitor:error',
        correlationId: 'req-apex-jobs',
        payload: { code: 'INVALID_INSTANCE_URL' },
      });
      expect(String(posted()[0].payload.message)).toContain('javascript:');
    });

    it('reports an org it does not know on monitor:error, correlated', async () => {
      const handler = handlerWithOrg(undefined);

      await handler.handle(openRequest({ orgId: 'org-1' }));

      expect(openExternal).not.toHaveBeenCalled();
      expect(posted()).toHaveLength(1);
      expect(posted()[0]).toMatchObject({
        type: 'monitor:error',
        correlationId: 'req-apex-jobs',
        payload: { code: 'ORG_NOT_FOUND' },
      });
    });

    it('reports a browser that cannot be reached on monitor:error, correlated', async () => {
      const handler = handlerWithOrg('https://acme.my.salesforce.com');
      vi.spyOn(browser, 'open').mockRejectedValue(new Error('VS Code API unavailable'));

      await handler.handle(openRequest({ orgId: 'org-1' }));

      expect(posted()).toHaveLength(1);
      expect(posted()[0]).toMatchObject({
        type: 'monitor:error',
        correlationId: 'req-apex-jobs',
        payload: { message: 'VS Code API unavailable' },
      });
    });
  });

  describe('what a refresh tick reads', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    /** A connection answering every call a refresh makes; `/limits` is `request`. */
    function createRefreshConn(request: ReturnType<typeof vi.fn>): Record<string, unknown> {
      const limits = request as unknown as (url: string) => Promise<unknown>;
      return {
        request: (url: string): Promise<unknown> =>
          url === '/services/data' ? Promise.resolve(SERVED_API_VERSIONS) : limits(url),
        query: vi.fn().mockResolvedValue({ totalSize: 10, done: true, records: [] }),
        version: '62.0',
        limitInfo: { apiUsage: { used: 100, limit: 15000 } },
      };
    }

    /** Job rows for the AsyncApexJob query, the org row for the org info. */
    function answerQueriesBySoql(): void {
      mockQueryAll.mockImplementation(async (_conn: unknown, soql: string) =>
        soql.includes('FROM Organization')
          ? [
              {
                Name: 'TestOrg',
                Id: '00Dtest',
                OrganizationType: 'Developer Edition',
                NamespacePrefix: null,
                CreatedDate: '2026-01-01',
              },
            ]
          : [],
      );
    }

    function request(id: string, type: string, orgId: string): InboundRequest {
      return inboundRequest({ id, type, timestamp: Date.now(), payload: { orgId } });
    }

    it('asks for the job list without waiting for /limits to answer', async () => {
      let answerLimits: (limits: typeof FAKE_LIMITS) => void = () => {};
      const limitsCall = vi.fn(
        () =>
          new Promise<typeof FAKE_LIMITS>((resolve) => {
            answerLimits = resolve;
          }),
      );
      mockGetJsforceConnection.mockResolvedValue(createRefreshConn(limitsCall));
      answerQueriesBySoql();

      const tick = handler.handle(request('req-parallel', 'monitor:refresh', 'org-parallel'));
      await vi.waitFor(() => expect(limitsCall).toHaveBeenCalledTimes(1));
      await vi.waitFor(() =>
        expect(mockQueryAll).toHaveBeenCalledWith(
          expect.anything(),
          expect.stringContaining('FROM AsyncApexJob'),
        ),
      );
      answerLimits(FAKE_LIMITS);
      await tick;

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      expect(postToWebview.mock.calls.map(([m]) => (m as BaseMessage).type)).toEqual([
        'monitor:data',
      ]);
    });

    it('reports the /limits failure when both org calls fail, whichever fails first', async () => {
      mockGetJsforceConnection.mockResolvedValue(
        createRefreshConn(
          vi.fn(
            () =>
              new Promise((_resolve, reject) => {
                setTimeout(() => reject(new Error('limits refused')), 20);
              }),
          ),
        ),
      );
      mockQueryAll.mockRejectedValue(new Error('job query refused'));

      await handler.handle(request('req-both-fail', 'monitor:refresh', 'org-both-fail'));

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const reply = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { message: string };
      };
      expect(reply.type).toBe('monitor:error');
      expect(reply.payload.message).toBe('limits refused');
    });

    it('sends the week of stored trend points and reads the stored history once', async () => {
      const now = Date.now();
      const at = (msAgo: number): string => new Date(now - msAgo).toISOString();
      const apiAt = (usedPercent: number) => [
        { name: 'DailyApiRequests', max: 15000, remaining: 15000 - usedPercent * 150, usedPercent },
      ];
      const stored = [
        { orgId: 'org-week', limits: apiAt(40), timestamp: at(6 * DAY_MS) },
        { orgId: 'org-week', limits: apiAt(50), timestamp: at(2 * 60 * 60 * 1000) },
      ];
      const configGet = deps.configStore.get as ReturnType<typeof vi.fn>;
      configGet.mockImplementation((key: string) =>
        key === 'trend:org-week' ? structuredClone(stored) : undefined,
      );
      mockGetJsforceConnection.mockResolvedValue(
        createRefreshConn(vi.fn().mockResolvedValue(FAKE_LIMITS)),
      );
      answerQueriesBySoql();

      await handler.handle(request('req-week', 'monitor:refresh', 'org-week'));

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const reply = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { trends: Record<string, { timestamps?: string[] }> };
      };
      expect(reply.type).toBe('monitor:data');
      expect(reply.payload.trends.DailyApiRequests.timestamps?.[0]).toBe(at(6 * DAY_MS));
      expect(configGet.mock.calls.filter(([key]) => key === 'trend:org-week')).toHaveLength(1);
    });
  });

  describe('one AsyncApexJob query per refresh tick', () => {
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
        request: orgRequest(),
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
              payload: { orgHealthStatus?: { failedJobs: number } };
            },
        )
        .find((m) => m.type === 'monitor:data');
      expect(data).toBeDefined();
      // One failed row reaches the jobs signal. A cache miss would have
      // re-queried and counted the same, so this only guards against the
      // reuse handing the provider an empty result set.
      expect(data?.payload.orgHealthStatus?.failedJobs).toBe(1);
    });
  });

  describe('a refresh that outlives its bound', () => {
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
          request: orgRequest(),
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
        request: orgRequest(),
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
     * schedule. Flagging it would band a healthy schedule, and send the reader
     * to Setup > Apex Jobs, which does not abort scheduled jobs (All Scheduled
     * Jobs does).
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
