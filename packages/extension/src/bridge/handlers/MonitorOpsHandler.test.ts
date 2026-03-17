import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MonitorOpsHandler } from './MonitorOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import type { BaseMessage } from '@sandforge/shared';

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

  it('handles monitor:refresh error path with typed error response', async () => {
    vi.mock('../../core/connection/ConnectionHelper.js', () => ({
      getJsforceConnection: vi.fn().mockRejectedValue(new Error('connection failed')),
    }));

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

    vi.restoreAllMocks();
  });
});
