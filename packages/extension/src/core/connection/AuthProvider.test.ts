import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthProvider } from './AuthProvider';
import type { AuthCredentials, AuthResult } from './AuthProvider';
import type { SfdxBridge, SfdxImportResult } from './SfdxBridge';
import { OrgSafetyTier } from '@sandforge/shared';

vi.mock('jsforce', () => {
  const mockLogin = vi.fn();
  const mockIdentity = vi.fn();
  const mockQuery = vi.fn();
  const MockConnection = vi.fn().mockImplementation((opts: Record<string, string>) => ({
    accessToken: opts.accessToken ?? 'mock-access-token',
    instanceUrl: opts.instanceUrl ?? 'https://mock.salesforce.com',
    login: mockLogin,
    identity: mockIdentity,
    query: mockQuery,
  }));
  return {
    default: { Connection: MockConnection },
    __mockLogin: mockLogin,
    __mockIdentity: mockIdentity,
    __mockQuery: mockQuery,
    __MockConnection: MockConnection,
  };
});

/* eslint-disable @typescript-eslint/no-explicit-any */
import * as jsforceModule from 'jsforce';
const { __mockLogin, __mockIdentity, __mockQuery } = jsforceModule as any;
/* eslint-enable @typescript-eslint/no-explicit-any */

