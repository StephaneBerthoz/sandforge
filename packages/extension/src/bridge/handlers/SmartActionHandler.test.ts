import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseMessage } from '@sandforge/shared';
import { SmartActionHandler } from './SmartActionHandler';
import type { HandlerDeps } from './HandlerTypes';
import type { InboundRequest } from './HandlerTypes.js';
import { inboundRequest } from '../../test/mockFactories.js';

/** An org holding a working set of every object; every other org is empty. */
const FULL_ORG = 'org-source-full';

vi.mock('../../core/connection/ConnectionHelper', () => ({
  getJsforceConnection: vi.fn().mockImplementation((orgId: string) => {
    const totalSize = orgId === FULL_ORG ? 500 : 0;
    return Promise.resolve({
      query: vi.fn().mockResolvedValue({ totalSize, done: true, records: [] }),
    });
  }),
}));

/** The action of the last recommendation the handler posted. */
function lastAction(deps: HandlerDeps): string {
  const calls = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls;
  return (calls.at(-1)?.[0] as { payload: { recommendation: { action: string } } }).payload
    .recommendation.action;
}

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
    const msg: InboundRequest = inboundRequest({
      id: '1',
      type: 'org:list',
      timestamp: Date.now(),
    });
    const result = await handler.handle(msg);
    expect(result).toBe(false);
  });

  it('should handle smart-action:analyze and return recommendation for empty org', async () => {
    const msg: InboundRequest & { payload: Record<string, unknown> } = inboundRequest({
      id: 'req-1',
      type: 'smart-action:analyze',
      timestamp: Date.now(),
      payload: { targetOrgId: 'org-target-1' },
    });

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
    const msg: InboundRequest & { payload: Record<string, unknown> } = inboundRequest({
      id: 'req-2',
      type: 'smart-action:analyze',
      timestamp: Date.now(),
      payload: { targetOrgId: 'org-target-1' },
    });

    await handler.handle(msg);
    await handler.handle(inboundRequest({ ...msg, id: 'req-3' }));

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(2);

    const logFn = deps.log as ReturnType<typeof vi.fn>;
    const cacheHitLogs = logFn.mock.calls.filter(
      (call: string[]) => typeof call[0] === 'string' && call[0].includes('Cache hit'),
    );
    expect(cacheHitLogs.length).toBe(1);
  });

  it('analyzes an org again once told to forget it', async () => {
    const analyze = (id: string): Promise<boolean> =>
      handler.handle(
        inboundRequest({
          id,
          type: 'smart-action:analyze',
          timestamp: Date.now(),
          payload: { targetOrgId: 'org-target-1' },
        }),
      );

    await analyze('req-before');
    handler.forgetOrg('org-target-1');
    await analyze('req-after');

    const cacheHits = (deps.log as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: string[]) => typeof call[0] === 'string' && call[0].includes('Cache hit'),
    );
    expect(cacheHits).toHaveLength(0);
  });

  it('analyzes again once a source org is connected, instead of serving the seed it gave without one', async () => {
    // Held by target alone, the recommendation read before a second org was
    // connected was served for five minutes after.
    const analyze = (id: string, payload: Record<string, unknown>): Promise<boolean> =>
      handler.handle(
        inboundRequest({ id, type: 'smart-action:analyze', timestamp: Date.now(), payload }),
      );

    await analyze('req-alone', { targetOrgId: 'org-target-1' });
    expect(lastAction(deps)).toBe('quick-seed');

    await analyze('req-with-source', { targetOrgId: 'org-target-1', sourceOrgId: FULL_ORG });
    expect(lastAction(deps)).toBe('clone');
  });

  it('forgets a recommendation read with an org as its source when that org is forgotten', async () => {
    const analyze = (id: string): Promise<boolean> =>
      handler.handle(
        inboundRequest({
          id,
          type: 'smart-action:analyze',
          timestamp: Date.now(),
          payload: { targetOrgId: 'org-target-1', sourceOrgId: FULL_ORG },
        }),
      );

    await analyze('req-before');
    handler.forgetOrg(FULL_ORG);
    await analyze('req-after');

    const cacheHits = (deps.log as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: string[]) => typeof call[0] === 'string' && call[0].includes('Cache hit'),
    );
    expect(cacheHits).toHaveLength(0);
  });

  it('should report smart-action:analyze in SMART_ACTION_TYPES', async () => {
    const msg: InboundRequest & { payload: Record<string, unknown> } = inboundRequest({
      id: 'req-4',
      type: 'smart-action:analyze',
      timestamp: Date.now(),
      payload: { targetOrgId: 'org-1' },
    });
    const handled = await handler.handle(msg);
    expect(handled).toBe(true);
  });

  describe('payload validation', () => {
    it('rejects smart-action:analyze without targetOrgId (INVALID_PAYLOAD)', async () => {
      const msg: InboundRequest & { payload: Record<string, unknown> } = inboundRequest({
        id: 'req-bad',
        type: 'smart-action:analyze',
        timestamp: Date.now(),
        payload: {},
      });
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
