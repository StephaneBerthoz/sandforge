import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SalesforceOrg } from '@sandforge/shared';
import { OrgSafetyTier } from '@sandforge/shared';
import { ExtensionHandlers } from './ExtensionHandlers';
import { MessageBroker } from './MessageBroker';
import { WebviewStateSync } from './WebviewStateSync';
import { OrgManager } from '../core/connection/OrgManager';
import { OrgRegistry } from '../core/connection/OrgRegistry';
import { ConfigStore } from '../core/storage/ConfigStore';
import { InMemoryConfigStoreBackend } from '../test/InMemoryConfigStoreBackend';
import { SecretVault } from '../core/storage/SecretVault';
import type { SecretStorageAdapter } from '../core/storage/SecretVault';
import { AuthProvider } from '../core/connection/AuthProvider';
import type { SfdxBridge } from '../core/connection/SfdxBridge';
import { clearDescribeCache, describeCached } from '../core/connection/describeCache';
import { MonitorOpsHandler } from './handlers/MonitorOpsHandler';
import { ForgeHandler } from './handlers/ForgeHandler';
import { FrozenDatasetHandler } from './handlers/FrozenDatasetHandler';
import { AIHandler } from './handlers/AIHandler';
import { SmartActionHandler } from './handlers/SmartActionHandler';

const mockPoolRemove = vi.hoisted(() => vi.fn());

vi.mock('../core/connection/ConnectionHelper', () => ({
  getJsforceConnection: vi.fn(),
  getConnectionPool: vi.fn(() => ({ remove: mockPoolRemove })),
}));

function createSecretStorage(): SecretStorageAdapter {
  const store = new Map<string, string>();
  return {
    get: (key: string) => Promise.resolve(store.get(key)),
    store: (key: string, value: string) => {
      store.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      store.delete(key);
      return Promise.resolve();
    },
  };
}

/** The org id a sandbox was registered with, and the one it answers with after a refresh. */
const REGISTERED_ORG_ID = '00DXX00000AbCdE2A1';
const REFRESHED_ORG_ID = '00Dxx00000FgHiJ3B2';

function sandbox(): SalesforceOrg {
  return {
    id: REGISTERED_ORG_ID,
    alias: 'UAT',
    username: 'admin@acme.test.uat',
    instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
    orgId: REGISTERED_ORG_ID,
    orgType: 'Sandbox',
    authMethod: 'sfdx_import',
    safetyTier: OrgSafetyTier.MEDIUM,
    appearance: { color: '#4a9eff', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '62.0', edition: 'Enterprise Edition', features: [] },
    status: 'connected',
    lastConnected: '2026-09-01T08:00:00.000Z',
    tags: [],
  };
}

describe('ExtensionHandlers — a sandbox refresh', () => {
  let handlers: ExtensionHandlers;
  let orgManager: OrgManager;

  beforeEach(() => {
    mockPoolRemove.mockReset();
    clearDescribeCache();
    const broker = new MessageBroker();
    orgManager = new OrgManager();
    orgManager.addOrg(sandbox());
    const configStore = new ConfigStore(new InMemoryConfigStoreBackend());
    configStore.initialize();
    const secretVault = new SecretVault(createSecretStorage());
    handlers = new ExtensionHandlers({
      log: () => undefined,
      broker,
      stateSync: new WebviewStateSync(broker),
      orgManager,
      orgRegistry: new OrgRegistry(configStore, secretVault, orgManager),
      configStore,
      secretVault,
      authProvider: new AuthProvider(),
      sfdxBridge: {} as SfdxBridge,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops what every module holds about the sandbox once it answers as a new org', async () => {
    const forgotten = [
      vi.spyOn(MonitorOpsHandler.prototype, 'forgetOrg'),
      vi.spyOn(ForgeHandler.prototype, 'forgetOrg'),
      vi.spyOn(FrozenDatasetHandler.prototype, 'forgetOrg'),
      vi.spyOn(AIHandler.prototype, 'forgetOrg'),
      vi.spyOn(SmartActionHandler.prototype, 'forgetOrg'),
    ];
    const describe = vi.fn().mockResolvedValue({ fields: [] });
    await describeCached(REGISTERED_ORG_ID, 'Account', describe);

    handlers.sandboxRefreshes.observe(
      REGISTERED_ORG_ID,
      { organizationId: REFRESHED_ORG_ID },
      'connection',
    );

    expect(mockPoolRemove).toHaveBeenCalledWith(REGISTERED_ORG_ID);
    for (const spy of forgotten) expect(spy).toHaveBeenCalledWith(REGISTERED_ORG_ID);
    await describeCached(REGISTERED_ORG_ID, 'Account', describe);
    expect(describe).toHaveBeenCalledTimes(2);
  });

  it('keeps everything while the sandbox answers as the org it was registered with', async () => {
    const forget = vi.spyOn(MonitorOpsHandler.prototype, 'forgetOrg');
    const describe = vi.fn().mockResolvedValue({ fields: [] });
    await describeCached(REGISTERED_ORG_ID, 'Account', describe);

    handlers.sandboxRefreshes.observe(
      REGISTERED_ORG_ID,
      { organizationId: REGISTERED_ORG_ID },
      'connection',
    );

    expect(mockPoolRemove).not.toHaveBeenCalled();
    expect(forget).not.toHaveBeenCalled();
    await describeCached(REGISTERED_ORG_ID, 'Account', describe);
    expect(describe).toHaveBeenCalledTimes(1);
  });
});
