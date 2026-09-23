import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SfdxBridge } from './SfdxBridge';
import type { CliTokenReader, JwtLoginRequest } from './SfdxBridge';

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
}));

import { exec, execFile } from 'child_process';

/** What the fake CLI prints and how it exits for one run. */
interface FakeRun {
  stdout?: string;
  stderr?: string;
  error?: Error & { killed?: boolean };
  /** Never call back, as a CLI whose child keeps the pipe open. */
  hang?: boolean;
}

/** One process start, as the process boundary saw it. */
interface SeenCall {
  file?: string;
  args?: string[];
  /** Windows: the command line `exec` was given. */
  command?: string;
  stdin: string;
  stdinEnded: boolean;
  /** The child's stdin, to emit on as the pipe would. */
  stdinStream?: EventEmitter;
}

type Callback = (error: FakeRun['error'] | null, stdout: string, stderr: string) => void;

/**
 * The `sf` CLI at the process boundary: every start is recorded with its argv
 * (or command line) and what was written to its stdin, and answered from the
 * script in order.
 */
function scriptCli(runs: FakeRun[]): SeenCall[] {
  const calls: SeenCall[] = [];
  const start = (call: SeenCall, callback: Callback): unknown => {
    calls.push(call);
    const run = runs.shift() ?? {};
    if (!run.hang) {
      setImmediate(() => callback(run.error ?? null, run.stdout ?? '', run.stderr ?? ''));
    }
    // An emitter, as the real stdin is: an 'error' nobody listens to throws.
    const stdin = Object.assign(new EventEmitter(), {
      end: (data?: string) => {
        call.stdin += data ?? '';
        call.stdinEnded = true;
      },
    });
    call.stdinStream = stdin;
    return { pid: 4242, stdin };
  };
  vi.mocked(execFile).mockImplementation(((
    file: string,
    args: string[],
    _options: unknown,
    callback: Callback,
  ) => start({ file, args, stdin: '', stdinEnded: false }, callback)) as never);
  vi.mocked(exec).mockImplementation(((command: string, _options: unknown, callback: Callback) =>
    start({ command, stdin: '', stdinEnded: false }, callback)) as never);
  return calls;
}

/** A successful `sf org login … --json` document, access token redacted as the CLI prints it. */
function loginOutput(result: Record<string, unknown>): string {
  return JSON.stringify({
    status: 0,
    result: {
      accessToken: "[REDACTED] Use 'sf org auth show-access-token' to view",
      ...result,
    },
    warnings: ["Secrets are now hidden from 'sf org login jwt' command output."],
  });
}

const JWT_REQUEST: JwtLoginRequest = {
  username: 'integration@example.com',
  clientId: '3MVG9FakeConsumerKey.ForTests_Only',
  keyFile: '/home/someone/keys/server key "prod" $(touch pwned).key',
  loginUrl: 'https://test.salesforce.com',
  alias: 'ci-sandbox',
};

const SIGNED_IN = {
  username: 'integration@example.com',
  orgId: '00D000000000001AAA',
  instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
};