function createCredentials(overrides: Partial<AuthCredentials> = {}): AuthCredentials {
  return {
    method: 'oauth_web',
    loginUrl: 'https://login.salesforce.com',
    ...overrides,
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

function createTestImportResult(): SfdxImportResult {
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
  };
}

describe('AuthProvider', () => {
  let provider: AuthProvider;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    provider = new AuthProvider();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('authenticate', () => {
    it('should return message for oauth_web method', async () => {
      const result = await provider.authenticate(createCredentials({ method: 'oauth_web' }));

      expect(result.success).toBe(false);
      expect(result.error).toContain('OAuth');
    });

    it('should return message for oauth_device method', async () => {
      const result = await provider.authenticate(createCredentials({ method: 'oauth_device' }));

      expect(result.success).toBe(false);
      expect(result.error).toContain('OAuth');
    });

    it('should return error for jwt method', async () => {
      const result = await provider.authenticate(createCredentials({ method: 'jwt' }));

      expect(result.success).toBe(false);
      expect(result.error).toContain('JWT');
    });

    it('should require username and password for usernamePassword method', async () => {
      const result = await provider.authenticate(
        createCredentials({ method: 'usernamePassword' }),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Username and password are required');
    });

    it('should authenticate via jsforce with username/password', async () => {
      __mockLogin.mockResolvedValueOnce({
        id: 'user-001',
        organizationId: '00D1',
      });

      const result = await provider.authenticate(
        createCredentials({
          method: 'usernamePassword',
          username: 'admin@test.com',
          password: 'secret123',
          securityToken: 'TOKEN',
        }),
      );

      expect(result.success).toBe(true);
      expect(result.userId).toBe('user-001');
      expect(result.orgId).toBe('00D1');
      expect(__mockLogin).toHaveBeenCalledWith('admin@test.com', 'secret123TOKEN');
    });

    it('should handle jsforce login errors gracefully', async () => {
      __mockLogin.mockRejectedValueOnce(new Error('INVALID_LOGIN'));

      const result = await provider.authenticate(
        createCredentials({
          method: 'usernamePassword',
          username: 'admin@test.com',
          password: 'wrong',
        }),
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('INVALID_LOGIN');
    });

    it('should return error for sfdx_import without bridge', async () => {
      const result = await provider.authenticate(createCredentials({ method: 'sfdx_import' }));

      expect(result.success).toBe(false);
      expect(result.error).toContain('bridge not configured');
    });

    it('should import orgs from sfdx bridge', async () => {
      const mockBridge = createMockSfdxBridge({
        listOrgs: vi.fn().mockResolvedValue([createTestImportResult()]),
      });
      provider.setSfdxBridge(mockBridge);

      const result = await provider.authenticate(createCredentials({ method: 'sfdx_import' }));

      expect(result.success).toBe(true);
      expect(result.orgId).toBe('00D1');
      expect(result.accessToken).toBe('sfdx-token-1');
    });

    it('should return error when sfdx has no connected orgs', async () => {
      const mockBridge = createMockSfdxBridge({
        listOrgs: vi.fn().mockResolvedValue([]),
      });
      provider.setSfdxBridge(mockBridge);

      const result = await provider.authenticate(createCredentials({ method: 'sfdx_import' }));

      expect(result.success).toBe(false);
      expect(result.error).toContain('No connected orgs');
    });
  });

  describe('validateConnection', () => {
    it('should call identity() and query Organization', async () => {
      __mockIdentity.mockResolvedValueOnce({
        user_id: 'user-001',
        username: 'admin@test.com',
        display_name: 'Admin User',
      });
      __mockQuery.mockResolvedValueOnce({
        records: [{
          Id: '00D1',
          Name: 'Test Org',
          OrganizationType: 'Developer Edition',
          IsSandbox: false,
        }],
      });

      const result = await provider.validateConnection('token-1', 'https://test.sf.com');

      expect(result.userId).toBe('user-001');
      expect(result.username).toBe('admin@test.com');
      expect(result.orgId).toBe('00D1');
      expect(result.orgName).toBe('Test Org');
      expect(result.isSandbox).toBe(false);
    });
  });

  describe('buildConnectionConfig', () => {
    it('should build a ConnectionConfig from credentials and auth result', () => {
      const credentials = createCredentials({
        loginUrl: 'https://login.salesforce.com',
        clientId: 'client-123',
        clientSecret: 'secret-456',
        username: 'admin@test.com',
      });

      const authResult: AuthResult = {
        success: true,
        accessToken: 'access-token-xyz',
        refreshToken: 'refresh-token-xyz',
        instanceUrl: 'https://myorg.my.salesforce.com',
      };

      const config = provider.buildConnectionConfig(credentials, authResult);

      expect(config).toEqual({
        loginUrl: 'https://login.salesforce.com',
        clientId: 'client-123',
        clientSecret: 'secret-456',
        accessToken: 'access-token-xyz',
        refreshToken: 'refresh-token-xyz',
        instanceUrl: 'https://myorg.my.salesforce.com',
        username: 'admin@test.com',
      });
    });

    it('should handle missing optional fields', () => {
      const credentials = createCredentials();
      const authResult: AuthResult = { success: true };

      const config = provider.buildConnectionConfig(credentials, authResult);

      expect(config.loginUrl).toBe('https://login.salesforce.com');
      expect(config.clientId).toBeUndefined();
      expect(config.accessToken).toBeUndefined();
    });
  });

  describe('token caching', () => {
    it('should cache and retrieve a token', () => {
      provider.cacheToken('org-001', 'my-token', 60_000);

      expect(provider.getCachedToken('org-001')).toBe('my-token');
    });

    it('should report a cached token as valid', () => {
      provider.cacheToken('org-001', 'my-token', 60_000);

      expect(provider.isTokenValid('org-001')).toBe(true);
    });

    it('should return undefined for unknown org', () => {
      expect(provider.getCachedToken('unknown')).toBeUndefined();
    });

    it('should report unknown org token as invalid', () => {
      expect(provider.isTokenValid('unknown')).toBe(false);
    });

    it('should expire a token after TTL', () => {
      provider.cacheToken('org-001', 'my-token', 60_000);

      vi.advanceTimersByTime(60_001);

      expect(provider.getCachedToken('org-001')).toBeUndefined();
      expect(provider.isTokenValid('org-001')).toBe(false);
    });

    it('should clear a specific org token cache', () => {
      provider.cacheToken('org-001', 'token-1', 60_000);
      provider.cacheToken('org-002', 'token-2', 60_000);

      provider.clearTokenCache('org-001');

      expect(provider.getCachedToken('org-001')).toBeUndefined();
      expect(provider.getCachedToken('org-002')).toBe('token-2');
    });

    it('should clear all token caches', () => {
      provider.cacheToken('org-001', 'token-1', 60_000);
      provider.cacheToken('org-002', 'token-2', 60_000);

      provider.clearAllTokens();

      expect(provider.getCachedToken('org-001')).toBeUndefined();
      expect(provider.getCachedToken('org-002')).toBeUndefined();
    });
  });
});
