import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionHandler } from './ExecutionHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import type { BaseMessage } from '@sandforge/shared';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';

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
    const msg: BaseMessage = { id: '1', type: 'unknown:type', timestamp: Date.now() };
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

      const msg: BaseMessage & { payload: { operationId: string } } = {
        id: 'req-abort-1',
        type: 'execution:abort',
        timestamp: Date.now(),
        payload: { operationId: 'op-1' },
      };

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
      const msg: BaseMessage & { payload: { operationId: string } } = {
        id: 'req-abort-2',
        type: 'execution:abort',
        timestamp: Date.now(),
        payload: { operationId: 'non-existent' },
      };

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

      const msg: BaseMessage & { payload: { operationId: string } } = {
        id: 'req-status-1',
        type: 'execution:status',
        timestamp: Date.now(),
        payload: { operationId: 'op-2' },
      };

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
      const msg: BaseMessage & { payload: { operationId: string } } = {
        id: 'req-status-2',
        type: 'execution:status',
        timestamp: Date.now(),
        payload: { operationId: 'ghost' },
      };

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

      const msg: BaseMessage = {
        id: 'req-list-1',
        type: 'execution:list',
        timestamp: Date.now(),
      };

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
      const msg: BaseMessage = {
        id: 'req-list-2',
        type: 'execution:list',
        timestamp: Date.now(),
      };

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
});
