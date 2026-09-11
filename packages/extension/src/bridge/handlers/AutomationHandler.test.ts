import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutomationHandler } from './AutomationHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import type { BaseMessage } from '@sandforge/shared';
import { inboundRequest } from '../../test/mockFactories.js';

/**
 * Creates minimal mock deps for AutomationHandler tests.
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

describe('AutomationHandler', () => {
  let handler: AutomationHandler;
  let deps: HandlerDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
    handler = new AutomationHandler(deps);
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

  it('handles pipeline:templates and response includes correlationId', async () => {
    const msg: InboundRequest = inboundRequest({
      id: 'req-auto-1',
      type: 'pipeline:templates',
      timestamp: Date.now(),
    });

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      correlationId?: string;
      payload: { templates: unknown[] };
    };
    expect(response.type).toBe('pipeline:templates:response');
    expect(response.correlationId).toBe('req-auto-1');
    expect(Array.isArray(response.payload.templates)).toBe(true);
  });

  it('handles marketplace:list error path with correlationId', async () => {
    // No marketplace injected -- will throw
    const msg: InboundRequest & { payload: Record<string, unknown> } = inboundRequest({
      id: 'req-auto-2',
      type: 'marketplace:list',
      timestamp: Date.now(),
      payload: {},
    });

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      correlationId?: string;
      payload: { success: boolean; error: string };
    };
    expect(response.type).toBe('marketplace:list:response');
    expect(response.correlationId).toBe('req-auto-2');
    expect(response.payload.success).toBe(false);
    expect(response.payload.error).toContain('not available');
  });

  it('handles marketplace:list success path with correlationId', async () => {
    const mockMarketplace = {
      getTemplates: vi.fn().mockReturnValue([
        {
          id: 'tpl-1',
          name: 'Test Template',
          description: 'Desc',
          category: 'test',
        },
      ]),
      search: vi.fn(),
      getByCategory: vi.fn(),
    };
    handler.setPipelineMarketplace(
      mockMarketplace as unknown as Parameters<typeof handler.setPipelineMarketplace>[0],
    );

    const msg: InboundRequest & { payload: Record<string, unknown> } = inboundRequest({
      id: 'req-auto-3',
      type: 'marketplace:list',
      timestamp: Date.now(),
      payload: {},
    });

    await handler.handle(msg);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      correlationId?: string;
      payload: { success: boolean; templates: unknown[] };
    };
    expect(response.type).toBe('marketplace:list:response');
    expect(response.correlationId).toBe('req-auto-3');
    expect(response.payload.success).toBe(true);
    expect(response.payload.templates).toHaveLength(1);
  });

  it('handles marketplace:install error path with correlationId', async () => {
    const msg: InboundRequest & { payload: { templateId: string } } = inboundRequest({
      id: 'req-auto-4',
      type: 'marketplace:install',
      timestamp: Date.now(),
      payload: { templateId: 'nonexistent' },
    });

    await handler.handle(msg);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      correlationId?: string;
      payload: { success: boolean };
    };
    expect(response.type).toBe('marketplace:install:response');
    expect(response.correlationId).toBe('req-auto-4');
    expect(response.payload.success).toBe(false);
  });

  it('handles pipeline:list with correlationId and returns pipelines from ConfigStore', async () => {
    const configStore = deps.configStore as unknown as {
      getByCategory: ReturnType<typeof vi.fn>;
    };
    configStore.getByCategory = vi.fn().mockReturnValue({
      'pipeline:saved:p1': {
        id: 'p1',
        name: 'Test Pipeline',
        savedAt: '2026-03-17T00:00:00Z',
      },
    });

    const msg: InboundRequest = inboundRequest({
      id: 'req-auto-list',
      type: 'pipeline:list',
      timestamp: Date.now(),
    });

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      correlationId?: string;
      payload: { pipelines: unknown[] };
    };
    expect(response.type).toBe('pipeline:list:response');
    expect(response.correlationId).toBe('req-auto-list');
    expect(response.payload.pipelines).toHaveLength(1);
  });

  it('handles pipeline:history with correlationId and returns sorted history', async () => {
    const configStore = deps.configStore as unknown as {
      getByCategory: ReturnType<typeof vi.fn>;
    };
    configStore.getByCategory = vi.fn().mockReturnValue({
      'pipeline:history:h1': { id: 'h1', status: 'completed', timestamp: 100 },
      'pipeline:history:h2': { id: 'h2', status: 'failed', timestamp: 200 },
    });

    const msg: InboundRequest = inboundRequest({
      id: 'req-auto-hist',
      type: 'pipeline:history',
      timestamp: Date.now(),
    });

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      correlationId?: string;
      payload: { history: Array<{ timestamp: number }> };
    };
    expect(response.type).toBe('pipeline:history:response');
    expect(response.correlationId).toBe('req-auto-hist');
    expect(response.payload.history).toHaveLength(2);
    // Sorted by timestamp descending (200 before 100)
    expect(response.payload.history[0].timestamp).toBe(200);
    expect(response.payload.history[1].timestamp).toBe(100);
  });

  it('handles pipeline:save with correlationId and persists to ConfigStore', async () => {
    const configStore = deps.configStore as unknown as {
      set: ReturnType<typeof vi.fn>;
    };
    configStore.set = vi.fn();

    const msg: InboundRequest & {
      payload: { id: string; config: Record<string, unknown> };
    } = inboundRequest({
      id: 'req-auto-save',
      type: 'pipeline:save',
      timestamp: Date.now(),
      payload: { id: 'p-save-1', config: { name: 'My Pipeline', steps: [] } },
    });

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    expect(configStore.set).toHaveBeenCalledWith(
      'pipeline:saved:p-save-1',
      expect.objectContaining({ name: 'My Pipeline', id: 'p-save-1' }),
      'pipelines',
    );

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      correlationId?: string;
      payload: { success: boolean; id: string };
    };
    expect(response.type).toBe('pipeline:save:response');
    expect(response.correlationId).toBe('req-auto-save');
    expect(response.payload.success).toBe(true);
    expect(response.payload.id).toBe('p-save-1');
  });

  it('handles pipeline:list error path', async () => {
    const configStore = deps.configStore as unknown as {
      getByCategory: ReturnType<typeof vi.fn>;
    };
    configStore.getByCategory = vi.fn().mockImplementation(() => {
      throw new Error('store failed');
    });

    const msg: InboundRequest = inboundRequest({
      id: 'req-auto-list-err',
      type: 'pipeline:list',
      timestamp: Date.now(),
    });

    await handler.handle(msg);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { message: string };
    };
    expect(response.type).toBe('pipeline:error');
    expect(response.payload.message).toBe('store failed');
  });

  describe('payload validation', () => {
    it('rejects pipeline:save without config (INVALID_PAYLOAD)', async () => {
      const msg = inboundRequest({
        id: 'bad-save',
        type: 'pipeline:save',
        timestamp: Date.now(),
        payload: { id: 'p-1' },
      } as unknown as BaseMessage);

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const errMsg = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { code: string };
      };
      expect(errMsg.type).toBe('pipeline:error');
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
    });

    it('rejects operation:cancel with a non-string operationId (INVALID_PAYLOAD)', async () => {
      const msg = inboundRequest({
        id: 'bad-cancel',
        type: 'operation:cancel',
        timestamp: Date.now(),
        payload: { operationId: 42 },
      } as unknown as BaseMessage);

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const errMsg = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { code: string };
      };
      expect(errMsg.type).toBe('pipeline:error');
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
    });

    it('rejects pipeline:execute with a malformed pipeline (INVALID_PAYLOAD)', async () => {
      const msg = inboundRequest({
        id: 'bad-run',
        type: 'pipeline:execute',
        timestamp: Date.now(),
        payload: { pipeline: { name: '' } },
      } as unknown as BaseMessage);

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const errMsg = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { code: string };
      };
      expect(errMsg.type).toBe('pipeline:error');
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
    });

    it('rejects marketplace:install without templateId (INVALID_PAYLOAD)', async () => {
      const msg = inboundRequest({
        id: 'bad-install',
        type: 'marketplace:install',
        timestamp: Date.now(),
        payload: {},
      } as unknown as BaseMessage);

      const result = await handler.handle(msg);
      expect(result).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const errMsg = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { code: string };
      };
      expect(errMsg.type).toBe('pipeline:error');
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
    });
  });
});
