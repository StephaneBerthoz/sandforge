import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SalesforceOrg, ConnectionConfig } from '@sandforge/shared';
import { OrgSafetyTier } from '@sandforge/shared';
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
    safetyTier: OrgSafetyTier.LOW,
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

    it('should prune a legacy duplicate entry that shares the same Salesforce orgId', async () => {
      // Canonical entry: key, id and orgId all aligned (current scheme).
      const canonical = { ...createTestOrg('00D999'), orgId: '00D999' };
      await registry.saveOrg(canonical, {
        loginUrl: 'https://login.salesforce.com',
        accessToken: 'fresh-token',
      });

      // Ghost entry from an older build: stored under a different key/id but
      // pointing at the SAME Salesforce org — with its own stale credentials.
      const ghost = {
        ...createTestOrg('legacy-uuid-1'),
        orgId: '00D999',
        alias: 'org-00D999 (old)',
      };
      configStore.set('org.legacy-uuid-1', ghost, 'orgs');
      await secretVault.storeObject('org-cred.legacy-uuid-1', {
        loginUrl: 'https://login.salesforce.com',
        accessToken: 'stale-token',
      });

      const freshOrgManager = new OrgManager();
      const freshRegistry = new OrgRegistry(configStore, secretVault, freshOrgManager);
      freshRegistry.loadAll();

      // One entry survives: the canonical one.
      expect(freshOrgManager.getAllOrgs()).toHaveLength(1);
      expect(freshOrgManager.getOrg('00D999')?.alias).toBe('org-00D999');
      // Ghost purged from ConfigStore and SecretVault.
      expect(configStore.get('org.legacy-uuid-1')).toBeUndefined();
      const ghostCreds = await secretVault.getObject('org-cred.legacy-uuid-1');
      expect(ghostCreds).toBeUndefined();
      // Canonical credentials untouched.
      const creds = await freshRegistry.getCredentials('00D999');
      expect(creds?.accessToken).toBe('fresh-token');
    });

    it('should keep the canonical entry even when the ghost is written after it', async () => {
      // Ghost written FIRST, canonical second — the orgId-keyed entry must win
      // regardless of iteration order.
      const ghost = { ...createTestOrg('legacy-uuid-2'), orgId: '00D888' };
      configStore.set('org.legacy-uuid-2', ghost, 'orgs');
      const canonical = { ...createTestOrg('00D888'), orgId: '00D888' };
      configStore.set('org.00D888', canonical, 'orgs');

      const freshOrgManager = new OrgManager();
      new OrgRegistry(configStore, secretVault, freshOrgManager).loadAll();

      expect(freshOrgManager.getAllOrgs()).toHaveLength(1);
      expect(freshOrgManager.getOrg('00D888')).toBeDefined();
      expect(configStore.get('org.legacy-uuid-2')).toBeUndefined();
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

    // The startup sweep validates orgs one after the other and every
    // org's check begins with this read. A keyring that never answers used to
    // park the sweep on org 1 forever.
    it('should reject on a secret-storage read that never settles instead of hanging', async () => {
      // Captured before the fake clock is installed — the guard below has to
      // fire in real time even while the mocked one is frozen.
      const realSetTimeout = globalThis.setTimeout;
      const neverSettles: SecretStorageAdapter = {
        get: vi.fn(() => new Promise<string | undefined>(() => undefined)),
        store: vi.fn(() => Promise.resolve()),
        delete: vi.fn(() => Promise.resolve()),
      };
      const stalled = new OrgRegistry(configStore, new SecretVault(neverSettles), orgManager);

      vi.useFakeTimers();
      try {
        const settled = stalled
          .getCredentials('001')
          .then(() => 'resolved' as const)
          .catch((err: unknown) => err);
        // Without the deadline `settled` never settles; racing a real-time
        // guard turns that into a failed assertion rather than a hung suite.
        const guard = new Promise<'hung'>((resolve) => {
          realSetTimeout(() => resolve('hung'), 500);
        });

        await vi.advanceTimersByTimeAsync(10_000);
        const outcome = await Promise.race([settled, guard]);

        expect(outcome).toBeInstanceOf(Error);
        const message = (outcome as Error).message;
        expect(message).toMatch(/Secret storage did not answer/);
        // startupValidation classifies on this exact pattern: a stuck keyring
        // must land on 'error', never on 'expired' ("re-authenticate" would be
        // the wrong advice — the token was never even read).
        expect(/Authentication expired|No credentials/.test(message)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should leave no armed timer once the vault answers', async () => {
      const org = createTestOrg('050');
      await registry.saveOrg(org, {
        loginUrl: 'https://login.salesforce.com',
        accessToken: 'tok',
      });

      vi.useFakeTimers();
      try {
        const creds = await registry.getCredentials('050');

        expect(creds?.accessToken).toBe('tok');
        // Guards the deadline's own failure mode: a missing clearTimeout would
        // arm a 10 s timer on every credential read.
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
