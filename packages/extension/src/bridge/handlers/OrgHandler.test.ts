import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OrgHandler } from './OrgHandler';
import type { HandlerDeps } from './HandlerTypes';
import type { UUID } from '@sandforge/shared';
import { getConnectionPool } from '../../core/connection/ConnectionHelper';
import type { InboundRequest } from './HandlerTypes.js';
import { inboundRequest } from '../../test/mockFactories.js';

function createMockDeps(): HandlerDeps {
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: { updateState: vi.fn() } as unknown as HandlerDeps['stateSync'],
    orgManager: {
      getAllOrgs: vi.fn().mockReturnValue([{ id: 'org-1', alias: 'dev', status: 'connected' }]),
      getOrg: vi.fn(),
    } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {
      saveOrg: vi.fn().mockResolvedValue(undefined),
      removeOrg: vi.fn().mockResolvedValue(undefined),
    } as unknown as HandlerDeps['orgRegistry'],
    configStore: {} as HandlerDeps['configStore'],
    secretVault: {} as HandlerDeps['secretVault'],
    authProvider: {} as HandlerDeps['authProvider'],
    sfdxBridge: {} as HandlerDeps['sfdxBridge'],
    nextId: vi.fn().mockReturnValue('test-id'),
  };
}

function createMsg(
  type: string,
  payload: Record<string, unknown> = {},
): InboundRequest & { payload: Record<string, unknown> } {
  return inboundRequest({ id: 'req-99', type, timestamp: Date.now(), payload });
}

describe('OrgHandler', () => {
  let handler: OrgHandler;
  let deps: HandlerDeps;

  beforeEach(() => {
    deps = createMockDeps();
    handler = new OrgHandler(deps);
  });

  it('returns false for unknown message types', async () => {
    expect(await handler.handle(createMsg('unknown:type'))).toBe(false);
  });

  it('handles org:list with correlationId', async () => {
    const result = await handler.handle(createMsg('org:list'));
    expect(result).toBe(true);

    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.type).toBe('org:list:response');
    expect(response.correlationId).toBe('req-99');
    expect(response.payload.orgs).toHaveLength(1);
  });

  it('handles org:disconnect with correlationId', async () => {
    const result = await handler.handle(createMsg('org:disconnect', { orgId: 'org-1' }));
    expect(result).toBe(true);

    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.type).toBe('org:statusChanged');
    expect(response.correlationId).toBe('req-99');
    expect(response.payload.status).toBe('disconnected');
  });

  it('handles org:select: invokes the selection callback and broadcasts org:selected', async () => {
    deps.onOrgSelected = vi.fn();
    (deps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'org-1',
      alias: 'dev',
    });

    const result = await handler.handle(createMsg('org:select', { orgId: 'org-1' }));
    expect(result).toBe(true);

    expect(deps.onOrgSelected).toHaveBeenCalledWith('org-1');
    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.type).toBe('org:selected');
    expect(response.payload.orgId).toBe('org-1');
  });

  it('org:select without the callback still broadcasts (no crash on partial deps)', async () => {
    (deps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockReturnValue({
      id: 'org-1',
    });

    const result = await handler.handle(createMsg('org:select', { orgId: 'org-1' }));
    expect(result).toBe(true);
    const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(response.type).toBe('org:selected');
  });

  it('org:select on an unknown org warns and does not broadcast', async () => {
    deps.onOrgSelected = vi.fn();
    (deps.orgManager.getOrg as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const result = await handler.handle(createMsg('org:select', { orgId: 'ghost' }));
    expect(result).toBe(true);

    expect(deps.onOrgSelected).not.toHaveBeenCalled();
    const calls = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.every((c) => (c[0] as { type: string }).type !== 'org:selected')).toBe(true);
  });

  describe('org:disconnect evicts the pooled access token', () => {
    const ORG_ID = 'org-1' as UUID;

    afterEach(() => {
      getConnectionPool().remove(ORG_ID);
    });

    it('removes the org entry from the connection pool', async () => {
      const pool = getConnectionPool();
      pool.acquire(ORG_ID, 'https://dev.my.salesforce.com', 'token-to-revoke');
      expect(pool.get(ORG_ID)?.accessToken).toBe('token-to-revoke');

      await handler.handle(createMsg('org:disconnect', { orgId: ORG_ID }));

      expect(pool.get(ORG_ID)).toBeUndefined();
    });

    it('leaves other orgs pooled', async () => {
      const pool = getConnectionPool();
      const other = 'org-2' as UUID;
      pool.acquire(ORG_ID, 'https://dev.my.salesforce.com', 'token-to-revoke');
      pool.acquire(other, 'https://qa.my.salesforce.com', 'token-kept');

      await handler.handle(createMsg('org:disconnect', { orgId: ORG_ID }));

      expect(pool.get(ORG_ID)).toBeUndefined();
      expect(pool.get(other)?.accessToken).toBe('token-kept');
      pool.remove(other);
    });

    it('does not touch the pool when the payload is rejected', async () => {
      const pool = getConnectionPool();
      pool.acquire(ORG_ID, 'https://dev.my.salesforce.com', 'token-to-revoke');

      await handler.handle(createMsg('org:disconnect', {}));

      expect(pool.get(ORG_ID)?.accessToken).toBe('token-to-revoke');
    });
  });

  describe('payload validation', () => {
    it('rejects org:disconnect without orgId (INVALID_PAYLOAD)', async () => {
      const result = await handler.handle(createMsg('org:disconnect', {}));
      expect(result).toBe(true);

      const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(response.type).toBe('org:error');
      expect(response.payload.code).toBe('INVALID_PAYLOAD');
      expect(deps.orgRegistry.removeOrg).not.toHaveBeenCalled();
    });

    it('rejects org:connect without authMethod (INVALID_PAYLOAD)', async () => {
      const result = await handler.handle(createMsg('org:connect', { orgId: '' }));
      expect(result).toBe(true);

      const response = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(response.type).toBe('org:error');
      expect(response.payload.code).toBe('INVALID_PAYLOAD');
    });
  });
});
