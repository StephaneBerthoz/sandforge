import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionHandler } from './ExecutionHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import type { BaseMessage } from '@sandforge/shared';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
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

  it('does not claim the status, list and manual-retry requests no page sends', async () => {
    for (const type of ['execution:status', 'execution:list', 'execution:manual-retry']) {
      const msg: InboundRequest = inboundRequest({
        id: `req-${type}`,
        type,
        timestamp: Date.now(),
      });
      expect(await handler.handle(msg)).toBe(false);
    }
    expect(deps.broker.postToWebview).not.toHaveBeenCalled();
  });

  describe('payload validation', () => {
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
});
