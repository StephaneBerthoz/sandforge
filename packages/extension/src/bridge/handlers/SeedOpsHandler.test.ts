import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SeedOpsHandler } from './SeedOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import type { BaseMessage } from '@sandforge/shared';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

const mockGetConn = vi.mocked(getJsforceConnection);

/**
 * Creates minimal mock deps for SeedOpsHandler tests.
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

describe('SeedOpsHandler', () => {
  let handler: SeedOpsHandler;
  let deps: HandlerDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
    handler = new SeedOpsHandler(deps);
  });

  it('returns false for unhandled message types', async () => {
    const msg: BaseMessage = { id: '1', type: 'unknown:type', timestamp: Date.now() };
    const result = await handler.handle(msg);
    expect(result).toBe(false);
  });

  it('handles seed:describe-global and response includes correlationId', async () => {
    mockGetConn.mockResolvedValue({
      describeGlobal: vi.fn().mockResolvedValue({
        sobjects: [
          { name: 'Account', label: 'Account', createable: true },
          { name: 'Lead', label: 'Lead', createable: false },
        ],
      }),
    } as never);

    const msg: BaseMessage & { payload: { orgId: string } } = {
      id: 'req-100',
      type: 'seed:describe-global',
      timestamp: Date.now(),
      payload: { orgId: 'org-1' },
    };

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & { correlationId?: string; payload: { objects: unknown[] } };
    expect(response.type).toBe('seed:describe-global:response');
    expect(response.correlationId).toBe('req-100');
    expect(response.payload.objects).toHaveLength(1);
    expect((response.payload.objects[0] as { apiName: string }).apiName).toBe('Account');
  });

  it('handles seed:describe-object and response includes correlationId', async () => {
    mockGetConn.mockResolvedValue({
      describe: vi.fn().mockResolvedValue({
        label: 'Account',
        fields: [
          { name: 'Name', label: 'Account Name', type: 'string', nillable: false, defaultedOnCreate: false, length: 255, createable: true },
        ],
      }),
    } as never);

    const msg: BaseMessage & { payload: { orgId: string; objectApiName: string } } = {
      id: 'req-200',
      type: 'seed:describe-object',
      timestamp: Date.now(),
      payload: { orgId: 'org-1', objectApiName: 'Account' },
    };

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & { correlationId?: string };
    expect(response.type).toBe('seed:describe-object:response');
    expect(response.correlationId).toBe('req-200');
  });

  it('error path sends error response via sendHandlerError', async () => {
    mockGetConn.mockRejectedValue(new Error('connection failed'));

    const msg: BaseMessage & { payload: { orgId: string } } = {
      id: 'req-300',
      type: 'seed:describe-global',
      timestamp: Date.now(),
      payload: { orgId: 'org-1' },
    };

    await handler.handle(msg);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & { payload: { message: string } };
    expect(response.type).toBe('seed:error');
    expect(response.payload.message).toBe('connection failed');
  });
});
