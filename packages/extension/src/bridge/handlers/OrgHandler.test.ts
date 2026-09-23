import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OrgHandler } from './OrgHandler';
import type { HandlerDeps } from './HandlerTypes';
import type { BaseMessage, SalesforceOrg, UUID } from '@sandforge/shared';
import { OrgSafetyTier } from '@sandforge/shared';
import { getConnectionPool } from '../../core/connection/ConnectionHelper';
import { OrgManager } from '../../core/connection/OrgManager';
import { OrgRegistry } from '../../core/connection/OrgRegistry';
import { ConfigStore } from '../../core/storage/ConfigStore';
import { SandboxRefreshDetector } from '../../modules/monitor/SandboxRefreshDetector';
import type { InboundRequest } from './HandlerTypes.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';

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

    it('points a login host on another Salesforce cloud to SFDX Import', async () => {
      const authenticate = vi.fn();
      deps.authProvider = { authenticate } as unknown as HandlerDeps['authProvider'];

      await handler.handle(
        createMsg('org:connect', {
          orgId: '',
          authMethod: 'usernamePassword',
          username: 'u@example.com',
          password: 'secret',
          loginUrl: 'https://x.my.salesforce.mil',
        }),
      );

      expect(authenticate).not.toHaveBeenCalled();
      const reply = (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls
        .map((c) => c[0] as { type: string; payload: { code?: string; message?: string } })
        .find((m) => m.type === 'org:error');
      expect(reply?.payload.code).toBe('INVALID_LOGIN_URL');
      expect(reply?.payload.message).toMatch(/SFDX Import/);
      expect(reply?.payload.message).toMatch(/sf org login web --instance-url/);
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
    it.each(['saml', 'oauth_password_grant'])(
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
      const secretVault = {
        storeObject: vi.fn().mockResolvedValue(undefined),
      } as unknown as HandlerDeps['secretVault'];
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

    it('keeps the edit when the org is imported again from the CLI', async () => {
      registryHarness();
      await handler.handle(
        createMsg('org:update', {
          orgId: 'org-1',
          alias: 'QA sandbox',
          color: '#F59E0B',
          tags: ['qa'],
        }),
      );
      // The CLI knows nothing of the edit: its org carries the defaults.
      deps.sfdxBridge = {
        isCliAvailable: vi.fn().mockResolvedValue(true),
        listOrgs: vi.fn().mockResolvedValue([
          {
            org: {
              ...SAVED,
              alias: 'dev@example.com',
              instanceUrl: 'https://dev2.my.salesforce.com',
              appearance: { color: '#4a9eff', icon: 'cloud', position: 0 },
              tags: [],
            },
            credentials: { loginUrl: 'https://dev2.my.salesforce.com', accessToken: 'tok' },
          },
        ]),
      } as unknown as HandlerDeps['sfdxBridge'];

      await handler.handle(createMsg('org:connect', { orgId: '', authMethod: 'sfdx_import' }));

      const list = posted()
        .filter((m) => m.type === 'org:list:response')
        .at(-1);
      const [org] = list?.payload.orgs as SalesforceOrg[];
      expect(org.alias).toBe('QA sandbox');
      expect(org.appearance.color).toBe('#F59E0B');
      expect(org.tags).toEqual(['qa']);
      expect(org.instanceUrl).toBe('https://dev2.my.salesforce.com');
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

  describe('importing a sandbox again after a refresh', () => {
    // A refresh gives the sandbox a new org id under the same username. The
    // entry below was registered before it, under the org id it had then.
    const FORMER_ORG_ID = '00DXX00000AbCdE2A1';
    const REFRESHED_ORG_ID = '00Dxx00000FgHiJ3B2';
    const USERNAME = 'admin@acme.test.uat';
    const INSTANCE_URL = 'https://acme--uat.sandbox.my.salesforce.com';

    const REGISTERED: SalesforceOrg = {
      id: FORMER_ORG_ID,
      alias: 'UAT',
      username: USERNAME,
      instanceUrl: INSTANCE_URL,
      orgId: FORMER_ORG_ID,
      orgType: 'Sandbox',
      authMethod: 'sfdx_import',
      safetyTier: OrgSafetyTier.MEDIUM,
      appearance: { color: '#F59E0B', icon: 'cloud', position: 3 },
      metadata: { apiVersion: '62.0', edition: 'Enterprise Edition', features: [] },
      status: 'connected',
      lastConnected: '2026-09-01T08:00:00.000Z',
      tags: ['uat'],
    };

    /** The sandbox as the CLI lists it after the refresh: its new org id, and the defaults. */
    function listed(orgId = REFRESHED_ORG_ID, username = USERNAME) {
      return {
        org: {
          ...REGISTERED,
          id: orgId,
          orgId,
          alias: username,
          username,
          appearance: { color: '#4a9eff', icon: 'cloud', position: 0 },
          lastConnected: '2026-09-22T09:00:00.000Z',
          tags: [],
        },
        credentials: {
          loginUrl: INSTANCE_URL,
          accessToken: 'token-of-the-new-org',
          instanceUrl: INSTANCE_URL,
          username,
        },
      };
    }

    /** A real registry and refresh detector over one store, as the extension wires them. */
    function harness(): {
      configStore: ConfigStore;
      orgManager: OrgManager;
      detector: SandboxRefreshDetector;
      storeObject: ReturnType<typeof vi.fn>;
    } {
      const configStore = new ConfigStore(new InMemoryConfigStoreBackend());
      configStore.initialize();
      const storeObject = vi.fn().mockResolvedValue(undefined);
      const secretVault = { storeObject } as unknown as HandlerDeps['secretVault'];
      const orgManager = new OrgManager();
      const orgRegistry = new OrgRegistry(configStore, secretVault, orgManager);
      configStore.set(`org.${FORMER_ORG_ID}`, REGISTERED, 'orgs');
      orgRegistry.loadAll();
      const detector = new SandboxRefreshDetector({ configStore, orgManager });
      Object.assign(deps, {
        configStore,
        secretVault,
        orgManager,
        orgRegistry,
        sandboxRefreshes: detector,
      });
      return { configStore, orgManager, detector, storeObject };
    }

    /** Import from a CLI that lists `orgs`, through the path `authMethod` names. */
    async function importing(
      authMethod: 'sfdx_import' | 'oauth_web',
      ...orgs: Array<ReturnType<typeof listed>>
    ): Promise<void> {
      deps.sfdxBridge = {
        isCliAvailable: vi.fn().mockResolvedValue(true),
        loginWeb: vi.fn().mockResolvedValue(undefined),
        listOrgs: vi.fn().mockResolvedValue(orgs),
      } as unknown as HandlerDeps['sfdxBridge'];
      await handler.handle(createMsg('org:connect', { orgId: '', authMethod }));
    }

    /** The org id the connect request was acknowledged with. */
    function acknowledged(): unknown {
      return (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls
        .map(([m]) => m as BaseMessage & { payload: Record<string, unknown> })
        .find((m) => m.type === 'org:statusChanged')?.payload.orgId;
    }

    it.each(['sfdx_import', 'oauth_web'] as const)(
      'updates, through %s, the entry the detector saw refreshed into the org imported',
      async (authMethod) => {
        const { configStore, orgManager, detector, storeObject } = harness();
        // The entry reached the new org through the CLI, and said so.
        detector.observe(FORMER_ORG_ID, { organizationId: REFRESHED_ORG_ID }, 'connection');

        await importing(authMethod, listed());

        const orgs = orgManager.getAllOrgs();
        expect(orgs).toHaveLength(1);
        expect(orgs[0]).toMatchObject({
          id: FORMER_ORG_ID,
          orgId: REFRESHED_ORG_ID,
          alias: 'UAT',
          appearance: expect.objectContaining({ color: '#F59E0B' }),
          tags: ['uat'],
        });
        expect(configStore.get(`org.${REFRESHED_ORG_ID}`)).toBeUndefined();
        expect(storeObject).toHaveBeenCalledWith(
          `org-cred.${FORMER_ORG_ID}`,
          expect.objectContaining({ accessToken: 'token-of-the-new-org' }),
        );
        // What is kept under the entry's id stays with it.
        expect(detector.refreshesOf(FORMER_ORG_ID)).toHaveLength(1);
        expect(acknowledged()).toBe(FORMER_ORG_ID);

        const reloaded = new OrgManager();
        new OrgRegistry(configStore, {} as HandlerDeps['secretVault'], reloaded).loadAll();
        expect(reloaded.getAllOrgs().map((o) => o.id)).toEqual([FORMER_ORG_ID]);
      },
    );

    it('updates, through a JWT sign-in, the entry the detector saw refreshed into the org signed into', async () => {
      const { orgManager, detector } = harness();
      detector.observe(FORMER_ORG_ID, { organizationId: REFRESHED_ORG_ID }, 'connection');
      const imported = listed();
      deps.sfdxBridge = {
        isCliAvailable: vi.fn().mockResolvedValue(true),
        loginJwt: vi.fn().mockResolvedValue({ username: USERNAME }),
        findOrg: vi.fn().mockResolvedValue(imported),
      } as unknown as HandlerDeps['sfdxBridge'];

      await handler.handle(
        createMsg('org:connect', {
          orgId: '',
          authMethod: 'jwt',
          alias: 'uat',
          loginUrl: 'https://test.salesforce.com',
          username: USERNAME,
          clientId: '3MVG9FakeConsumerKey.ForTests_Only',
          jwtKeyFile: '/tmp/keys/server.key',
        }),
      );

      expect(orgManager.getAllOrgs().map((o) => o.id)).toEqual([FORMER_ORG_ID]);
      expect(orgManager.getOrg(FORMER_ORG_ID)).toMatchObject({
        orgId: REFRESHED_ORG_ID,
        alias: 'UAT',
      });
      expect(acknowledged()).toBe(FORMER_ORG_ID);
    });

    it('adds the import as it comes when no refresh into its org is on record', async () => {
      const { orgManager } = harness();

      await importing('sfdx_import', listed());

      expect(
        orgManager
          .getAllOrgs()
          .map((o) => o.id)
          .sort(),
      ).toEqual([FORMER_ORG_ID, REFRESHED_ORG_ID].sort());
      expect(orgManager.getOrg(FORMER_ORG_ID)?.orgId).toBe(FORMER_ORG_ID);
      expect(acknowledged()).toBe(REFRESHED_ORG_ID);
    });

    it('does not take the entry for the import when it was refreshed into another org', async () => {
      const { orgManager, detector } = harness();
      detector.observe(FORMER_ORG_ID, { organizationId: '00Dxx00000ZzZzZ7F6' }, 'connection');

      await importing('sfdx_import', listed());

      expect(orgManager.getAllOrgs()).toHaveLength(2);
      expect(orgManager.getOrg(FORMER_ORG_ID)?.alias).toBe('UAT');
    });

    it('does not take the entry for an org imported under another username', async () => {
      const { orgManager, detector } = harness();
      detector.observe(FORMER_ORG_ID, { organizationId: REFRESHED_ORG_ID }, 'connection');

      await importing('sfdx_import', listed(REFRESHED_ORG_ID, 'someone.else@acme.test.uat'));

      expect(orgManager.getAllOrgs()).toHaveLength(2);
      expect(orgManager.getOrg(FORMER_ORG_ID)?.username).toBe(USERNAME);
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
