import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SalesforceOrg, ConnectionConfig } from '@sandforge/shared';
import { OrgRegistry } from './OrgRegistry';
import { OrgManager } from './OrgManager';
import { ConfigStore } from '../storage/ConfigStore';
import { InMemoryConfigStoreBackend } from '../storage/ConfigStoreBackend';
import { SecretVault } from '../storage/SecretVault';
import type { SecretStorageAdapter } from '../storage/SecretVault';

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

function createTestOrg(id: string): SalesforceOrg {
  return {
    id,
    alias: `org-${id}`,
    username: `user@${id}.test`,
    instanceUrl: `https://${id}.salesforce.com`,
    orgId: `00D${id}`,
    orgType: 'Sandbox',
    authMethod: 'oauth_web',
    safetyTier: 'low' as const,
    appearance: { color: '#00ff00', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '59.0', edition: 'Developer', features: [] },
    status: 'connected',
    lastConnected: new Date().toISOString(),
    tags: [],
  };
}

describe('OrgRegistry', () => {
  let configStore: ConfigStore;
  let secretVault: SecretVault;
  let orgManager: OrgManager;
  let registry: OrgRegistry;
  let backend: InMemoryConfigStoreBackend;

  beforeEach(() => {
    backend = new InMemoryConfigStoreBackend();
    configStore = new ConfigStore(backend);
    configStore.initialize();
    secretVault = new SecretVault(createMockSecretStorage());
    orgManager = new OrgManager();
    registry = new OrgRegistry(configStore, secretVault, orgManager);
  });

  describe('saveOrg', () => {
    it('should persist org metadata and add to OrgManager', async () => {
      const org = createTestOrg('001');

      await registry.saveOrg(org);

      expect(orgManager.getOrg('001')).toEqual(org);
      expect(configStore.get(`org.001`)).toEqual(org);
    });

    it('should persist credentials in SecretVault when provided', async () => {
      const org = createTestOrg('002');
      const creds: ConnectionConfig = {
        loginUrl: 'https://login.salesforce.com',
        accessToken: 'token123',
        refreshToken: 'refresh123',
      };

      await registry.saveOrg(org, creds);

      const stored = await registry.getCredentials('002');
      expect(stored).toEqual(creds);
    });
  });

  describe('loadAll', () => {
    it('should populate OrgManager from ConfigStore', async () => {
      const org1 = createTestOrg('010');
      const org2 = createTestOrg('020');
      await registry.saveOrg(org1);
      await registry.saveOrg(org2);

      const freshOrgManager = new OrgManager();
      const freshRegistry = new OrgRegistry(configStore, secretVault, freshOrgManager);
      freshRegistry.loadAll();

      expect(freshOrgManager.getAllOrgs()).toHaveLength(2);
      expect(freshOrgManager.getOrg('010')).toEqual(org1);
      expect(freshOrgManager.getOrg('020')).toEqual(org2);
    });
  });

  describe('removeOrg', () => {
    it('should remove from ConfigStore, SecretVault, and OrgManager', async () => {
      const org = createTestOrg('030');
      const creds: ConnectionConfig = {
        loginUrl: 'https://login.salesforce.com',
        accessToken: 'tok',
      };
      await registry.saveOrg(org, creds);

      await registry.removeOrg('030');

      expect(orgManager.getOrg('030')).toBeUndefined();
      expect(configStore.get('org.030')).toBeUndefined();
      const storedCreds = await registry.getCredentials('030');
      expect(storedCreds).toBeUndefined();
    });
  });

  describe('updateOrgMetadata', () => {
    it('should update metadata without touching credentials', async () => {
      const org = createTestOrg('040');
      const creds: ConnectionConfig = {
        loginUrl: 'https://login.salesforce.com',
        accessToken: 'secret',
      };
      await registry.saveOrg(org, creds);

      const updated = { ...org, alias: 'renamed-org' };
      registry.updateOrgMetadata(updated);

      expect(orgManager.getOrg('040')?.alias).toBe('renamed-org');
      const storedCreds = await registry.getCredentials('040');
      expect(storedCreds?.accessToken).toBe('secret');
    });
  });

  describe('getCredentials', () => {
    it('should return undefined for unknown orgId', async () => {
      const result = await registry.getCredentials('nonexistent');
      expect(result).toBeUndefined();
    });
  });
});
