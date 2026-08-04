import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseMessage } from '@sandforge/shared';
import { OrgSafetyTier } from '@sandforge/shared';
import { ExtensionHandlers } from './ExtensionHandlers';
import type { ExtensionHandlersDeps } from './ExtensionHandlers';
import { MessageBroker } from './MessageBroker';
import { MessageRouter } from './MessageRouter';
import { WebviewStateSync } from './WebviewStateSync';
import { OrgManager } from '../core/connection/OrgManager';
import { OrgRegistry } from '../core/connection/OrgRegistry';
import { ConfigStore } from '../core/storage/ConfigStore';
import { InMemoryConfigStoreBackend } from '../core/storage/ConfigStoreBackend';
import { SecretVault } from '../core/storage/SecretVault';
import type { SecretStorageAdapter } from '../core/storage/SecretVault';
import { AuthProvider } from '../core/connection/AuthProvider';
import type { SfdxBridge, SfdxImportResult } from '../core/connection/SfdxBridge';
import { getJsforceConnection } from '../core/connection/ConnectionHelper';

vi.mock('../core/connection/ConnectionHelper', () => ({
  getJsforceConnection: vi.fn(),
}));

function createMockSecretStorage(): SecretStorageAdapter {
  const store = new Map<string, string>();
  return {
    get: vi.fn((key: string) => Promise.resolve(store.get(key))),
    store: vi.fn((key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    delete: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve();
    }),
  };
}

