import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionHandler } from './ExecutionHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import type {
  BaseMessage,
  SyncConfig,
  SyncExecutionResult,
  SyncHistoryEntry,
} from '@sandforge/shared';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { SyncHistoryStore } from '../../modules/sync/SyncHistoryStore.js';
import type { SyncOpsHandler } from './SyncOpsHandler.js';
import { inboundRequest } from '../../test/mockFactories.js';

/**
 * Creates minimal mock deps for ExecutionHandler tests.
 */
function createMockDeps(): HandlerDeps {
  let idCounter = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: { getOrg: vi.fn() } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
    configStore: { get: vi.fn() } as unknown as HandlerDeps['configStore'],
    secretVault: {} as unknown as HandlerDeps['secretVault'],
    authProvider: {} as unknown as HandlerDeps['authProvider'],
    sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
    nextId: () => String(++idCounter),
  };
}

/** In-memory ConfigStore mock backing a real SyncHistoryStore. */
function createInMemoryConfigStore(): HandlerDeps['configStore'] {
  const data = new Map<string, unknown>();
  return {
    get: vi.fn(<T>(key: string): T | undefined => data.get(key) as T | undefined),
    set: vi.fn((key: string, value: unknown): void => {
      data.set(key, value);
    }),
    delete: vi.fn((key: string): boolean => data.delete(key)),
  } as unknown as HandlerDeps['configStore'];
}

function createSyncConfig(id: string): SyncConfig {
  return {
    id,
    name: `Config ${id}`,
    description: 'Test config',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    direction: 'source_to_target',
    mode: 'full',
    objects: [],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    dryRun: false,
    createdAt: '2026-03-01T00:00:00Z',
    updatedAt: '2026-03-01T00:00:00Z',
  };
}

function createHistoryEntry(
  id: string,
  operationId: string,
  status: SyncExecutionResult['status'],
  startTime: string,
): SyncHistoryEntry {
  return {
    id,
    configSnapshot: createSyncConfig(`cfg-${id}`),
    result: {
      configId: `cfg-${id}`,
      operationId,
      status,
      objectResults: [],
      totalProcessed: 100,
      totalSuccess: status === 'failure' ? 0 : 100,
      totalFailed: status === 'failure' ? 100 : 0,
      totalSkipped: 0,
      duration: 5000,
      timestamp: startTime,
    },
    startTime,
    endTime: startTime,
    triggeredBy: 'manual',
  };
}

