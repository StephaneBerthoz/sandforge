import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OrgHandler } from './OrgHandler';
import type { HandlerDeps } from './HandlerTypes';
import type { BaseMessage, SalesforceOrg, UUID } from '@sandforge/shared';
import { OrgSafetyTier } from '@sandforge/shared';
import { getConnectionPool } from '../../core/connection/ConnectionHelper';
import { OrgManager } from '../../core/connection/OrgManager';
import { OrgRegistry } from '../../core/connection/OrgRegistry';
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

  describe('org:connect login URL', () => {
    /** The org:error reply posted for the connect request, if any. */
    function connectError(): { code?: string } | undefined {
      const calls = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls;
      const reply = calls
        .map((c) => c[0] as { type: string; payload: { code?: string } })
        .find((m) => m.type === 'org:error');
      return reply?.payload;
    }

    it.each([
      ['a host that is not Salesforce', 'https://evil.example.com'],
      ['a Salesforce name used as a prefix', 'https://login.salesforce.com.evil.io'],
      ['a path after the host', 'https://login.salesforce.com/"&calc&"'],
    ])(
      'refuses %s for username/password before any credential is sent',
      async (_label, loginUrl) => {
        const authenticate = vi.fn();
        deps.authProvider = { authenticate } as unknown as HandlerDeps['authProvider'];

        await handler.handle(
          createMsg('org:connect', {
            orgId: '',
            authMethod: 'usernamePassword',
            username: 'u@example.com',
            password: 'secret',
            loginUrl,
          }),
        );

        expect(authenticate).not.toHaveBeenCalled();
        expect(connectError()?.code).toBe('INVALID_LOGIN_URL');
      },
    );

    it.each([
      ['a host that is not Salesforce', 'https://evil.example.com'],
      ['a Salesforce name used as a prefix', 'https://login.salesforce.com.evil.io'],
      ['an environment variable in the path', 'https://login.salesforce.com/%PATH%'],
    ])('refuses %s for OAuth web before the CLI runs', async (_label, loginUrl) => {
      const loginWeb = vi.fn();
      const isCliAvailable = vi.fn().mockResolvedValue(true);
      deps.sfdxBridge = { loginWeb, isCliAvailable } as unknown as HandlerDeps['sfdxBridge'];

      await handler.handle(
        createMsg('org:connect', { orgId: '', authMethod: 'oauth_web', loginUrl }),
      );

      expect(loginWeb).not.toHaveBeenCalled();
      expect(connectError()?.code).toBe('INVALID_LOGIN_URL');
    });

    it('sends username/password credentials to the origin of the login URL', async () => {
      const authenticate = vi.fn().mockResolvedValue({ success: false, error: 'bad password' });
      deps.authProvider = { authenticate } as unknown as HandlerDeps['authProvider'];

      await handler.handle(
        createMsg('org:connect', {
          orgId: '',
          authMethod: 'usernamePassword',
          username: 'u@example.com',
          password: 'secret',
          loginUrl: 'https://Acme.my.salesforce.com/',
        }),
      );

      expect(authenticate).toHaveBeenCalledWith(
        expect.objectContaining({ loginUrl: 'https://acme.my.salesforce.com' }),
      );
    });

    it('hands OAuth web the origin of the login URL, not the raw string', async () => {
      const loginWeb = vi.fn().mockResolvedValue(undefined);
      deps.sfdxBridge = {
        isCliAvailable: vi.fn().mockResolvedValue(true),
        loginWeb,
        listOrgs: vi.fn().mockResolvedValue([]),
      } as unknown as HandlerDeps['sfdxBridge'];

      await handler.handle(
        createMsg('org:connect', {
          orgId: '',
          authMethod: 'oauth_web',
          alias: 'uat',
          loginUrl: 'https://TEST.salesforce.com/',
        }),
      );

      expect(loginWeb).toHaveBeenCalledWith('uat', 'https://test.salesforce.com');
    });
  });

  describe('org:connect with a method that is not implemented', () => {
    it.each(['jwt', 'oauth_device'])(
      'answers %s with UNSUPPORTED_AUTH and touches nothing',
      async (authMethod) => {
        await handler.handle(createMsg('org:connect', { orgId: '', authMethod }));

        const calls = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls;
        const reply = calls
          .map((c) => c[0] as { type: string; correlationId?: string; payload: { code?: string } })
          .find((m) => m.type === 'org:error');
        expect(reply?.payload.code).toBe('UNSUPPORTED_AUTH');
        expect(reply?.correlationId).toBe('req-99');
        expect(deps.orgRegistry.saveOrg).not.toHaveBeenCalled();
      },
    );
  });

  describe('org:update', () => {
    const SAVED: SalesforceOrg = {
      id: 'org-1',
      alias: 'dev',
      username: 'dev@example.com',
      instanceUrl: 'https://dev.my.salesforce.com',
      orgId: 'org-1',
      orgType: 'Sandbox',
      authMethod: 'oauth_web',
      safetyTier: OrgSafetyTier.MEDIUM,
      appearance: { color: '#4a9eff', icon: 'cloud', position: 2 },
      metadata: { apiVersion: '62.0', edition: 'Developer', features: [] },
      status: 'connected',
      lastConnected: '2026-09-01T00:00:00Z',
      tags: [],
    };

    /** A real registry over an in-memory store, so a reload can be replayed. */
    function registryHarness(): {
      store: Map<string, unknown>;
      orgManager: OrgManager;
      orgRegistry: OrgRegistry;
    } {
      const store = new Map<string, unknown>();
      const configStore = {
        get: (key: string) => store.get(key),
        set: (key: string, value: unknown) => {
          store.set(key, value);
        },
        delete: (key: string) => store.delete(key),
        getByCategory: () => Object.fromEntries(store),
      } as unknown as HandlerDeps['configStore'];
      const secretVault = {} as HandlerDeps['secretVault'];
      const orgManager = new OrgManager();
      const orgRegistry = new OrgRegistry(configStore, secretVault, orgManager);
      configStore.set('org.org-1', SAVED, 'orgs');
      orgRegistry.loadAll();
      deps.orgManager = orgManager;
      deps.orgRegistry = orgRegistry;
      deps.configStore = configStore;
      return { store, orgManager, orgRegistry };
    }

    const posted = (): Array<BaseMessage & { payload: Record<string, unknown> }> =>
      (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls.map(
        ([m]) => m as BaseMessage & { payload: Record<string, unknown> },
      );

    it('saves alias, colour and tags to the registry and answers with the saved list', async () => {
      const { store } = registryHarness();

      const result = await handler.handle(
        createMsg('org:update', {
          orgId: 'org-1',
          alias: 'QA sandbox',
          color: '#F59E0B',
          tags: ['qa', 'eu'],
        }),
      );
      expect(result).toBe(true);

      const saved = store.get('org.org-1') as SalesforceOrg;
      expect(saved.alias).toBe('QA sandbox');
      expect(saved.appearance).toEqual({ color: '#F59E0B', icon: 'cloud', position: 2 });
      expect(saved.tags).toEqual(['qa', 'eu']);
      expect(saved.safetyTier).toBe(OrgSafetyTier.MEDIUM);
      expect(saved.username).toBe('dev@example.com');

      const [reply] = posted();
      expect(reply.type).toBe('org:list:response');
      expect(reply.correlationId).toBe('req-99');
      expect((reply.payload.orgs as SalesforceOrg[])[0].alias).toBe('QA sandbox');
      expect(deps.stateSync.updateState).toHaveBeenCalledWith({
        orgs: [expect.objectContaining({ alias: 'QA sandbox' })],
      });
    });

    it('keeps the edit in the next org:list and after the registry loads again', async () => {
      const { store } = registryHarness();
      await handler.handle(
        createMsg('org:update', {
          orgId: 'org-1',
          alias: 'QA sandbox',
          color: '#F59E0B',
          tags: [],
        }),
      );

      await handler.handle(createMsg('org:list'));
      const list = posted().at(-1);
      expect(list?.type).toBe('org:list:response');
      expect((list?.payload.orgs as SalesforceOrg[])[0].alias).toBe('QA sandbox');

      const reloaded = new OrgManager();
      new OrgRegistry(deps.configStore, {} as HandlerDeps['secretVault'], reloaded).loadAll();
      expect(reloaded.getOrg('org-1' as UUID)?.alias).toBe('QA sandbox');
      expect(store.size).toBe(1);
    });

    it('does not change the safety tier even when the payload names one', async () => {
      const { store } = registryHarness();
      await handler.handle(
        createMsg('org:update', {
          orgId: 'org-1',
          alias: 'dev',
          color: '#4a9eff',
          tags: [],
          safetyTier: 'low',
        }),
      );
      expect((store.get('org.org-1') as SalesforceOrg).safetyTier).toBe(OrgSafetyTier.MEDIUM);
    });

    it('answers an unknown org on org:error and writes nothing', async () => {
      const { store } = registryHarness();
      await handler.handle(
        createMsg('org:update', { orgId: 'ghost', alias: 'x', color: '#4a9eff', tags: [] }),
      );

      const [reply] = posted();
      expect(reply.type).toBe('org:error');
      expect(reply.correlationId).toBe('req-99');
      expect(reply.payload.code).toBe('ORG_NOT_FOUND');
      expect(store.has('org.ghost')).toBe(false);
    });

    it.each([
      ['an empty alias', { orgId: 'org-1', alias: '  ', color: '#4a9eff', tags: [] }],
      ['a colour that is not a hex code', { orgId: 'org-1', alias: 'dev', color: 'red', tags: [] }],
      ['tags that are not strings', { orgId: 'org-1', alias: 'dev', color: '#4a9eff', tags: [1] }],
    ])('refuses %s (INVALID_PAYLOAD) and writes nothing', async (_label, payload) => {
      const { store } = registryHarness();
      await handler.handle(createMsg('org:update', payload));

      const [reply] = posted();
      expect(reply.type).toBe('org:error');
      expect(reply.payload.code).toBe('INVALID_PAYLOAD');
      expect((store.get('org.org-1') as SalesforceOrg).alias).toBe('dev');
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
