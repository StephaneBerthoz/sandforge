import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncOpsHandler } from './SyncOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import type { BaseMessage } from '@sandforge/shared';

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
    configStore: {
      get: vi.fn().mockReturnValue(undefined),
      set: vi.fn(),
    } as unknown as HandlerDeps['configStore'],
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
        performanceTracker: { start: mockStart, complete: mockComplete } as unknown as HandlerDeps['infraServices'] extends undefined ? never : NonNullable<HandlerDeps['infraServices']>['performanceTracker'],
        productionGuard: undefined as unknown as NonNullable<HandlerDeps['infraServices']>['productionGuard'],
        offlineManager: undefined as unknown as NonNullable<HandlerDeps['infraServices']>['offlineManager'],
        piiDetector: undefined as unknown as NonNullable<HandlerDeps['infraServices']>['piiDetector'],
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
        performanceTracker: { start: mockStart, complete: mockComplete } as unknown as NonNullable<HandlerDeps['infraServices']>['performanceTracker'],
        productionGuard: undefined as unknown as NonNullable<HandlerDeps['infraServices']>['productionGuard'],
        offlineManager: undefined as unknown as NonNullable<HandlerDeps['infraServices']>['offlineManager'],
        piiDetector: undefined as unknown as NonNullable<HandlerDeps['infraServices']>['piiDetector'],
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
        sobjects: [
          { name: 'Account', label: 'Account', createable: true, queryable: true },
        ],
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
      const response = postToWebview.mock.calls[0][0] as BaseMessage & { payload: { objects: string[] } };
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

      const msg: BaseMessage & { payload: { sourceOrgId: string; targetOrgId: string; objectApiName: string } } = {
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
});
