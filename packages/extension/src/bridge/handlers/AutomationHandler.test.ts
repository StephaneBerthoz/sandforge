import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AutomationHandler } from './AutomationHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import type { BaseMessage } from '@sandforge/shared';

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
    const msg: BaseMessage = { id: '1', type: 'unknown:type', timestamp: Date.now() };
    const result = await handler.handle(msg);
    expect(result).toBe(false);
  });

  it('handles pipeline:templates and response includes correlationId', async () => {
    const msg: BaseMessage = {
      id: 'req-auto-1',
      type: 'pipeline:templates',
      timestamp: Date.now(),
    };

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & { correlationId?: string; payload: { templates: unknown[] } };
    expect(response.type).toBe('pipeline:templates:response');
    expect(response.correlationId).toBe('req-auto-1');
    expect(Array.isArray(response.payload.templates)).toBe(true);
  });

  it('handles marketplace:list error path with correlationId', async () => {
    // No marketplace injected -- will throw
    const msg: BaseMessage & { payload: Record<string, unknown> } = {
      id: 'req-auto-2',
      type: 'marketplace:list',
      timestamp: Date.now(),
      payload: {},
    };

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & { correlationId?: string; payload: { success: boolean; error: string } };
    expect(response.type).toBe('marketplace:list:response');
    expect(response.correlationId).toBe('req-auto-2');
    expect(response.payload.success).toBe(false);
    expect(response.payload.error).toContain('not available');
  });

  it('handles marketplace:list success path with correlationId', async () => {
    const mockMarketplace = {
      getTemplates: vi.fn().mockReturnValue([
        { id: 'tpl-1', name: 'Test Template', description: 'Desc', category: 'test' },
      ]),
      search: vi.fn(),
      getByCategory: vi.fn(),
    };
    handler.setPipelineMarketplace(mockMarketplace as unknown as Parameters<typeof handler.setPipelineMarketplace>[0]);

    const msg: BaseMessage & { payload: Record<string, unknown> } = {
      id: 'req-auto-3',
      type: 'marketplace:list',
      timestamp: Date.now(),
      payload: {},
    };

    await handler.handle(msg);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    const response = postToWebview.mock.calls[0][0] as BaseMessage & { correlationId?: string; payload: { success: boolean; templates: unknown[] } };
    expect(response.type).toBe('marketplace:list:response');
    expect(response.correlationId).toBe('req-auto-3');
    expect(response.payload.success).toBe(true);
    expect(response.payload.templates).toHaveLength(1);
  });

  it('handles marketplace:install error path with correlationId', async () => {
    const msg: BaseMessage & { payload: { templateId: string } } = {
      id: 'req-auto-4',
      type: 'marketplace:install',
      timestamp: Date.now(),
      payload: { templateId: 'nonexistent' },
    };

    await handler.handle(msg);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    const response = postToWebview.mock.calls[0][0] as BaseMessage & { correlationId?: string; payload: { success: boolean } };
    expect(response.type).toBe('marketplace:install:response');
    expect(response.correlationId).toBe('req-auto-4');
    expect(response.payload.success).toBe(false);
  });
});
