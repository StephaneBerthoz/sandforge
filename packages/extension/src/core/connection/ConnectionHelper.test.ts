import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getJsforceConnection,
  getConnectionPool,
  getCircuitBreaker,
  resetCircuitBreakers,
} from './ConnectionHelper';
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
  execFile: vi.fn(),
}));

vi.mock('util', () => ({
  promisify: (fn: unknown) => fn,
}));

import { exec, execFile } from 'child_process';

const mockExec = vi.mocked(exec);
const mockExecFile = vi.mocked(execFile);

/**
 * `refreshTokenViaCli` branches on `process.platform`:
 * - Windows uses `exec` (shell required for `sf.cmd` PATHEXT resolution)
 * - POSIX uses `execFile` with argv-as-array (no shell — safer per audit RT-#8)
 *
 * Tests must mock the right one for the current platform; this helper
 * returns the active mock so individual tests stay platform-agnostic.
 */
const mockCliInvoker = process.platform === 'win32' ? mockExec : mockExecFile;

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
    // Reset singleton pool and per-org circuit breakers between tests
    getConnectionPool().dispose();
    resetCircuitBreakers();
  });

  afterEach(() => {
    vi.useRealTimers();
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
      mockCliInvoker.mockResolvedValueOnce({ stdout: refreshJson, stderr: '' } as never);

      const conn = await getJsforceConnection('org-1', orgRegistry, orgManager);

      expect(conn).toBeDefined();
      expect(orgRegistry.saveOrg).toHaveBeenCalledWith(
        org,
        expect.objectContaining({
          accessToken: 'new-token-456',
        }),
      );
    });

    it('should throw an actionable error when token refresh fails', async () => {
      const org = makeOrg();
      const creds = makeCreds();
      const orgManager = createMockOrgManager(org);
      const orgRegistry = createMockOrgRegistry(creds);

      mockIdentity.mockRejectedValueOnce(new Error('INVALID_SESSION_ID'));
      mockCliInvoker.mockRejectedValueOnce(new Error('sf not found') as never);

      await expect(getJsforceConnection('org-1', orgRegistry, orgManager)).rejects.toThrow(
        /Authentication expired for org "test-org".*sf org login web --alias test-org/,
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

    it('should invoke the SF CLI with the validated username', async () => {
      const org = makeOrg();
      const creds = makeCreds();
      const orgManager = createMockOrgManager(org);
      const orgRegistry = createMockOrgRegistry(creds);

      mockIdentity.mockRejectedValueOnce(new Error('INVALID_SESSION_ID'));

      const refreshJson = JSON.stringify({ result: { accessToken: 'new-token' } });
      mockCliInvoker.mockResolvedValueOnce({ stdout: refreshJson, stderr: '' } as never);

      await getJsforceConnection('org-1', orgRegistry, orgManager);

      if (process.platform === 'win32') {
        // Windows: shell-based exec with double-quoted username (regex-validated upstream)
        expect(mockExec).toHaveBeenCalledWith(
          expect.stringContaining('sf org display -u "admin@test.com" --json'),
          expect.objectContaining({ maxBuffer: expect.any(Number) }),
        );
      } else {
        // POSIX: argv-as-array execFile — no shell, no interpolation (RT-#8 hardening)
        expect(mockExecFile).toHaveBeenCalledWith(
          'sf',
          ['org', 'display', '-u', 'admin@test.com', '--json'],
          expect.objectContaining({ maxBuffer: expect.any(Number) }),
        );
      }
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

    it('should recover from INVALID_AUTH_HEADER (HTTP 401) via a single CLI refresh', async () => {
      const org = makeOrg();
      const creds = makeCreds();
      const orgManager = createMockOrgManager(org);
      const orgRegistry = createMockOrgRegistry(creds);

      // Real-world shape from the reported incident: HTTP 401, token expired.
      const unauthorized = Object.assign(new Error('Unauthorized'), {
        statusCode: 401,
        errorCode: 'INVALID_AUTH_HEADER',
      });
      mockIdentity.mockRejectedValueOnce(unauthorized).mockResolvedValueOnce({ user_id: 'u1' });

      const refreshJson = JSON.stringify({ result: { accessToken: 'new-token-789' } });
      mockCliInvoker.mockResolvedValueOnce({ stdout: refreshJson, stderr: '' } as never);

      const conn = await getJsforceConnection('org-1', orgRegistry, orgManager);

      expect(conn).toBeDefined();
      // Exactly one refresh attempt and exactly one retry of the validation call.
      expect(mockCliInvoker).toHaveBeenCalledTimes(1);
      expect(mockIdentity).toHaveBeenCalledTimes(2);
      // Refreshed token persisted back to the vault.
      expect(orgRegistry.saveOrg).toHaveBeenCalledWith(
        org,
        expect.objectContaining({ accessToken: 'new-token-789' }),
      );
    });

    it('should throw an actionable error when the 401 refresh fails', async () => {
      const org = makeOrg();
      const creds = makeCreds();
      const orgManager = createMockOrgManager(org);
      const orgRegistry = createMockOrgRegistry(creds);

      mockIdentity.mockRejectedValueOnce(
        Object.assign(new Error('Unauthorized'), { statusCode: 401 }),
      );
      mockCliInvoker.mockRejectedValueOnce(new Error('sf not found') as never);

      await expect(getJsforceConnection('org-1', orgRegistry, orgManager)).rejects.toThrow(
        /Authentication expired for org "test-org".*sf org login web --alias test-org/,
      );
      expect(mockCliInvoker).toHaveBeenCalledTimes(1);
    });

    it('should throw an actionable error when the refreshed token is still rejected', async () => {
      const org = makeOrg();
      const creds = makeCreds();
      const orgManager = createMockOrgManager(org);
      const orgRegistry = createMockOrgRegistry(creds);

      // Initial validation AND the single retry both reject — no second refresh.
      mockIdentity
        .mockRejectedValueOnce(new Error('INVALID_SESSION_ID'))
        .mockRejectedValueOnce(new Error('INVALID_SESSION_ID'));
      const refreshJson = JSON.stringify({ result: { accessToken: 'still-bad-token' } });
      mockCliInvoker.mockResolvedValueOnce({ stdout: refreshJson, stderr: '' } as never);

      await expect(getJsforceConnection('org-1', orgRegistry, orgManager)).rejects.toThrow(
        /Authentication expired for org "test-org".*sf org login web --alias test-org/,
      );
      expect(mockCliInvoker).toHaveBeenCalledTimes(1);
      expect(mockIdentity).toHaveBeenCalledTimes(2);
    });

    it('should not retry non-auth HTTP errors (500)', async () => {
      const org = makeOrg();
      const creds = makeCreds();
      const orgManager = createMockOrgManager(org);
      const orgRegistry = createMockOrgRegistry(creds);

      mockIdentity.mockRejectedValueOnce(
        Object.assign(new Error('Internal Server Error'), { statusCode: 500 }),
      );

      await expect(getJsforceConnection('org-1', orgRegistry, orgManager)).rejects.toThrow(
        'Connection failed for "test-org": Internal Server Error',
      );
      expect(mockCliInvoker).not.toHaveBeenCalled();
      expect(mockIdentity).toHaveBeenCalledTimes(1);
    });
  });

  describe('circuit breaker (per-org)', () => {
    it('returns the same breaker per org and distinct breakers across orgs', () => {
      expect(getCircuitBreaker('org-1')).toBe(getCircuitBreaker('org-1'));
      expect(getCircuitBreaker('org-1')).not.toBe(getCircuitBreaker('org-2'));
    });

    it('keeps an open breaker for one org from blocking other orgs', async () => {
      const org1 = makeOrg({ id: 'org-1', alias: 'org-one' });
      const org2 = makeOrg({ id: 'org-2', alias: 'org-two' });
      const creds = makeCreds();

      // Trip org-1's breaker (failureThreshold = 3)
      mockIdentity.mockRejectedValue(new Error('NETWORK_ERROR'));
      for (let i = 0; i < 3; i++) {
        await expect(
          getJsforceConnection('org-1', createMockOrgRegistry(creds), createMockOrgManager(org1)),
        ).rejects.toThrow('Connection failed');
      }
      expect(getCircuitBreaker('org-1').getState()).toBe('open');

      // org-1 is now blocked...
      await expect(
        getJsforceConnection('org-1', createMockOrgRegistry(creds), createMockOrgManager(org1)),
      ).rejects.toThrow('Circuit breaker is open');

      // ...but org-2 still connects on its own breaker
      mockIdentity.mockResolvedValueOnce({ user_id: 'u2' });
      const conn = await getJsforceConnection(
        'org-2',
        createMockOrgRegistry(creds),
        createMockOrgManager(org2),
      );
      expect(conn).toBeDefined();
      expect(getCircuitBreaker('org-2').getState()).toBe('closed');
    });

    it('releases the half-open permit on failure so the breaker recovers instead of locking out forever', async () => {
      vi.useFakeTimers();
      const org = makeOrg();
      const creds = makeCreds();
      const orgManager = createMockOrgManager(org);
      const orgRegistry = createMockOrgRegistry(creds);

      // Trip the breaker: 3 consecutive failures
      mockIdentity.mockRejectedValue(new Error('NETWORK_ERROR'));
      for (let i = 0; i < 3; i++) {
        await expect(getJsforceConnection('org-1', orgRegistry, orgManager)).rejects.toThrow(
          'Connection failed',
        );
      }
      const breaker = getCircuitBreaker('org-1');
      expect(breaker.getState()).toBe('open');

      // Cooldown elapses -> half-open; the probe fails and re-opens the breaker.
      vi.advanceTimersByTime(31_000);
      await expect(getJsforceConnection('org-1', orgRegistry, orgManager)).rejects.toThrow(
        'Connection failed',
      );
      expect(breaker.getState()).toBe('open');

      // Cooldown elapses again. The permit from the previous half-open probe
      // must have been released (finally block) — otherwise canExecute() stays
      // false forever and this call would throw "Circuit breaker is open".
      vi.advanceTimersByTime(31_000);
      mockIdentity.mockResolvedValueOnce({ user_id: 'u1' });
      const conn = await getJsforceConnection('org-1', orgRegistry, orgManager);
      expect(conn).toBeDefined();
      expect(breaker.getState()).toBe('closed');
    });

    it('does not count an auth failure recovered by refresh towards the breaker threshold', async () => {
      const org = makeOrg();
      const creds = makeCreds();
      const orgManager = createMockOrgManager(org);
      const orgRegistry = createMockOrgRegistry(creds);

      // Three full cycles of: auth rejection -> CLI refresh -> successful retry.
      // (failureThreshold = 3 — had these counted as failures, the breaker
      // would now be open.)
      for (let i = 0; i < 3; i++) {
        mockIdentity
          .mockRejectedValueOnce(new Error('INVALID_SESSION_ID'))
          .mockResolvedValueOnce({ user_id: 'u1' });
        mockCliInvoker.mockResolvedValueOnce({
          stdout: JSON.stringify({ result: { accessToken: `refreshed-token-${i}` } }),
          stderr: '',
        } as never);

        const conn = await getJsforceConnection('org-1', orgRegistry, orgManager);
        expect(conn).toBeDefined();
      }

      const breaker = getCircuitBreaker('org-1');
      expect(breaker.getState()).toBe('closed');
      expect(breaker.getFailureCount()).toBe(0);
    });

    it('counts a failed auth recovery as a breaker failure', async () => {
      const org = makeOrg();
      const creds = makeCreds();
      const orgManager = createMockOrgManager(org);
      const orgRegistry = createMockOrgRegistry(creds);

      mockIdentity.mockRejectedValue(new Error('INVALID_SESSION_ID'));
      // One CLI rejection per attempt (Once variants only — a persistent
      // rejection would leak into later tests, mockExecFile is not reset).
      for (let i = 0; i < 3; i++) {
        mockCliInvoker.mockRejectedValueOnce(new Error('sf not found') as never);
        await expect(getJsforceConnection('org-1', orgRegistry, orgManager)).rejects.toThrow(
          'Authentication expired for org "test-org"',
        );
      }

      expect(getCircuitBreaker('org-1').getState()).toBe('open');
      await expect(getJsforceConnection('org-1', orgRegistry, orgManager)).rejects.toThrow(
        'Circuit breaker is open',
      );
    });
  });
});