describe('ExecutionHandler', () => {
  let handler: ExecutionHandler;
  let deps: HandlerDeps;
  let registry: BackgroundOperationRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
    registry = new BackgroundOperationRegistry();
    handler = new ExecutionHandler(deps, registry);
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

  describe('execution:abort', () => {
    it('calls registry.abort() and sends success response', async () => {
      const abortController = new AbortController();
      const promise = new Promise(() => {
        /* never resolves */
      });
      registry.register('op-1', 'sync', 'Test operation', promise, abortController);

      const msg: InboundRequest & { payload: { operationId: string } } = inboundRequest({
        id: 'req-abort-1',
        type: 'execution:abort',
        timestamp: Date.now(),
        payload: { operationId: 'op-1' },
      });

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      // Abort controller should be triggered
      expect(abortController.signal.aborted).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      expect(postToWebview).toHaveBeenCalledTimes(1);

      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        correlationId?: string;
        payload: { success: boolean; operationId: string };
      };
      expect(response.type).toBe('execution:abort:response');
      expect(response.correlationId).toBe('req-abort-1');
      expect(response.payload.success).toBe(true);
      expect(response.payload.operationId).toBe('op-1');
    });

    it('sends error response for unknown operation', async () => {
      const msg: InboundRequest & { payload: { operationId: string } } = inboundRequest({
        id: 'req-abort-2',
        type: 'execution:abort',
        timestamp: Date.now(),
        payload: { operationId: 'non-existent' },
      });

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      expect(postToWebview).toHaveBeenCalledTimes(1);

      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { success: boolean; error: string };
      };
      expect(response.type).toBe('execution:abort:response');
      expect(response.payload.success).toBe(false);
      expect(response.payload.error).toContain('not found');
    });
  });

  describe('execution:status', () => {
    it('returns operation details for a known operation', async () => {
      const abortController = new AbortController();
      const promise = new Promise(() => {
        /* never resolves */
      });
      registry.register('op-2', 'seed', 'Seed 5 objects', promise, abortController);
      registry.updateProgress('op-2', 42, '4,200 records');

      const msg: InboundRequest & { payload: { operationId: string } } = inboundRequest({
        id: 'req-status-1',
        type: 'execution:status',
        timestamp: Date.now(),
        payload: { operationId: 'op-2' },
      });

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      expect(postToWebview).toHaveBeenCalledTimes(1);

      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        correlationId?: string;
        payload: {
          found: boolean;
          operation: {
            operationId: string;
            module: string;
            description: string;
            status: string;
            progressPercent: number;
            resultSummary?: string;
          };
        };
      };
      expect(response.type).toBe('execution:status:response');
      expect(response.correlationId).toBe('req-status-1');
      expect(response.payload.found).toBe(true);
      expect(response.payload.operation.operationId).toBe('op-2');
      expect(response.payload.operation.module).toBe('seed');
      expect(response.payload.operation.description).toBe('Seed 5 objects');
      expect(response.payload.operation.status).toBe('running');
      expect(response.payload.operation.progressPercent).toBe(42);
      expect(response.payload.operation.resultSummary).toBe('4,200 records');
    });

    it('returns not-found for unknown operation', async () => {
      const msg: InboundRequest & { payload: { operationId: string } } = inboundRequest({
        id: 'req-status-2',
        type: 'execution:status',
        timestamp: Date.now(),
        payload: { operationId: 'ghost' },
      });

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { found: boolean; error: string };
      };
      expect(response.type).toBe('execution:status:response');
      expect(response.payload.found).toBe(false);
      expect(response.payload.error).toContain('not found');
    });
  });

  describe('execution:list', () => {
    it('returns all active operations', async () => {
      const ac1 = new AbortController();
      const ac2 = new AbortController();
      const p1 = new Promise(() => {
        /* never resolves */
      });
      const p2 = new Promise(() => {
        /* never resolves */
      });

      registry.register('op-a', 'sync', 'Sync 3 objects', p1, ac1);
      registry.register('op-b', 'seed', 'Seed 10 objects', p2, ac2);

      const msg: InboundRequest = inboundRequest({
        id: 'req-list-1',
        type: 'execution:list',
        timestamp: Date.now(),
      });

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      expect(postToWebview).toHaveBeenCalledTimes(1);

      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        correlationId?: string;
        payload: { operations: Array<{ operationId: string; module: string }> };
      };
      expect(response.type).toBe('execution:list:response');
      expect(response.correlationId).toBe('req-list-1');
      expect(response.payload.operations).toHaveLength(2);
      const ids = response.payload.operations.map((op) => op.operationId).sort();
      expect(ids).toEqual(['op-a', 'op-b']);
    });

    it('returns empty array when no operations exist', async () => {
      const msg: InboundRequest = inboundRequest({
        id: 'req-list-2',
        type: 'execution:list',
        timestamp: Date.now(),
      });

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { operations: unknown[] };
      };
      expect(response.type).toBe('execution:list:response');
      expect(response.payload.operations).toEqual([]);
    });
  });

  describe('payload validation', () => {
    it('rejects execution:status without operationId (INVALID_PAYLOAD)', async () => {
      const msg = inboundRequest({
        id: 'bad-status',
        type: 'execution:status',
        timestamp: Date.now(),
        payload: {},
      } as unknown as BaseMessage);

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const errMsg = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { code: string };
      };
      expect(errMsg.type).toBe('execution:error');
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
    });

    it('rejects execution:manual-retry without objectName (INVALID_PAYLOAD)', async () => {
      const msg = inboundRequest({
        id: 'bad-retry',
        type: 'execution:manual-retry',
        timestamp: Date.now(),
        payload: { executionId: 'op-1' },
      } as unknown as BaseMessage);

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const errMsg = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { code: string };
      };
      expect(errMsg.type).toBe('execution:error');
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
    });

    it('accepts execution:abort with the webview executionId shape', async () => {
      const msg = inboundRequest({
        id: 'abort-flat',
        type: 'execution:abort',
        timestamp: Date.now(),
        // The retry shape: `{ executionId, objectName }`, no operationId.
        payload: { executionId: 'ghost', objectName: 'Account' },
      } as unknown as BaseMessage);

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { success: boolean; error?: string; code?: string };
      };
      expect(response.type).toBe('execution:abort:response');
      expect(response.payload.success).toBe(false);
      expect(response.payload.code).not.toBe('INVALID_PAYLOAD');
    });
  });

  describe('execution:manual-retry', () => {
    let historyStore: SyncHistoryStore;
    let syncOps: { rerunFromSnapshot: ReturnType<typeof vi.fn> };
    let replayHandler: ExecutionHandler;

    beforeEach(() => {
      historyStore = new SyncHistoryStore(createInMemoryConfigStore());
      syncOps = { rerunFromSnapshot: vi.fn().mockResolvedValue(undefined) };
      replayHandler = new ExecutionHandler(
        deps,
        registry,
        historyStore,
        syncOps as unknown as SyncOpsHandler,
      );
    });

    function retryMsg(executionId: string, objectName = 'Account'): InboundRequest {
      return inboundRequest({
        id: 'req-retry-1',
        type: 'execution:manual-retry',
        timestamp: Date.now(),
        payload: { executionId, objectName },
      } as BaseMessage);
    }

    function postedOfType(type: string): (BaseMessage & { payload: Record<string, unknown> })[] {
      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      return postToWebview.mock.calls
        .map((call) => call[0] as BaseMessage & { payload: Record<string, unknown> })
        .filter((m) => m.type === type);
    }

    it('replays the failed sync execution whose operationId matches exactly', async () => {
      const failedEntry = createHistoryEntry('e1', 'op-sync-1', 'failure', '2026-03-01T00:00:00Z');
      historyStore.save(failedEntry);

      const result = await replayHandler.handle(retryMsg('op-sync-1'));

      expect(result).toBe(true);
      expect(syncOps.rerunFromSnapshot).toHaveBeenCalledTimes(1);
      const [rerunMsg, snapshot] = syncOps.rerunFromSnapshot.mock.calls[0] as [
        BaseMessage,
        unknown,
      ];
      expect(rerunMsg.id).toBe('req-retry-1');
      expect(snapshot).toEqual(failedEntry.configSnapshot);

      // The panel is acknowledged on execution:retry-status before the rerun.
      const statuses = postedOfType('execution:retry-status');
      expect(statuses).toHaveLength(1);
      expect(statuses[0].payload).toMatchObject({
        executionId: 'op-sync-1',
        objectName: 'Account',
        attemptNumber: 1,
        nextRetryAt: null,
        lastError: '',
        canRetry: false,
        canAbort: false,
      });
    });

    it('falls back to the most recent failed sync run when the registry tracks a sync operation', async () => {
      historyStore.save(createHistoryEntry('e-old', 'op-old', 'failure', '2026-03-01T00:00:00Z'));
      const newest = createHistoryEntry('e-new', 'op-new', 'partial', '2026-03-03T00:00:00Z');
      historyStore.save(newest);
      // The webview's executionId is the bridge operation id (msg.id), which
      // never matches the orchestrator-minted result.operationId.
      registry.register(
        'bridge-op-sync',
        'sync',
        'Sync 1 object',
        new Promise(() => {
          /* never resolves */
        }),
        new AbortController(),
      );

      const result = await replayHandler.handle(retryMsg('bridge-op-sync'));

      expect(result).toBe(true);
      expect(syncOps.rerunFromSnapshot).toHaveBeenCalledTimes(1);
      const [, snapshot] = syncOps.rerunFromSnapshot.mock.calls[0] as [BaseMessage, unknown];
      expect(snapshot).toEqual(newest.configSnapshot);
    });

    it('answers canRetry:false without replaying for a non-sync module', async () => {
      historyStore.save(createHistoryEntry('e1', 'op-sync-1', 'failure', '2026-03-01T00:00:00Z'));
      registry.register(
        'op-seed-1',
        'seed',
        'Seed 5 objects',
        new Promise(() => {
          /* never resolves */
        }),
        new AbortController(),
      );

      const result = await replayHandler.handle(retryMsg('op-seed-1'));

      expect(result).toBe(true);
      expect(syncOps.rerunFromSnapshot).not.toHaveBeenCalled();
      const statuses = postedOfType('execution:retry-status');
      expect(statuses).toHaveLength(1);
      expect(statuses[0].payload.canRetry).toBe(false);
      expect(String(statuses[0].payload.lastError)).toContain('not supported');
    });

    it('answers canRetry:false when no failed sync execution exists in history', async () => {
      // A successful run is never a replay candidate, even on an exact id match.
      historyStore.save(createHistoryEntry('e1', 'op-sync-ok', 'success', '2026-03-01T00:00:00Z'));
      registry.register(
        'op-sync-ok',
        'sync',
        'Sync 1 object',
        new Promise(() => {
          /* never resolves */
        }),
        new AbortController(),
      );

      const result = await replayHandler.handle(retryMsg('op-sync-ok'));

      expect(result).toBe(true);
      expect(syncOps.rerunFromSnapshot).not.toHaveBeenCalled();
      const statuses = postedOfType('execution:retry-status');
      expect(statuses).toHaveLength(1);
      expect(statuses[0].payload.canRetry).toBe(false);
      expect(String(statuses[0].payload.lastError)).toContain('No failed sync execution');
    });

    it('answers canRetry:false for an unknown operation (honest not-found)', async () => {
      const result = await replayHandler.handle(retryMsg('ghost'));

      expect(result).toBe(true);
      expect(syncOps.rerunFromSnapshot).not.toHaveBeenCalled();
      const statuses = postedOfType('execution:retry-status');
      expect(statuses).toHaveLength(1);
      expect(statuses[0].payload.canRetry).toBe(false);
      expect(String(statuses[0].payload.lastError)).toContain('Operation not found: ghost');
    });
  });
});
