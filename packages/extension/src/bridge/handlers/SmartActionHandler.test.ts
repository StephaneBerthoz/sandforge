import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseMessage } from '@sandforge/shared';
import { SmartActionHandler } from './SmartActionHandler';
import type { HandlerDeps } from './HandlerTypes';

vi.mock('../../core/connection/ConnectionHelper', () => ({
  getJsforceConnection: vi.fn().mockImplementation(() => {
    return Promise.resolve({
      query: vi.fn().mockResolvedValue({ totalSize: 0, done: true, records: [] }),
    });
  }),
}));

/** Create minimal HandlerDeps for testing. */
function createMockDeps(): HandlerDeps {
  return {
    log: vi.fn(),
    broker: {
      postToWebview: vi.fn(),
      onDidReceiveMessage: vi.fn(),
    } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: {
      getOrg: vi.fn().mockReturnValue({ alias: 'test', metadata: { apiVersion: '62.0' } }),
    } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {
      getCredentials: vi.fn().mockResolvedValue({
        accessToken: 'token',
        instanceUrl: 'https://test.salesforce.com',
      }),
    } as unknown as HandlerDeps['orgRegistry'],
    configStore: {} as HandlerDeps['configStore'],
    secretVault: {} as HandlerDeps['secretVault'],
    authProvider: {} as HandlerDeps['authProvider'],
    sfdxBridge: {} as HandlerDeps['sfdxBridge'],
    nextId: vi.fn().mockReturnValue('test-id-1'),
  };
}

describe('SmartActionHandler', () => {
  let deps: HandlerDeps;
  let handler: SmartActionHandler;

  beforeEach(() => {
    deps = createMockDeps();
    handler = new SmartActionHandler(deps);
  });

  it('should return false for unrelated message types', async () => {
    const msg: BaseMessage = { id: '1', type: 'org:list', timestamp: Date.now() };
    const result = await handler.handle(msg);
    expect(result).toBe(false);
  });

  it('should handle smart-action:analyze and return recommendation for empty org', async () => {
    const msg: BaseMessage & { payload: Record<string, unknown> } = {
      id: 'req-1',
      type: 'smart-action:analyze',
      timestamp: Date.now(),
      payload: { targetOrgId: 'org-target-1' },
    };

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { recommendation: { action: string } };
    };
    expect(response.type).toBe('smart-action:analyze:response');
    expect(response.correlationId).toBe('req-1');
    expect(response.payload.recommendation.action).toBe('quick-seed');
  });

  it('should return cached result on second call within 5 minutes', async () => {
    const msg: BaseMessage & { payload: Record<string, unknown> } = {
      id: 'req-2',
      type: 'smart-action:analyze',
      timestamp: Date.now(),
      payload: { targetOrgId: 'org-target-1' },
    };

    await handler.handle(msg);
    await handler.handle({ ...msg, id: 'req-3' });

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(2);

    const logFn = deps.log as ReturnType<typeof vi.fn>;
    const cacheHitLogs = logFn.mock.calls.filter(
      (call: string[]) => typeof call[0] === 'string' && call[0].includes('Cache hit'),
    );
    expect(cacheHitLogs.length).toBe(1);
  });

  it('should report smart-action:analyze in SMART_ACTION_TYPES', async () => {
    const msg: BaseMessage & { payload: Record<string, unknown> } = {
      id: 'req-4',
      type: 'smart-action:analyze',
      timestamp: Date.now(),
      payload: { targetOrgId: 'org-1' },
    };
    const handled = await handler.handle(msg);
    expect(handled).toBe(true);
  });

  describe('payload validation', () => {
    it('rejects smart-action:analyze without targetOrgId (INVALID_PAYLOAD)', async () => {
      const msg: BaseMessage & { payload: Record<string, unknown> } = {
        id: 'req-bad',
        type: 'smart-action:analyze',
        timestamp: Date.now(),
        payload: {},
      };
      const handled = await handler.handle(msg);
      expect(handled).toBe(true);

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const errMsg = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { code: string };
      };
      expect(errMsg.type).toBe('smart-action:error');
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
    });
  });
});
