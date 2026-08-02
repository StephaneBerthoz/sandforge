import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SfdxBridge } from './SfdxBridge';

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
 * `loginWeb` branches on `process.platform`:
 * - Windows uses `exec` (shell required for `sf.cmd` PATHEXT resolution)
 * - POSIX uses `execFile` with argv-as-array (no shell — RT-#8 hardening)
 *
 * Tests pick the active mock for the current platform so they stay
 * platform-agnostic (same pattern as ConnectionHelper.test.ts).
 */
const mockCliInvoker = process.platform === 'win32' ? mockExec : mockExecFile;

function makeSfOrgListOutput(
  nonScratchOrgs: Record<string, unknown>[] = [],
  scratchOrgs: Record<string, unknown>[] = [],
  extra?: {
    sandboxes?: Record<string, unknown>[];
    other?: Record<string, unknown>[];
    devHubs?: Record<string, unknown>[];
  },
): string {
  return JSON.stringify({
    result: { nonScratchOrgs, scratchOrgs, ...extra },
  });
}

describe('SfdxBridge', () => {
  let bridge: SfdxBridge;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = new SfdxBridge();
  });

  describe('isCliAvailable', () => {
    it('should return true when sf CLI is found', async () => {
      mockExec.mockResolvedValueOnce({ stdout: 'sf 2.x', stderr: '' } as never);

      const result = await bridge.isCliAvailable();

      expect(result).toBe(true);
      expect(mockExec).toHaveBeenCalledWith(
        'sf --version',
        expect.objectContaining({ maxBuffer: 10 * 1024 * 1024, windowsHide: true }),
      );
    });

    it('should return false when sf CLI is not found', async () => {
      mockExec.mockRejectedValueOnce(new Error('ENOENT') as never);

      const result = await bridge.isCliAvailable();

      expect(result).toBe(false);
    });
  });

  describe('listOrgs', () => {
    it('should parse and return connected orgs', async () => {
      const output = makeSfOrgListOutput([
        {
          orgId: '00D1',
          username: 'admin@prod.com',
          alias: 'prod',
          instanceUrl: 'https://prod.my.salesforce.com',
          accessToken: 'token-1',
          connectedStatus: 'Connected',
          isSandbox: false,
        },
        {
          orgId: '00D2',
          username: 'admin@sandbox.com',
          alias: 'sbx',
          instanceUrl: 'https://sbx.my.salesforce.com',
          accessToken: 'token-2',
          connectedStatus: 'Connected',
          isSandbox: true,
        },
      ]);
      mockExec.mockResolvedValueOnce({ stdout: output, stderr: '' } as never);

      const results = await bridge.listOrgs();

      expect(results).toHaveLength(2);

      expect(results[0].org.orgId).toBe('00D1');
      expect(results[0].org.alias).toBe('prod');
      expect(results[0].org.orgType).toBe('Production');
      expect(results[0].org.safetyTier).toBe('critical');
      expect(results[0].credentials.accessToken).toBe('token-1');

      expect(results[1].org.orgId).toBe('00D2');
      expect(results[1].org.alias).toBe('sbx');
      expect(results[1].org.orgType).toBe('Sandbox');
      expect(results[1].org.safetyTier).toBe('medium');
    });

    it('should pass --json flag with NO_COLOR env', async () => {
      const output = makeSfOrgListOutput([]);
      mockExec.mockResolvedValueOnce({ stdout: output, stderr: '' } as never);

      await bridge.listOrgs();

      expect(mockExec).toHaveBeenCalledWith(
        'sf org list --json',
        expect.objectContaining({
          timeout: 30_000,
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true,
        }),
      );
    });

    it('should filter out non-Connected orgs', async () => {
      const output = makeSfOrgListOutput([
        {
          orgId: '00D1',
          username: 'admin@prod.com',
          instanceUrl: 'https://prod.my.salesforce.com',
          connectedStatus: 'Connected',
        },
        {
          orgId: '00D3',
          username: 'admin@expired.com',
          instanceUrl: 'https://expired.my.salesforce.com',
          connectedStatus: 'Expired',
        },
      ]);
      mockExec.mockResolvedValueOnce({ stdout: output, stderr: '' } as never);

      const results = await bridge.listOrgs();

      expect(results).toHaveLength(1);
      expect(results[0].org.orgId).toBe('00D1');
    });

    it('should dedupe orgs by orgId', async () => {
      const output = makeSfOrgListOutput([
        {
          orgId: '00D1',
          username: 'admin@prod.com',
          alias: 'first',
          instanceUrl: 'https://prod.my.salesforce.com',
          connectedStatus: 'Connected',
        },
        {
          orgId: '00D1',
          username: 'admin@prod.com',
          alias: 'duplicate',
          instanceUrl: 'https://prod.my.salesforce.com',
          connectedStatus: 'Connected',
        },
      ]);
      mockExec.mockResolvedValueOnce({ stdout: output, stderr: '' } as never);

      const results = await bridge.listOrgs();

      expect(results).toHaveLength(1);
      expect(results[0].org.alias).toBe('first');
    });

    it('should combine nonScratchOrgs and scratchOrgs', async () => {
      const output = makeSfOrgListOutput(
        [
          {
            orgId: '00D1',
            username: 'admin@prod.com',
            instanceUrl: 'https://prod.my.salesforce.com',
            connectedStatus: 'Connected',
            isSandbox: false,
          },
        ],
        [
          {
            orgId: '00D9',
            username: 'dev@scratch.com',
            instanceUrl: 'https://scratch.my.salesforce.com',
            connectedStatus: 'Connected',
            isScratchOrg: true,
          },
        ],
      );
      mockExec.mockResolvedValueOnce({ stdout: output, stderr: '' } as never);

      const results = await bridge.listOrgs();

      expect(results).toHaveLength(2);
      expect(results[1].org.orgType).toBe('Scratch');
    });

    it('should include orgs from sandboxes bucket (SF CLI v2)', async () => {
      const output = makeSfOrgListOutput([], [], {
        sandboxes: [
          {
            orgId: '00D5',
            username: 'admin@sandbox.com',
            alias: 'my-sbx',
            instanceUrl: 'https://sbx.sandbox.my.salesforce.com',
            connectedStatus: 'Connected',
            isSandbox: true,
          },
        ],
      });
      mockExec.mockResolvedValueOnce({ stdout: output, stderr: '' } as never);

      const results = await bridge.listOrgs();

      expect(results).toHaveLength(1);
      expect(results[0].org.orgId).toBe('00D5');
      expect(results[0].org.orgType).toBe('Sandbox');
    });

    it('should dedupe across all buckets', async () => {
      const output = makeSfOrgListOutput(
        [
          {
            orgId: '00D1',
            username: 'admin@prod.com',
            alias: 'from-nonScratch',
            instanceUrl: 'https://prod.my.salesforce.com',
            connectedStatus: 'Connected',
          },
        ],
        [],
        {
          sandboxes: [
            {
              orgId: '00D1',
              username: 'admin@prod.com',
              alias: 'from-sandboxes',
              instanceUrl: 'https://prod.my.salesforce.com',
              connectedStatus: 'Connected',
            },
          ],
        },
      );
      mockExec.mockResolvedValueOnce({ stdout: output, stderr: '' } as never);

      const results = await bridge.listOrgs();

      expect(results).toHaveLength(1);
      expect(results[0].org.alias).toBe('from-nonScratch');
    });

    it('should use username as alias when alias is missing', async () => {
      const output = makeSfOrgListOutput([
        {
          orgId: '00D1',
          username: 'admin@prod.com',
          instanceUrl: 'https://prod.my.salesforce.com',
          connectedStatus: 'Connected',
        },
      ]);
      mockExec.mockResolvedValueOnce({ stdout: output, stderr: '' } as never);

      const results = await bridge.listOrgs();

      expect(results[0].org.alias).toBe('admin@prod.com');
    });

    it('should extract JSON when stdout has warnings before JSON', async () => {
      const json = makeSfOrgListOutput([
        {
          orgId: '00D1',
          username: 'admin@prod.com',
          instanceUrl: 'https://prod.my.salesforce.com',
          connectedStatus: 'Connected',
        },
      ]);
      const polluted = `Warning: some deprecation notice\nAnother warning line\n${json}`;
      mockExec.mockResolvedValueOnce({ stdout: polluted, stderr: '' } as never);

      const results = await bridge.listOrgs();

      expect(results).toHaveLength(1);
      expect(results[0].org.orgId).toBe('00D1');
    });

    it('should extract JSON when stdout has ANSI escape codes before JSON', async () => {
      const json = makeSfOrgListOutput([
        {
          orgId: '00D1',
          username: 'admin@prod.com',
          instanceUrl: 'https://prod.my.salesforce.com',
          connectedStatus: 'Connected',
        },
      ]);
      const withAnsi = `\u001b[33mWarning\u001b[0m: some message\n${json}`;
      mockExec.mockResolvedValueOnce({ stdout: withAnsi, stderr: '' } as never);

      const results = await bridge.listOrgs();

      expect(results).toHaveLength(1);
      expect(results[0].org.orgId).toBe('00D1');
    });

    it('should throw meaningful error when stdout contains no JSON', async () => {
      mockExec.mockResolvedValueOnce({
        stdout: 'Error: something went wrong\nNo JSON here',
        stderr: '',
      } as never);

      await expect(bridge.listOrgs()).rejects.toThrow('No JSON found in output');
    });

    it('should throw meaningful error when JSON is malformed', async () => {
      mockExec.mockResolvedValueOnce({ stdout: '{broken json', stderr: '' } as never);

      await expect(bridge.listOrgs()).rejects.toThrow('Failed to parse SF CLI JSON');
    });

    it('should parse JSON from non-zero exit code (SF CLI error with JSON output)', async () => {
      const output = makeSfOrgListOutput([
        {
          orgId: '00D1',
          username: 'admin@prod.com',
          instanceUrl: 'https://prod.my.salesforce.com',
          connectedStatus: 'Connected',
        },
      ]);
      const err = new Error('Command failed: sf org list --json') as Error & {
        stdout: string;
        stderr: string;
        code: number;
      };
      err.stdout = output;
      err.stderr = '';
      err.code = 1;
      mockExec.mockRejectedValueOnce(err as never);

      const results = await bridge.listOrgs();

      expect(results).toHaveLength(1);
      expect(results[0].org.orgId).toBe('00D1');
    });

    it('should throw when exec fails with no stdout', async () => {
      const err = new Error('Command failed') as Error & { stdout: string; stderr: string };
      err.stdout = '';
      err.stderr = 'sf: command not found';
      mockExec.mockRejectedValueOnce(err as never);

      await expect(bridge.listOrgs()).rejects.toThrow('SF CLI failed with no output');
    });
  });

  describe('loginWeb', () => {
    it('should call sf org login web with alias and instanceUrl', async () => {
      mockCliInvoker.mockResolvedValueOnce({ stdout: '', stderr: '' } as never);

      await bridge.loginWeb('my-org', 'https://login.salesforce.com');

      if (process.platform === 'win32') {
        // Windows: shell-based exec with double-quoted, regex-validated values
        expect(mockExec).toHaveBeenCalledWith(
          'sf org login web --instance-url "https://login.salesforce.com" --alias "my-org"',
          expect.objectContaining({
            timeout: 120_000,
            maxBuffer: 10 * 1024 * 1024,
            windowsHide: true,
          }),
        );
      } else {
        // POSIX: argv-as-array execFile — no shell, no interpolation
        expect(mockExecFile).toHaveBeenCalledWith(
          'sf',
          ['org', 'login', 'web', '--instance-url', 'https://login.salesforce.com', '--alias', 'my-org'],
          expect.objectContaining({
            timeout: 120_000,
            maxBuffer: 10 * 1024 * 1024,
            windowsHide: true,
          }),
        );
      }
    });

    it('should omit --alias when alias is empty', async () => {
      mockCliInvoker.mockResolvedValueOnce({ stdout: '', stderr: '' } as never);

      await bridge.loginWeb('', 'https://test.salesforce.com');

      if (process.platform === 'win32') {
        expect(mockExec).toHaveBeenCalledWith(
          'sf org login web --instance-url "https://test.salesforce.com"',
          expect.objectContaining({
            timeout: 120_000,
            maxBuffer: 10 * 1024 * 1024,
            windowsHide: true,
          }),
        );
      } else {
        expect(mockExecFile).toHaveBeenCalledWith(
          'sf',
          ['org', 'login', 'web', '--instance-url', 'https://test.salesforce.com'],
          expect.objectContaining({
            timeout: 120_000,
            maxBuffer: 10 * 1024 * 1024,
            windowsHide: true,
          }),
        );
      }
    });

    it('should reject a malicious alias to prevent shell injection', async () => {
      await expect(
        bridge.loginWeb('my-org; rm -rf /', 'https://login.salesforce.com'),
      ).rejects.toThrow('Invalid alias format');
      expect(mockExec).not.toHaveBeenCalled();
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('should reject an alias with shell metacharacters', async () => {
      await expect(
        bridge.loginWeb('org"$(whoami)"', 'https://login.salesforce.com'),
      ).rejects.toThrow('Invalid alias format');
      expect(mockExec).not.toHaveBeenCalled();
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('should reject a non-https instanceUrl', async () => {
      await expect(bridge.loginWeb('my-org', 'http://login.salesforce.com')).rejects.toThrow(
        'Invalid instanceUrl',
      );
      expect(mockExec).not.toHaveBeenCalled();
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('should reject a malformed instanceUrl', async () => {
      await expect(bridge.loginWeb('my-org', 'not a url')).rejects.toThrow('Invalid instanceUrl');
      expect(mockExec).not.toHaveBeenCalled();
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('should reject an instanceUrl with shell metacharacters in the hostname', async () => {
      await expect(
        bridge.loginWeb('my-org', 'https://login.salesforce.com";rm -rf /'),
      ).rejects.toThrow('Invalid instanceUrl');
      expect(mockExec).not.toHaveBeenCalled();
      expect(mockExecFile).not.toHaveBeenCalled();
    });
  });
});