// These read the argv sf receives from a POSIX spawn. On Windows the command
// goes through cmd.exe instead, quoted, and a path holding a quote is refused
// there: the Windows suite checks that path with the platform stubbed.
describe.skipIf(process.platform === 'win32')('SfdxBridge.loginJwt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs sf org login jwt with the key file path as one untouched argv entry, and no shell', async () => {
    const calls = scriptCli([{ stdout: loginOutput(SIGNED_IN) }]);

    await new SfdxBridge().loginJwt(JWT_REQUEST);

    expect(exec).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('sf');
    expect(calls[0].args).toEqual([
      'org',
      'login',
      'jwt',
      '--username',
      'integration@example.com',
      '--jwt-key-file',
      '/home/someone/keys/server key "prod" $(touch pwned).key',
      '--client-id',
      '3MVG9FakeConsumerKey.ForTests_Only',
      '--instance-url',
      'https://test.salesforce.com',
      '--alias',
      'ci-sandbox',
      '--json',
    ]);
    // Nothing is fed to the CLI, and its stdin is closed so no prompt can wait.
    expect(calls[0].stdin).toBe('');
    expect(calls[0].stdinEnded).toBe(true);
  });

  it('returns the org the CLI signed in to', async () => {
    scriptCli([{ stdout: loginOutput(SIGNED_IN) }]);

    expect(await new SfdxBridge().loginJwt(JWT_REQUEST)).toEqual(SIGNED_IN);
  });

  it('leaves the alias out when none is given', async () => {
    const calls = scriptCli([{ stdout: loginOutput(SIGNED_IN) }]);

    await new SfdxBridge().loginJwt({ ...JWT_REQUEST, alias: undefined });

    expect(calls[0].args).not.toContain('--alias');
  });

  it('passes the origin of the login URL, never the raw string', async () => {
    const calls = scriptCli([{ stdout: loginOutput(SIGNED_IN) }]);

    await new SfdxBridge().loginJwt({
      ...JWT_REQUEST,
      loginUrl: 'https://Acme.my.salesforce.com/',
    });

    const args = calls[0].args ?? [];
    expect(args[args.indexOf('--instance-url') + 1]).toBe('https://acme.my.salesforce.com');
  });

  it('refuses a login URL off Salesforce before anything runs', async () => {
    const calls = scriptCli([]);

    await expect(
      new SfdxBridge().loginJwt({ ...JWT_REQUEST, loginUrl: 'https://evil.example.com' }),
    ).rejects.toThrow('Invalid instanceUrl');
    expect(calls).toHaveLength(0);
  });

  it("surfaces the CLI's own message when it refuses the login", async () => {
    // What sf prints with --json when the JWT grant fails: the document is on
    // stdout and the process exits 1.
    scriptCli([
      {
        stdout: JSON.stringify({
          name: 'JwtGrantError',
          message:
            "We encountered a JSON web token error, which is likely not an issue with Salesforce CLI. Here's the error: invalid_grant: user hasn't approved this consumer",
          exitCode: 1,
          status: 1,
          commandName: 'LoginJwt',
        }),
        error: Object.assign(new Error('Command failed: sf org login jwt'), { code: 1 }),
      },
    ]);

    await expect(new SfdxBridge().loginJwt(JWT_REQUEST)).rejects.toThrow(
      "We encountered a JSON web token error, which is likely not an issue with Salesforce CLI. Here's the error: invalid_grant: user hasn't approved this consumer",
    );
  });

  it('surfaces the first line the CLI wrote to stderr when it printed no JSON', async () => {
    scriptCli([
      {
        stderr: ' ›   Warning: org login jwt is not a sf command.\n ›   Error: Run sf help org',
        error: Object.assign(new Error('Command failed'), { code: 127 }),
      },
    ]);

    await expect(new SfdxBridge().loginJwt(JWT_REQUEST)).rejects.toThrow(
      '›   Warning: org login jwt is not a sf command.',
    );
  });

  it('says the login did not finish when the CLI is killed on its timeout', async () => {
    scriptCli([{ error: Object.assign(new Error('Command failed'), { killed: true }) }]);

    await expect(new SfdxBridge().loginJwt(JWT_REQUEST)).rejects.toThrow(
      'sf org login jwt did not finish within 60 s.',
    );
  });

  it('refuses a success that does not name the org it signed in to', async () => {
    scriptCli([{ stdout: JSON.stringify({ status: 0, result: {} }) }]);

    await expect(new SfdxBridge().loginJwt(JWT_REQUEST)).rejects.toThrow(
      'sf org login jwt succeeded but did not say which org it signed in to.',
    );
  });

  describe('when a CLI child keeps the run open past its timeout', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('stops waiting two seconds after the timeout and says so', async () => {
      scriptCli([{ hang: true }]);

      const login = new SfdxBridge().loginJwt(JWT_REQUEST);
      const settled = expect(login).rejects.toThrow('sf org login jwt did not finish within 60 s.');
      await vi.advanceTimersByTimeAsync(62_000);

      await settled;
    });
  });
});

