import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseMessage } from '@sandforge/shared';
import { OrgHandler } from './OrgHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { ASSIGN_RIGHT_SOQL } from '../../modules/forge/AutomationMuteLease.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
const mockGetJsforceConnection = vi.fn();
vi.mock('../../core/connection/ConnectionHelper.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/connection/ConnectionHelper.js')>()),
  getJsforceConnection: (...args: unknown[]) => mockGetJsforceConnection(...args),
}));

/*
 * A page that reads nothing of the target before its run — Sync's Run, Quick
 * Sync, Autopilot's review, a Frozen load, a Seed run's removal, a
 * checkpoint's Undo and replay, an emptying's resume — offered the box that
 * mutes to a user who could not assign permission sets, and the run it
 * started was refused at its first step. The page asks the right alone, by
 * the statement the run's lease asks it with, before it offers the box.
 */
describe('org:assign-right', () => {
  let deps: HandlerDeps;
  let handler: OrgHandler;
  const query = vi.fn();

  function request(payload: Record<string, unknown>): InboundRequest {
    return inboundRequest({
      id: 'wv-right',
      type: 'org:assign-right',
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
    mockGetJsforceConnection.mockResolvedValue({ query });
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {} as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as unknown as HandlerDeps['orgRegistry'],
      configStore: {} as HandlerDeps['configStore'],
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      nextId: () => 'ext-1',
    };
    handler = new OrgHandler(deps);
  });

  it('says a user with neither Assign Permission Sets nor Manage Users cannot assign, by the lease’s own statement', async () => {
    query.mockResolvedValue({
      records: [{ PermissionsAssignPermissionSets: false, PermissionsManageUsers: false }],
    });

    expect(await handler.handle(request({ orgId: 'tgt-org' }))).toBe(true);

    expect(mockGetJsforceConnection).toHaveBeenCalledWith('tgt-org', {}, {});
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(ASSIGN_RIGHT_SOQL);
    expect(posted()).toEqual([
      expect.objectContaining({
        type: 'org:assign-right:response',
        correlationId: 'wv-right',
        payload: { orgId: 'tgt-org', cannotAssign: true },
      }),
    ]);
  });

  it.each([
    [
      'Assign Permission Sets',
      { PermissionsAssignPermissionSets: true, PermissionsManageUsers: false },
    ],
    ['Manage Users', { PermissionsAssignPermissionSets: false, PermissionsManageUsers: true }],
  ])('leaves the box to a user who has %s', async (_right, row) => {
    query.mockResolvedValue({ records: [row] });

    await handler.handle(request({ orgId: 'tgt-org' }));

    expect(posted()).toEqual([
      expect.objectContaining({
        type: 'org:assign-right:response',
        payload: { orgId: 'tgt-org' },
      }),
    ]);
  });

  it('leaves the box, and the run’s lease to ask again, where the org would not say or could not be reached', async () => {
    query.mockResolvedValueOnce({ records: [] });
    await handler.handle(request({ orgId: 'tgt-org' }));
    query.mockRejectedValueOnce(new Error("No such column 'PermissionsAssignPermissionSets'"));
    await handler.handle(request({ orgId: 'tgt-org' }));
    mockGetJsforceConnection.mockRejectedValueOnce(new Error('No credentials for org'));
    await handler.handle(request({ orgId: 'tgt-org' }));

    expect(posted().map((message) => [message.type, message.payload])).toEqual([
      ['org:assign-right:response', { orgId: 'tgt-org' }],
      ['org:assign-right:response', { orgId: 'tgt-org' }],
      ['org:assign-right:response', { orgId: 'tgt-org' }],
    ]);
  });

  it('refuses a request that names no org, asking nothing of any', async () => {
    await handler.handle(request({}));

    expect(mockGetJsforceConnection).not.toHaveBeenCalled();
    expect(posted()).toEqual([
      expect.objectContaining({
        type: 'org:error',
        correlationId: 'wv-right',
        payload: expect.objectContaining({ code: 'INVALID_PAYLOAD' }),
      }),
    ]);
  });
});
