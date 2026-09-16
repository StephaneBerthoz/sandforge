import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncOpsHandler } from './SyncOpsHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import type { BaseMessage } from '@sandforge/shared';
import { DEFAULT_ROBUSTNESS_CONFIG } from '@sandforge/shared';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ErrorResolver } from '../../modules/ai/ErrorResolver.js';
import type { AIProvider } from '../../modules/ai/ErrorResolver.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));
vi.mock('../../modules/sync/DataSync.js', () => ({
  DataSync: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../../modules/sync/MetadataSync.js', () => ({
  MetadataSync: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../../modules/sync/ConflictResolver.js', () => ({
  ConflictResolver: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../../modules/sync/FieldMapping.js', () => ({
  FieldMappingService: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../../modules/sync/TransformPipeline.js', () => ({
  TransformPipeline: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../../modules/sync/IncrementalTracker.js', () => ({
  IncrementalTracker: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../../modules/sync/BulkDataWriter.js', () => ({
  BulkDataWriter: vi.fn(),
}));
vi.mock('../../modules/sync/SyncOrchestrator.js', () => ({
  SyncOrchestrator: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ status: 'completed' }),
  })),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { BulkDataWriter } from '../../modules/sync/BulkDataWriter.js';
import { BulkApiManager } from '../../core/engine/BulkApiManager.js';
import { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import { OfflineManager } from '../../core/connection/OfflineManager.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { SyncHistoryStore } from '../../modules/sync/SyncHistoryStore.js';
import { SyncExecutionLogger } from '../../modules/sync/SyncExecutionLogger.js';
import { inboundRequest } from '../../test/mockFactories.js';

const mockGetConn = vi.mocked(getJsforceConnection);

/** In-memory ConfigStore mock with real data tracking. */
function createMockConfigStoreWithData() {
  const data: Record<string, { value: string; category: string }> = {};

  return {
    get: vi.fn(<T>(key: string): T | undefined => {
      const entry = data[key];
      if (!entry) return undefined;
      return JSON.parse(entry.value) as T;
    }),
    set: vi.fn(<T>(key: string, value: T, category: string): void => {
      data[key] = { value: JSON.stringify(value), category };
    }),
    delete: vi.fn((key: string): boolean => {
      if (!(key in data)) return false;
      delete data[key];
      return true;
    }),
    has: vi.fn((key: string): boolean => key in data),
    getKeysByPrefix: vi.fn((prefix: string): string[] =>
      Object.keys(data).filter((k) => k.startsWith(prefix)),
    ),
    getByCategory: vi.fn((category: string): Record<string, unknown> => {
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(data)) {
        if (entry.category === category) {
          result[key] = JSON.parse(entry.value);
        }
      }
      return result;
    }),
    getAllKeys: vi.fn((): string[] => Object.keys(data)),
    clearCategory: vi.fn(),
    clearAll: vi.fn(),
    initialize: vi.fn(),
  };
}

/**
 * Creates minimal mock deps for SyncOpsHandler tests.
 */
function createMockDeps(): HandlerDeps {
  let idCounter = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: { getOrg: vi.fn() } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: createMockConfigStoreWithData() as unknown as HandlerDeps['configStore'],
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    nextId: () => String(++idCounter),
  };
}

/**
 * Minimal sync config that passes the `sync:execute` / `sync:config:save`
 * payload validation (mirrors the webview's shape).
 */
function validSyncConfig(): Record<string, unknown> {
  return {
    id: 'cfg-1',
    name: 'sync-from-ui',
    description: 'test',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    direction: 'source_to_target',
    mode: 'full',
    objects: [
      {
        objectApiName: 'Account',
        operation: 'upsert',
        externalIdField: 'Ext_Id__c',
        batchSize: 200,
        fieldMappings: [],
        transformRules: [],
        excludedFields: [],
        addOnFields: [],
        insertOrder: 0,
      },
    ],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
  };
}

/**
 * Same shape as {@link validSyncConfig} but with an explicit per-object
 * operation list — used by the Production Guard tests, where the operation a
 * sync really performs is the whole point.
 */
function syncConfigWithObjects(
  objects: Array<{ objectApiName: string; operation: string }>,
): Record<string, unknown> {
  return {
    ...validSyncConfig(),
    objects: objects.map((o, index) => ({
      objectApiName: o.objectApiName,
      operation: o.operation,
      externalIdField: 'Ext_Id__c',
      batchSize: 200,
      fieldMappings: [],
      transformRules: [],
      excludedFields: [],
      addOnFields: [],
      insertOrder: index,
    })),
  };
}