describe('SfdxBridge.loginJwt on Windows', () => {
  const realPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, 'platform', { value: 'win32' });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
  });

  it('double-quotes every argument on the command line cmd.exe runs', async () => {
    const calls = scriptCli([{ stdout: loginOutput(SIGNED_IN) }]);

    await new SfdxBridge().loginJwt({
      ...JWT_REQUEST,
      keyFile: 'C:\\Users\\Jane Doe\\keys (old)\\server&prod.key',
    });

    expect(execFile).not.toHaveBeenCalled();
    expect(calls[0].command).toBe(
      'sf "org" "login" "jwt" "--username" "integration@example.com" ' +
        '"--jwt-key-file" "C:\\Users\\Jane Doe\\keys (old)\\server&prod.key" ' +
        '"--client-id" "3MVG9FakeConsumerKey.ForTests_Only" ' +
        '"--instance-url" "https://test.salesforce.com" "--alias" "ci-sandbox" "--json"',
    );
  });

  it.each([
    ['a percent sign', 'C:\\keys\\%USERPROFILE%.key'],
    ['an exclamation mark', 'C:\\keys\\!secret!.key'],
    ['a double quote', 'C:\\keys\\a" & calc & ".key'],
    ['a line break', 'C:\\keys\\a\r\ncalc.key'],
  ])('refuses a key file path holding %s before anything runs', async (_label, keyFile) => {
    const calls = scriptCli([]);

    await expect(new SfdxBridge().loginJwt({ ...JWT_REQUEST, keyFile })).rejects.toThrow(
      'The private key file path cannot contain ", %, ! or control characters on Windows',
    );
    expect(calls).toHaveLength(0);
  });
});

describe('SfdxBridge.loginWeb', () => {
  const realPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
  });

  it('runs sf org login web with the login origin, the alias and --json, and no shell', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const calls = scriptCli([{ stdout: loginOutput(SIGNED_IN) }]);

    await new SfdxBridge().loginWeb('my-org', 'https://Acme.my.salesforce.com/');

    expect(exec).not.toHaveBeenCalled();
    expect(calls[0].file).toBe('sf');
    expect(calls[0].args).toEqual([
      'org',
      'login',
      'web',
      '--instance-url',
      'https://acme.my.salesforce.com',
      '--alias',
      'my-org',
      '--json',
    ]);
    expect(calls[0].stdinEnded).toBe(true);
  });

  it('leaves the alias out when none is given', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const calls = scriptCli([{ stdout: loginOutput(SIGNED_IN) }]);

    await new SfdxBridge().loginWeb('', 'https://test.salesforce.com');

    expect(calls[0].args).toEqual([
      'org',
      'login',
      'web',
      '--instance-url',
      'https://test.salesforce.com',
      '--json',
    ]);
  });

  it('double-quotes every argument on the command line cmd.exe runs', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const calls = scriptCli([{ stdout: loginOutput(SIGNED_IN) }]);

    await new SfdxBridge().loginWeb('my-org', 'https://Acme.my.salesforce.com/');

    expect(execFile).not.toHaveBeenCalled();
    expect(calls[0].command).toBe(
      'sf "org" "login" "web" "--instance-url" "https://acme.my.salesforce.com" "--alias" "my-org" "--json"',
    );
  });

  it('returns the org the CLI signed in to', async () => {
    scriptCli([{ stdout: loginOutput(SIGNED_IN) }]);

    expect(await new SfdxBridge().loginWeb('uat', 'https://test.salesforce.com')).toEqual(
      SIGNED_IN,
    );
  });

  it("surfaces the CLI's own message when the sign-in fails", async () => {
    scriptCli([
      {
        stdout: JSON.stringify({
          status: 1,
          name: 'AuthCodeExchangeError',
          message: 'Error authenticating with auth code due to: invalid_grant',
        }),
        error: Object.assign(new Error('Command failed: sf org login web'), { code: 1 }),
      },
    ]);

    await expect(new SfdxBridge().loginWeb('uat', 'https://test.salesforce.com')).rejects.toThrow(
      'Error authenticating with auth code due to: invalid_grant',
    );
  });

  it('says the sign-in did not finish when the CLI is killed on its timeout', async () => {
    scriptCli([{ error: Object.assign(new Error('Command failed'), { killed: true }) }]);

    await expect(new SfdxBridge().loginWeb('uat', 'https://test.salesforce.com')).rejects.toThrow(
      'sf org login web did not finish within 120 s.',
    );
  });
});

