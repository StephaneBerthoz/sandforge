import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CompareHandler } from './CompareHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import type { BaseMessage } from '@sandforge/shared';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));
vi.mock('../../modules/compare/DiffEngine.js', () => ({
  DiffEngine: vi.fn().mockImplementation(function () {
    return {};
  }),
}));
vi.mock('../../modules/compare/MetadataCompare.js', () => ({
  MetadataCompare: vi.fn().mockImplementation(function () {
    return {};
  }),
}));
vi.mock('../../modules/compare/ConfigCompare.js', () => ({
  ConfigCompare: vi.fn().mockImplementation(function () {
    return {};
  }),
}));
vi.mock('../../modules/compare/PermissionCompare.js', () => ({
  PermissionCompare: vi.fn().mockImplementation(function () {
    return {};
  }),
}));
vi.mock('../../modules/compare/DataCompare.js', () => ({
  DataCompare: vi.fn().mockImplementation(function () {
    return {};
  }),
}));
vi.mock('../../modules/compare/CompareOrchestrator.js', () => ({
  CompareOrchestrator: vi.fn().mockImplementation(function () {
    return {
      execute: vi.fn().mockResolvedValue({ diffs: [], summary: {} }),
    };
  }),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { inboundRequest } from '../../test/mockFactories.js';

const mockGetConn = vi.mocked(getJsforceConnection);

/**
 * Creates minimal mock deps for CompareHandler tests.
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
    services: {
      compareOrchestrator: vi.fn().mockReturnValue({
        execute: vi.fn().mockResolvedValue({ diffs: [], summary: {} }),
      }),
    } as unknown as HandlerDeps['services'],
    nextId: () => String(++idCounter),
  };
}

describe('CompareHandler', () => {
  let handler: CompareHandler;
  let deps: HandlerDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = createMockDeps();
    handler = new CompareHandler(deps);
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

  it('handles compare:execute with response type compare:execute:response and correlationId', async () => {
    mockGetConn.mockResolvedValue({
      metadata: { list: vi.fn().mockResolvedValue([]) },
      request: vi.fn().mockResolvedValue({}),
      query: vi.fn().mockResolvedValue({ records: [], totalSize: 0 }),
      limitInfo: undefined,
    } as never);

    const msg: InboundRequest & {
      payload: { sourceOrgId: string; targetOrgId: string; types: string[] };
    } = inboundRequest({
      id: 'req-cmp-1',
      type: 'compare:execute',
      timestamp: Date.now(),
      payload: { sourceOrgId: 'src', targetOrgId: 'tgt', types: ['ApexClass'] },
    });

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      correlationId?: string;
    };
    expect(response.type).toBe('compare:execute:response');
    expect(response.correlationId).toBe('req-cmp-1');
  });

  it('does not claim compare:start, the alias no page sends', async () => {
    const msg: InboundRequest = inboundRequest({
      id: 'req-cmp-alias',
      type: 'compare:start',
      timestamp: Date.now(),
    });

    expect(await handler.handle(msg)).toBe(false);
    expect(deps.broker.postToWebview).not.toHaveBeenCalled();
  });

  it('error path sends typed error response', async () => {
    mockGetConn.mockRejectedValue(new Error('connection failed'));

    const msg: InboundRequest & {
      payload: { sourceOrgId: string; targetOrgId: string; types: string[] };
    } = inboundRequest({
      id: 'req-cmp-err',
      type: 'compare:execute',
      timestamp: Date.now(),
      payload: { sourceOrgId: 'src', targetOrgId: 'tgt', types: ['ApexClass'] },
    });

    await handler.handle(msg);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { message: string };
    };
    expect(response.type).toBe('compare:error');
    expect(response.payload.message).toBe('connection failed');
  });

  it('handles compare:permissions with response type and correlationId', async () => {
    mockGetConn.mockResolvedValue({
      query: vi.fn().mockResolvedValue({ records: [], totalSize: 0, done: true }),
      limitInfo: undefined,
    } as never);

    const msg: InboundRequest & {
      payload: { sourceOrgId: string; targetOrgId: string };
    } = inboundRequest({
      id: 'req-cmp-perm',
      type: 'compare:permissions',
      timestamp: Date.now(),
      payload: { sourceOrgId: 'src', targetOrgId: 'tgt' },
    });

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      correlationId?: string;
      payload: { permissions: Record<string, unknown> };
    };
    expect(response.type).toBe('compare:permissions:response');
    expect(response.correlationId).toBe('req-cmp-perm');
    expect(response.payload.permissions).toBeDefined();
  });

  it('handles compare:snapshots with response type and correlationId', async () => {
    mockGetConn.mockResolvedValue({
      describeGlobal: vi.fn().mockResolvedValue({
        sobjects: [
          { name: 'Account', custom: false, label: 'Account', queryable: true },
          {
            name: 'My_Custom__c',
            custom: true,
            label: 'My Custom',
            queryable: true,
          },
        ],
      }),
      limitInfo: undefined,
    } as never);

    const msg: InboundRequest & {
      payload: { sourceOrgId: string; targetOrgId: string };
    } = inboundRequest({
      id: 'req-cmp-snap',
      type: 'compare:snapshots',
      timestamp: Date.now(),
      payload: { sourceOrgId: 'src', targetOrgId: 'tgt' },
    });

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      correlationId?: string;
      payload: {
        snapshot: {
          source: Record<string, unknown>;
          target: Record<string, unknown>;
          diff: Record<string, unknown>;
        };
      };
    };
    expect(response.type).toBe('compare:snapshots:response');
    expect(response.correlationId).toBe('req-cmp-snap');
    expect(response.payload.snapshot.source).toBeDefined();
    expect(response.payload.snapshot.target).toBeDefined();
    expect(response.payload.snapshot.diff).toBeDefined();
  });

  it('handles compare:drift with response type and correlationId', async () => {
    mockGetConn.mockResolvedValue({
      query: vi.fn().mockResolvedValue({
        records: [
          {
            Name: 'TestOrg',
            LanguageLocaleKey: 'en_US',
            DefaultLocaleSidKey: 'en_US',
            TimeZoneSidKey: 'America/Los_Angeles',
            FiscalYearStartMonth: '1',
          },
        ],
        totalSize: 1,
        done: true,
      }),
      limitInfo: undefined,
    } as never);

    const msg: InboundRequest & {
      payload: { sourceOrgId: string; targetOrgId: string };
    } = inboundRequest({
      id: 'req-cmp-drift',
      type: 'compare:drift',
      timestamp: Date.now(),
      payload: { sourceOrgId: 'src', targetOrgId: 'tgt' },
    });

    const result = await handler.handle(msg);
    expect(result).toBe(true);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      correlationId?: string;
      payload: {
        drift: { items: unknown[]; driftCount: number; matchCount: number };
      };
    };
    expect(response.type).toBe('compare:drift:response');
    expect(response.correlationId).toBe('req-cmp-drift');
    expect(response.payload.drift.items).toBeDefined();
    expect(typeof response.payload.drift.driftCount).toBe('number');
    expect(typeof response.payload.drift.matchCount).toBe('number');
  });

  describe('compare:permissions against orgs that hold more than a page', () => {
    interface PermissionSetRow {
      Id: string;
      Name: string;
      Label: string;
      IsOwnedByProfile: boolean;
    }

    /**
     * An org answering the two reads the tab makes. A `LIMIT` without an
     * `ORDER BY` returns rows in the org's own order, which is not the other
     * org's, and a `WHERE IsOwnedByProfile = false` is honoured.
     */
    function org(permissionSets: PermissionSetRow[], profiles: string[]) {
      return {
        limitInfo: undefined,
        query: vi.fn((soql: string) => {
          let rows: Array<Record<string, unknown>> = /FROM PermissionSet\b/.test(soql)
            ? permissionSets.filter(
                (p) => !/IsOwnedByProfile = false/.test(soql) || !p.IsOwnedByProfile,
              )
            : profiles.map((name, i) => ({ Id: `00e00000000000${i}AAA`, Name: name }));
          const limit = /LIMIT (\d+)/.exec(soql);
          if (limit) rows = rows.slice(0, Number(limit[1]));
          return Promise.resolve({ records: rows, totalSize: rows.length, done: true });
        }),
      };
    }

    const regular = (name: string, i: number): PermissionSetRow => ({
      Id: `0PS00000000${String(i).padStart(4, '0')}AAA`,
      Name: name,
      Label: name,
      IsOwnedByProfile: false,
    });

    async function comparePermissions(
      source: ReturnType<typeof org>,
      target: ReturnType<typeof org>,
    ): Promise<{
      permissionSets: Record<'sourceOnly' | 'targetOnly' | 'shared', Array<{ name: string }>>;
      profiles: Record<'sourceOnly' | 'targetOnly' | 'shared', Array<{ name: string }>>;
    }> {
      mockGetConn.mockImplementation((orgId: string) =>
        Promise.resolve((orgId === 'src' ? source : target) as never),
      );
      (deps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockReturnValue({ orgType: 'Sandbox' });
      await handler.handle(
        inboundRequest({
          id: 'req-cmp-perm-all',
          type: 'compare:permissions',
          timestamp: Date.now(),
          payload: { sourceOrgId: 'src', targetOrgId: 'tgt' },
        }),
      );
      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const response = postToWebview.mock.calls[0][0] as BaseMessage & {
        payload: { permissions: Awaited<ReturnType<typeof comparePermissions>> };
      };
      expect(response.type).toBe('compare:permissions:response');
      return response.payload.permissions;
    }

    it('compares every permission set of both orgs, not the first hundred of each', async () => {
      // Run against two real sandboxes holding 283 and 282 permission sets,
      // the tab read a hundred of each and reported 9 on one side only, 9 on
      // the other and 91 in both. The orgs differ by 3, 2 and 280.
      const names = Array.from({ length: 150 }, (_, i) => `PS_${String(i).padStart(3, '0')}`);
      const source = org(
        names.map((name, i) => regular(name, i)),
        ['System Administrator'],
      );
      const target = org(
        [...names].reverse().map((name, i) => regular(name, i)),
        ['System Administrator'],
      );

      const permissions = await comparePermissions(source, target);

      expect(permissions.permissionSets.sourceOnly).toEqual([]);
      expect(permissions.permissionSets.targetOnly).toEqual([]);
      expect(permissions.permissionSets.shared).toHaveLength(150);
    });

    it('leaves out the permission sets profiles own, whose names each org generates', async () => {
      // A profile's own permission set is named after the profile's Id in
      // that org (X00e…), so the same profile carries a different name in
      // each. The profiles themselves are compared by name below.
      const owned = (name: string): PermissionSetRow => ({
        Id: '0PS000000009999AAA',
        Name: name,
        Label: '00e000000000001',
        IsOwnedByProfile: true,
      });
      const source = org(
        [regular('Sales_Ops', 1), owned('X00e000000000001SRC')],
        ['System Administrator'],
      );
      const target = org(
        [regular('Sales_Ops', 1), owned('X00e000000000002TGT')],
        ['System Administrator'],
      );

      const permissions = await comparePermissions(source, target);

      expect(permissions.permissionSets.sourceOnly).toEqual([]);
      expect(permissions.permissionSets.targetOnly).toEqual([]);
      expect(permissions.permissionSets.shared.map((p) => p.name)).toEqual(['Sales_Ops']);
      expect(permissions.profiles.shared.map((p) => p.name)).toEqual(['System Administrator']);
    });
  });

  it('compare:permissions error path sends typed error', async () => {
    mockGetConn.mockRejectedValue(new Error('perm connection failed'));

    const msg: InboundRequest & {
      payload: { sourceOrgId: string; targetOrgId: string };
    } = inboundRequest({
      id: 'req-cmp-perm-err',
      type: 'compare:permissions',
      timestamp: Date.now(),
      payload: { sourceOrgId: 'src', targetOrgId: 'tgt' },
    });

    await handler.handle(msg);

    const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
    expect(postToWebview).toHaveBeenCalledTimes(1);

    const response = postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { message: string };
    };
    expect(response.type).toBe('compare:error');
    expect(response.payload.message).toBe('perm connection failed');
  });

  describe('payload validation', () => {
    it('rejects compare:execute with empty types array', async () => {
      const msg = inboundRequest({
        id: 'bad-cmp',
        type: 'compare:execute',
        timestamp: Date.now(),
        payload: { sourceOrgId: 'a', targetOrgId: 'b', types: [] },
      } as unknown as BaseMessage);

      const result = await handler.handle(msg);
      expect(result).toBe(true);
      expect(mockGetConn).not.toHaveBeenCalled();

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const errMsg = postToWebview.mock.calls[0][0] as {
        type: string;
        payload: { code: string };
      };
      expect(errMsg.type).toBe('compare:error');
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
    });

    it('rejects compare:permissions without targetOrgId', async () => {
      const msg = inboundRequest({
        id: 'bad-perm',
        type: 'compare:permissions',
        timestamp: Date.now(),
        payload: { sourceOrgId: 'a' },
      } as unknown as BaseMessage);

      await handler.handle(msg);
      expect(mockGetConn).not.toHaveBeenCalled();

      const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
      const errMsg = postToWebview.mock.calls[0][0] as {
        payload: { code: string };
      };
      expect(errMsg.payload.code).toBe('INVALID_PAYLOAD');
    });
  });
});
