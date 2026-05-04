import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getJsforceConnection, getConnectionPool, getCircuitBreaker } from './ConnectionHelper';
import type { OrgRegistry } from './OrgRegistry';
import type { OrgManager } from './OrgManager';
import type { SalesforceOrg, ConnectionConfig } from '@sandforge/shared';
import { OrgSafetyTier } from '@sandforge/shared';

const mockIdentity = vi.fn();

vi.mock('jsforce', () => ({
  default: {
    Connection: vi.fn().mockImplementation(() => ({
      identity: mockIdentity,
    })),
  },
}));

vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

vi.mock('util', () => ({
  promisify: (fn: unknown) => fn,
}));

import { exec } from 'child_process';

const mockExec = vi.mocked(exec);

function makeOrg(overrides: Partial<SalesforceOrg> = {}): SalesforceOrg {
  return {
    id: 'org-1',
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
    ...overrides,
  };
}

function makeCreds(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    loginUrl: 'https://test.salesforce.com',
    accessToken: 'token-123',
    instanceUrl: 'https://test.my.salesforce.com',
    username: 'admin@test.com',
    ...overrides,
  };
}

function createMockOrgManager(org?: SalesforceOrg): OrgManager {
  return {
    getOrg: vi.fn().mockReturnValue(org),
    getAllOrgs: vi.fn().mockReturnValue(org ? [org] : []),
    addOrg: vi.fn(),
    removeOrg: vi.fn(),
    updateStatus: vi.fn(),
    onOrgChange: vi.fn(),
    offOrgChange: vi.fn(),
    findByTag: vi.fn().mockReturnValue([]),
    connectedCount: org ? 1 : 0,
    clear: vi.fn(),
    dispose: vi.fn(),
  } as unknown as OrgManager;
}

function createMockOrgRegistry(creds?: ConnectionConfig): OrgRegistry {
  return {
    getCredentials: vi.fn().mockResolvedValue(creds),
    saveOrg: vi.fn().mockResolvedValue(undefined),
    removeOrg: vi.fn().mockResolvedValue(undefined),
    loadAll: vi.fn(),
    updateOrgMetadata: vi.fn(),
  } as unknown as OrgRegistry;
}

describe('ConnectionHelper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIdentity.mockReset();
    mockExec.mockReset();
    // Reset singleton pool and circuit breaker between tests
    getConnectionPool().dispose();
    getCircuitBreaker().reset();
  });

  describe('getJsforceConnection', () => {
    it('should return a connection when credentials are valid', async () => {
      const org = makeOrg();
      const creds = makeCreds();
      const orgManager = createMockOrgManager(org);
      const orgRegistry = createMockOrgRegistry(creds);
      mockIdentity.mockResolvedValueOnce({ user_id: 'u1', username: 'admin@test.com' });

      const conn = await getJsforceConnection('org-1', orgRegistry, orgManager);

      expect(conn).toBeDefined();
      expect(conn.identity).toBeDefined();
      expect(orgRegistry.getCredentials).toHaveBeenCalledWith('org-1');
    });

    it('should throw when org not found', async () => {
      const orgManager = createMockOrgManager(undefined);
      const orgRegistry = createMockOrgRegistry();

      await expect(getJsforceConnection('missing', orgRegistry, orgManager)).rejects.toThrow(
        'Org not found: missing',
      );
    });

    it('should throw when no credentials', async () => {
      const org = makeOrg();
      const orgManager = createMockOrgManager(org);
      const orgRegistry = createMockOrgRegistry(undefined);

      await expect(getJsforceConnection('org-1', orgRegistry, orgManager)).rejects.toThrow(
        'No credentials for org',
      );
    });

    it('should throw when accessToken is missing', async () => {
      const org = makeOrg();
      const orgManager = createMockOrgManager(org);
      const orgRegistry = createMockOrgRegistry(makeCreds({ accessToken: undefined }));

      await expect(getJsforceConnection('org-1', orgRegistry, orgManager)).rejects.toThrow(
        'No credentials for org',
      );
    });

    it('should refresh token when session expired', async () => {
      const org = makeOrg();
      const creds = makeCreds();
      const orgManager = createMockOrgManager(org);
      const orgRegistry = createMockOrgRegistry(creds);

      mockIdentity
        .mockRejectedValueOnce(new Error('INVALID_SESSION_ID'))
        .mockResolvedValueOnce({ user_id: 'u1' });

      const refreshJson = JSON.stringify({ result: { accessToken: 'new-token-456' } });
      mockExec.mockResolvedValueOnce({ stdout: refreshJson, stderr: '' } as never);

      const conn = await getJsforceConnection('org-1', orgRegistry, orgManager);

      expect(conn).toBeDefined();
      expect(orgRegistry.saveOrg).toHaveBeenCalledWith(
        org,
        expect.objectContaining({
          accessToken: 'new-token-456',
        }),
      );
    });

    it('should throw when token refresh fails', async () => {
      const org = makeOrg();
      const creds = makeCreds();
      const orgManager = createMockOrgManager(org);
      const orgRegistry = createMockOrgRegistry(creds);

      mockIdentity.mockRejectedValueOnce(new Error('INVALID_SESSION_ID'));
      mockExec.mockRejectedValueOnce(new Error('sf not found') as never);

      await expect(getJsforceConnection('org-1', orgRegistry, orgManager)).rejects.toThrow(
        'Token expired for "test-org" and refresh failed',
      );
    });

    it('should reject malicious usernames to prevent command injection', async () => {
      const maliciousUsername = 'admin@test.com; rm -rf /';
      const org = makeOrg({ username: maliciousUsername });
      const creds = makeCreds();
      const orgManager = createMockOrgManager(org);
      const orgRegistry = createMockOrgRegistry(creds);

      mockIdentity.mockRejectedValueOnce(new Error('INVALID_SESSION_ID'));

      await expect(getJsforceConnection('org-1', orgRegistry, orgManager)).rejects.toThrow(
        'Invalid username format',
      );
    });

    it('should call exec with quoted username for valid usernames', async () => {
      const org = makeOrg();
      const creds = makeCreds();
      const orgManager = createMockOrgManager(org);
      const orgRegistry = createMockOrgRegistry(creds);

      mockIdentity.mockRejectedValueOnce(new Error('INVALID_SESSION_ID'));

      const refreshJson = JSON.stringify({ result: { accessToken: 'new-token' } });
      mockExec.mockResolvedValueOnce({ stdout: refreshJson, stderr: '' } as never);

      await getJsforceConnection('org-1', orgRegistry, orgManager);

      expect(mockExec).toHaveBeenCalledWith(
        expect.stringContaining('sf org display -u "admin@test.com" --json'),
        expect.objectContaining({ maxBuffer: expect.any(Number) }),
      );
    });

    it('should throw on non-session errors without attempting refresh', async () => {
      const org = makeOrg();
      const creds = makeCreds();
      const orgManager = createMockOrgManager(org);
      const orgRegistry = createMockOrgRegistry(creds);

      mockIdentity.mockRejectedValueOnce(new Error('NETWORK_ERROR'));

      await expect(getJsforceConnection('org-1', orgRegistry, orgManager)).rejects.toThrow(
        'Connection failed for "test-org": NETWORK_ERROR',
      );
      expect(mockExec).not.toHaveBeenCalled();
    });
  });
});
