import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncOpsHandler } from './SyncOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
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

describe('SyncOpsHandler', () => {
  let handler: SyncOpsHandler;
  let deps: HandlerDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
    handler = new SyncOpsHandler(deps);
  });

  it('returns false for unhandled message types', async () => {
    const msg: BaseMessage = { id: '1', type: 'unknown:type', timestamp: Date.now() };
    const result = await handler.handle(msg);
    expect(result).toBe(false);
  });

  it('returns true for handled message types and response includes correlationId', async () => {
    mockGetConn.mockResolvedValue({
      describeGlobal: vi.fn().mockResolvedValue({ sobjects: [] }),
      limitInfo: undefined,
    } as never);

    const msg: BaseMessage & { payload: { orgId: string } } = {
      id: 'req-sync-1',
      type: 'sync:describe-global',
      timestamp: Date.now(),
      payload: { orgId: 'org-1' },
    };
    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalled();

    const response = postToWebview.mock.calls[0][0] as BaseMessage & { correlationId?: string };
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

      const msg: BaseMessage & { payload: { config: Record<string, unknown> } } = {
        id: '1',
        type: 'sync:execute',
        timestamp: Date.now(),
        payload: {
          config: {
            sourceOrgId: 'src-org',
            targetOrgId: 'tgt-org',
            objects: [],
          },
        },
      };

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
        performanceTracker: { start: mockStart, complete: mockComplete } as unknown as NonNullable<
          HandlerDeps['infraServices']
        >['performanceTracker'],
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

      const msg: BaseMessage & { payload: { config: Record<string, unknown> } } = {
        id: '1',
        type: 'sync:execute',
        timestamp: Date.now(),
        payload: {
          config: {
            sourceOrgId: 'src-org',
            targetOrgId: 'tgt-org',
            objects: [],
          },
        },
      };

      await handler.handle(msg);

      // complete is called exactly once (in finally, not duplicated)
      expect(mockComplete).toHaveBeenCalledTimes(1);
    });
  });

  describe('robustness integration', () => {
    it('wraps describe-global with TimeoutManager', async () => {
      const describeGlobalFn = vi.fn().mockResolvedValue({
        sobjects: [{ name: 'Account', label: 'Account', createable: true, queryable: true }],
      });
      mockGetConn.mockResolvedValue({
        describeGlobal: describeGlobalFn,
        limitInfo: undefined,
      } as never);

      const msg: BaseMessage & { payload: { orgId: string } } = {
        id: 'req-timeout-sync',
        type: 'sync:describe-global',
        timestamp: Date.now(),
        payload: { orgId: 'org-1' },
      };

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

      const msg: BaseMessage & {
        payload: { sourceOrgId: string; targetOrgId: string; objectApiName: string };
      } = {
        id: 'req-fields-timeout',
        type: 'sync:describe-fields',
        timestamp: Date.now(),
        payload: { sourceOrgId: 'src-org', targetOrgId: 'tgt-org', objectApiName: 'Account' },
      };

      await handler.handle(msg);

      expect(sourceDescribeFn).toHaveBeenCalledTimes(1);
      expect(targetDescribeFn).toHaveBeenCalledTimes(1);
    });

    it('loads robustness config from ConfigStore', async () => {
      mockGetConn.mockResolvedValue({
        describeGlobal: vi.fn().mockResolvedValue({ sobjects: [] }),
        limitInfo: undefined,
      } as never);

      const msg: BaseMessage & { payload: { orgId: string } } = {
        id: 'req-config-sync',
        type: 'sync:describe-global',
        timestamp: Date.now(),
        payload: { orgId: 'org-1' },
      };

      await handler.handle(msg);

      expect(deps.configStore.get).toHaveBeenCalledWith('robustness:config');
    });

    it('falls back to defaults when configStore returns undefined', async () => {
      vi.mocked(deps.configStore.get).mockReturnValue(undefined);

      mockGetConn.mockResolvedValue({
        describeGlobal: vi.fn().mockResolvedValue({ sobjects: [] }),
        limitInfo: undefined,
      } as never);

      const msg: BaseMessage & { payload: { orgId: string } } = {
        id: 'req-default-sync',
        type: 'sync:describe-global',
        timestamp: Date.now(),
        payload: { orgId: 'org-1' },
      };

      const result = await handler.handle(msg);
      expect(result).toBe(true);
    });
  });

  describe('sync:config CRUD handlers', () => {
    it('handles sync:config:save and responds with success', async () => {
      const config = {
        id: 'cfg-1',
        name: 'Test Config',
        description: 'desc',
        updatedAt: '2026-03-01T00:00:00Z',
        sourceOrgId: 'src',
        targetOrgId: 'tgt',
        direction: 'source-to-target',
        mode: 'full',
        objects: [],
        conflictStrategy: 'source-wins',
        enableRollback: false,
        dryRun: false,
        createdAt: '2026-03-01T00:00:00Z',
      };

      const msg: BaseMessage & { payload: { config: Record<string, unknown> } } = {
        id: 'req-save',
        type: 'sync:config:save',
        timestamp: Date.now(),
        payload: { config: config as unknown as Record<string, unknown> },
      };

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
        id: 'cfg-list',
        name: 'List Config',
        description: 'test desc',
        updatedAt: '2026-03-01T00:00:00Z',
        sourceOrgId: 'src',
        targetOrgId: 'tgt',
        direction: 'source-to-target',
        mode: 'full',
        objects: [],
        conflictStrategy: 'source-wins',
        enableRollback: false,
        dryRun: false,
        createdAt: '2026-03-01T00:00:00Z',
      };
      await handler.handle({
        id: 'save-1',
        type: 'sync:config:save',
        timestamp: Date.now(),
        payload: { config },
      } as BaseMessage & { payload: { config: Record<string, unknown> } });

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      postToWebview.mockClear();

      const msg: BaseMessage = {
        id: 'req-list',
        type: 'sync:config:list',
        timestamp: Date.now(),
      };

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
      const msg: BaseMessage & { payload: { id: string } } = {
        id: 'req-load',
        type: 'sync:config:load',
        timestamp: Date.now(),
        payload: { id: 'non-existent' },
      };

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
      const msg: BaseMessage & { payload: { id: string } } = {
        id: 'req-del',
        type: 'sync:config:delete',
        timestamp: Date.now(),
        payload: { id: 'non-existent' },
      };

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

      const msg: BaseMessage & { payload: { config: Record<string, unknown> } } = {
        id: 'bg-op-1',
        type: 'sync:execute',
        timestamp: Date.now(),
        payload: {
          config: {
            sourceOrgId: 'src-org',
            targetOrgId: 'tgt-org',
            objects: [],
          },
        },
      };

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

      const msg: BaseMessage & { payload: { config: Record<string, unknown> } } = {
        id: 'bg-op-2',
        type: 'sync:execute',
        timestamp: Date.now(),
        payload: {
          config: {
            sourceOrgId: 'src-org',
            targetOrgId: 'tgt-org',
            objects: [],
          },
        },
      };

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
    it('SyncOpsHandler source references STREAMING_THRESHOLD and ChunkedBulkExecutor', () => {
      const handlerPath = path.join(__dirname, 'SyncOpsHandler.ts');
      const source = fs.readFileSync(handlerPath, 'utf-8') as string;

      expect(source).toContain('STREAMING_THRESHOLD');
      expect(source).toContain('ChunkedBulkExecutor');
      expect(source).toContain('BackgroundOperationRegistry');
    });
  });
});
