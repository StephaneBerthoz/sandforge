import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncOpsHandler } from './SyncOpsHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import type { BaseMessage } from '@sandforge/shared';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));
vi.mock('../../modules/sync/DataSync.js', () => ({
  DataSync: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../../modules/sync/MetadataSync.js', () => ({
  MetadataSync: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../../modules/sync/DeltaDetector.js', () => ({
  DeltaDetector: vi.fn().mockImplementation(() => ({})),
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
vi.mock('../../modules/sync/MigrationScript.js', () => ({
  MigrationScript: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../../modules/sync/IncrementalTracker.js', () => ({
  IncrementalTracker: vi.fn().mockImplementation(() => ({})),
}));
vi.mock('../../modules/sync/SyncOrchestrator.js', () => ({
  SyncOrchestrator: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ status: 'completed' }),
  })),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
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
    dryRun: false,
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
      };

      mockGetConn.mockResolvedValue({
        query: vi.fn().mockResolvedValue({ records: [] }),
        sobject: vi.fn().mockReturnValue({
          create: vi.fn().mockResolvedValue([]),
          upsert: vi.fn().mockResolvedValue([]),
          update: vi.fn().mockResolvedValue([]),
          destroy: vi.fn().mockResolvedValue([]),
        }),
        tooling: { executeAnonymous: vi.fn() },
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

    it('loads robustness config from ConfigStore', async () => {
      mockGetConn.mockResolvedValue({
        describeGlobal: vi.fn().mockResolvedValue({ sobjects: [] }),
        limitInfo: undefined,
      } as never);

      const msg: InboundRequest & { payload: { orgId: string } } = inboundRequest({
        id: 'req-config-sync',
        type: 'sync:describe-global',
        timestamp: Date.now(),
        payload: { orgId: 'org-1' },
      });

      await handler.handle(msg);

      expect(deps.configStore.get).toHaveBeenCalledWith('robustness:config');
    });

    it('falls back to defaults when configStore returns undefined', async () => {
      vi.mocked(deps.configStore.get).mockReturnValue(undefined);

      mockGetConn.mockResolvedValue({
        describeGlobal: vi.fn().mockResolvedValue({ sobjects: [] }),
        limitInfo: undefined,
      } as never);

      const msg: InboundRequest & { payload: { orgId: string } } = inboundRequest({
        id: 'req-default-sync',
        type: 'sync:describe-global',
        timestamp: Date.now(),
        payload: { orgId: 'org-1' },
      });

      const result = await handler.handle(msg);
      expect(result).toBe(true);
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
        sobject: vi.fn().mockReturnValue({
          create: vi.fn().mockResolvedValue([]),
          upsert: vi.fn().mockResolvedValue([]),
          update: vi.fn().mockResolvedValue([]),
          destroy: vi.fn().mockResolvedValue([]),
        }),
        tooling: { executeAnonymous: vi.fn() },
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
        sobject: vi.fn().mockReturnValue({
          create: vi.fn().mockResolvedValue([]),
          upsert: vi.fn().mockResolvedValue([]),
          update: vi.fn().mockResolvedValue([]),
          destroy: vi.fn().mockResolvedValue([]),
        }),
        tooling: { executeAnonymous: vi.fn() },
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

  describe('streaming threshold', () => {
    it('BulkDataWriter source references STREAMING_THRESHOLD and ChunkedBulkExecutor', () => {
      const writerPath = path.join(__dirname, '../../modules/sync/BulkDataWriter.ts');
      const source = fs.readFileSync(writerPath, 'utf-8') as string;

      expect(source).toContain('STREAMING_THRESHOLD');
      expect(source).toContain('ChunkedBulkExecutor');
    });

    it('SyncOpsHandler source delegates writes to BulkDataWriter', () => {
      const handlerPath = path.join(__dirname, 'SyncOpsHandler.ts');
      const source = fs.readFileSync(handlerPath, 'utf-8') as string;

      expect(source).toContain('BulkDataWriter');
      expect(source).toContain('BackgroundOperationRegistry');
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
        sobject: vi.fn().mockReturnValue({
          create: vi.fn().mockResolvedValue([]),
          upsert: vi.fn().mockResolvedValue([]),
          update: vi.fn().mockResolvedValue([]),
          destroy: vi.fn().mockResolvedValue([]),
        }),
        tooling: { executeAnonymous: vi.fn() },
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
        sobject: vi.fn().mockReturnValue({
          create: vi.fn().mockResolvedValue([]),
          upsert: vi.fn().mockResolvedValue([]),
          update: vi.fn().mockResolvedValue([]),
          destroy: vi.fn().mockResolvedValue([]),
        }),
        tooling: { executeAnonymous: vi.fn() },
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
        recordCount: 0,
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

  describe('PERF-04: the source read is paginated, and a bound that cuts it is announced', () => {
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
        tooling: { executeAnonymous: vi.fn() },
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

      // And the sandbox source is still read in full, as PERF-04 requires.
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
});