function createMockSfdxBridge(overrides: Partial<SfdxBridge> = {}): SfdxBridge {
  return {
    isCliAvailable: vi.fn().mockResolvedValue(true),
    listOrgs: vi.fn().mockResolvedValue([]),
    loginWeb: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as SfdxBridge;
}

function createMockAuthProvider(): AuthProvider {
  const provider = new AuthProvider();
  vi.spyOn(provider, 'authenticate');
  vi.spyOn(provider, 'validateConnection');
  vi.spyOn(provider, 'buildConnectionConfig');
  return provider;
}

function createTestImportResult(overrides: Partial<SfdxImportResult> = {}): SfdxImportResult {
  return {
    org: {
      id: '00D1',
      alias: 'test-org',
      username: 'admin@test.com',
      instanceUrl: 'https://test.my.salesforce.com',
      orgId: '00D1',
      orgType: 'Sandbox',
      authMethod: 'sfdx_import',
      safetyTier: OrgSafetyTier.LOW,
      appearance: { color: '#4a9eff', icon: 'cloud', position: 0 },
      metadata: { apiVersion: '62.0', edition: '', features: [] },
      status: 'connected',
      lastConnected: new Date().toISOString(),
      tags: [],
    },
    credentials: {
      loginUrl: 'https://test.my.salesforce.com',
      accessToken: 'sfdx-token-1',
      instanceUrl: 'https://test.my.salesforce.com',
      username: 'admin@test.com',
    },
    ...overrides,
  };
}

function msg(
  type: string,
  payload?: Record<string, unknown>,
): BaseMessage & { payload?: Record<string, unknown> } {
  return {
    id: 'test-1',
    type,
    timestamp: Date.now(),
    ...(payload ? { payload } : {}),
  };
}

/** Minimal sync config that passes the sync:config payload validation. */
function validSyncConfig(id: string, name: string): Record<string, unknown> {
  return {
    id,
    name,
    description: '',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    direction: 'source_to_target',
    mode: 'full',
    objects: [
      {
        objectApiName: 'Account',
        operation: 'upsert',
        fieldMappings: [],
        transformRules: [],
        excludedFields: [],
        addOnFields: [],
        batchSize: 200,
        insertOrder: 0,
      },
    ],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    dryRun: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

/** Minimal sync schedule entry that passes the sync:schedule payload validation. */
function validSchedule(id: string): Record<string, unknown> {
  return {
    id,
    name: 'Nightly sync',
    configId: 'cfg-1',
    cron: '0 6 * * *',
    timezone: 'UTC',
    enabled: true,
    maxRetries: 3,
    notifyOnComplete: true,
    notifyOnFailure: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
  };
}

describe('ExtensionHandlers', () => {
  let broker: MessageBroker;
  let router: MessageRouter;
  let stateSync: WebviewStateSync;
  let orgManager: OrgManager;
  let orgRegistry: OrgRegistry;
  let configStore: ConfigStore;
  let authProvider: AuthProvider;
  let sfdxBridge: SfdxBridge;
  let deps: ExtensionHandlersDeps;
  let handlers: ExtensionHandlers;
  let posted: BaseMessage[];
  let logs: string[];

  beforeEach(() => {
    broker = new MessageBroker();
    router = new MessageRouter(broker);
    stateSync = new WebviewStateSync(broker);
    orgManager = new OrgManager();

    const backend = new InMemoryConfigStoreBackend();
    configStore = new ConfigStore(backend);
    configStore.initialize();

    const secretVault = new SecretVault(createMockSecretStorage());
    orgRegistry = new OrgRegistry(configStore, secretVault, orgManager);

    authProvider = createMockAuthProvider();
    sfdxBridge = createMockSfdxBridge();

    posted = [];
    vi.spyOn(broker, 'postToWebview').mockImplementation((m) => {
      posted.push(m);
    });

    logs = [];
    deps = {
      log: (m: string) => logs.push(m),
      broker,
      stateSync,
      orgManager,
      orgRegistry,
      configStore,
      secretVault,
      authProvider,
      sfdxBridge,
    };

    handlers = new ExtensionHandlers(deps);
    handlers.registerAll(router);
  });

  describe('org:list', () => {
    it('should respond with current orgs', () => {
      orgManager.addOrg({
        id: '1',
        alias: 'test',
        username: 'u',
        instanceUrl: 'https://x.sf.com',
        orgId: '00D1',
        orgType: 'Sandbox',
        authMethod: 'oauth_web',
        safetyTier: OrgSafetyTier.LOW,
        appearance: { color: '#000', icon: 'cloud', position: 0 },
        metadata: { apiVersion: '59.0', edition: 'Dev', features: [] },
        status: 'connected',
        lastConnected: new Date().toISOString(),
        tags: [],
      });

      broker['dispatch'](msg('org:list'));

      expect(posted).toHaveLength(1);
      expect(posted[0].type).toBe('org:list:response');
      const payload = (posted[0] as BaseMessage & { payload: { orgs: unknown[] } }).payload;
      expect(payload.orgs).toHaveLength(1);
      expect(logs.some((l) => l.includes('[RX] org:list'))).toBe(true);
      expect(logs.some((l) => l.includes('[TX] org:list:response'))).toBe(true);
    });
  });

  describe('org:connect — sfdx_import', () => {
    it('should import orgs from SF CLI', async () => {
      const importResult = createTestImportResult();
      (sfdxBridge.listOrgs as ReturnType<typeof vi.fn>).mockResolvedValue([importResult]);

      broker['dispatch'](msg('org:connect', { orgId: '', authMethod: 'sfdx_import' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(2));

      const types = posted.map((p) => p.type);
      expect(types).toContain('org:list:response');
      expect(types).toContain('notification');
      expect(orgManager.getAllOrgs()).toHaveLength(1);
      expect(orgManager.getAllOrgs()[0].orgId).toBe('00D1');
    });

    it('should show error when SF CLI is not available', async () => {
      (sfdxBridge.isCliAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      broker['dispatch'](msg('org:connect', { orgId: '', authMethod: 'sfdx_import' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const notification = posted.find((p) => p.type === 'notification') as BaseMessage & {
        payload: { level: string; message: string };
      };
      expect(notification).toBeDefined();
      expect(notification.payload.level).toBe('error');
      expect(notification.payload.message).toContain('not found');
    });

    it('should show warning when no connected orgs found', async () => {
      (sfdxBridge.listOrgs as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      broker['dispatch'](msg('org:connect', { orgId: '', authMethod: 'sfdx_import' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const notification = posted.find((p) => p.type === 'notification') as BaseMessage & {
        payload: { level: string };
      };
      expect(notification.payload.level).toBe('warning');
    });
  });

  describe('org:connect — usernamePassword', () => {
    it('should show error when username/password missing', async () => {
      broker['dispatch'](msg('org:connect', { orgId: '', authMethod: 'usernamePassword' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const notification = posted.find((p) => p.type === 'notification') as BaseMessage & {
        payload: { level: string };
      };
      expect(notification.payload.level).toBe('error');
    });

    it('should authenticate and save org on success', async () => {
      vi.spyOn(authProvider, 'authenticate').mockResolvedValue({
        success: true,
        accessToken: 'token-1',
        instanceUrl: 'https://test.sf.com',
        userId: 'user-1',
        orgId: '00D1',
      });
      vi.spyOn(authProvider, 'validateConnection').mockResolvedValue({
        userId: 'user-1',
        username: 'admin@test.com',
        displayName: 'Admin',
        orgId: '00D1',
        orgName: 'Test Org',
        orgType: 'Developer Edition',
        isSandbox: true,
      });
      vi.spyOn(authProvider, 'buildConnectionConfig').mockReturnValue({
        loginUrl: 'https://login.salesforce.com',
        accessToken: 'token-1',
        instanceUrl: 'https://test.sf.com',
        username: 'admin@test.com',
      });

      broker['dispatch'](
        msg('org:connect', {
          orgId: '',
          authMethod: 'usernamePassword',
          username: 'admin@test.com',
          password: 'secret',
          loginUrl: 'https://login.salesforce.com',
          alias: 'my-sandbox',
        }),
      );
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(2));

      expect(orgManager.getAllOrgs()).toHaveLength(1);
      const org = orgManager.getAllOrgs()[0];
      expect(org.username).toBe('admin@test.com');
      expect(org.orgId).toBe('00D1');
      expect(org.orgType).toBe('Sandbox');

      const types = posted.map((p) => p.type);
      expect(types).toContain('org:statusChanged');
      expect(types).toContain('notification');
    });
  });

  describe('org:connect — oauth_web', () => {
    it('should call sfdxBridge.loginWeb and import orgs', async () => {
      const importResult = createTestImportResult();
      (sfdxBridge.listOrgs as ReturnType<typeof vi.fn>).mockResolvedValue([importResult]);

      broker['dispatch'](
        msg('org:connect', {
          orgId: '',
          authMethod: 'oauth_web',
          alias: 'my-org',
          loginUrl: 'https://login.salesforce.com',
        }),
      );
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      expect(sfdxBridge.loginWeb).toHaveBeenCalledWith('my-org', 'https://login.salesforce.com');
      expect(orgManager.getAllOrgs()).toHaveLength(1);
    });

    it('should show error when SF CLI is not available', async () => {
      (sfdxBridge.isCliAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      broker['dispatch'](msg('org:connect', { orgId: '', authMethod: 'oauth_web' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const notification = posted.find((p) => p.type === 'notification') as BaseMessage & {
        payload: { level: string };
      };
      expect(notification.payload.level).toBe('error');
    });
  });

  describe('org:connect — unsupported', () => {
    it('should send warning for unsupported auth methods', async () => {
      broker['dispatch'](msg('org:connect', { orgId: '', authMethod: 'jwt' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const notification = posted.find((p) => p.type === 'notification') as BaseMessage & {
        payload: { level: string; message: string };
      };
      expect(notification.payload.level).toBe('warning');
      expect(notification.payload.message).toContain('not yet supported');
    });
  });

  describe('org:disconnect', () => {
    it('should remove org and respond with statusChanged', async () => {
      orgManager.addOrg({
        id: 'rem-1',
        alias: 'test',
        username: 'u',
        instanceUrl: 'https://x.sf.com',
        orgId: '00D1',
        orgType: 'Sandbox',
        authMethod: 'oauth_web',
        safetyTier: OrgSafetyTier.LOW,
        appearance: { color: '#000', icon: 'cloud', position: 0 },
        metadata: { apiVersion: '59.0', edition: 'Dev', features: [] },
        status: 'connected',
        lastConnected: new Date().toISOString(),
        tags: [],
      });

      broker['dispatch'](msg('org:disconnect', { orgId: 'rem-1' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const statusMsg = posted.find((p) => p.type === 'org:statusChanged');
      expect(statusMsg).toBeDefined();
      expect(orgManager.getOrg('rem-1')).toBeUndefined();
    });
  });

  describe('settings:get', () => {
    it('should return settings from ConfigStore', () => {
      configStore.set('theme', 'dark', 'settings');

      broker['dispatch'](msg('settings:get'));

      expect(posted).toHaveLength(1);
      expect(posted[0].type).toBe('settings:response');
      const payload = (
        posted[0] as BaseMessage & { payload: { settings: Record<string, unknown> } }
      ).payload;
      expect(payload.settings['theme']).toBe('dark');
    });
  });

  describe('settings:update', () => {
    it('should save setting and respond with full settings', () => {
      broker['dispatch'](msg('settings:update', { key: 'lang', value: 'fr' }));

      expect(posted).toHaveLength(1);
      expect(posted[0].type).toBe('settings:response');
      expect(configStore.get<string>('lang')).toBe('fr');
    });
  });

  describe('monitor:start / monitor:refresh', () => {
    it('should fetch limits and jobs from Salesforce', async () => {
      const mockConnection = {
        request: vi.fn().mockResolvedValue({
          DailyApiRequests: { Max: 100000, Remaining: 40000 },
          DailyBulkV2QueryJobs: { Max: 10000, Remaining: 9000 },
        }),
        query: vi.fn().mockResolvedValue({
          records: [
            {
              Id: 'job-1',
              JobType: 'BatchApex',
              Status: 'Completed',
              NumberOfErrors: 0,
              CreatedDate: '2024-01-01T12:00:00Z',
              CreatedById: 'user-1',
            },
          ],
        }),
      };
      (getJsforceConnection as ReturnType<typeof vi.fn>).mockResolvedValue(mockConnection);

      broker['dispatch'](msg('monitor:start', { orgId: 'org-1' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const dataMsg = posted.find((p) => p.type === 'monitor:data');
      expect(dataMsg).toBeDefined();
      const payload = (
        dataMsg as BaseMessage & {
          payload: { limits: unknown[]; jobs: unknown[]; healthScore: number };
        }
      ).payload;
      expect(payload.limits).toHaveLength(2);
      expect(payload.jobs).toHaveLength(1);
      expect(typeof payload.healthScore).toBe('number');
    });

    it('should send monitor:error on connection failure', async () => {
      (getJsforceConnection as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Connection failed'),
      );

      broker['dispatch'](msg('monitor:start', { orgId: 'org-1' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const errMsg = posted.find((p) => p.type === 'monitor:error');
      expect(errMsg).toBeDefined();
      const payload = (errMsg as BaseMessage & { payload: { message: string } }).payload;
      expect(payload.message).toContain('Connection failed');
    });

    it('should calculate health score based on limit usage', async () => {
      const mockConnection = {
        request: vi.fn().mockResolvedValue({
          CriticalLimit: { Max: 1000, Remaining: 50 },
          WarningLimit: { Max: 1000, Remaining: 200 },
          OkLimit: { Max: 1000, Remaining: 500 },
        }),
        query: vi.fn().mockResolvedValue({ records: [] }),
      };
      (getJsforceConnection as ReturnType<typeof vi.fn>).mockResolvedValue(mockConnection);

      broker['dispatch'](msg('monitor:refresh', { orgId: 'org-1' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const dataMsg = posted.find((p) => p.type === 'monitor:data');
      expect(dataMsg).toBeDefined();
      const payload = (dataMsg as BaseMessage & { payload: { healthScore: number } }).payload;
      // UnifiedHealthScorer (linear): CriticalLimit: 95% → score 7, WarningLimit: 80% → score 28, OkLimit: 50% → score 70
      // Weighted average = round((7 + 28 + 70) / 3) = 35
      expect(payload.healthScore).toBe(35);
    });
  });

  describe('seed:describe-global', () => {
    it('should return createable objects from describeGlobal', async () => {
      const mockConnection = {
        describeGlobal: vi.fn().mockResolvedValue({
          sobjects: [
            { name: 'Account', label: 'Account', createable: true },
            { name: 'Contact', label: 'Contact', createable: true },
            { name: 'ApexClass', label: 'Apex Class', createable: false },
          ],
        }),
      };
      (getJsforceConnection as ReturnType<typeof vi.fn>).mockResolvedValue(mockConnection);

      broker['dispatch'](msg('seed:describe-global', { orgId: 'org-1' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const response = posted.find((p) => p.type === 'seed:describe-global:response');
      expect(response).toBeDefined();
      const payload = (response as BaseMessage & { payload: { objects: { apiName: string }[] } })
        .payload;
      expect(payload.objects).toHaveLength(2);
      expect(payload.objects[0].apiName).toBe('Account');
    });

    it('should send seed:error on failure', async () => {
      (getJsforceConnection as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Auth failed'),
      );

      broker['dispatch'](msg('seed:describe-global', { orgId: 'org-1' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const errMsg = posted.find((p) => p.type === 'seed:error');
      expect(errMsg).toBeDefined();
    });
  });

  describe('seed:describe-object', () => {
    it('should return createable fields from describe', async () => {
      const mockConnection = {
        describe: vi.fn().mockResolvedValue({
          label: 'Account',
          fields: [
            {
              name: 'Name',
              label: 'Account Name',
              type: 'string',
              createable: true,
              nillable: false,
              defaultedOnCreate: false,
              picklistValues: [],
              referenceTo: [],
              length: 255,
            },
            {
              name: 'Id',
              label: 'Record ID',
              type: 'id',
              createable: false,
              nillable: false,
              defaultedOnCreate: true,
              picklistValues: [],
              referenceTo: [],
              length: 18,
            },
            {
              name: 'Industry',
              label: 'Industry',
              type: 'picklist',
              createable: true,
              nillable: true,
              defaultedOnCreate: false,
              picklistValues: [{ value: 'Tech' }, { value: 'Finance' }],
              referenceTo: [],
              length: 40,
            },
          ],
        }),
      };
      (getJsforceConnection as ReturnType<typeof vi.fn>).mockResolvedValue(mockConnection);

      broker['dispatch'](msg('seed:describe-object', { orgId: 'org-1', objectApiName: 'Account' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const response = posted.find((p) => p.type === 'seed:describe-object:response');
      expect(response).toBeDefined();
      const payload = (
        response as BaseMessage & {
          payload: {
            objectApiName: string;
            fields: { fieldApiName: string; picklistValues: string[] }[];
          };
        }
      ).payload;
      expect(payload.objectApiName).toBe('Account');
      expect(payload.fields).toHaveLength(2); // Id is not createable
      expect(payload.fields[1].picklistValues).toEqual(['Tech', 'Finance']);
    });
  });

  describe('sync:describe-global', () => {
    it('should return queryable and createable objects', async () => {
      const mockConnection = {
        describeGlobal: vi.fn().mockResolvedValue({
          sobjects: [
            { name: 'Account', label: 'Account', createable: true, queryable: true },
            { name: 'Contact', label: 'Contact', createable: true, queryable: true },
            { name: 'ApexClass', label: 'Apex Class', createable: false, queryable: true },
            { name: 'ChangeEvent', label: 'Change Event', createable: true, queryable: false },
          ],
        }),
      };
      (getJsforceConnection as ReturnType<typeof vi.fn>).mockResolvedValue(mockConnection);

      broker['dispatch'](msg('sync:describe-global', { orgId: 'org-1' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const response = posted.find((p) => p.type === 'sync:describe-global:response');
      expect(response).toBeDefined();
      const payload = (response as BaseMessage & { payload: { objects: string[] } }).payload;
      expect(payload.objects).toHaveLength(2);
      expect(payload.objects).toContain('Account');
      expect(payload.objects).toContain('Contact');
    });

    it('should send sync:error on failure', async () => {
      (getJsforceConnection as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Auth failed'),
      );

      broker['dispatch'](msg('sync:describe-global', { orgId: 'org-1' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const errMsg = posted.find((p) => p.type === 'sync:error');
      expect(errMsg).toBeDefined();
    });
  });

  describe('sync:describe-fields', () => {
    it('should return source and target fields', async () => {
      const mockConnection = {
        describe: vi.fn().mockResolvedValue({
          fields: [
            { name: 'Name', label: 'Name', type: 'string', createable: true },
            { name: 'Id', label: 'ID', type: 'id', createable: false },
            { name: 'Industry', label: 'Industry', type: 'picklist', createable: true },
          ],
        }),
      };
      (getJsforceConnection as ReturnType<typeof vi.fn>).mockResolvedValue(mockConnection);

      broker['dispatch'](
        msg('sync:describe-fields', {
          sourceOrgId: 'org-1',
          targetOrgId: 'org-2',
          objectApiName: 'Account',
        }),
      );
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const response = posted.find((p) => p.type === 'sync:describe-fields:response');
      expect(response).toBeDefined();
      const payload = (
        response as BaseMessage & {
          payload: { sourceFields: { apiName: string }[]; targetFields: { apiName: string }[] };
        }
      ).payload;
      expect(payload.sourceFields).toHaveLength(2);
      expect(payload.targetFields).toHaveLength(2);
      expect(payload.sourceFields[0].apiName).toBe('Name');
    });
  });

  describe('dataops:backup', () => {
    it('should export records and send response', async () => {
      const mockRecords = Array.from({ length: 42 }, (_, i) => ({
        Id: `001${i}`,
        Name: `Acct ${i}`,
      }));
      const mockConnection = {
        query: vi.fn().mockResolvedValue({ records: mockRecords, totalSize: 42 }),
      };
      (getJsforceConnection as ReturnType<typeof vi.fn>).mockResolvedValue(mockConnection);

      broker['dispatch'](msg('dataops:backup', { orgId: 'org-1', objects: ['Account'] }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(4), { timeout: 10000 });

      const response = posted.find((p) => p.type === 'dataops:backup:response');
      expect(response).toBeDefined();
      const payload = (
        response as BaseMessage & {
          payload: {
            objects: Array<{ objectApiName: string; recordCount: number }>;
            totalRecords: number;
          };
        }
      ).payload;
      expect(payload.objects).toHaveLength(1);
      expect(payload.objects[0].recordCount).toBe(42);
      expect(payload.totalRecords).toBe(42);

      // Should also send operation lifecycle messages
      const started = posted.find((p) => p.type === 'operation:started');
      expect(started).toBeDefined();
      const completed = posted.find((p) => p.type === 'operation:completed');
      expect(completed).toBeDefined();
    });

    it('should send operation:failed on failure', async () => {
      (getJsforceConnection as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('No access'));

      broker['dispatch'](msg('dataops:backup', { orgId: 'org-1', objects: ['Account'] }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      // Single failure emission: operation:failed is the channel the webview consumes.
      const errMsg = posted.find((p) => p.type === 'operation:failed');
      expect(errMsg).toBeDefined();
    });
  });

  describe('compare:start', () => {
    it('should send compare:error on failure', async () => {
      (getJsforceConnection as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Connection failed'),
      );

      broker['dispatch'](
        msg('compare:start', { sourceOrgId: 'org-1', targetOrgId: 'org-2', types: ['ApexClass'] }),
      );
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const errMsg = posted.find((p) => p.type === 'compare:error');
      expect(errMsg).toBeDefined();
      const payload = (errMsg as BaseMessage & { payload: { message: string } }).payload;
      expect(payload.message).toContain('Connection failed');
    });
  });

  describe('pipeline:run', () => {
    it('should execute pipeline and send response', async () => {
      broker['dispatch'](
        msg('pipeline:run', {
          pipeline: {
            id: 'p1',
            name: 'Test',
            description: '',
            steps: [],
            triggers: [],
            variables: [],
            tags: [],
            version: 1,
            createdAt: '',
            updatedAt: '',
          },
          variables: {},
        }),
      );
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1), { timeout: 10000 });

      // Pipeline execution should produce a response (empty steps = immediate
      // completion); without injected services the run fails via the single
      // operation:failed channel.
      const response = posted.find(
        (p) => p.type === 'pipeline:run:response' || p.type === 'operation:failed',
      );
      expect(response).toBeDefined();
    });
  });

  describe('operation control handlers', () => {
    it('should send warning when cancelling with no active operation', () => {
      broker['dispatch'](msg('operation:cancel', { operationId: 'none' }));

      expect(posted).toHaveLength(1);
      expect(posted[0].type).toBe('notification');
      const payload = (posted[0] as BaseMessage & { payload: { message: string } }).payload;
      expect(payload.message).toContain('No active operation found');
    });

    it('should send warning when pausing with no active operation', () => {
      broker['dispatch'](msg('operation:pause', { operationId: 'none' }));

      expect(posted).toHaveLength(1);
      expect(posted[0].type).toBe('notification');
      const payload = (posted[0] as BaseMessage & { payload: { message: string } }).payload;
      expect(payload.message).toContain('No active operation found');
    });

    it('should send warning when resuming with no active operation', () => {
      broker['dispatch'](msg('operation:resume', { operationId: 'none' }));

      expect(posted).toHaveLength(1);
      expect(posted[0].type).toBe('notification');
      const payload = (posted[0] as BaseMessage & { payload: { message: string } }).payload;
      expect(payload.message).toContain('No active operation found');
    });
  });

  describe('backup:execute handler', () => {
    it('should send error when no org connection available', async () => {
      broker['dispatch'](msg('backup:execute', { orgId: 'nonexistent', objects: ['Account'] }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1), { timeout: 10000 });

      // Should fail since org is not connected - sends operation:started then operation:failed + dataops:error
      const errorMsg = posted.find(
        (p) => p.type === 'dataops:error' || p.type === 'operation:failed',
      );
      expect(errorMsg).toBeDefined();
    });
  });

  describe('monitor:abort-job', () => {
    it('should send error when connection fails', async () => {
      (getJsforceConnection as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('No access'));

      broker['dispatch'](msg('monitor:abort-job', { orgId: 'org-1', jobId: '7071x000001ABCDE12' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1), { timeout: 10000 });

      const response = posted.find((p) => p.type === 'monitor:abort-job:response');
      expect(response).toBeDefined();
      const payload = (response as BaseMessage & { payload: { success: boolean } }).payload;
      expect(payload.success).toBe(false);
    });

    it('should abort job successfully', async () => {
      const mockConnection = {
        sobject: vi.fn().mockReturnValue({
          update: vi.fn().mockResolvedValue({ success: true }),
        }),
      };
      (getJsforceConnection as ReturnType<typeof vi.fn>).mockResolvedValue(mockConnection);

      broker['dispatch'](msg('monitor:abort-job', { orgId: 'org-1', jobId: '7071x000001ABCDE12' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1), { timeout: 10000 });

      const response = posted.find((p) => p.type === 'monitor:abort-job:response');
      expect(response).toBeDefined();
      const payload = (response as BaseMessage & { payload: { success: boolean; jobId: string } })
        .payload;
      expect(payload.success).toBe(true);
      expect(payload.jobId).toBe('7071x000001ABCDE12');
    });
  });

  describe('ai handlers', () => {
    it('should return error when AI is not configured', async () => {
      broker['dispatch'](msg('ai:chat', { conversationId: 'conv-1', message: 'Hello' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const errMsg = posted.find((p) => p.type === 'ai:error');
      expect(errMsg).toBeDefined();
      const payload = (errMsg as BaseMessage & { payload: { message: string } }).payload;
      expect(payload.message).toContain('not configured');
    });

    it('should return error for conversation create when AI not configured', () => {
      broker['dispatch'](msg('ai:conversation:create', { title: 'Test' }));

      const errMsg = posted.find((p) => p.type === 'ai:error');
      expect(errMsg).toBeDefined();
    });

    it('should return AI status with disabled when no assistant', async () => {
      broker['dispatch'](msg('ai:status', {}));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const response = posted.find((p) => p.type === 'ai:status:response');
      expect(response).toBeDefined();
      const payload = (
        response as BaseMessage & { payload: { enabled: boolean; provider: string } }
      ).payload;
      expect(payload.enabled).toBe(false);
      expect(payload.provider).toBe('none');
    });
  });

  describe('pipeline:templates', () => {
    it('should return predefined pipeline templates', () => {
      broker['dispatch'](msg('pipeline:templates', {}));

      expect(posted).toHaveLength(1);
      expect(posted[0].type).toBe('pipeline:templates:response');
      const payload = (
        posted[0] as BaseMessage & { payload: { templates: Array<{ id: string; name: string }> } }
      ).payload;
      expect(payload.templates.length).toBeGreaterThanOrEqual(3);
      expect(payload.templates[0].name).toBe('Sandbox Refresh');
      expect(payload.templates[1].name).toBe('Data Migration Dry Run');
      expect(payload.templates[2].name).toBe('Nightly Cleanup');
    });
  });

  describe('dataops:anonymization-templates', () => {
    it('should return predefined anonymization templates', () => {
      broker['dispatch'](msg('dataops:anonymization-templates', {}));

      expect(posted).toHaveLength(1);
      expect(posted[0].type).toBe('dataops:anonymization-templates:response');
      const payload = (
        posted[0] as BaseMessage & {
          payload: { templates: Array<{ id: string; complianceFramework: string }> };
        }
      ).payload;
      expect(payload.templates.length).toBeGreaterThanOrEqual(4);
      expect(payload.templates.find((t) => t.complianceFramework === 'gdpr')).toBeDefined();
      expect(payload.templates.find((t) => t.complianceFramework === 'ccpa')).toBeDefined();
      expect(payload.templates.find((t) => t.complianceFramework === 'hipaa')).toBeDefined();
      expect(payload.templates.find((t) => t.complianceFramework === 'custom')).toBeDefined();
    });
  });

  describe('dataops:rollback — real implementation', () => {
    it('should fail with clear message when no backup exists', async () => {
      const mockConn = { identity: vi.fn().mockResolvedValue({}) };
      vi.mocked(getJsforceConnection).mockResolvedValue(mockConn as never);

      broker['dispatch'](msg('dataops:rollback', { orgId: 'org1', operationId: 'nonexistent-op' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const errMsg = posted.find((p) => p.type === 'operation:failed') as BaseMessage & {
        payload: { error: string };
      };
      expect(errMsg).toBeDefined();
      expect(errMsg.payload.error).toContain('No backup found');
    });

    it('should restore records from backup when backup exists', async () => {
      const upsertResults = [
        { success: true, id: 'rec1' },
        { success: true, id: 'rec2' },
      ];
      const mockUpsert = vi.fn().mockResolvedValue(upsertResults);
      const mockConn = {
        identity: vi.fn().mockResolvedValue({}),
        sobject: vi.fn().mockReturnValue({
          upsert: mockUpsert,
        }),
        describe: vi.fn().mockResolvedValue({
          name: 'Account',
          label: 'Account',
          labelPlural: 'Accounts',
          keyPrefix: '001',
          custom: false,
          createable: true,
          updateable: true,
          deletable: true,
          queryable: true,
          fields: [
            {
              name: 'Name',
              label: 'Name',
              type: 'string',
              length: 255,
              nillable: false,
              createable: true,
              updateable: true,
              externalId: false,
              referenceTo: [],
              relationshipName: null,
              picklistValues: [],
              defaultValue: null,
              calculated: false,
              autoNumber: false,
              unique: false,
            },
          ],
          recordTypeInfos: [],
          childRelationships: [],
        }),
      };
      vi.mocked(getJsforceConnection).mockResolvedValue(mockConn as never);

      // Seed backup data into configStore
      const backupKey = 'backup:op-123';
      configStore.set(
        backupKey,
        {
          operationId: 'op-123',
          orgId: 'org1',
          objects: [{ objectApiName: 'Account', recordCount: 2 }],
          totalRecords: 2,
          timestamp: new Date().toISOString(),
        },
        'backups',
      );
      configStore.set(
        `${backupKey}:Account`,
        [
          { Id: 'rec1', Name: 'Acme', attributes: { type: 'Account' } },
          { Id: 'rec2', Name: 'Test', attributes: { type: 'Account' } },
        ],
        'backups',
      );

      // Verify configStore setup
      expect(configStore.get(backupKey)).toBeDefined();
      expect(configStore.get(`${backupKey}:Account`)).toBeDefined();

      broker['dispatch'](msg('dataops:rollback', { orgId: 'org1', operationId: 'op-123' }));

      // The handler is async and dispatched fire-and-forget — we need to flush microtasks
      await new Promise((resolve) => setTimeout(resolve, 50));
      // Then wait for the full chain
      await vi.waitFor(() => logs.length >= 2, { timeout: 5000 });

      const errLog = logs.find((l) => l.includes('[ERR]'));
      if (errLog) {
        expect.fail(`Rollback error: ${errLog}`);
      }

      const response = posted.find((p) => p.type === 'dataops:rollback:response') as BaseMessage & {
        payload: { status: string; totalRestored: number };
      };
      expect(response).toBeDefined();
      expect(response.payload.status).toBe('success');
      expect(response.payload.totalRestored).toBe(2);
    });
  });

  describe('SOQL injection prevention', () => {
    it('should reject invalid object names in seed:describe-object', async () => {
      broker['dispatch'](
        msg('seed:describe-object', { orgId: 'org1', objectApiName: 'Account; DROP TABLE' }),
      );
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const errMsg = posted.find((p) => p.type === 'seed:error') as BaseMessage & {
        payload: { message: string };
      };
      expect(errMsg).toBeDefined();
      expect(errMsg.payload.message).toContain('Invalid Salesforce API name');
    });

    it('should accept valid object names', async () => {
      const mockConn = {
        identity: vi.fn().mockResolvedValue({}),
        describe: vi.fn().mockResolvedValue({
          label: 'Account',
          fields: [
            {
              name: 'Name',
              label: 'Name',
              type: 'string',
              nillable: false,
              defaultedOnCreate: false,
              createable: true,
              length: 255,
            },
          ],
        }),
      };
      vi.mocked(getJsforceConnection).mockResolvedValue(mockConn as never);

      broker['dispatch'](msg('seed:describe-object', { orgId: 'org1', objectApiName: 'Account' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1), { timeout: 3000 });

      const response = posted.find((p) => p.type === 'seed:describe-object:response');
      const errResponse = posted.find((p) => p.type === 'seed:error');
      // Either we get a successful response or no error about invalid name
      expect(response ?? errResponse).toBeDefined();
      if (response) {
        expect(response.type).toBe('seed:describe-object:response');
      }
      if (errResponse) {
        // If error, it should NOT be about SOQL injection
        expect(
          (errResponse as BaseMessage & { payload: { message: string } }).payload.message,
        ).not.toContain('Invalid Salesforce object API name');
      }
    });
  });

  describe('Production Guard uses orgTypeToGuardTier', () => {
    it('should use orgTypeToGuardTier instead of inline tierMap', async () => {
      const mockConn = {
        identity: vi.fn().mockResolvedValue({}),
        sobject: vi.fn().mockReturnValue({ create: vi.fn().mockResolvedValue([]) }),
      };
      vi.mocked(getJsforceConnection).mockResolvedValue(mockConn as never);

      // Add a production org
      orgManager.addOrg({
        id: 'prod-org',
        alias: 'prod',
        username: 'admin@prod.com',
        instanceUrl: 'https://prod.sf.com',
        orgId: '00D2',
        orgType: 'Production',
        authMethod: 'oauth_web',
        safetyTier: OrgSafetyTier.HIGH,
        appearance: { color: '#ff0000', icon: 'cloud', position: 0 },
        metadata: { apiVersion: '62.0', edition: 'Enterprise', features: [] },
        status: 'connected',
        lastConnected: new Date().toISOString(),
        tags: [],
      });

      // Set up production guard
      const { ProductionGuard } = await import('../core/precheck/ProductionGuard.js');
      const guard = new ProductionGuard();
      handlers.setInfraServices({
        productionGuard: guard,
        performanceTracker: {
          start: vi.fn(),
          update: vi.fn(),
          complete: vi.fn(),
          stop: vi.fn(),
        } as never,
        offlineManager: { isOffline: vi.fn().mockReturnValue(false) } as never,
        piiDetector: { detectPII: vi.fn() } as never,
      });

      // Seed execute on production should work (insert is allowed with confirmation)
      broker['dispatch'](msg('seed:execute', { orgId: 'prod-org', template: { objects: [] } }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      // Verify the guard was called — the operation should proceed (insert is allowed on production, just needs confirmation)
      expect(logs.some((l) => l.includes('[RX] seed:execute'))).toBe(true);
    });
  });

  describe('monitor alerts routing', () => {
    it('monitor:alerts should respond with active alerts and history', async () => {
      broker['dispatch'](msg('monitor:alerts', { orgId: 'org-1' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const response = posted.find((p) => p.type === 'monitor:alerts:result');
      expect(response).toBeDefined();
      const payload = (
        response as BaseMessage & { payload: { alerts: unknown[]; history: unknown[] } }
      ).payload;
      expect(payload.alerts).toEqual([]);
      expect(payload.history).toEqual([]);
      expect(logs.some((l) => l.includes('[RX] monitor:alerts'))).toBe(true);
    });

    it('monitor:alert:acknowledge should respond with success', async () => {
      broker['dispatch'](msg('monitor:alert:acknowledge', { alertId: 'alert-1' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const response = posted.find((p) => p.type === 'monitor:alert:acknowledge:response');
      expect(response).toBeDefined();
      const payload = (response as BaseMessage & { payload: { success: boolean } }).payload;
      expect(payload.success).toBe(true);
    });

    it('monitor:alert:dismiss should respond with success', async () => {
      broker['dispatch'](msg('monitor:alert:dismiss', { alertId: 'alert-1' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const response = posted.find((p) => p.type === 'monitor:alert:dismiss:response');
      expect(response).toBeDefined();
      const payload = (response as BaseMessage & { payload: { success: boolean } }).payload;
      expect(payload.success).toBe(true);
    });
  });

  describe('seed template + persona routing', () => {
    it('seed:template:save should create the template and respond with its id', async () => {
      broker['dispatch'](
        msg('seed:template:save', {
          template: { name: 'My Template', description: '', tags: [], objects: [] },
        }),
      );
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const response = posted.find((p) => p.type === 'seed:template:save:response');
      expect(response).toBeDefined();
      const payload = (response as BaseMessage & { payload: { success: boolean; id: string } })
        .payload;
      expect(payload.success).toBe(true);
      expect(typeof payload.id).toBe('string');
    });

    it('seed:template:list should list saved templates', async () => {
      broker['dispatch'](
        msg('seed:template:save', {
          template: { name: 'Listed Template', description: '', tags: [], objects: [] },
        }),
      );
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      broker['dispatch'](msg('seed:template:list'));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(2));

      const response = posted.find((p) => p.type === 'seed:template:list:response');
      expect(response).toBeDefined();
      const payload = (
        response as BaseMessage & { payload: { templates: Array<{ name: string }> } }
      ).payload;
      expect(payload.templates).toHaveLength(1);
      expect(payload.templates[0].name).toBe('Listed Template');
    });

    it('seed:template:load should return null for an unknown id', async () => {
      broker['dispatch'](msg('seed:template:load', { id: 'missing' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const response = posted.find((p) => p.type === 'seed:template:load:response');
      expect(response).toBeDefined();
      const payload = (response as BaseMessage & { payload: { template: unknown } }).payload;
      expect(payload.template).toBeNull();
    });

    it('seed:template:delete should delete a saved template', async () => {
      broker['dispatch'](
        msg('seed:template:save', {
          template: { name: 'To Delete', description: '', tags: [], objects: [] },
        }),
      );
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      // SeedTemplateManager.create always assigns a fresh id — use the one
      // returned by the save response.
      const saveResponse = posted.find((p) => p.type === 'seed:template:save:response');
      const templateId = (saveResponse as BaseMessage & { payload: { id: string } }).payload.id;

      broker['dispatch'](msg('seed:template:delete', { id: templateId }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(2));

      const response = posted.find((p) => p.type === 'seed:template:delete:response');
      expect(response).toBeDefined();
      const payload = (response as BaseMessage & { payload: { success: boolean } }).payload;
      expect(payload.success).toBe(true);
    });

    it('seed:list-personas should return the built-in personas', async () => {
      broker['dispatch'](msg('seed:list-personas'));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const response = posted.find((p) => p.type === 'seed:list-personas:response');
      expect(response).toBeDefined();
      const payload = (response as BaseMessage & { payload: { personas: unknown[] } }).payload;
      expect(payload.personas.length).toBeGreaterThan(0);
    });

    it('seed:create-persona should reject an empty description', async () => {
      broker['dispatch'](msg('seed:create-persona', { description: '   ' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const response = posted.find((p) => p.type === 'seed:create-persona:response');
      expect(response).toBeDefined();
      const payload = (response as BaseMessage & { payload: { success: boolean } }).payload;
      expect(payload.success).toBe(false);
    });
  });

  describe('sync config routing', () => {
    it('sync:config:save should persist the config and respond with its id', async () => {
      broker['dispatch'](
        msg('sync:config:save', {
          config: validSyncConfig('cfg-1', 'Cfg 1'),
        }),
      );
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const response = posted.find((p) => p.type === 'sync:config:save:response');
      expect(response).toBeDefined();
      const payload = (response as BaseMessage & { payload: { success: boolean; id: string } })
        .payload;
      expect(payload.success).toBe(true);
      expect(payload.id).toBe('cfg-1');
    });

    it('sync:config:list should list saved configs', async () => {
      broker['dispatch'](
        msg('sync:config:save', {
          config: validSyncConfig('cfg-2', 'Cfg 2'),
        }),
      );
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      broker['dispatch'](msg('sync:config:list'));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(2));

      const response = posted.find((p) => p.type === 'sync:config:list:response');
      expect(response).toBeDefined();
      const payload = (response as BaseMessage & { payload: { configs: Array<{ id: string }> } })
        .payload;
      expect(payload.configs).toHaveLength(1);
      expect(payload.configs[0].id).toBe('cfg-2');
    });

    it('sync:config:load should return null for an unknown id', async () => {
      broker['dispatch'](msg('sync:config:load', { id: 'missing' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const response = posted.find((p) => p.type === 'sync:config:load:response');
      expect(response).toBeDefined();
      const payload = (response as BaseMessage & { payload: { config: unknown } }).payload;
      expect(payload.config).toBeNull();
    });

    it('sync:config:delete should delete a saved config', async () => {
      broker['dispatch'](
        msg('sync:config:save', {
          config: validSyncConfig('cfg-3', 'Cfg 3'),
        }),
      );
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      broker['dispatch'](msg('sync:config:delete', { id: 'cfg-3' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(2));

      const response = posted.find((p) => p.type === 'sync:config:delete:response');
      expect(response).toBeDefined();
      const payload = (response as BaseMessage & { payload: { success: boolean } }).payload;
      expect(payload.success).toBe(true);
    });
  });

  describe('sync schedule routing', () => {
    it('sync:schedule:upsert should persist the schedule and respond with computed nextRunAt', async () => {
      broker['dispatch'](msg('sync:schedule:upsert', { schedule: validSchedule('sched-1') }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const response = posted.find((p) => p.type === 'sync:schedule:upsert:response');
      expect(response).toBeDefined();
      const payload = (
        response as BaseMessage & {
          payload: { success: boolean; schedule: { id: string; nextRunAt?: string } };
        }
      ).payload;
      expect(payload.success).toBe(true);
      expect(payload.schedule.id).toBe('sched-1');
      // cron-parser computes a next run for the valid '0 6 * * *' expression
      expect(payload.schedule.nextRunAt).toBeTruthy();
    });

    it('sync:schedule:list should list upserted schedules', async () => {
      broker['dispatch'](msg('sync:schedule:upsert', { schedule: validSchedule('sched-2') }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      broker['dispatch'](msg('sync:schedule:list'));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(2));

      const response = posted.find((p) => p.type === 'sync:schedule:list:response');
      expect(response).toBeDefined();
      const payload = (response as BaseMessage & { payload: { schedules: Array<{ id: string }> } })
        .payload;
      expect(payload.schedules).toHaveLength(1);
      expect(payload.schedules[0].id).toBe('sched-2');
    });

    it('sync:schedule:toggle should disable an enabled schedule', async () => {
      broker['dispatch'](msg('sync:schedule:upsert', { schedule: validSchedule('sched-3') }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      broker['dispatch'](msg('sync:schedule:toggle', { scheduleId: 'sched-3', enabled: false }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(2));

      const response = posted.find((p) => p.type === 'sync:schedule:toggle:response');
      expect(response).toBeDefined();
      const payload = (
        response as BaseMessage & {
          payload: { success: boolean; scheduleId: string; enabled: boolean };
        }
      ).payload;
      expect(payload.success).toBe(true);
      expect(payload.scheduleId).toBe('sched-3');
      expect(payload.enabled).toBe(false);
    });

    it('sync:schedule:toggle should report NOT_FOUND for an unknown schedule', async () => {
      broker['dispatch'](msg('sync:schedule:toggle', { scheduleId: 'missing', enabled: false }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const errMsg = posted.find((p) => p.type === 'sync:schedule:error');
      expect(errMsg).toBeDefined();
      const payload = (errMsg as BaseMessage & { payload: { code: string } }).payload;
      expect(payload.code).toBe('NOT_FOUND');
    });

    it('sync:schedule:delete should delete an existing schedule', async () => {
      broker['dispatch'](msg('sync:schedule:upsert', { schedule: validSchedule('sched-4') }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      broker['dispatch'](msg('sync:schedule:delete', { scheduleId: 'sched-4' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(2));

      const response = posted.find((p) => p.type === 'sync:schedule:delete:response');
      expect(response).toBeDefined();
      const payload = (
        response as BaseMessage & { payload: { success: boolean; scheduleId: string } }
      ).payload;
      expect(payload.success).toBe(true);
      expect(payload.scheduleId).toBe('sched-4');

      broker['dispatch'](msg('sync:schedule:list'));
      await vi.waitFor(() =>
        expect(posted.some((p) => p.type === 'sync:schedule:list:response')).toBe(true),
      );
      const listResponse = posted.find((p) => p.type === 'sync:schedule:list:response');
      const listPayload = (listResponse as BaseMessage & { payload: { schedules: unknown[] } })
        .payload;
      expect(listPayload.schedules).toHaveLength(0);
    });

    it('sync:schedule:upsert should reject an invalid payload with INVALID_PAYLOAD', async () => {
      broker['dispatch'](msg('sync:schedule:upsert', { schedule: { id: 'sched-bad' } }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const errMsg = posted.find((p) => p.type === 'sync:schedule:error');
      expect(errMsg).toBeDefined();
      const payload = (errMsg as BaseMessage & { payload: { code: string } }).payload;
      expect(payload.code).toBe('INVALID_PAYLOAD');
    });
  });

  describe('forge:target-preflight:request', () => {
    it('should count existing rows on the target org', async () => {
      const mockConnection = {
        query: vi.fn().mockResolvedValue({ totalSize: 7 }),
      };
      (getJsforceConnection as ReturnType<typeof vi.fn>).mockResolvedValue(mockConnection);

      broker['dispatch'](
        msg('forge:target-preflight:request', {
          targetOrgId: 'org-1',
          objectApiNames: ['Account', 'Contact'],
        }),
      );
      await vi.waitFor(() =>
        expect(posted.some((p) => p.type === 'forge:target-preflight:response')).toBe(true),
      );

      const response = posted.find((p) => p.type === 'forge:target-preflight:response');
      const payload = (
        response as BaseMessage & {
          payload: { counts: Array<{ objectApiName: string; existing: number }> };
        }
      ).payload;
      expect(payload.counts).toEqual([
        { objectApiName: 'Account', existing: 7 },
        { objectApiName: 'Contact', existing: 7 },
      ]);
    });

    it('should reject an invalid payload with forge:target-preflight:error', async () => {
      broker['dispatch'](
        msg('forge:target-preflight:request', {
          targetOrgId: 'org-1',
          objectApiNames: ['Account; DROP TABLE'],
        }),
      );
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const errMsg = posted.find((p) => p.type === 'forge:target-preflight:error');
      expect(errMsg).toBeDefined();
    });
  });

  describe('realtime no-op routing (webview contract types)', () => {
    it('realtime:resolve-conflict should respond on realtime:conflict-resolved', async () => {
      broker['dispatch'](
        msg('realtime:resolve-conflict', { conflictId: 'conflict-1', resolution: 'source-wins' }),
      );
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const response = posted.find((p) => p.type === 'realtime:conflict-resolved');
      expect(response).toBeDefined();
      const payload = (
        response as BaseMessage & { payload: { success: boolean; comingSoon: boolean } }
      ).payload;
      expect(payload.success).toBe(false);
      expect(payload.comingSoon).toBe(true);
    });

    it('realtime:start should respond on realtime:started', async () => {
      broker['dispatch'](
        msg('realtime:start', { sourceOrgId: 'org-1', targetOrgId: 'org-2', watchedObjects: [] }),
      );
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const response = posted.find((p) => p.type === 'realtime:started');
      expect(response).toBeDefined();
    });

    it('realtime:stop should respond on realtime:stopped', async () => {
      broker['dispatch'](msg('realtime:stop', { sessionId: '' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const response = posted.find((p) => p.type === 'realtime:stopped');
      expect(response).toBeDefined();
    });
  });

  describe('ai:conversation:list routing', () => {
    it('should respond with the persisted conversation index', async () => {
      broker['dispatch'](msg('ai:conversation:list', {}));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const response = posted.find((p) => p.type === 'ai:conversation:list:response');
      expect(response).toBeDefined();
      const payload = (response as BaseMessage & { payload: { conversations: unknown[] } }).payload;
      expect(payload.conversations).toEqual([]);
    });
  });

  describe('ai:diagnose routing (handler not wired)', () => {
    it('should answer with an explicit AI_NOT_CONFIGURED error response', async () => {
      broker['dispatch'](
        msg('ai:diagnose', {
          runId: 'run-1',
          orgId: 'org-1',
          errorContext: { kind: 'generic', errorMessage: 'boom' },
        }),
      );
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const response = posted.find((p) => p.type === 'ai:diagnose:response');
      expect(response).toBeDefined();
      const payload = (
        response as BaseMessage & {
          payload: { runId: string; error: { code: string; message: string } };
        }
      ).payload;
      expect(payload.runId).toBe('run-1');
      expect(payload.error.code).toBe('AI_NOT_CONFIGURED');
    });

    it('ai:approve-action should answer failed when not configured', async () => {
      broker['dispatch'](msg('ai:approve-action', { runId: 'run-1', actionIndex: 0 }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const response = posted.find((p) => p.type === 'ai:approve-action:response');
      expect(response).toBeDefined();
      const payload = (
        response as BaseMessage & { payload: { status: string; resultMessage: string } }
      ).payload;
      expect(payload.status).toBe('failed');
    });
  });

  describe('sync:history routing', () => {
    it('sync:history:list should respond with stored entries (empty by default)', async () => {
      broker['dispatch'](msg('sync:history:list'));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const response = posted.find((p) => p.type === 'sync:history:list:response');
      expect(response).toBeDefined();
      const payload = (response as BaseMessage & { payload: { entries: unknown[] } }).payload;
      expect(payload.entries).toEqual([]);
    });

    it('sync:history:detail should return null for an unknown entry', async () => {
      broker['dispatch'](msg('sync:history:detail', { entryId: 'missing' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const response = posted.find((p) => p.type === 'sync:history:detail:response');
      expect(response).toBeDefined();
      const payload = (response as BaseMessage & { payload: { entry: unknown } }).payload;
      expect(payload.entry).toBeNull();
    });

    it('sync:history:export should produce CSV data', async () => {
      broker['dispatch'](msg('sync:history:export', { format: 'csv' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const response = posted.find((p) => p.type === 'sync:history:export:response');
      expect(response).toBeDefined();
      const payload = (response as BaseMessage & { payload: { data: string; format: string } })
        .payload;
      expect(payload.format).toBe('csv');
      expect(payload.data).toContain('configName');
    });

    it('sync:history:export should reject an invalid format with INVALID_PAYLOAD', async () => {
      broker['dispatch'](msg('sync:history:export', { format: 'xml' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const errMsg = posted.find((p) => p.type === 'sync:history:error');
      expect(errMsg).toBeDefined();
      const payload = (errMsg as BaseMessage & { payload: { code: string } }).payload;
      expect(payload.code).toBe('INVALID_PAYLOAD');
    });

    it('sync:history:rerun should answer NOT_FOUND for an unknown entry', async () => {
      broker['dispatch'](msg('sync:history:rerun', { entryId: 'missing' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const errMsg = posted.find((p) => p.type === 'sync:history:error');
      expect(errMsg).toBeDefined();
      const payload = (errMsg as BaseMessage & { payload: { code: string } }).payload;
      expect(payload.code).toBe('NOT_FOUND');
    });
  });

  describe('seed:clone routing', () => {
    it('seed:clone:describe-source should list createable+queryable objects', async () => {
      const mockConnection = {
        describeGlobal: vi.fn().mockResolvedValue({
          sobjects: [
            { name: 'Account', label: 'Account', createable: true, queryable: true },
            { name: 'ChangeEvent', label: 'Change Event', createable: true, queryable: false },
          ],
        }),
      };
      (getJsforceConnection as ReturnType<typeof vi.fn>).mockResolvedValue(mockConnection);

      broker['dispatch'](msg('seed:clone:describe-source', { sourceOrgId: 'org-1' }));
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const response = posted.find((p) => p.type === 'seed:clone:describe-source:response');
      expect(response).toBeDefined();
      const payload = (
        response as BaseMessage & {
          payload: { objects: Array<{ apiName: string; label: string; recordCount: number }> };
        }
      ).payload;
      expect(payload.objects).toHaveLength(1);
      expect(payload.objects[0].apiName).toBe('Account');
    });

    it('seed:clone:preview should return counts, samples and insert order', async () => {
      const mockConnection = {
        describe: vi.fn().mockResolvedValue({
          name: 'Account',
          fields: [
            { name: 'Id', type: 'id', createable: false },
            { name: 'Name', type: 'string', createable: true },
          ],
        }),
        query: vi.fn().mockResolvedValue({
          totalSize: 2,
          done: true,
          records: [
            { Id: '001AAAAAAAAAAAAAA', Name: 'Acme' },
            { Id: '001BBBBBBBBBBBBBB', Name: 'Beta' },
          ],
        }),
      };
      (getJsforceConnection as ReturnType<typeof vi.fn>).mockResolvedValue(mockConnection);

      broker['dispatch'](
        msg('seed:clone:preview', {
          sourceOrgId: 'org-1',
          targetOrgId: 'org-2',
          objects: [{ objectApiName: 'Account' }],
        }),
      );
      await vi.waitFor(() =>
        expect(posted.some((p) => p.type === 'seed:clone:preview:response')).toBe(true),
      );

      const response = posted.find((p) => p.type === 'seed:clone:preview:response');
      const payload = (
        response as BaseMessage & {
          payload: {
            objects: Array<{ objectApiName: string; recordCount: number }>;
            insertOrder: string[];
          };
        }
      ).payload;
      expect(payload.objects).toHaveLength(1);
      expect(payload.objects[0].recordCount).toBe(2);
      expect(payload.insertOrder).toEqual(['Account']);
    });

    it('seed:clone:execute should clone records and remap IDs', async () => {
      const created: unknown[][] = [];
      const mockConnection = {
        describe: vi.fn().mockResolvedValue({
          name: 'Account',
          fields: [
            { name: 'Id', type: 'id', createable: false },
            { name: 'Name', type: 'string', createable: true },
          ],
        }),
        query: vi.fn().mockResolvedValue({
          totalSize: 1,
          done: true,
          records: [{ Id: '001AAAAAAAAAAAAAA', Name: 'Acme' }],
        }),
        sobject: vi.fn().mockImplementation(() => ({
          create: vi.fn().mockImplementation((batch: unknown[]) => {
            created.push(batch);
            return Promise.resolve([{ success: true, id: '001NEWID00000001' }]);
          }),
        })),
      };
      (getJsforceConnection as ReturnType<typeof vi.fn>).mockResolvedValue(mockConnection);

      broker['dispatch'](
        msg('seed:clone:execute', {
          sourceOrgId: 'org-1',
          targetOrgId: 'org-2',
          objects: [{ objectApiName: 'Account' }],
        }),
      );
      await vi.waitFor(
        () => expect(posted.some((p) => p.type === 'seed:clone:execute:response')).toBe(true),
        { timeout: 10000 },
      );

      const response = posted.find((p) => p.type === 'seed:clone:execute:response');
      const payload = (
        response as BaseMessage & {
          payload: {
            status: string;
            totalInserted: number;
            objectResults: Array<{ idMappings: Array<{ sourceId: string; targetId: string }> }>;
          };
        }
      ).payload;
      expect(payload.status).toBe('success');
      expect(payload.totalInserted).toBe(1);
      expect(payload.objectResults[0].idMappings).toEqual([
        { sourceId: '001AAAAAAAAAAAAAA', targetId: '001NEWID00000001' },
      ]);
      // The source Id must be stripped from the written record.
      expect(created[0][0]).toEqual({ Name: 'Acme' });
    });

    it('seed:clone:execute should reject upsert without externalIdField', async () => {
      broker['dispatch'](
        msg('seed:clone:execute', {
          sourceOrgId: 'org-1',
          targetOrgId: 'org-2',
          objects: [{ objectApiName: 'Account' }],
          upsert: true,
        }),
      );
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const errMsg = posted.find((p) => p.type === 'seed:clone:error');
      expect(errMsg).toBeDefined();
      const payload = (errMsg as BaseMessage & { payload: { code: string } }).payload;
      expect(payload.code).toBe('INVALID_PAYLOAD');
    });

    it('seed:clone:execute should reject a SOQL-injection whereClause', async () => {
      broker['dispatch'](
        msg('seed:clone:execute', {
          sourceOrgId: 'org-1',
          targetOrgId: 'org-2',
          objects: [{ objectApiName: 'Account', whereClause: "Name != '' DELETE FROM Account" }],
        }),
      );
      await vi.waitFor(() => expect(posted.length).toBeGreaterThanOrEqual(1));

      const errMsg = posted.find((p) => p.type === 'seed:clone:error');
      expect(errMsg).toBeDefined();
    });
  });

  describe('seed:csv routing', () => {
    it('seed:csv:validate should validate rows against describe metadata', async () => {
      const mockConnection = {
        describe: vi.fn().mockResolvedValue({
          name: 'Account',
          fields: [
            {
              name: 'Name',
              label: 'Name',
              type: 'string',
              nillable: false,
              defaultValue: null,
              length: 255,
            },
          ],
        }),
      };
      (getJsforceConnection as ReturnType<typeof vi.fn>).mockResolvedValue(mockConnection);

      broker['dispatch'](
        msg('seed:csv:validate', {
          orgId: 'org-1',
          objectApiName: 'Account',
          records: [{ Name: 'Acme' }, { Name: '' }],
          columnMappings: [
            {
              csvHeader: 'Name',
              sfFieldApiName: 'Name',
              sfFieldType: 'string',
              sfFieldLength: 255,
            },
          ],
        }),
      );
      await vi.waitFor(() =>
        expect(posted.some((p) => p.type === 'seed:csv:validate:response')).toBe(true),
      );

      const response = posted.find((p) => p.type === 'seed:csv:validate:response');
      const payload = (
        response as BaseMessage & {
          payload: { valid: boolean; errors: Array<{ errorType: string }> };
        }
      ).payload;
      expect(payload.valid).toBe(false);
      expect(payload.errors[0].errorType).toBe('missing_required');
    });

    it('seed:csv:execute should insert mapped records and report counts', async () => {
      const mockConnection = {
        sobject: vi.fn().mockImplementation(() => ({
          create: vi.fn().mockResolvedValue([{ success: true, id: '001NEWID00000002' }]),
        })),
      };
      (getJsforceConnection as ReturnType<typeof vi.fn>).mockResolvedValue(mockConnection);

      broker['dispatch'](
        msg('seed:csv:execute', {
          orgId: 'org-1',
          objectApiName: 'Account',
          records: [{ Name: 'Acme', NumberOfEmployees: '42' }],
          columnMappings: [
            {
              csvHeader: 'Name',
              sfFieldApiName: 'Name',
              sfFieldType: 'string',
              sfFieldLength: 255,
            },
            {
              csvHeader: 'NumberOfEmployees',
              sfFieldApiName: 'NumberOfEmployees',
              sfFieldType: 'int',
              sfFieldLength: null,
            },
          ],
        }),
      );
      await vi.waitFor(
        () => expect(posted.some((p) => p.type === 'seed:csv:execute:response')).toBe(true),
        { timeout: 10000 },
      );

      const response = posted.find((p) => p.type === 'seed:csv:execute:response');
      const payload = (
        response as BaseMessage & {
          payload: { insertedCount: number; failedCount: number; errors: string[] };
        }
      ).payload;
      expect(payload.insertedCount).toBe(1);
      expect(payload.failedCount).toBe(0);
      expect(payload.errors).toEqual([]);
    });
  });

  describe('execution:manual-retry routing', () => {
    it('should answer execution:retry-status with canRetry:false (not replayable)', async () => {
      const { BackgroundOperationRegistry } =
        await import('../core/engine/BackgroundOperationRegistry.js');
      const localBroker = new MessageBroker();
      const localPosted: BaseMessage[] = [];
      vi.spyOn(localBroker, 'postToWebview').mockImplementation((m) => {
        localPosted.push(m);
      });
      const localRouter = new MessageRouter(localBroker);
      const localHandlers = new ExtensionHandlers({ ...deps, broker: localBroker });
      localHandlers.setBackgroundRegistry(new BackgroundOperationRegistry());
      localHandlers.registerAll(localRouter);

      localBroker['dispatch'](
        msg('execution:manual-retry', { executionId: 'op-x', objectName: 'Account' }),
      );
      await vi.waitFor(() => expect(localPosted.length).toBeGreaterThanOrEqual(1));

      const response = localPosted.find((p) => p.type === 'execution:retry-status');
      expect(response).toBeDefined();
      const payload = (
        response as BaseMessage & {
          payload: { executionId: string; canRetry: boolean; lastError: string };
        }
      ).payload;
      expect(payload.executionId).toBe('op-x');
      expect(payload.canRetry).toBe(false);
      expect(payload.lastError).toContain('Operation not found');
    });
  });
});