describe('SyncOpsHandler', () => {
  let handler: SyncOpsHandler;
  let deps: HandlerDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
    handler = new SyncOpsHandler(deps);
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

  it('returns true for handled message types and response includes correlationId', async () => {
    mockGetConn.mockResolvedValue({
      describeGlobal: vi.fn().mockResolvedValue({ sobjects: [] }),
      limitInfo: undefined,
    } as never);

    const msg: InboundRequest & { payload: { orgId: string } } = inboundRequest({
      id: 'req-sync-1',
      type: 'sync:describe-global',
      timestamp: Date.now(),
      payload: { orgId: 'org-1' },
    });
    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalled();

    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      correlationId?: string;
    };
    expect(response.type).toBe('sync:describe-global:response');
    expect(response.correlationId).toBe('req-sync-1');
  });

  describe('operationId cleanup in handleExecute', () => {
    it('calls performanceTracker.complete even when execute throws', async () => {
      const mockComplete = vi.fn();
      const mockStart = vi.fn();

      deps.infraServices = {
        performanceTracker: {
          start: mockStart,
          complete: mockComplete,
        } as unknown as HandlerDeps['infraServices'] extends undefined
          ? never
          : NonNullable<HandlerDeps['infraServices']>['performanceTracker'],
        productionGuard: undefined as unknown as NonNullable<
          HandlerDeps['infraServices']
        >['productionGuard'],
        offlineManager: undefined as unknown as NonNullable<
          HandlerDeps['infraServices']
        >['offlineManager'],
        piiDetector: undefined as unknown as NonNullable<
          HandlerDeps['infraServices']
        >['piiDetector'],
        backgroundRegistry: undefined as unknown as NonNullable<
          HandlerDeps['infraServices']
        >['backgroundRegistry'],
      };

      mockGetConn.mockRejectedValue(new Error('connection failed'));

      const msg: InboundRequest & {
        payload: { config: Record<string, unknown> };
      } = inboundRequest({
        id: '1',
        type: 'sync:execute',
        timestamp: Date.now(),
        payload: {
          config: validSyncConfig(),
        },
      });

      await handler.handle(msg);

      // performanceTracker.start was called
      expect(mockStart).toHaveBeenCalledTimes(1);
      // performanceTracker.complete was called via finally block
      expect(mockComplete).toHaveBeenCalledTimes(1);
      // The operationId passed to complete matches the one passed to start
      expect(mockComplete.mock.calls[0][0]).toBe(mockStart.mock.calls[0][0]);
    });

    it('calls performanceTracker.complete on success path via finally', async () => {
      const mockComplete = vi.fn();
      const mockStart = vi.fn();

      deps.infraServices = {
        performanceTracker: {
          start: mockStart,
          complete: mockComplete,
        } as unknown as NonNullable<HandlerDeps['infraServices']>['performanceTracker'],
        productionGuard: undefined as unknown as NonNullable<
          HandlerDeps['infraServices']
        >['productionGuard'],
        offlineManager: undefined as unknown as NonNullable<
          HandlerDeps['infraServices']
        >['offlineManager'],
        piiDetector: undefined as unknown as NonNullable<
          HandlerDeps['infraServices']
        >['piiDetector'],
        backgroundRegistry: undefined as unknown as NonNullable<
          HandlerDeps['infraServices']
        >['backgroundRegistry'],
      };

      mockGetConn.mockResolvedValue({
        query: vi.fn().mockResolvedValue({ records: [] }),
        // Both orgs are described before the run to compare field types.
        describe: vi.fn().mockResolvedValue({ fields: [] }),
        sobject: vi.fn().mockReturnValue({
          create: vi.fn().mockResolvedValue([]),
          upsert: vi.fn().mockResolvedValue([]),
          update: vi.fn().mockResolvedValue([]),
          destroy: vi.fn().mockResolvedValue([]),
        }),
        limitInfo: undefined,
      } as never);

      const msg: InboundRequest & {
        payload: { config: Record<string, unknown> };
      } = inboundRequest({
        id: '1',
        type: 'sync:execute',
        timestamp: Date.now(),
        payload: {
          config: validSyncConfig(),
        },
      });

      await handler.handle(msg);

      // complete is called exactly once (in finally, not duplicated)
      expect(mockComplete).toHaveBeenCalledTimes(1);
    });
  });

  describe('sync:error channel', () => {
    /** Extracts all messages posted to the webview. */
    function postedMessages(): Array<
      BaseMessage & { payload: { message?: string; error?: string } }
    > {
      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      return postToWebview.mock.calls.map((c) => c[0]);
    }

    it('emits sync:error with the real message exactly once when executeSync fails', async () => {
      mockGetConn.mockRejectedValue(new Error('connection failed'));

      const msg: InboundRequest & {
        payload: { config: Record<string, unknown> };
      } = inboundRequest({
        id: '1',
        type: 'sync:execute',
        timestamp: Date.now(),
        payload: { config: validSyncConfig() },
      });

      await handler.handle(msg);

      const posted = postedMessages();
      const syncErrors = posted.filter((m) => m.type === 'sync:error');
      expect(syncErrors).toHaveLength(1);
      expect(syncErrors[0].payload.message).toBe('connection failed');
      // The operation:failed lifecycle message is preserved alongside.
      const opFailed = posted.filter((m) => m.type === 'operation:failed');
      expect(opFailed).toHaveLength(1);
      expect(opFailed[0].payload.error).toBe('connection failed');
    });

    it('emits sync:error exactly once on pre-flight failure (production guard blocked)', async () => {
      deps.infraServices = {
        performanceTracker: { start: vi.fn(), complete: vi.fn() },
        productionGuard: {
          check: vi.fn().mockReturnValue({
            allowed: false,
            blockedReason: 'prod org write blocked',
            impactSummary: 'writes to production',
          }),
          logOperation: vi.fn(),
          confirmIfNeeded: vi.fn(),
        },
        offlineManager: undefined,
        piiDetector: undefined,
      } as unknown as NonNullable<HandlerDeps['infraServices']>;

      const msg: InboundRequest & {
        payload: { config: Record<string, unknown> };
      } = inboundRequest({
        id: '1',
        type: 'sync:execute',
        timestamp: Date.now(),
        payload: { config: validSyncConfig() },
      });

      await handler.handle(msg);

      const posted = postedMessages();
      const syncErrors = posted.filter((m) => m.type === 'sync:error');
      expect(syncErrors).toHaveLength(1);
      expect(syncErrors[0].payload.message).toContain('prod org write blocked');
      expect(posted.filter((m) => m.type === 'operation:failed')).toHaveLength(1);
    });

    it('correlates sync:error to the request that caused it', async () => {
      // The whole point of the correlationId: `useMessageResponse` can only
      // drop a stale or foreign error when the error names its request. An
      // uncorrelated `sync:error` is adopted by whatever sync request happens
      // to be in flight — a minutes-long execute reported as failed because an
      // unrelated describe blew up.
      mockGetConn.mockRejectedValue(new Error('connection failed'));

      const msg: InboundRequest & {
        payload: { config: Record<string, unknown> };
      } = inboundRequest({
        id: 'req-execute-42',
        type: 'sync:execute',
        timestamp: Date.now(),
        payload: { config: validSyncConfig() },
      });

      await handler.handle(msg);

      const syncErrors = postedMessages().filter((m) => m.type === 'sync:error');
      expect(syncErrors).toHaveLength(1);
      expect(syncErrors[0].correlationId).toBe('req-execute-42');
    });

    it('gives a scheduled run a correlationId that matches no webview request', async () => {
      // A scheduled tick answers nobody. Its error still carries the synthetic
      // run id, so the webview matches it against nothing and drops it —
      // the opposite of an uncorrelated error, which every in-flight sync
      // request would try to claim.
      mockGetConn.mockRejectedValue(new Error('connection failed'));

      await handler.executeScheduled(
        validSyncConfig() as unknown as import('@sandforge/shared').SyncConfig,
      );

      const syncErrors = postedMessages().filter((m) => m.type === 'sync:error');
      expect(syncErrors).toHaveLength(1);
      expect(syncErrors[0].correlationId).toMatch(/^sync:schedule:/);
    });

    it('scheduled executions still convert failure to a failure-status result and emit sync:error once', async () => {
      mockGetConn.mockRejectedValue(new Error('connection failed'));

      const result = await handler.executeScheduled(
        validSyncConfig() as unknown as import('@sandforge/shared').SyncConfig,
      );

      expect(result.status).toBe('failure');
      const posted = postedMessages();
      expect(posted.filter((m) => m.type === 'sync:error')).toHaveLength(1);
      expect(posted.filter((m) => m.type === 'operation:failed')).toHaveLength(1);
    });

    it('tells the model which module and object a failed sync was on', async () => {
      // The prompt is all the model sees: an org error with no run behind it
      // gets an answer that fits any sync.
      const provider = vi.fn<AIProvider>(() =>
        Promise.resolve(JSON.stringify({ explanation: 'why', suggestions: [], confidence: 0.4 })),
      );
      deps.errorResolver = new ErrorResolver(provider);
      deps.broker = {
        postToWebview: vi.fn(),
        panelCount: 1,
        showFixSuggestion: vi.fn(),
      } as unknown as HandlerDeps['broker'];
      mockGetConn.mockRejectedValue(new Error('SOMETHING_WE_HAVE_NEVER_SEEN: odd'));

      await handler.handle(
        inboundRequest({
          id: '1',
          type: 'sync:execute',
          timestamp: Date.now(),
          payload: { config: validSyncConfig() },
        }),
      );
      await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));

      const [prompt] = provider.mock.calls[0];
      expect(prompt).toContain('Module: sync');
      expect(prompt).toContain('Operation: sync:execute');
      expect(prompt).toContain('Target object: Account');
      expect(prompt).toContain('Batch size: 200');
    });

    it('names the objects of a run that failed before it reached the org', async () => {
      // The pre-flight failure happens before any connection, so the context
      // can only come from the configuration the run was started with.
      const provider = vi.fn<AIProvider>(() =>
        Promise.resolve(JSON.stringify({ explanation: 'why', suggestions: [], confidence: 0.4 })),
      );
      deps.errorResolver = new ErrorResolver(provider);
      deps.broker = {
        postToWebview: vi.fn(),
        panelCount: 1,
        showFixSuggestion: vi.fn(),
      } as unknown as HandlerDeps['broker'];
      deps.infraServices = {
        performanceTracker: { start: vi.fn(), complete: vi.fn() },
        productionGuard: {
          check: vi.fn().mockReturnValue({
            allowed: true,
            requiresConfirmation: true,
            warnings: [],
            impactSummary: 'upsert 1 object',
          }),
          logOperation: vi.fn(),
          // The confirmation is a host dialog: when it fails the run ends
          // before a connection is ever opened.
          confirmIfNeeded: vi
            .fn()
            .mockRejectedValue(new Error('SOMETHING_WE_HAVE_NEVER_SEEN: odd')),
        },
        offlineManager: undefined,
        piiDetector: undefined,
      } as unknown as NonNullable<HandlerDeps['infraServices']>;

      await handler.handle(
        inboundRequest({
          id: 'req-sync-preflight',
          type: 'sync:execute',
          timestamp: Date.now(),
          payload: { config: validSyncConfig() },
        }),
      );
      await vi.waitFor(() => expect(provider).toHaveBeenCalledTimes(1));

      expect(mockGetConn).not.toHaveBeenCalled();
      const [prompt] = provider.mock.calls[0];
      expect(prompt).toContain('Module: sync');
      expect(prompt).toContain('Operation: sync:execute');
      expect(prompt).toContain('Target object: Account');
      expect(prompt).toContain('Batch size: 200');
    });
  });

  describe('robustness integration', () => {
    it('wraps describe-global with TimeoutManager', async () => {
      const describeGlobalFn = vi.fn().mockResolvedValue({
        sobjects: [
          {
            name: 'Account',
            label: 'Account',
            createable: true,
            queryable: true,
          },
        ],
      });
      mockGetConn.mockResolvedValue({
        describeGlobal: describeGlobalFn,
        limitInfo: undefined,
      } as never);

      const msg: InboundRequest & { payload: { orgId: string } } = inboundRequest({
        id: 'req-timeout-sync',
        type: 'sync:describe-global',
        timestamp: Date.now(),
        payload: { orgId: 'org-1' },
      });

      await handler.handle(msg);

      // describeGlobal was called (wrapped by TimeoutManager)
      expect(describeGlobalFn).toHaveBeenCalledTimes(1);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { objects: string[] };
      };
      expect(response.type).toBe('sync:describe-global:response');
      expect(response.payload.objects).toContain('Account');
    });

    it('wraps describe-fields with TimeoutManager', async () => {
      const sourceDescribeFn = vi.fn().mockResolvedValue({
        fields: [{ name: 'Name', label: 'Name', type: 'string', createable: true }],
      });
      const targetDescribeFn = vi.fn().mockResolvedValue({
        fields: [{ name: 'Name', label: 'Name', type: 'string', createable: true }],
      });
      mockGetConn.mockImplementation(async (orgId: string) => {
        if (orgId === 'src-org') {
          return { describe: sourceDescribeFn, limitInfo: undefined } as never;
        }
        return { describe: targetDescribeFn, limitInfo: undefined } as never;
      });

      const msg: InboundRequest & {
        payload: {
          sourceOrgId: string;
          targetOrgId: string;
          objectApiName: string;
        };
      } = inboundRequest({
        id: 'req-fields-timeout',
        type: 'sync:describe-fields',
        timestamp: Date.now(),
        payload: {
          sourceOrgId: 'src-org',
          targetOrgId: 'tgt-org',
          objectApiName: 'Account',
        },
      });

      await handler.handle(msg);

      expect(sourceDescribeFn).toHaveBeenCalledTimes(1);
      expect(targetDescribeFn).toHaveBeenCalledTimes(1);
    });

    /**
     * Hold a describe open and report the timeout the handler gave up after.
     * The handler catches the TimeoutError and answers `sync:error`, so the
     * message is read rather than the rejection.
     */
    async function timeoutAfter(advanceMs: number): Promise<string | undefined> {
      mockGetConn.mockResolvedValue({
        describeGlobal: vi.fn().mockImplementation(
          () =>
            new Promise(() => {
              /* never resolves -- a hung API call */
            }),
        ),
        limitInfo: undefined,
      } as never);

      vi.useFakeTimers();
      try {
        void handler.handle(
          inboundRequest({
            id: 'req-timeout-sync',
            type: 'sync:describe-global',
            timestamp: Date.now(),
            payload: { orgId: 'org-1' },
          }),
        );
        await vi.advanceTimersByTimeAsync(advanceMs);
      } finally {
        vi.useRealTimers();
      }

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const error = postToWebview.mock.calls
        .map((c) => c[0] as BaseMessage & { payload?: { message?: string } })
        .find((m) => m.type === 'sync:error');
      return error?.payload?.message;
    }

    it('gives up on a hung describe after the injected timeout', async () => {
      deps.robustness = {
        ...DEFAULT_ROBUSTNESS_CONFIG,
        timeouts: { ...DEFAULT_ROBUSTNESS_CONFIG.timeouts, describeGlobal: 5000 },
      };

      expect(await timeoutAfter(5000)).toContain('timed out after 5000ms');
    });

    it('falls back to the default timeout when no robustness config is injected', async () => {
      const timeout = DEFAULT_ROBUSTNESS_CONFIG.timeouts.describeGlobal;

      expect(await timeoutAfter(timeout)).toContain(`timed out after ${timeout}ms`);
    });
  });

  describe('sync:config CRUD handlers', () => {
    it('handles sync:config:save and responds with success', async () => {
      const config = validSyncConfig();

      const msg: InboundRequest & {
        payload: { config: Record<string, unknown> };
      } = inboundRequest({
        id: 'req-save',
        type: 'sync:config:save',
        timestamp: Date.now(),
        payload: { config },
      });

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        correlationId?: string;
        payload: { success: boolean; id: string };
      };
      expect(response.type).toBe('sync:config:save:response');
      expect(response.correlationId).toBe('req-save');
      expect(response.payload.success).toBe(true);
      expect(response.payload.id).toBe('cfg-1');
    });

    it.each([
      ['direction', 'target_to_source'],
      ['mode', 'incremental'],
      ['conflictStrategy', 'manual'],
    ])('refuses to save a configuration whose %s the sync cannot run', async (field, value) => {
      // A saved configuration is what a schedule runs unattended, so it has to
      // pass the same boundary as a run started by hand — otherwise the refusal
      // only lands weeks later, on the first tick, with nobody watching.
      const config = { ...validSyncConfig(), [field]: value };

      const result = await handler.handle(
        inboundRequest({
          id: 'req-save-refused',
          type: 'sync:config:save',
          timestamp: Date.now(),
          payload: { config },
        } as BaseMessage & { payload: { config: Record<string, unknown> } }),
      );
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { code: string };
      };
      expect(response.type).toBe('sync:error');
      expect(response.payload.code).toBe('INVALID_PAYLOAD');
      // Nothing reached the store, so the schedule builder, which offers only
      // what sync:config:list returns, has nothing to build a schedule on.
      expect(deps.configStore.set).not.toHaveBeenCalled();
      postToWebview.mockClear();
      await handler.handle(
        inboundRequest({ id: 'req-list-after-refusal', type: 'sync:config:list', timestamp: 1 }),
      );
      const list = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { configs: unknown[] };
      };
      expect(list.type).toBe('sync:config:list:response');
      expect(list.payload.configs).toEqual([]);
    });

    it('handles sync:config:list and responds with summaries', async () => {
      // Save a config first
      const config = {
        ...validSyncConfig(),
        id: 'cfg-list',
        name: 'List Config',
      };
      await handler.handle(
        inboundRequest({
          id: 'save-1',
          type: 'sync:config:save',
          timestamp: Date.now(),
          payload: { config },
        } as BaseMessage & { payload: { config: Record<string, unknown> } }),
      );

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      postToWebview.mockClear();

      const msg: InboundRequest = inboundRequest({
        id: 'req-list',
        type: 'sync:config:list',
        timestamp: Date.now(),
      });

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { configs: Array<{ id: string; name: string }> };
      };
      expect(response.type).toBe('sync:config:list:response');
      expect(response.payload.configs).toHaveLength(1);
      expect(response.payload.configs[0].id).toBe('cfg-list');
      expect(response.payload.configs[0].name).toBe('List Config');
    });

    it('handles sync:config:load and responds with config or null', async () => {
      const msg: InboundRequest & { payload: { id: string } } = inboundRequest({
        id: 'req-load',
        type: 'sync:config:load',
        timestamp: Date.now(),
        payload: { id: 'non-existent' },
      });

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { config: unknown };
      };
      expect(response.type).toBe('sync:config:load:response');
      expect(response.payload.config).toBeNull();
    });

    it('handles sync:config:delete and responds with success boolean', async () => {
      const msg: InboundRequest & { payload: { id: string } } = inboundRequest({
        id: 'req-del',
        type: 'sync:config:delete',
        timestamp: Date.now(),
        payload: { id: 'non-existent' },
      });

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { success: boolean };
      };
      expect(response.type).toBe('sync:config:delete:response');
      expect(response.payload.success).toBe(false);
    });
  });

  describe('background operation registry', () => {
    it('registers operation in BackgroundOperationRegistry when registry is set', async () => {
      const registry = new BackgroundOperationRegistry();
      handler.setRegistry(registry);

      mockGetConn.mockResolvedValue({
        query: vi.fn().mockResolvedValue({ records: [] }),
        // Both orgs are described before the run to compare field types.
        describe: vi.fn().mockResolvedValue({ fields: [] }),
        sobject: vi.fn().mockReturnValue({
          create: vi.fn().mockResolvedValue([]),
          upsert: vi.fn().mockResolvedValue([]),
          update: vi.fn().mockResolvedValue([]),
          destroy: vi.fn().mockResolvedValue([]),
        }),
        limitInfo: undefined,
      } as never);

      const msg: InboundRequest & {
        payload: { config: Record<string, unknown> };
      } = inboundRequest({
        id: 'bg-op-1',
        type: 'sync:execute',
        timestamp: Date.now(),
        payload: {
          config: validSyncConfig(),
        },
      });

      await handler.handle(msg);

      // Operation should be registered in the registry
      expect(registry.has('bg-op-1')).toBe(true);
      const op = registry.get('bg-op-1');
      expect(op?.module).toBe('sync');
    });

    it('handleExecute returns immediately when registry is set (detached mode)', async () => {
      const registry = new BackgroundOperationRegistry();
      handler.setRegistry(registry);

      // Connection setup that will work
      mockGetConn.mockResolvedValue({
        query: vi.fn().mockResolvedValue({ records: [] }),
        // Both orgs are described before the run to compare field types.
        describe: vi.fn().mockResolvedValue({ fields: [] }),
        sobject: vi.fn().mockReturnValue({
          create: vi.fn().mockResolvedValue([]),
          upsert: vi.fn().mockResolvedValue([]),
          update: vi.fn().mockResolvedValue([]),
          destroy: vi.fn().mockResolvedValue([]),
        }),
        limitInfo: undefined,
      } as never);

      const msg: InboundRequest & {
        payload: { config: Record<string, unknown> };
      } = inboundRequest({
        id: 'bg-op-2',
        type: 'sync:execute',
        timestamp: Date.now(),
        payload: {
          config: validSyncConfig(),
        },
      });

      // handleExecute should return without awaiting completion
      const result = await handler.handle(msg);
      expect(result).toBe(true);

      // operation:started was sent
      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const startedMsgs = postToWebview.mock.calls
        .map((c) => c[0] as BaseMessage)
        .filter((m) => m.type === 'operation:started');
      expect(startedMsgs.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Bulk API job limiter', () => {
    /** Run one sync to completion and hand back the writer's dependencies. */
    async function runSync(): Promise<ConstructorParameters<typeof BulkDataWriter>[0]> {
      mockGetConn.mockResolvedValue({
        query: vi.fn().mockResolvedValue({ records: [] }),
        describe: vi.fn().mockResolvedValue({ fields: [] }),
        sobject: vi.fn().mockReturnValue({
          create: vi.fn().mockResolvedValue([]),
          upsert: vi.fn().mockResolvedValue([]),
          update: vi.fn().mockResolvedValue([]),
          destroy: vi.fn().mockResolvedValue([]),
        }),
        limitInfo: undefined,
      } as never);

      await handler.handle(
        inboundRequest({
          id: 'sync-limiter-1',
          type: 'sync:execute',
          timestamp: Date.now(),
          payload: { config: validSyncConfig() },
        } as BaseMessage),
      );

      const call = vi.mocked(BulkDataWriter).mock.calls[0];
      if (!call) throw new Error('BulkDataWriter was never constructed');
      return call[0];
    }

    it('writes through the injected limiter, not one sized per run', async () => {
      // Salesforce caps concurrent Bulk API jobs per org, not per run: a sync
      // holding a budget of its own let a sync and a seed exceed the cap
      // together.
      const bulkManager = new BulkApiManager(2);
      deps.bulkManager = bulkManager;
      deps.services = {
        getSandforgeSetting: vi.fn(() => 200),
        syncOrchestrator: vi.fn(() => ({
          execute: vi.fn().mockResolvedValue({ status: 'completed' }),
        })),
      } as unknown as HandlerDeps['services'];

      expect((await runSync()).bulkManager).toBe(bulkManager);
    });

    it('falls back to the default job limit when none is injected', async () => {
      deps.services = {
        getSandforgeSetting: vi.fn(() => 200),
        syncOrchestrator: vi.fn(() => ({
          execute: vi.fn().mockResolvedValue({ status: 'completed' }),
        })),
      } as unknown as HandlerDeps['services'];

      expect((await runSync()).bulkManager.maxConcurrentJobs).toBe(
        DEFAULT_ROBUSTNESS_CONFIG.bulk.maxConcurrentJobs,
      );
    });
  });

  describe('scheduled runs in the background operation registry', () => {
    // Live Operations lists scheduled syncs, and its Cancel reaches runs
    // through the registry only: an unregistered run answers "Operation not
    // found" and cannot be stopped.
    it('registers a scheduled sync under its operationId while it runs', async () => {
      const registry = new BackgroundOperationRegistry();
      handler.setRegistry(registry);
      let refuseConnection: (err: Error) => void = () => undefined;
      mockGetConn.mockReturnValue(
        new Promise<never>((_resolve, reject) => {
          refuseConnection = reject;
        }),
      );

      const run = handler.executeScheduled(
        validSyncConfig() as unknown as import('@sandforge/shared').SyncConfig,
      );

      await vi.waitFor(() => expect(registry.getActiveOperations()).toHaveLength(1));
      const [op] = registry.getActiveOperations();
      expect(op.operationId.startsWith('sync:schedule:')).toBe(true);
      expect(op.module).toBe('sync');
      expect(op.status).toBe('running');

      refuseConnection(new Error('connection failed'));
      await run;
      await vi.waitFor(() => expect(registry.get(op.operationId)?.status).toBe('failed'));
    });
  });

  describe('payload validation', () => {
    it('rejects sync:execute with an injection-shaped objectApiName before touching the org', async () => {
      const config = validSyncConfig();
      (config.objects as Array<Record<string, unknown>>)[0].objectApiName =
        'Account WHERE Id != null';

      const msg = inboundRequest({
        id: 'bad-1',
        type: 'sync:execute',
        timestamp: Date.now(),
        payload: { config },
      } as BaseMessage);

      const result = await handler.handle(msg);
      expect(result).toBe(true);
      expect(mockGetConn).not.toHaveBeenCalled();

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const errMsg = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { code: string; message: string };
      };
      expect(errMsg.type).toBe('sync:error');
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
      expect(errMsg.payload.message).toContain('Invalid Salesforce API name');
    });

    it('rejects sync:execute with a subquery WHERE clause', async () => {
      const config = validSyncConfig();
      (config.objects as Array<Record<string, unknown>>)[0].where =
        'Id IN (SELECT Id FROM Contact)';

      const msg = inboundRequest({
        id: 'bad-2',
        type: 'sync:execute',
        timestamp: Date.now(),
        payload: { config },
      } as BaseMessage);

      await handler.handle(msg);
      expect(mockGetConn).not.toHaveBeenCalled();

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const errMsg = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { code: string };
      };
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
    });

    it('accepts a valid sync:execute payload (validation does not break the flow)', async () => {
      mockGetConn.mockRejectedValue(new Error('no org in test'));

      const msg = inboundRequest({
        id: 'good-1',
        type: 'sync:execute',
        timestamp: Date.now(),
        payload: { config: validSyncConfig() },
      } as BaseMessage);

      await handler.handle(msg);
      // Reached the connection stage: validation let the payload through.
      expect(mockGetConn).toHaveBeenCalled();
    });
  });

  describe('live operation tracker', () => {
    it('registers the operation and marks it failed on connection failure', async () => {
      const tracker = new LiveOperationTracker();
      handler.setLiveOperationTracker(tracker);

      mockGetConn.mockRejectedValue(new Error('connection failed'));

      const msg: InboundRequest & {
        payload: { config: Record<string, unknown> };
      } = inboundRequest({
        id: 'sync-live-1',
        type: 'sync:execute',
        timestamp: Date.now(),
        payload: { config: validSyncConfig() },
      });

      await handler.handle(msg);

      const op = tracker.get('sync-live-1');
      expect(op?.module).toBe('sync');
      expect(op?.status).toBe('failed');
      expect(op?.error).toBe('connection failed');
      tracker.dispose();
    });

    it('registers the operation and completes it on success', async () => {
      const tracker = new LiveOperationTracker();
      handler.setLiveOperationTracker(tracker);

      deps.services = {
        getSandforgeSetting: vi.fn(() => 200),
        syncOrchestrator: vi.fn(() => ({
          execute: vi.fn().mockResolvedValue({ status: 'completed' }),
        })),
      } as unknown as HandlerDeps['services'];

      mockGetConn.mockResolvedValue({
        query: vi.fn().mockResolvedValue({ records: [] }),
        // Both orgs are described before the run to compare field types.
        describe: vi.fn().mockResolvedValue({ fields: [] }),
        sobject: vi.fn().mockReturnValue({
          create: vi.fn().mockResolvedValue([]),
          upsert: vi.fn().mockResolvedValue([]),
          update: vi.fn().mockResolvedValue([]),
          destroy: vi.fn().mockResolvedValue([]),
        }),
        limitInfo: undefined,
      } as never);

      const msg: InboundRequest & {
        payload: { config: Record<string, unknown> };
      } = inboundRequest({
        id: 'sync-live-2',
        type: 'sync:execute',
        timestamp: Date.now(),
        payload: { config: validSyncConfig() },
      });

      await handler.handle(msg);

      const op = tracker.get('sync-live-2');
      expect(op?.module).toBe('sync');
      expect(op?.status).toBe('completed');
      expect(op?.percentage).toBe(100);
      tracker.dispose();
    });

    it('tracks scheduled executions as well', async () => {
      const tracker = new LiveOperationTracker();
      handler.setLiveOperationTracker(tracker);

      mockGetConn.mockRejectedValue(new Error('connection failed'));

      const result = await handler.executeScheduled(
        validSyncConfig() as unknown as import('@sandforge/shared').SyncConfig,
      );
      expect(result.status).toBe('failure');

      const ops = tracker.getAll();
      expect(ops).toHaveLength(1);
      expect(ops[0].module).toBe('sync');
      expect(ops[0].status).toBe('failed');
      expect(ops[0].operationId.startsWith('sync:schedule:')).toBe(true);
      tracker.dispose();
    });
  });

  describe('offline queue producer', () => {
    function wireOfflineManager(): OfflineManager {
      const offlineManager = new OfflineManager(deps.configStore);
      deps.infraServices = {
        performanceTracker: undefined,
        productionGuard: undefined,
        offlineManager,
        piiDetector: undefined,
      } as unknown as NonNullable<HandlerDeps['infraServices']>;
      return offlineManager;
    }

    it('enqueues the sync config for replay when the failure is a network error', async () => {
      const offlineManager = wireOfflineManager();

      mockGetConn.mockRejectedValue(
        Object.assign(new Error('getaddrinfo ENOTFOUND login.salesforce.com'), {
          code: 'ENOTFOUND',
        }),
      );

      const msg: InboundRequest & {
        payload: { config: Record<string, unknown> };
      } = inboundRequest({
        id: 'sync-offline-1',
        type: 'sync:execute',
        timestamp: Date.now(),
        payload: { config: validSyncConfig() },
      });

      await handler.handle(msg);

      const queue = offlineManager.getQueue();
      expect(queue).toHaveLength(1);
      expect(queue[0].id).toBe('sync-offline-1');
      expect(queue[0].type).toBe('sync');
      expect(queue[0].orgId).toBe('tgt-org');
      expect((queue[0].payload.config as { id: string }).id).toBe('cfg-1');
    });

    it('does NOT enqueue when the failure is a Salesforce API error', async () => {
      const offlineManager = wireOfflineManager();

      mockGetConn.mockRejectedValue(new Error('FIELD_INTEGRITY_EXCEPTION: bad value'));

      const msg: InboundRequest & {
        payload: { config: Record<string, unknown> };
      } = inboundRequest({
        id: 'sync-offline-2',
        type: 'sync:execute',
        timestamp: Date.now(),
        payload: { config: validSyncConfig() },
      });

      await handler.handle(msg);

      expect(offlineManager.getQueueSize()).toBe(0);
    });

    it('does NOT re-enqueue when a replay (rerun) fails again on a network error', async () => {
      const offlineManager = wireOfflineManager();

      mockGetConn.mockRejectedValue(
        Object.assign(new Error('getaddrinfo ENOTFOUND login.salesforce.com'), {
          code: 'ENOTFOUND',
        }),
      );

      // Replay path used by the OfflineManager drain (ExtensionHandlers.
      // replayQueuedOperation → rerunFromSnapshot): a second transport failure
      // must drop the operation instead of re-queuing it — otherwise the drain
      // loops forever, firing operationQueued/operationExecuted notifications
      // on every cycle.
      const msg: InboundRequest = inboundRequest({
        id: 'sync-offline-rerun',
        type: 'sync:history:rerun',
        timestamp: Date.now(),
      });

      await handler.rerunFromSnapshot(msg, validSyncConfig());

      expect(offlineManager.getQueueSize()).toBe(0);

      // The failure still surfaces on the usual channels.
      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const types = postToWebview.mock.calls.map((c) => (c[0] as BaseMessage).type);
      expect(types).toContain('operation:failed');
      expect(types).toContain('sync:error');
    });
  });

  describe('production guard request', () => {
    /** Make the target org ('tgt-org') resolve to the given org type. */
    function mockTargetOrgType(orgType: string): void {
      (deps.orgManager.getOrg as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ orgType });
    }

    /** Wire the real ProductionGuard so its rules — not a stub — decide. */
    function wireRealGuard(): ProductionGuard {
      const guard = new ProductionGuard();
      deps.infraServices = {
        performanceTracker: undefined,
        productionGuard: guard,
        offlineManager: undefined,
        piiDetector: undefined,
      } as unknown as NonNullable<HandlerDeps['infraServices']>;
      return guard;
    }

    /** Wire a spying guard that always allows, to inspect the request built. */
    function wireSpyGuard(): ReturnType<typeof vi.fn> {
      const check = vi.fn().mockReturnValue({
        allowed: true,
        requiresConfirmation: false,
        requiresApproval: false,
        warnings: [],
        impactSummary: 'summary',
      });
      deps.infraServices = {
        performanceTracker: undefined,
        productionGuard: {
          check,
          logOperation: vi.fn(),
          confirmIfNeeded: vi.fn().mockResolvedValue(true),
        },
        offlineManager: undefined,
        piiDetector: undefined,
      } as unknown as NonNullable<HandlerDeps['infraServices']>;
      return check;
    }

    /** A connection good enough for the run to succeed past the guard. */
    function mockWorkingConnection(): void {
      mockGetConn.mockResolvedValue({
        query: vi.fn().mockResolvedValue({ records: [] }),
        // Both orgs are described before the run to compare field types.
        describe: vi.fn().mockResolvedValue({ fields: [] }),
        sobject: vi.fn().mockReturnValue({
          create: vi.fn().mockResolvedValue([]),
          upsert: vi.fn().mockResolvedValue([]),
          update: vi.fn().mockResolvedValue([]),
          destroy: vi.fn().mockResolvedValue([]),
        }),
        limitInfo: undefined,
      } as never);
    }

    it('blocks a delete-mode sync to a production org', async () => {
      wireRealGuard();
      mockTargetOrgType('Production');
      mockWorkingConnection();

      const msg: InboundRequest & {
        payload: { config: Record<string, unknown> };
      } = inboundRequest({
        id: 'sync-guard-delete',
        type: 'sync:execute',
        timestamp: Date.now(),
        payload: {
          config: syncConfigWithObjects([{ objectApiName: 'Account', operation: 'delete' }]),
        },
      });

      await handler.handle(msg);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const posted = postToWebview.mock.calls.map(
        (c) => c[0] as BaseMessage & { payload: { message?: string } },
      );
      const syncErrors = posted.filter((m) => m.type === 'sync:error');
      expect(syncErrors).toHaveLength(1);
      expect(syncErrors[0].payload.message).toContain(
        'delete is not allowed on production org tgt-org',
      );
      // The guard gates the run: no connection is even opened.
      expect(mockGetConn).not.toHaveBeenCalled();
    });

    it('blocks a scheduled delete-mode sync to a production org', async () => {
      wireRealGuard();
      mockTargetOrgType('Production');
      mockWorkingConnection();

      await expect(
        handler.executeScheduled(
          syncConfigWithObjects([
            { objectApiName: 'Account', operation: 'delete' },
          ]) as unknown as import('@sandforge/shared').SyncConfig,
        ),
      ).rejects.toThrow(/delete is not allowed on production org tgt-org/);
      expect(mockGetConn).not.toHaveBeenCalled();
    });

    /**
     * Wire a guard that allows the run but demands a confirmation the user
     * then refuses. Both entry points must stop on that refusal.
     */
    function wireDecliningGuard(): ReturnType<typeof vi.fn> {
      const confirmIfNeeded = vi.fn().mockResolvedValue(false);
      deps.infraServices = {
        performanceTracker: undefined,
        productionGuard: {
          check: vi.fn().mockReturnValue({
            allowed: true,
            requiresConfirmation: true,
            requiresApproval: false,
            warnings: [],
            impactSummary: 'upsert 1 object on a production org',
          }),
          logOperation: vi.fn(),
          confirmIfNeeded,
        },
        offlineManager: undefined,
        piiDetector: undefined,
      } as unknown as NonNullable<HandlerDeps['infraServices']>;
      return confirmIfNeeded;
    }

    it('stops an interactive sync the user declined to confirm, before any connection', async () => {
      // A decline is not a failure to report twice, nor a run to start anyway:
      // exactly one sync:error settles the webview mutation and the org is
      // never opened.
      const confirmIfNeeded = wireDecliningGuard();
      mockWorkingConnection();

      await handler.handle(
        inboundRequest({
          id: 'sync-declined',
          type: 'sync:execute',
          timestamp: Date.now(),
          payload: { config: validSyncConfig() },
        }),
      );

      expect(confirmIfNeeded).toHaveBeenCalledOnce();
      expect(mockGetConn).not.toHaveBeenCalled();

      const posted = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[0] as BaseMessage & { payload: { message?: string; code?: string } },
      );
      const syncErrors = posted.filter((m) => m.type === 'sync:error');
      expect(syncErrors).toHaveLength(1);
      expect(syncErrors[0].payload.code).toBe('PROD_CONFIRMATION_DECLINED');
      expect(syncErrors[0].payload.message).toBe(
        'Operation cancelled by user (production confirmation declined).',
      );
      expect(posted.filter((m) => m.type === 'operation:failed')).toHaveLength(1);
      // Nothing was executed: no completion is announced.
      expect(posted.filter((m) => m.type === 'operation:completed')).toHaveLength(0);
    });

    it('rejects a scheduled sync the user declined to confirm, before any connection', async () => {
      // The scheduler owns the outcome of a tick, so a decline rejects rather
      // than posting to a channel nobody listens on at tick time.
      const confirmIfNeeded = wireDecliningGuard();
      mockWorkingConnection();

      await expect(
        handler.executeScheduled(
          validSyncConfig() as unknown as import('@sandforge/shared').SyncConfig,
        ),
      ).rejects.toThrow('Scheduled sync cancelled (production confirmation declined).');

      expect(confirmIfNeeded).toHaveBeenCalledOnce();
      expect(mockGetConn).not.toHaveBeenCalled();
    });

    it('reports the most destructive operation and every object to the guard', async () => {
      const check = wireSpyGuard();
      mockTargetOrgType('Sandbox');
      mockWorkingConnection();

      const msg: InboundRequest & {
        payload: { config: Record<string, unknown> };
      } = inboundRequest({
        id: 'sync-guard-request',
        type: 'sync:execute',
        timestamp: Date.now(),
        payload: {
          config: syncConfigWithObjects([
            { objectApiName: 'Account', operation: 'upsert' },
            { objectApiName: 'Contact', operation: 'delete' },
          ]),
        },
      });

      await handler.handle(msg);

      expect(check).toHaveBeenCalledTimes(1);
      expect(check.mock.calls[0][0]).toMatchObject({
        orgId: 'tgt-org',
        orgTier: 'development',
        operation: 'delete',
        objectName: 'Account, Contact',
        // Row counts are unknown until the orchestrator queries the source.
        recordCount: 'unknown',
        module: 'sync',
      });
    });

    it('reports a non-destructive multi-object sync as its own operation', async () => {
      const check = wireSpyGuard();
      mockTargetOrgType('Sandbox');
      mockWorkingConnection();

      const msg: InboundRequest & {
        payload: { config: Record<string, unknown> };
      } = inboundRequest({
        id: 'sync-guard-request-2',
        type: 'sync:execute',
        timestamp: Date.now(),
        payload: {
          config: syncConfigWithObjects([
            { objectApiName: 'Account', operation: 'insert' },
            { objectApiName: 'Contact', operation: 'update' },
          ]),
        },
      });

      await handler.handle(msg);

      expect(check.mock.calls[0][0]).toMatchObject({
        operation: 'update',
        objectName: 'Account, Contact',
      });
    });
  });

  describe('execution history for failed runs', () => {
    /** Wire the real logger + store over the in-memory ConfigStore mock. */
    function wireRealHistory(): SyncHistoryStore {
      const store = new SyncHistoryStore(deps.configStore);
      handler.setHistoryLogger(new SyncExecutionLogger(store));
      return store;
    }

    it('records a sync that threw, and its snapshot is re-runnable', async () => {
      const store = wireRealHistory();
      mockGetConn.mockRejectedValue(new Error('connection failed'));

      const msg: InboundRequest & {
        payload: { config: Record<string, unknown> };
      } = inboundRequest({
        id: 'sync-history-fail',
        type: 'sync:execute',
        timestamp: Date.now(),
        payload: { config: validSyncConfig() },
      });

      await handler.handle(msg);

      // The run that failed is exactly the one the history panel must show:
      // without it, "re-run" is unreachable for the runs that need it.
      const entries = store.list();
      expect(entries).toHaveLength(1);
      expect(entries[0].result.status).toBe('failure');
      expect(entries[0].result.operationId).toBe('sync-history-fail');
      expect(entries[0].result.configId).toBe('cfg-1');
      expect(entries[0].triggeredBy).toBe('manual');

      // And the persisted snapshot really drives `sync:history:rerun`.
      mockGetConn.mockClear();
      await handler.rerunFromSnapshot(
        inboundRequest({
          id: 'sync-history-rerun',
          type: 'sync:history:rerun',
          timestamp: Date.now(),
        }),
        entries[0].configSnapshot,
      );
      expect(mockGetConn).toHaveBeenCalled();
      const afterRerun = store.list();
      expect(afterRerun).toHaveLength(2);
      expect(afterRerun.map((e) => e.triggeredBy)).toContain('rerun');
    });

    it('records a failed scheduled run', async () => {
      const store = wireRealHistory();
      mockGetConn.mockRejectedValue(new Error('connection failed'));

      const result = await handler.executeScheduled(
        validSyncConfig() as unknown as import('@sandforge/shared').SyncConfig,
      );

      expect(result.status).toBe('failure');
      const entries = store.list();
      expect(entries).toHaveLength(1);
      expect(entries[0].triggeredBy).toBe('schedule');
      expect(entries[0].result.status).toBe('failure');
    });

    it('never lets a history-logging failure mask the sync error', async () => {
      handler.setHistoryLogger({
        logExecution: vi.fn(() => {
          throw new Error('history store full');
        }),
      } as unknown as SyncExecutionLogger);
      mockGetConn.mockRejectedValue(new Error('connection failed'));

      const result = await handler.executeScheduled(
        validSyncConfig() as unknown as import('@sandforge/shared').SyncConfig,
      );

      expect(result.status).toBe('failure');
      expect(deps.log).toHaveBeenCalledWith(
        expect.stringContaining('[WARN] sync history logging failed: history store full'),
      );
      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const posted = postToWebview.mock.calls.map(
        (c) => c[0] as BaseMessage & { payload: { message?: string } },
      );
      const syncErrors = posted.filter((m) => m.type === 'sync:error');
      expect(syncErrors).toHaveLength(1);
      expect(syncErrors[0].payload.message).toBe('connection failed');
    });
  });

  describe('the source read is paginated, and a bound that cuts it is announced', () => {
    /**
     * One row as a real `SELECT FIELDS(ALL) FROM Account` returns it:
     * `attributes` plus ~35 columns. A three-field fixture pages exactly the
     * same way and proves nothing about what a real page costs or carries.
     */
    function accountRow(index: number): Record<string, unknown> {
      const id = `001AB000${String(index).padStart(6, '0')}`;
      return {
        attributes: {
          type: 'Account',
          url: `/services/data/v62.0/sobjects/Account/${id}`,
        },
        Id: id,
        IsDeleted: false,
        MasterRecordId: null,
        Name: `Account ${index}`,
        Type: 'Customer - Direct',
        ParentId: null,
        BillingStreet: `${index} rue de la Paix`,
        BillingCity: 'Paris',
        BillingState: 'IDF',
        BillingPostalCode: '75002',
        BillingCountry: 'France',
        ShippingStreet: `${index} rue de la Paix`,
        ShippingCity: 'Paris',
        ShippingState: 'IDF',
        ShippingPostalCode: '75002',
        ShippingCountry: 'France',
        Phone: '+33 1 23 45 67 89',
        Fax: null,
        AccountNumber: `CD${index}`,
        Website: 'https://example.invalid',
        Sic: '5712',
        Industry: 'Technology',
        AnnualRevenue: 1_000_000 + index,
        NumberOfEmployees: 42,
        Ownership: 'Private',
        TickerSymbol: null,
        Description: 'Seeded by the sync test double.',
        Rating: 'Warm',
        Site: null,
        OwnerId: '005AB0000012345',
        CreatedDate: '2026-01-01T00:00:00.000+0000',
        CreatedById: '005AB0000012345',
        LastModifiedDate: '2026-02-01T00:00:00.000+0000',
        LastModifiedById: '005AB0000012345',
        SystemModstamp: '2026-02-01T00:00:00.000+0000',
        LastActivityDate: null,
      };
    }

    /**
     * A connection double that behaves like the API the handler talks to:
     * `query` honours the `LIMIT` clause of the SOQL it is given, returns one
     * page at a time, and hands back a cursor for the rest. A double that
     * ignores `LIMIT` hides the whole defect — it pages happily while the real
     * org stops at the limit and says `done: true`.
     */
    function createOrgConnection(total: number, pageSize: number) {
      const page = (cap: number, offset: number) => {
        const count = Math.max(0, Math.min(pageSize, cap - offset));
        const next = offset + count;
        const done = next >= cap;
        return {
          totalSize: cap,
          done,
          records: Array.from({ length: count }, (_, i) => accountRow(offset + i)),
          // The cursor carries the cap so the double stays stateless.
          ...(done
            ? {}
            : {
                nextRecordsUrl: `/services/data/v62.0/query/01g000-${cap}-${next}`,
              }),
        };
      };
      return {
        query: vi.fn(async (soql: string) => {
          const limit = /\bLIMIT\s+(\d+)/i.exec(soql);
          return page(limit ? Math.min(Number(limit[1]), total) : total, 0);
        }),
        queryMore: vi.fn(async (url: string) => {
          const [, cap, offset] = url.split('-');
          return page(Number(cap), Number(offset));
        }),
        describe: vi.fn(),
        sobject: vi.fn().mockReturnValue({
          create: vi.fn().mockResolvedValue([]),
          upsert: vi.fn().mockResolvedValue([]),
          update: vi.fn().mockResolvedValue([]),
          destroy: vi.fn().mockResolvedValue([]),
        }),
        limitInfo: undefined,
      };
    }

    /** Shape of the query function the handler hands to the orchestrator. */
    type QueryFn = (
      orgId: string,
      objectConfig: import('@sandforge/shared').SyncObjectConfig,
    ) => Promise<Record<string, unknown>[]>;

    /**
     * Run `sync:execute` and hand back the `querySource` closure the handler
     * built for the orchestrator — the code under test.
     */
    /**
     * Both read closures, with a distinct org type per side.
     *
     * The single-tier version of this helper could not have caught the
     * inversion below: it made both orgs the same type, which is exactly the
     * case where reading the tier from the source alone looks correct.
     */
    async function captureQueryFns(
      sourceType: string,
      targetType: string = sourceType,
    ): Promise<{ querySource: QueryFn; queryTarget: QueryFn }> {
      (deps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockImplementation((id: string) => ({
        orgType: id === validSyncConfig().sourceOrgId ? sourceType : targetType,
      }));
      let both: { querySource: QueryFn; queryTarget: QueryFn } | undefined;
      deps.services = {
        getSandforgeSetting: vi.fn(() => 200),
        syncOrchestrator: vi.fn((d: unknown) => {
          both = d as { querySource: QueryFn; queryTarget: QueryFn };
          return {
            execute: vi.fn().mockResolvedValue({ status: 'completed' }),
          };
        }),
      } as unknown as HandlerDeps['services'];

      await handler.handle(
        inboundRequest({
          id: `sync-perf04-${sourceType}-${targetType}`,
          type: 'sync:execute',
          timestamp: Date.now(),
          payload: { config: validSyncConfig() },
        } as BaseMessage),
      );

      if (!both) throw new Error('syncOrchestrator was never called');
      return both;
    }

    async function captureQuerySource(orgType: string): Promise<QueryFn> {
      (deps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockReturnValue({
        orgType,
      });
      let captured: { querySource: QueryFn } | undefined;
      deps.services = {
        getSandforgeSetting: vi.fn(() => 200),
        syncOrchestrator: vi.fn((d: unknown) => {
          captured = d as { querySource: QueryFn };
          return {
            execute: vi.fn().mockResolvedValue({ status: 'completed' }),
          };
        }),
      } as unknown as HandlerDeps['services'];

      await handler.handle(
        inboundRequest({
          id: `sync-perf04-${orgType}`,
          type: 'sync:execute',
          timestamp: Date.now(),
          payload: { config: validSyncConfig() },
        } as BaseMessage),
      );

      if (!captured) throw new Error('syncOrchestrator was never called');
      return captured.querySource;
    }

    /** The object config the wizard produces for `Account`. */
    function accountConfig(): import('@sandforge/shared').SyncObjectConfig {
      return (validSyncConfig().objects as import('@sandforge/shared').SyncObjectConfig[])[0];
    }

    /** Every `notification` message posted to the webview. */
    function notifications(): Array<{
      level: string;
      title: string;
      message: string;
    }> {
      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      return postToWebview.mock.calls
        .map(
          (c) =>
            c[0] as BaseMessage & {
              payload: { level: string; title: string; message: string };
            },
        )
        .filter((m) => m.type === 'notification')
        .map((m) => m.payload);
    }

    it('reads every page of a sandbox source, not just the first', async () => {
      const conn = createOrgConnection(6_000, 2_000);
      mockGetConn.mockResolvedValue(conn as never);

      const querySource = await captureQuerySource('Sandbox');
      const records = await querySource('src-org', accountConfig());

      // The whole object, not the first page: 6 000 rows over three pages.
      expect(records).toHaveLength(6_000);
      expect(conn.queryMore).toHaveBeenCalledTimes(2);
      // And no server-side truncation to hide behind.
      expect(conn.query.mock.calls[0][0]).not.toMatch(/\bLIMIT\b/i);
      expect(notifications()).toHaveLength(0);
    });

    /**
     * An SFDMU export carries a read order, and the importer keeps it. It is
     * appended to the real read, between the filter and any limit, and checked
     * again where it becomes query text: an ORDER BY ends the statement, so
     * whatever followed it would run.
     */
    it('reads in the order the configuration names', async () => {
      const conn = createOrgConnection(10, 2_000);
      mockGetConn.mockResolvedValue(conn as never);

      const querySource = await captureQuerySource('Sandbox');
      await querySource('src-org', { ...accountConfig(), orderBy: 'Name ASC NULLS LAST' });

      expect(conn.query.mock.calls[0][0]).toMatch(/ ORDER BY Name ASC NULLS LAST$/);
    });

    it('refuses an order that carries more than a sort, before any query leaves', async () => {
      const conn = createOrgConnection(10, 2_000);
      mockGetConn.mockResolvedValue(conn as never);

      const querySource = await captureQuerySource('Sandbox');

      await expect(
        querySource('src-org', { ...accountConfig(), orderBy: 'Id ASC LIMIT 1' }),
      ).rejects.toThrow();
      expect(conn.query).not.toHaveBeenCalled();
    });

    /** The count closure the handler hands the orchestrator for the Grappe threshold. */
    async function captureCountSource(
      orgType: string,
    ): Promise<(orgId: string, objectConfig: ReturnType<typeof accountConfig>) => Promise<number>> {
      (deps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockReturnValue({ orgType });
      let captured:
        | { countSource?: (orgId: string, o: ReturnType<typeof accountConfig>) => Promise<number> }
        | undefined;
      deps.services = {
        getSandforgeSetting: vi.fn(() => 200),
        syncOrchestrator: vi.fn((d: unknown) => {
          captured = d as typeof captured;
          return { execute: vi.fn().mockResolvedValue({ status: 'completed' }) };
        }),
      } as unknown as HandlerDeps['services'];

      await handler.handle(
        inboundRequest({
          id: `sync-count-${orgType}`,
          type: 'sync:execute',
          timestamp: Date.now(),
          payload: { config: validSyncConfig() },
        } as BaseMessage),
      );

      if (!captured?.countSource) throw new Error('the orchestrator was handed no countSource');
      return captured.countSource;
    }

    it('counts the source with the read filter, for the Grappe threshold', async () => {
      const conn = createOrgConnection(6_000, 2_000);
      mockGetConn.mockResolvedValue(conn as never);

      const countSource = await captureCountSource('Sandbox');
      const total = await countSource('src-org', {
        ...accountConfig(),
        where: "Industry = 'Tech'",
      });

      expect(total).toBe(6_000);
      expect(conn.query.mock.calls[0][0]).toBe(
        "SELECT COUNT() FROM Account WHERE Industry = 'Tech'",
      );
      expect(conn.queryMore).not.toHaveBeenCalled();
    });

    it('counts a production source no further than its read cap', async () => {
      const conn = createOrgConnection(100_000, 2_000);
      mockGetConn.mockResolvedValue(conn as never);

      const countSource = await captureCountSource('Production');
      const querySource = await captureQuerySource('Production');
      const read = await querySource('src-org', accountConfig());

      expect(await countSource('src-org', accountConfig())).toBe(read.length);
    });

    it('counts a sandbox source no further than its read bound', async () => {
      const conn = createOrgConnection(60_000, 2_000);
      mockGetConn.mockResolvedValue(conn as never);

      const countSource = await captureCountSource('Sandbox');
      const querySource = await captureQuerySource('Sandbox');
      const read = await querySource('src-org', accountConfig());

      expect(read.length).toBeLessThan(60_000);
      expect(await countSource('src-org', accountConfig())).toBe(read.length);
    });

    it('says so when a read bound cuts the object short', async () => {
      // A cursor that never ends. Small pages so the 500-page bound is the one
      // reached: 500 pages of 2 000 rows would materialise a million records
      // in the test for the identical code path.
      const conn = createOrgConnection(1_000_000, 10);
      mockGetConn.mockResolvedValue(conn as never);

      const querySource = await captureQuerySource('Sandbox');
      const records = await querySource('src-org', accountConfig());

      expect(records).toHaveLength(5_000);
      const warned = notifications().filter((n) => n.level === 'warning');
      expect(warned).toHaveLength(1);
      expect(warned[0].message).toContain('Account');
      expect(warned[0].message).toContain('5000 record(s)');
      expect(warned[0].message).toContain('500 pages');
      // The side matters: a short read means something different on each.
      expect(warned[0].message).toContain('from the source');
      expect(warned[0].message).toContain('copies a subset');
      expect(deps.log).toHaveBeenCalledWith(
        expect.stringContaining(
          '[WARN] sync:execute Account (source): read stopped at 5000 record(s)',
        ),
      );
    });

    it('caps the PRODUCTION side of a sandbox -> production sync', async () => {
      // The regression this pins: the tier was read from the source alone and
      // the same closure served both reads. Harmless while every read carried
      // a LIMIT — but once the cap became conditional it inverted the
      // protection, and the production TARGET was read with no cap at all,
      // against the very org whose API budget the cap exists to protect.
      const conn = createOrgConnection(100_000, 2_000);
      mockGetConn.mockResolvedValue(conn as never);

      const { querySource, queryTarget } = await captureQueryFns('Sandbox', 'Production');

      const fromTarget = await queryTarget('tgt-org', accountConfig());
      expect(fromTarget).toHaveLength(500);
      expect(conn.query).toHaveBeenLastCalledWith(expect.stringContaining('LIMIT 500'));

      // And the sandbox source is still read in full, to the end of the cursor.
      const fromSource = await querySource('src-org', accountConfig());
      expect(fromSource.length).toBeGreaterThan(500);
    });

    it('keeps the conservative production cap — and announces it', async () => {
      const conn = createOrgConnection(100_000, 2_000);
      mockGetConn.mockResolvedValue(conn as never);

      const querySource = await captureQuerySource('Production');
      const records = await querySource('src-org', accountConfig());

      // The 500-record production cap is a deliberate guard on a business
      // org's API budget: it stays, server-side.
      expect(conn.query.mock.calls[0][0]).toContain('LIMIT 500');
      expect(records).toHaveLength(500);
      // What changes is that the user is told the sync is partial.
      const warned = notifications().filter((n) => n.level === 'warning');
      expect(warned).toHaveLength(1);
      expect(warned[0].message).toContain('production-tier query cap');
    });

    it('still falls back to an explicit field list when the org rejects FIELDS()', async () => {
      // Regression guard: the paged read must not cost the FIELDS() fallback,
      // which is the path every org below API 51 takes.
      const conn = createOrgConnection(3, 2_000);
      // Typed from the mock itself: `tsconfig.test.json` checks this file, and
      // a hand-written `Promise<unknown>` does not satisfy the query result shape.
      const realQuery = conn.query.getMockImplementation() as NonNullable<
        ReturnType<typeof conn.query.getMockImplementation>
      >;
      conn.query.mockImplementation(async (soql: string) => {
        if (soql.includes('FIELDS(ALL)')) {
          throw new Error('MALFORMED_QUERY: FIELDS(ALL) is not supported in this API version');
        }
        return realQuery(soql);
      });
      conn.describe.mockResolvedValue({
        fields: [{ name: 'Id' }, { name: 'Name' }, { name: 'Custom__c', custom: true }],
      });
      mockGetConn.mockResolvedValue(conn as never);

      const querySource = await captureQuerySource('Sandbox');
      const records = await querySource('src-org', accountConfig());

      expect(records).toHaveLength(3);
      expect(conn.describe).toHaveBeenCalledWith('Account');
      const lastSoql = conn.query.mock.calls[conn.query.mock.calls.length - 1][0] as string;
      expect(lastSoql).toContain('Id, Name, Custom__c');
      expect(notifications()).toHaveLength(0);
    });
  });

  describe('the WHERE clause is checked again where it becomes query text', () => {
    function queryConnection() {
      return {
        query: vi.fn(async () => ({ totalSize: 0, done: true, records: [] })),
        queryMore: vi.fn(),
        describe: vi.fn().mockResolvedValue({ fields: [] }),
        sobject: vi.fn(),
        limitInfo: undefined,
      };
    }

    async function captureQuerySource(): Promise<
      (
        orgId: string,
        objectConfig: import('@sandforge/shared').SyncObjectConfig,
      ) => Promise<unknown>
    > {
      (deps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockReturnValue({ orgType: 'Sandbox' });
      let captured:
        | {
            querySource: (
              orgId: string,
              objectConfig: import('@sandforge/shared').SyncObjectConfig,
            ) => Promise<unknown>;
          }
        | undefined;
      deps.services = {
        getSandforgeSetting: vi.fn(() => 200),
        syncOrchestrator: vi.fn((d: unknown) => {
          captured = d as typeof captured;
          return { execute: vi.fn().mockResolvedValue({ status: 'success' }) };
        }),
      } as unknown as HandlerDeps['services'];

      await handler.handle(
        inboundRequest({
          id: 'sync-where-build',
          type: 'sync:execute',
          timestamp: Date.now(),
          payload: { config: validSyncConfig() },
        } as BaseMessage),
      );
      if (!captured) throw new Error('syncOrchestrator was never called');
      return captured.querySource;
    }

    function accountConfig(where: string): import('@sandforge/shared').SyncObjectConfig {
      const [object] = validSyncConfig().objects as import('@sandforge/shared').SyncObjectConfig[];
      return { ...object, where };
    }

    it('refuses a WHERE that ends the statement, before any query leaves', async () => {
      const conn = queryConnection();
      mockGetConn.mockResolvedValue(conn as never);
      const querySource = await captureQuerySource();

      await expect(querySource('src-org', accountConfig('Id != null LIMIT 1'))).rejects.toThrow(
        'Invalid SOQL WHERE clause',
      );
      expect(conn.query).not.toHaveBeenCalled();
    });

    it('sends a filter whose literal spells a keyword unchanged', async () => {
      const conn = queryConnection();
      mockGetConn.mockResolvedValue(conn as never);
      const querySource = await captureQuerySource();

      await querySource('src-org', accountConfig("Status__c = 'Delete pending'"));

      expect(conn.query).toHaveBeenCalledWith(
        "SELECT FIELDS(ALL) FROM Account WHERE Status__c = 'Delete pending'",
      );
    });
  });

  describe('sync:describe-global leaves out objects whose content is a file', () => {
    it('does not offer Attachment, ContentVersion or Document', async () => {
      mockGetConn.mockResolvedValue({
        describeGlobal: vi.fn().mockResolvedValue({
          sobjects: ['Account', 'Attachment', 'ContentVersion', 'Document', 'Contact'].map(
            (name) => ({ name, createable: true, queryable: true }),
          ),
        }),
        limitInfo: undefined,
      } as never);

      await handler.handle(
        inboundRequest({
          id: 'req-global-binary',
          type: 'sync:describe-global',
          timestamp: Date.now(),
          payload: { orgId: 'org-1' },
        }),
      );

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { objects: string[] };
      };
      expect(response.payload.objects).toEqual(['Account', 'Contact']);
    });
  });

  describe('field types are compared across both orgs before anything is written', () => {
    type DescribedField = {
      name: string;
      type: string;
      createable?: boolean;
      updateable?: boolean;
    };

    /** A connection whose describe answers `fields` and whose writes are spies. */
    function orgConnection(fields: DescribedField[]) {
      const sobject = {
        create: vi.fn().mockResolvedValue([]),
        upsert: vi.fn().mockResolvedValue([]),
        update: vi.fn().mockResolvedValue([]),
        destroy: vi.fn().mockResolvedValue([]),
      };
      return {
        describe: vi.fn().mockResolvedValue({
          fields: fields.map((f) => ({ length: 0, createable: true, updateable: true, ...f })),
        }),
        query: vi.fn(async () => ({ totalSize: 0, done: true, records: [] })),
        queryMore: vi.fn(),
        sobject: vi.fn().mockReturnValue(sobject),
        writes: sobject,
        limitInfo: undefined,
      };
    }

    /** Run `sync:execute` for Account with `fieldMappings` between the two describes. */
    async function runSync(
      sourceFields: DescribedField[],
      targetFields: DescribedField[],
      fieldMappings: Array<{ sourceField: string; targetField: string; type: string }>,
    ) {
      const source = orgConnection(sourceFields);
      const target = orgConnection(targetFields);
      mockGetConn.mockImplementation(async (orgId: string) =>
        orgId === 'src-org' ? (source as never) : (target as never),
      );
      const execute = vi.fn().mockResolvedValue({ status: 'success', objectResults: [] });
      deps.services = {
        getSandforgeSetting: vi.fn(() => 200),
        syncOrchestrator: vi.fn(() => ({ execute })),
      } as unknown as HandlerDeps['services'];

      const config = validSyncConfig();
      (config.objects as Array<Record<string, unknown>>)[0].fieldMappings = fieldMappings;
      await handler.handle(
        inboundRequest({
          id: 'sync-field-types',
          type: 'sync:execute',
          timestamp: Date.now(),
          payload: { config },
        } as BaseMessage),
      );

      const posted = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[0] as BaseMessage & { payload: { message?: string } },
      );
      return { source, target, execute, posted };
    }

    it('a text field mapped onto a date field posts sync:error and writes nothing', async () => {
      const { target, execute, posted } = await runSync(
        [{ name: 'Legacy_Date__c', type: 'string' }],
        [{ name: 'Birthdate__c', type: 'date' }],
        [{ sourceField: 'Legacy_Date__c', targetField: 'Birthdate__c', type: 'direct' }],
      );

      const errors = posted.filter((m) => m.type === 'sync:error');
      expect(errors).toHaveLength(1);
      expect(errors[0].payload.message).toContain('Account.Legacy_Date__c (string)');
      expect(errors[0].payload.message).toContain('Account.Birthdate__c (date)');
      expect(posted.some((m) => m.type === 'operation:failed')).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      expect(target.writes.upsert).not.toHaveBeenCalled();
      expect(target.writes.create).not.toHaveBeenCalled();
    });

    it('compares same-named fields when the object has no explicit mapping', async () => {
      const { execute, posted } = await runSync(
        [
          { name: 'Name', type: 'string' },
          { name: 'Score__c', type: 'double' },
        ],
        [
          { name: 'Name', type: 'string' },
          { name: 'Score__c', type: 'boolean' },
        ],
        [],
      );

      const errors = posted.filter((m) => m.type === 'sync:error');
      expect(errors).toHaveLength(1);
      expect(errors[0].payload.message).toContain('Account.Score__c (double)');
      expect(execute).not.toHaveBeenCalled();
    });

    it('lets a compatible mapping through to the run', async () => {
      const { execute, posted } = await runSync(
        [{ name: 'Legacy_Name__c', type: 'string' }],
        [{ name: 'Name', type: 'string' }],
        [{ sourceField: 'Legacy_Name__c', targetField: 'Name', type: 'rename' }],
      );

      expect(posted.filter((m) => m.type === 'sync:error')).toHaveLength(0);
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('does not judge a mapping whose value a transform rewrites', async () => {
      const { execute, posted } = await runSync(
        [{ name: 'Legacy_Date__c', type: 'string' }],
        [{ name: 'Birthdate__c', type: 'date' }],
        [{ sourceField: 'Legacy_Date__c', targetField: 'Birthdate__c', type: 'transform' }],
      );

      expect(posted.filter((m) => m.type === 'sync:error')).toHaveLength(0);
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('ignores target fields the org does not let anyone write', async () => {
      const { execute } = await runSync(
        [{ name: 'Score__c', type: 'double' }],
        [
          {
            name: 'Score__c',
            type: 'boolean',
            createable: false,
            updateable: false,
          } as DescribedField,
        ],
        [],
      );

      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('a describe that lists a field without a type ends the run naming the object', async () => {
      const { execute, posted } = await runSync(
        [{ name: 'Name' } as DescribedField],
        [{ name: 'Name', type: 'string' }],
        [],
      );

      const errors = posted.filter((m) => m.type === 'sync:error');
      expect(errors).toHaveLength(1);
      expect(errors[0].payload.message).toContain('Account');
      expect(errors[0].payload.message).toContain('source org');
      expect(errors[0].payload.message).not.toContain('toLowerCase');
      expect(execute).not.toHaveBeenCalled();
    });
  });
});