// These read the argv sf receives from a POSIX spawn. On Windows the command
// goes through cmd.exe instead, quoted, and a path holding a quote is refused
// there: the Windows suite checks that path with the platform stubbed.
describe.skipIf(process.platform === 'win32')('SfdxBridge.loginWithRefreshToken', () => {
  const REFRESH_TOKEN = '5Aep861.FAKE_refresh-token-sentinel';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes the authorization URL to the CLI on stdin, never on its command line', async () => {
    const calls = scriptCli([{ stdout: loginOutput(SIGNED_IN) }]);

    const login = await new SfdxBridge().loginWithRefreshToken({
      clientId: '3MVG9FakeConsumerKey.ForTests_Only',
      refreshToken: REFRESH_TOKEN,
      instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
      alias: 'uat',
    });

    expect(login).toEqual(SIGNED_IN);
    expect(calls[0].file).toBe('sf');
    expect(calls[0].args).toEqual([
      'org',
      'login',
      'sfdx-url',
      '--alias',
      'uat',
      '--json',
      '--sfdx-url-stdin',
    ]);
    expect(calls[0].stdin).toBe(
      `force://3MVG9FakeConsumerKey.ForTests_Only::${REFRESH_TOKEN}@acme--uat.sandbox.my.salesforce.com\n`,
    );
    expect(calls[0].stdinEnded).toBe(true);
    expect(JSON.stringify(calls[0].args)).not.toContain(REFRESH_TOKEN);
  });

  it('keeps the token off the command line on Windows too', async () => {
    const realPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const calls = scriptCli([{ stdout: loginOutput(SIGNED_IN) }]);

      await new SfdxBridge().loginWithRefreshToken({
        clientId: '3MVG9FakeConsumerKey.ForTests_Only',
        refreshToken: REFRESH_TOKEN,
        instanceUrl: 'https://acme.my.salesforce.com',
      });

      expect(calls[0].command).toBe('sf "org" "login" "sfdx-url" "--json" "--sfdx-url-stdin"');
      expect(calls[0].stdin).toContain(REFRESH_TOKEN);
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform });
    }
  });

  it('survives a CLI that closed its stdin before the URL was written', async () => {
    const calls = scriptCli([{ stdout: loginOutput(SIGNED_IN) }]);

    const login = new SfdxBridge().loginWithRefreshToken({
      clientId: '3MVG9FakeConsumerKey.ForTests_Only',
      refreshToken: REFRESH_TOKEN,
      instanceUrl: 'https://acme.my.salesforce.com',
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    // What Node emits on a write to a pipe whose reader is gone: unheard, it
    // would be thrown as an uncaught exception in the extension host.
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    expect(() => calls[0].stdinStream?.emit('error', epipe)).not.toThrow();

    await expect(login).resolves.toEqual(SIGNED_IN);
  });

  it('refuses a token that would break the authorization URL, without quoting it', async () => {
    const calls = scriptCli([]);

    const attempt = new SfdxBridge().loginWithRefreshToken({
      clientId: '3MVG9FakeConsumerKey.ForTests_Only',
      refreshToken: 'secret@evil.example.com:x',
      instanceUrl: 'https://acme.my.salesforce.com',
    });

    await expect(attempt).rejects.toThrow('cannot store (unexpected characters)');
    await expect(attempt).rejects.not.toThrow('secret@evil');
    expect(calls).toHaveLength(0);
  });

  it('refuses an instance that is not a Salesforce host before anything runs', async () => {
    const calls = scriptCli([]);

    await expect(
      new SfdxBridge().loginWithRefreshToken({
        clientId: '3MVG9FakeConsumerKey.ForTests_Only',
        refreshToken: REFRESH_TOKEN,
        instanceUrl: 'https://acme.example.com',
      }),
    ).rejects.toThrow('Invalid instanceUrl');
    expect(calls).toHaveLength(0);
  });

  it("surfaces the CLI's message when it refuses the session", async () => {
    scriptCli([
      {
        stdout: JSON.stringify({
          status: 1,
          name: 'RefreshTokenAuthError',
          message: 'Error authenticating with the refresh token due to: invalid_client',
        }),
        error: Object.assign(new Error('Command failed'), { code: 1 }),
      },
    ]);

    await expect(
      new SfdxBridge().loginWithRefreshToken({
        clientId: '3MVG9FakeConsumerKey.ForTests_Only',
        refreshToken: REFRESH_TOKEN,
        instanceUrl: 'https://acme.my.salesforce.com',
      }),
    ).rejects.toThrow('Error authenticating with the refresh token due to: invalid_client');
  });
});

