import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrgHandler } from './OrgHandler';
import type { HandlerDeps } from './HandlerTypes';
import type { BaseMessage } from '@sandforge/shared';

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
): BaseMessage & { payload: Record<string, unknown> } {
  return { id: 'req-99', type, timestamp: Date.now(), payload };
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
