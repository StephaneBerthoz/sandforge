import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SfdxBridge } from './SfdxBridge';
import type { CliTokenReader, SfdxImportResult, SfdxUnreadableOrg } from './SfdxBridge';
import { logger } from '../../logger.js';

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

/** What a stand-in `sf` prints, by the way it is started. */
interface ScriptedSf {
  /** `sf org list --json` with its output on the extension's pipes. */
  pipe: { stdout: string; stderr: string };
  /** How long that run lasts, on a clock the test fakes. */
  pipeTakesMs?: number;
  /**
   * The same command with its output sent to files: what it writes into
   * them, or the error its shell exits with after the shell has created them.
   */
  file?: { stdout: string; stderr: string; error?: Error };
  /** What `where sf node` (Windows) or `which -a sf node` prints. */
  where?: string;
  /** What `sf --version` prints. */
  version?: string;
}

/** One start of a process, as `exec` was asked for it. */
interface SeenExec {
  command: string;
  env: NodeJS.ProcessEnv | undefined;
}

/** The redirection `readThroughFiles` writes, in either shell's quotes. */
const REDIRECTED = /^sf org list --json > (['"])([^'"]+)\1 2> (['"])([^'"]+)\3$/;

/**
 * The CLI at the process boundary, answering each command the way the shell
 * would run it. A redirected run gets two files the shell has already created
 * (empty), and writes into them what the script says.
 */
function scriptSf(script: ScriptedSf): SeenExec[] {
  const seen: SeenExec[] = [];
  mockExec.mockImplementation((async (
    command: string,
    options?: { env?: NodeJS.ProcessEnv },
  ): Promise<{ stdout: string; stderr: string }> => {
    seen.push({ command, env: options?.env });
    if (command === 'sf --version') return { stdout: script.version ?? '', stderr: '' };
    if (command === 'sf org list --json') {
      if (script.pipeTakesMs !== undefined) vi.setSystemTime(Date.now() + script.pipeTakesMs);
      return script.pipe;
    }
    const redirected = REDIRECTED.exec(command);
    if (redirected) {
      writeFileSync(redirected[2], script.file?.stdout ?? '');
      writeFileSync(redirected[4], script.file?.stderr ?? '');
      if (script.file?.error) throw script.file.error;
      return { stdout: '', stderr: '' };
    }
    if (command === 'where sf node' || command === 'which -a sf node') {
      return { stdout: script.where ?? '', stderr: '' };
    }
    throw new Error(`The stand-in sf was not scripted for: ${command}`);
  }) as never);
  return seen;
}

describe('SfdxBridge', () => {
  let bridge: SfdxBridge;
  let readToken: ReturnType<typeof vi.fn<CliTokenReader>>;

  beforeEach(() => {
    vi.clearAllMocks();
    // A scripted CLI answers every command it is given: it must not outlive its test.
    mockExec.mockReset();
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
        expect.objectContaining({
          maxBuffer: 10 * 1024 * 1024,
          windowsHide: true,
          // A managed laptop's sf took 13 s to say its version.
          timeout: 30_000,
        }),
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
      expect(results[0].org).not.toHaveProperty('organizationName');
    });

    it("keeps the org's own name the CLI lists, which names an org with no alias in place of its username", async () => {
      const output = makeSfOrgListOutput([
        {
          orgId: '00D1',
          username: 'admin@prod.com',
          instanceUrl: 'https://prod.my.salesforce.com',
          connectedStatus: 'Connected',
          name: ' Example Workspace ',
        },
      ]);
      mockExec.mockResolvedValueOnce({ stdout: output, stderr: '' } as never);

      const results = await bridge.listOrgs();

      expect(results[0].org.organizationName).toBe('Example Workspace');
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

    it('says which command printed nothing, and how to see which sf answered', async () => {
      scriptSf({ pipe: { stdout: '', stderr: '' } });

      await expect(bridge.listOrgs()).rejects.toThrow(
        /sf org list --json ended without an error and printed nothing, so there are no orgs to read\..*(where\.exe|which -a) sf/,
      );
    });

    it('quotes what an sf that printed nothing wrote on stderr', async () => {
      scriptSf({ pipe: { stdout: ' \r\n', stderr: '\nBlocked by policy\nmore' } });

      await expect(bridge.listOrgs()).rejects.toThrow('(it said: Blocked by policy)');
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
   * On a Windows laptop `sf org list --json` printed 40 KB in a terminal of
   * the window and nothing when the extension ran it, without an error. The
   * second run sends its output to a file, and what is said names the sf
   * this window runs, what it printed and how long it ran.
   */
  describe('an sf org list that prints nothing on its pipe', () => {
    const ORG = {
      orgId: '00D000000000001AAA',
      username: 'admin@uat.example',
      alias: 'uat',
      instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
      accessToken: 'token-1',
      connectedStatus: 'Connected',
      isSandbox: true,
    };
    const realPlatform = process.platform;
    let output: string[];

    beforeEach(() => {
      output = [];
      logger.init({ appendLine: (line) => output.push(line) });
    });

    afterEach(() => {
      Object.defineProperty(process, 'platform', { value: realPlatform });
      mockExec.mockReset();
    });

    /** The paths of the two files the redirected run of `seen` wrote to. */
    function redirectedFiles(seen: SeenExec[]): string[] {
      const run = seen.map((call) => REDIRECTED.exec(call.command)).find((match) => match !== null);
      return run ? [run[2], run[4]] : [];
    }

    it('reads the orgs from a file the second run sends its output to, then removes the file', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const seen = scriptSf({
        pipe: { stdout: '', stderr: '' },
        file: { stdout: makeSfOrgListOutput([ORG]), stderr: '' },
        where: '/usr/local/bin/sf\n/usr/local/bin/node\n',
      });

      const results = await bridge.listOrgs();

      expect(results.map((r) => r.org.orgId)).toEqual(['00D000000000001AAA']);
      const files = redirectedFiles(seen);
      expect(files).toHaveLength(2);
      expect(seen.map((call) => call.command)).toContain(
        `sf org list --json > '${files[0]}' 2> '${files[1]}'`,
      );
      expect(existsSync(dirname(files[0]))).toBe(false);
      expect(output.join('\n')).toMatch(
        /sf org list --json printed nothing on its pipe; what it wrote to a file was read instead\..*sf found: \/usr\/local\/bin\/sf; node found: \/usr\/local\/bin\/node/,
      );
    });

    it('says which sf this window runs, what its sf --version printed and how long it ran', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const home = homedir();
      scriptSf({
        version: '@salesforce/cli/2.156.8 linux-x64 node-v22.15.1\n',
        pipe: { stdout: '', stderr: '' },
        file: { stdout: '', stderr: '' },
        where: `${home}/.npm-global/bin/sf\n/usr/bin/sf\n${home}/.nvm/node\n`,
      });

      await bridge.isCliAvailable();
      const failure = await bridge.listOrgs().then(
        () => undefined,
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );

      expect(failure).toMatch(/It ran \d+\.\d s and exited with code 0\./);
      expect(failure).toMatch(
        /Run again with its output sent to a file, it ended with exit code 0 after \d+\.\d s, with 0 chars in its stdout file and 0 in its stderr file\./,
      );
      expect(failure).toContain(
        'This window runs ~/.npm-global/bin/sf (sf is found in 2 folders of its PATH)',
      );
      expect(failure).toContain(
        'and its sf --version says @salesforce/cli/2.156.8 linux-x64 node-v22.15.1',
      );
      expect(failure).not.toContain(home);
      const logged = output.join('\n');
      expect(logged).toContain('sf org list --json printed nothing, on its pipe or to a file.');
      expect(logged).toMatch(
        /first run: \d+\.\d s of the 30 s allowed, exit code 0, stdout 0 chars, stderr 0 chars;/,
      );
      expect(logged).toMatch(
        /run with its output sent to files: ended with exit code 0 after \d+\.\d s, with 0 chars in its stdout file and 0 in its stderr file;/,
      );
      expect(logged).toContain(
        'sf found: ~/.npm-global/bin/sf | /usr/bin/sf; node found: ~/.nvm/node',
      );
      expect(logged).toContain('sf --version: "@salesforce/cli/2.156.8 linux-x64 node-v22.15.1"');
      expect(logged).toContain('variables set: ');
      expect(logged).not.toContain(home);
    });

    it('says the run reached its limit when it lasted the 30 s it was allowed', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        scriptSf({
          pipe: { stdout: '', stderr: '' },
          pipeTakesMs: 30_000,
          file: { stdout: '', stderr: '' },
        });

        await expect(bridge.listOrgs()).rejects.toThrow(
          'It ran 30.0 s, its 30 s limit, and exited with code 0.',
        );
        expect(output.join('\n')).toContain(
          'first run: 30.0 s of the 30 s allowed (it reached the limit), exit code 0',
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('says how the second run ended and what it wrote on stderr when its shell fails', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      scriptSf({
        pipe: { stdout: '', stderr: '' },
        file: {
          stdout: '',
          stderr: '/bin/sh: 1: sf: not found\n',
          error: Object.assign(new Error('Command failed: sf org list --json'), { code: 127 }),
        },
      });

      await expect(bridge.listOrgs()).rejects.toThrow(
        /it ended with exit code 127 after \d+\.\d s, with 0 chars in its stdout file and 26 in its stderr file \("\/bin\/sh: 1: sf: not found"\)\./,
      );
    });

    it('says the second run could not be made when the temp folder holds a quote', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const quotedTemp = mkdtempSync(join(tmpdir(), "it's-"));
      // os.tmpdir() reads TMPDIR, TMP then TEMP on POSIX but TEMP then TMP on
      // Windows, whatever process.platform says: on the Windows runner, with
      // TMPDIR alone naming this folder, the second run was made in the
      // runner's own temp folder and nothing was refused.
      for (const name of ['TMPDIR', 'TMP', 'TEMP']) vi.stubEnv(name, quotedTemp);
      try {
        expect(tmpdir()).toBe(quotedTemp);
        const seen = scriptSf({ pipe: { stdout: '', stderr: '' } });

        await expect(bridge.listOrgs()).rejects.toThrow(
          'Run again with its output sent to a file, it could not be made (The temporary folder path cannot contain a quote or control characters',
        );
        expect(seen.every((call) => !call.command.includes(' > '))).toBe(true);
        expect(readdirSync(quotedTemp)).toEqual([]);
      } finally {
        vi.unstubAllEnvs();
        rmSync(quotedTemp, { recursive: true, force: true });
      }
    });

    /**
     * cmd.exe gets each file path in double quotes, as every argument it is
     * handed; `where` lists npm's extensionless shell script first, which
     * cmd.exe does not run, so the window's sf is the `.cmd` after it.
     */
    it('on Windows, quotes the files for cmd.exe and names the sf.cmd cmd.exe runs', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      const npm = `${homedir()}\\AppData\\Roaming\\npm`;
      const seen = scriptSf({
        version: '',
        pipe: { stdout: '', stderr: '' },
        file: { stdout: '', stderr: '' },
        where: `${npm}\\sf\r\n${npm}\\sf.cmd\r\nC:\\nvm4w\\nodejs\\sf.cmd\r\nC:\\nvm4w\\nodejs\\node.exe\r\n`,
      });

      await bridge.isCliAvailable();
      const failure = await bridge.listOrgs().then(
        () => undefined,
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );

      const files = redirectedFiles(seen);
      expect(seen.map((call) => call.command)).toContain(
        `sf org list --json > "${files[0]}" 2> "${files[1]}"`,
      );
      expect(seen.map((call) => call.command)).toContain('where sf node');
      expect(failure).toContain(
        'This window runs ~\\AppData\\Roaming\\npm\\sf.cmd (sf is found in 2 folders of its PATH)',
      );
      expect(failure).toContain('and its sf --version printed nothing either');
      expect(failure).toContain('run sf org list --json and where.exe sf');
    });

    it('leaves the pipe alone when sf org list printed its JSON there', async () => {
      const seen = scriptSf({ pipe: { stdout: makeSfOrgListOutput([ORG]), stderr: '' } });

      await bridge.listOrgs();

      expect(seen.map((call) => call.command)).toEqual(['sf org list --json']);
      expect(output).toEqual([]);
    });
  });

  /**
   * The extension host carries variables of VS Code's own processes, among
   * them ELECTRON_RUN_AS_NODE=1; a terminal of the window does not get them,
   * and neither does sf.
   */
  describe('the environment sf runs in', () => {
    const saved = { ...process.env };

    afterEach(() => {
      for (const name of Object.keys(process.env)) {
        if (!(name in saved)) delete process.env[name];
      }
      Object.assign(process.env, saved);
      mockExec.mockReset();
    });

    it('is the host environment without its VS Code variables, colours off', async () => {
      process.env.ELECTRON_RUN_AS_NODE = '1';
      process.env.VSCODE_PID = '4242';
      process.env.HTTPS_PROXY = 'http://proxy.example:8080';
      const seen = scriptSf({ pipe: { stdout: makeSfOrgListOutput([]), stderr: '' } });

      await bridge.listOrgs();

      const env = seen[0].env ?? {};
      expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(env.VSCODE_PID).toBeUndefined();
      expect(env.HTTPS_PROXY).toBe('http://proxy.example:8080');
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.NO_COLOR).toBe('1');
      expect(process.env.ELECTRON_RUN_AS_NODE).toBe('1');
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

    it('keeps the expiration date the CLI lists for a scratch org, and none for the others', async () => {
      const orgs = await importReal();

      expect(orgs.get('00D000000000004AAA')?.metadata.expirationDate).toBe('2026-09-26');
      expect(orgs.get('00D000000000001AAA')?.metadata).not.toHaveProperty('expirationDate');
      expect(orgs.get('00D000000000002AAA')?.metadata).not.toHaveProperty('expirationDate');
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

    it('names each org it leaves out, with what the CLI says of it', async () => {
      // Dropped without a word: with nothing else to import, the page said
      // the CLI "holds no connected org yet".
      mockExec.mockResolvedValueOnce({ stdout: realOrgList(), stderr: '' } as never);
      const left: SfdxUnreadableOrg[] = [];

      await bridge.listOrgs((org) => left.push(org));

      expect(left).toEqual([
        expect.objectContaining({
          alias: 'acme-old',
          reason: 'the CLI reports RefreshTokenAuthError',
          why: 'notConnected',
        }),
        expect.objectContaining({
          alias: 'spent',
          reason: 'a scratch org that expired on 2026-09-26',
          why: 'notConnected',
        }),
      ]);
    });

    it('imports a user of an org the CLI reaches though another user of it listed first cannot', async () => {
      const user = (username: string, connectedStatus: string) => ({
        orgId: '00D000000000007AAA',
        username,
        instanceUrl: 'https://acme.my.salesforce.com',
        connectedStatus,
      });
      mockExec.mockResolvedValueOnce({
        stdout: makeSfOrgListOutput([
          user('old@acme.example', 'RefreshTokenAuthError'),
          user('new@acme.example', 'Connected'),
        ]),
        stderr: '',
      } as never);
      const left: SfdxUnreadableOrg[] = [];

      const results = await bridge.listOrgs((org) => left.push(org));

      expect(results.map(({ org }) => org.username)).toEqual(['new@acme.example']);
      expect(left).toEqual([]);
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
    });

    it('types an org that is no sandbox and says it is a Developer Edition as a Developer org, blue and low', async () => {
      const orgs = await importReal();

      // The Dev Hub of this listing is a Developer Edition org, as a
      // Trailhead playground is: it holds nobody's business.
      expect(orgs.get('00D00000000000HUB')).toMatchObject({
        orgType: 'Developer',
        safetyTier: 'low',
        appearance: { color: '#4a9eff' },
      });
      // An Enterprise Edition org that is no sandbox stays a production org.
      expect(orgs.get('00D000000000002AAA')).toMatchObject({
        orgType: 'Production',
        safetyTier: 'critical',
        appearance: { color: '#e74c3c' },
      });
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
});