describe('SfdxBridge.findOrg', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** `sf org list --json` answered through exec, as listOrgs reads it. */
  function orgList(result: Record<string, unknown>): void {
    vi.mocked(exec).mockImplementation(((
      _command: string,
      _options: unknown,
      callback: (error: null, out: { stdout: string; stderr: string }) => void,
    ) => {
      callback(null, { stdout: JSON.stringify({ status: 0, result }), stderr: '' });
    }) as never);
  }

  const ADMIN = {
    orgId: '00D000000000001AAA',
    username: 'admin@example.com',
    alias: 'uat-admin',
    instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
    accessToken: '00D000000000001AAA!admin-session',
    connectedStatus: 'Connected',
    isSandbox: true,
  };
  const INTEGRATION = {
    ...ADMIN,
    username: 'integration@example.com',
    alias: 'uat-ci',
    accessToken: '00D000000000001AAA!integration-session',
  };

  it('finds the user who signed in, even when another user of the same org is listed first', async () => {
    orgList({ nonScratchOrgs: [ADMIN, INTEGRATION], sandboxes: [ADMIN, INTEGRATION] });

    const found = await new SfdxBridge().findOrg('Integration@Example.com');

    expect(found?.org.username).toBe('integration@example.com');
    expect(found?.org.alias).toBe('uat-ci');
    expect(found?.org.orgType).toBe('Sandbox');
    expect(found?.org.authMethod).toBe('sfdx_import');
  });

  it('finds nothing for a user the CLI cannot reach', async () => {
    orgList({ nonScratchOrgs: [{ ...INTEGRATION, connectedStatus: 'Unable to refresh session' }] });

    expect(await new SfdxBridge().findOrg('integration@example.com')).toBeUndefined();
  });

  it('finds nothing for a user the CLI does not hold', async () => {
    orgList({ nonScratchOrgs: [ADMIN] });

    expect(await new SfdxBridge().findOrg('integration@example.com')).toBeUndefined();
  });

  it('reads through the CLI the token of the user found when the listing hides it', async () => {
    orgList({
      nonScratchOrgs: [
        ADMIN,
        { ...INTEGRATION, accessToken: "[REDACTED] Use 'sf org auth show-access-token' to view" },
      ],
    });
    const readToken = vi.fn<CliTokenReader>(async () => ({
      accessToken: '00D000000000001AAA!live-session',
    }));

    const found = await new SfdxBridge(readToken).findOrg('integration@example.com');

    expect(readToken).toHaveBeenCalledTimes(1);
    expect(readToken).toHaveBeenCalledWith('integration@example.com');
    expect(found?.credentials.accessToken).toBe('00D000000000001AAA!live-session');
  });

  it('says which user it could not get a token for, and why, instead of finding it', async () => {
    orgList({ nonScratchOrgs: [{ ...INTEGRATION, accessToken: undefined }] });
    const readToken = vi.fn<CliTokenReader>(async () => {
      throw new Error('sf did not answer within 30 s — check the Salesforce CLI');
    });

    await expect(new SfdxBridge(readToken).findOrg('integration@example.com')).rejects.toThrow(
      'The Salesforce CLI gave no access token for integration@example.com: sf did not answer within 30 s',
    );
  });
});
