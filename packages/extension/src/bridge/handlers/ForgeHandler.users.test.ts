import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseMessage } from '@sandforge/shared';
import { ForgeHandler } from './ForgeHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { ACTIVE_USERS_SOQL } from '../../modules/forge/orgUsers.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const mockGetJsforceConnection = vi.fn();
vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: (...args: unknown[]) => mockGetJsforceConnection(...args),
}));

/*
 * Review maps the owner of the rows a run writes to one of the target's
 * users, picked by name: the extension lists the org's active users, each
 * with the id the mapping keeps.
 */
describe('forge:users:request', () => {
  let deps: HandlerDeps;
  let handler: ForgeHandler;
  const query = vi.fn();

  function request(payload: Record<string, unknown>): InboundRequest {
    return inboundRequest({
      id: 'wv-users',
      type: 'forge:users:request',
      timestamp: Date.now(),
      payload,
    } as BaseMessage);
  }

  function posted(): Array<BaseMessage & { payload: Record<string, unknown> }> {
    return vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map((call) => call[0] as BaseMessage & { payload: Record<string, unknown> });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetJsforceConnection.mockResolvedValue({ query, limitInfo: undefined });
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {} as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
      configStore: { get: vi.fn(), set: vi.fn() } as unknown as HandlerDeps['configStore'],
      secretVault: {} as unknown as HandlerDeps['secretVault'],
      authProvider: {} as unknown as HandlerDeps['authProvider'],
      sfdxBridge: {} as unknown as HandlerDeps['sfdxBridge'],
      nextId: () => 'ext-1',
    };
    handler = new ForgeHandler(deps);
  });

  it("answers with the org's active users who can own a record, each with its id", async () => {
    query.mockResolvedValue({
      done: true,
      records: [{ Id: '005000000000001AAA', Name: 'Ada Admin', Username: 'ada@example.invalid' }],
    });

    expect(await handler.handle(request({ orgId: 'tgt-org' }))).toBe(true);

    expect(mockGetJsforceConnection).toHaveBeenCalledWith('tgt-org', {}, {});
    expect(query).toHaveBeenCalledWith(ACTIVE_USERS_SOQL);
    expect(posted()).toEqual([
      expect.objectContaining({
        type: 'forge:users:response',
        correlationId: 'wv-users',
        payload: {
          orgId: 'tgt-org',
          users: [{ id: '005000000000001AAA', name: 'Ada Admin', username: 'ada@example.invalid' }],
          truncated: false,
        },
      }),
    ]);
  });

  it('says why the users could not be read, and reads none for a payload naming no org', async () => {
    query.mockRejectedValue(new Error('INVALID_SESSION_ID'));

    await handler.handle(request({ orgId: 'tgt-org' }));
    await handler.handle(request({ orgId: '' }));

    expect(posted().map((m) => m.type)).toEqual(['forge:users:error', 'forge:users:error']);
    expect(posted()[0]?.payload).toMatchObject({ code: 'USERS_ERROR' });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
