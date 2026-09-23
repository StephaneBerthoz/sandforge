import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SfdxBridge } from './SfdxBridge';
import type { CliTokenReader, SfdxImportResult, SfdxUnreadableOrg } from './SfdxBridge';

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
 * `getDefaultOrgUsername` branches on `process.platform`:
 * - Windows uses `exec` (shell required for `sf.cmd` PATHEXT resolution)
 * - POSIX uses `execFile` with argv-as-array (no shell — no interpolation)
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

/** What CLI 2.150 prints where each org's access token was. */
const REDACTED = "[REDACTED] Use 'sf org auth show-access-token' to view";

/** The token the stand-in CLI reads for `username`. */
function liveTokenOf(username: string): string {
  return `00Dlive!${username}`;
}

describe('SfdxBridge', () => {
  let bridge: SfdxBridge;
  let readToken: ReturnType<typeof vi.fn<CliTokenReader>>;

  beforeEach(() => {
    vi.clearAllMocks();
    readToken = vi.fn<CliTokenReader>(async (username) => ({
      accessToken: liveTokenOf(username),
    }));
    bridge = new SfdxBridge(readToken);
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
            status: 'Active',
            isExpired: false,
            isScratch: true,
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

  /**
   * CLI 2.150 prints a placeholder where each org's access token was. Stored
   * as the token, it failed the first call made with it.
   */
  describe('an org whose token sf org list hides', () => {
    const UAT = {
      orgId: '00D000000000001AAA',
      username: 'admin@uat.example',
      alias: 'uat',
      instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
      accessToken: REDACTED,
      connectedStatus: 'Connected',
      isSandbox: true,
    };
    const DEV = {
      ...UAT,
      orgId: '00D000000000002AAA',
      username: 'admin@dev.example',
      alias: 'dev',
      instanceUrl: 'https://acme--dev.sandbox.my.salesforce.com',
    };

    function listing(...orgs: Record<string, unknown>[]): void {
      mockExec.mockResolvedValueOnce({ stdout: makeSfOrgListOutput(orgs), stderr: '' } as never);
    }

    it.each([
      ['the placeholder', REDACTED],
      ['no token at all', undefined],
    ])('stores the token the CLI reads for an org listed with %s', async (_label, accessToken) => {
      listing({ ...UAT, accessToken });

      const [imported] = await bridge.listOrgs();

      expect(readToken).toHaveBeenCalledWith('admin@uat.example');
      expect(imported.credentials.accessToken).toBe(liveTokenOf('admin@uat.example'));
    });

    it('reads no token for an org whose listed token can be used', async () => {
      listing({ ...UAT, accessToken: '00D000000000001AAA!listed-session' });

      const [imported] = await bridge.listOrgs();

      expect(readToken).not.toHaveBeenCalled();
      expect(imported.credentials.accessToken).toBe('00D000000000001AAA!listed-session');
    });

    it('stores the instance the CLI read the token for', async () => {
      listing(UAT);
      readToken.mockResolvedValueOnce({
        accessToken: '00D000000000001AAA!live-session',
        instanceUrl: 'https://acme--uat2.sandbox.my.salesforce.com',
      });

      const [imported] = await bridge.listOrgs();

      expect(imported.org.instanceUrl).toBe('https://acme--uat2.sandbox.my.salesforce.com');
      expect(imported.credentials.instanceUrl).toBe('https://acme--uat2.sandbox.my.salesforce.com');
    });

    it('leaves out an org the CLI gives no token for, says which and why, and imports the others', async () => {
      listing(UAT, DEV);
      readToken.mockImplementation(async (username) => {
        if (username === 'admin@uat.example') {
          throw new Error('sf did not answer within 30 s — check the Salesforce CLI');
        }
        return { accessToken: liveTokenOf(username) };
      });
      const unreadable: SfdxUnreadableOrg[] = [];

      const results = await bridge.listOrgs((org) => {
        unreadable.push(org);
      });

      expect(results.map(({ org }) => org.alias)).toEqual(['dev']);
      expect(unreadable).toEqual([
        {
          username: 'admin@uat.example',
          alias: 'uat',
          orgId: '00D000000000001AAA',
          reason: 'sf did not answer within 30 s — check the Salesforce CLI',
        },
      ]);
    });

    it('leaves out an org the CLI hands the placeholder back for', async () => {
      listing(UAT);
      readToken.mockResolvedValueOnce({ accessToken: REDACTED });
      const unreadable: SfdxUnreadableOrg[] = [];

      const results = await bridge.listOrgs((org) => {
        unreadable.push(org);
      });

      expect(results).toEqual([]);
      expect(unreadable.map((org) => org.reason)).toEqual([
        'the Salesforce CLI showed no usable access token',
      ]);
    });

    it('reads four tokens at a time, and every one of them', async () => {
      listing(
        ...Array.from({ length: 10 }, (_, i) => ({
          ...UAT,
          orgId: `00D00000000000${i}AAA`,
          username: `admin${i}@example.com`,
          alias: `org-${i}`,
        })),
      );
      let reading = 0;
      let most = 0;
      readToken.mockImplementation(async (username) => {
        reading += 1;
        most = Math.max(most, reading);
        await new Promise((resolve) => setImmediate(resolve));
        reading -= 1;
        return { accessToken: liveTokenOf(username) };
      });

      const results = await bridge.listOrgs();

      expect(results).toHaveLength(10);
      expect(readToken).toHaveBeenCalledTimes(10);
      expect(most).toBe(4);
    });

    /**
     * Without a reader of its own, the bridge reads the token the way the
     * connection helper refreshes one. POSIX is forced so the argv is checked
     * on every CI host.
     */
    describe('through the CLI', () => {
      const realPlatform = process.platform;

      beforeEach(() => {
        Object.defineProperty(process, 'platform', { value: 'linux' });
      });

      afterEach(() => {
        Object.defineProperty(process, 'platform', { value: realPlatform });
        // An answer left unread must not reach the next test.
        mockExecFile.mockReset();
      });

      it('asks sf org auth show-access-token for the token, and stores the one it shows', async () => {
        listing(UAT);
        mockExecFile
          .mockResolvedValueOnce({
            stdout: JSON.stringify({
              status: 0,
              result: { instanceUrl: UAT.instanceUrl, accessToken: REDACTED },
            }),
            stderr: '',
          } as never)
          .mockResolvedValueOnce({
            stdout: JSON.stringify({
              status: 0,
              result: { accessToken: '00D000000000001AAA!live-session' },
            }),
            stderr: '',
          } as never);

        const [imported] = await new SfdxBridge().listOrgs();

        expect(mockExecFile).toHaveBeenCalledWith(
          'sf',
          ['org', 'auth', 'show-access-token', '-o', 'admin@uat.example', '--json'],
          expect.objectContaining({ timeout: 30_000 }),
        );
        expect(imported.credentials.accessToken).toBe('00D000000000001AAA!live-session');
      });
    });
  });

  /**
   * The answer `sf org list --json` (CLI 2.150) gives, key for key, with the
   * values replaced. A pinged org carries `connectedStatus`; a scratch org
   * sits in its own bucket with the Dev Hub's `status` and no
   * `connectedStatus`; the type is in `isSandbox` and `isScratch`, the edition
   * in `orgEdition`, and `name` is the org's own name. Sandboxes and Dev Hubs
   * are listed twice, once in `nonScratchOrgs`. Every token is the
   * placeholder, as the CLI prints it.
   */
  describe('a real sf org list --json answer', () => {
    const pinged = (org: {
      orgId: string;
      alias: string;
      name: string;
      isSandbox: boolean;
      isDevHub?: boolean;
      orgEdition: string;
      connectedStatus?: string;
    }): Record<string, unknown> => ({
      accessToken: REDACTED,
      instanceUrl: `https://${org.alias}.my.salesforce.com`,
      orgId: org.orgId,
      username: `admin@${org.alias}.example`,
      loginUrl: 'https://login.salesforce.com',
      clientId: 'PlatformCLI',
      isDevHub: org.isDevHub ?? false,
      instanceApiVersion: org.isSandbox ? '68.0' : '67.0',
      instanceApiVersionLastRetrieved: '9/22/2026, 10:00:00 PM',
      name: org.name,
      instanceName: 'EU42S',
      namespacePrefix: null,
      isSandbox: org.isSandbox,
      isScratch: false,
      trailExpirationDate: null,
      orgEdition: org.orgEdition,
      tracksSource: false,
      alias: org.alias,
      isDefaultDevHubUsername: false,
      isDefaultUsername: false,
      lastUsed: '2026-09-22T20:00:00.000Z',
      connectedStatus: org.connectedStatus ?? 'Connected',
    });
    const scratch = (org: {
      orgId: string;
      alias: string;
      status: string;
      isExpired: boolean;
    }): Record<string, unknown> => ({
      accessToken: REDACTED,
      instanceUrl: `https://${org.alias}.scratch.my.salesforce.com`,
      orgId: org.orgId,
      username: `test-${org.alias}@example.com`,
      loginUrl: 'https://CS42.salesforce.com',
      clientId: 'PlatformCLI',
      isDevHub: false,
      instanceApiVersion: '67.0',
      instanceApiVersionLastRetrieved: '9/22/2026, 10:00:00 PM',
      name: 'Acme Scratch',
      instanceName: 'CS42',
      namespacePrefix: null,
      isSandbox: false,
      isScratch: true,
      trailExpirationDate: '2026-09-26T17:34:31.000+0000',
      orgEdition: 'Developer Edition',
      devHubUsername: 'admin@hub.example',
      created: '2026-09-19T17:34:31.000+0000',
      expirationDate: '2026-09-26',
      createdOrgInstance: 'CS42',
      tracksSource: true,
      alias: org.alias,
      isDefaultDevHubUsername: false,
      isDefaultUsername: false,
      lastUsed: '2026-09-22T20:00:00.000Z',
      signupUsername: `test-${org.alias}@example.com`,
      createdBy: 'admin@hub.example',
      createdDate: '2026-09-19T17:34:31.000+0000',
      devHubOrgId: '00D00000000000HUB',
      devHubId: '00D00000000000HUB',
      attributes: {
        type: 'ScratchOrgInfo',
        url: '/services/data/v67.0/sobjects/ScratchOrgInfo/2SR000000000001AAA',
      },
      orgName: 'Acme Scratch',
      edition: 'Developer',
      status: org.status,
      isExpired: org.isExpired,
      namespace: null,
    });

    function realOrgList(): string {
      const sandbox = pinged({
        orgId: '00D000000000001AAA',
        alias: 'acme-uat',
        name: 'Acme Corp',
        isSandbox: true,
        orgEdition: 'Enterprise Edition',
      });
      const production = pinged({
        orgId: '00D000000000002AAA',
        alias: 'acme-prod',
        name: 'Acme Corp',
        isSandbox: false,
        orgEdition: 'Enterprise Edition',
      });
      const hub = pinged({
        orgId: '00D00000000000HUB',
        alias: 'hub',
        name: 'Acme Hub',
        isSandbox: false,
        isDevHub: true,
        orgEdition: 'Developer Edition',
      });
      const lapsed = pinged({
        orgId: '00D000000000003AAA',
        alias: 'acme-old',
        name: 'Acme Corp',
        isSandbox: true,
        orgEdition: 'Enterprise Edition',
        connectedStatus: 'RefreshTokenAuthError',
      });
      return JSON.stringify({
        status: 0,
        result: {
          other: [production],
          sandboxes: [sandbox, lapsed],
          nonScratchOrgs: [sandbox, lapsed, production, hub],
          devHubs: [hub],
          scratchOrgs: [
            scratch({
              orgId: '00D000000000004AAA',
              alias: 'feature',
              status: 'Active',
              isExpired: false,
            }),
            scratch({
              orgId: '00D000000000005AAA',
              alias: 'spent',
              status: 'Expired',
              isExpired: true,
            }),
          ],
        },
        warnings: [],
      });
    }

    async function importReal(): Promise<Map<string, SfdxImportResult['org']>> {
      mockExec.mockResolvedValueOnce({ stdout: realOrgList(), stderr: '' } as never);
      const results = await bridge.listOrgs();
      return new Map(results.map(({ org }) => [org.orgId, org]));
    }

    it('stores for each org imported the token the CLI reads for it, never the placeholder', async () => {
      mockExec.mockResolvedValueOnce({ stdout: realOrgList(), stderr: '' } as never);

      const results = await bridge.listOrgs();

      expect(results).toHaveLength(4);
      for (const { org, credentials } of results) {
        expect(credentials.accessToken).toBe(liveTokenOf(org.username));
      }
      // One read per org imported; none for the orgs left out.
      expect(readToken.mock.calls.map(([username]) => username).sort()).toEqual([
        'admin@acme-prod.example',
        'admin@acme-uat.example',
        'admin@hub.example',
        'test-feature@example.com',
      ]);
    });

    it('imports an active scratch org as a scratch org, at the lowest safety tier', async () => {
      const orgs = await importReal();

      expect(orgs.get('00D000000000004AAA')).toMatchObject({
        orgType: 'Scratch',
        safetyTier: 'low',
      });
    });

    it('leaves out a scratch org its Dev Hub reports expired, and a pinged org it cannot reach', async () => {
      const orgs = await importReal();

      expect(orgs.has('00D000000000005AAA')).toBe(false);
      expect(orgs.has('00D000000000003AAA')).toBe(false);
      expect([...orgs.keys()].sort()).toEqual([
        '00D000000000001AAA',
        '00D000000000002AAA',
        '00D000000000004AAA',
        '00D00000000000HUB',
      ]);
    });

    it("records the edition the CLI reports, never the org's name", async () => {
      const orgs = await importReal();

      expect(orgs.get('00D000000000001AAA')?.metadata.edition).toBe('Enterprise Edition');
      expect(orgs.get('00D000000000002AAA')?.metadata.edition).toBe('Enterprise Edition');
      expect(orgs.get('00D000000000004AAA')?.metadata.edition).toBe('Developer Edition');
    });

    it('types sandboxes and production orgs from their flags', async () => {
      const orgs = await importReal();

      expect(orgs.get('00D000000000001AAA')?.orgType).toBe('Sandbox');
      expect(orgs.get('00D000000000002AAA')?.orgType).toBe('Production');
      expect(orgs.get('00D00000000000HUB')?.orgType).toBe('Production');
    });
  });

  /** What reaches the CLI on success is checked in SfdxBridge.login.test.ts. */
  describe('loginWeb', () => {
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

    it('should reject a host that is not a Salesforce login host', async () => {
      await expect(bridge.loginWeb('my-org', 'https://evil.example.com')).rejects.toThrow(
        'Invalid instanceUrl',
      );
      expect(mockExec).not.toHaveBeenCalled();
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    /**
     * The Windows branch builds a shell string, and the hostname check alone
     * let the path through: `https://login.salesforce.com/"&calc&"` passed and
     * reached cmd.exe. The platform is forced so this runs on every CI host.
     */
    describe('on Windows', () => {
      const realPlatform = process.platform;

      beforeEach(() => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
      });

      afterEach(() => {
        Object.defineProperty(process, 'platform', { value: realPlatform });
      });

      it.each([
        ['a quoted command', 'https://login.salesforce.com/"&calc&"'],
        ['an environment variable', 'https://login.salesforce.com/%PATH%'],
      ])('throws on %s in the path before any shell runs', async (_label, instanceUrl) => {
        await expect(bridge.loginWeb('my-org', instanceUrl)).rejects.toThrow('Invalid instanceUrl');
        expect(mockExec).not.toHaveBeenCalled();
        expect(mockExecFile).not.toHaveBeenCalled();
      });
    });
  });

  describe('getDefaultOrgUsername', () => {
    it('returns the target-org value reported by the CLI', async () => {
      const json = JSON.stringify({
        result: [{ key: 'target-org', value: 'ACME-DEV', success: true }],
      });
      mockCliInvoker.mockResolvedValueOnce({ stdout: json, stderr: '' } as never);

      await expect(bridge.getDefaultOrgUsername()).resolves.toBe('ACME-DEV');
    });

    it('accepts the legacy targetusername key', async () => {
      const json = JSON.stringify({
        result: [{ key: 'targetusername', value: 'dev@example.com', success: true }],
      });
      mockCliInvoker.mockResolvedValueOnce({ stdout: json, stderr: '' } as never);

      await expect(bridge.getDefaultOrgUsername()).resolves.toBe('dev@example.com');
    });

    it('returns undefined when no default is configured', async () => {
      const json = JSON.stringify({ result: [] });
      mockCliInvoker.mockResolvedValueOnce({ stdout: json, stderr: '' } as never);

      await expect(bridge.getDefaultOrgUsername()).resolves.toBeUndefined();
    });

    it('returns undefined when the CLI call fails — never throws', async () => {
      mockCliInvoker.mockRejectedValueOnce(new Error('sf not found') as never);

      await expect(bridge.getDefaultOrgUsername()).resolves.toBeUndefined();
    });

    it('returns undefined on unparseable output', async () => {
      mockCliInvoker.mockResolvedValueOnce({ stdout: 'not json at all', stderr: '' } as never);

      await expect(bridge.getDefaultOrgUsername()).resolves.toBeUndefined();
    });
  });
});
