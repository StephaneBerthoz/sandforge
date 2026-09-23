import fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OrgHandler } from './OrgHandler';
import type { HandlerDeps } from './HandlerTypes';
import { SfdxBridge } from '../../core/connection/SfdxBridge';
import { inboundRequest } from '../../test/mockFactories.js';

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
}));

import { exec, execFile } from 'child_process';

/**
 * JWT sign-in, from the `org:connect` the page sends to the org it saves,
 * through the real SfdxBridge. Only the `sf` process is stood in for: every
 * start is recorded with its argv, and answered as the CLI answers.
 */

/** Content of the key file on disk: if any of it shows up anywhere, the file was read. */
const KEY_SENTINEL = 'KEY-CONTENT-SENTINEL-4f1c9a';
const KEY_PEM = `-----BEGIN PRIVATE KEY-----\n${KEY_SENTINEL}\n-----END PRIVATE KEY-----\n`;

const SIGNED_IN = {
  username: 'integration@example.com',
  orgId: '00D000000000001AAA',
  instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
};

const ORG_LIST = {
  status: 0,
  result: {
    nonScratchOrgs: [
      {
        orgId: '00D000000000001AAA',
        username: 'admin@example.com',
        alias: 'uat-admin',
        instanceUrl: SIGNED_IN.instanceUrl,
        accessToken: '00D000000000001AAA!admin-session',
        connectedStatus: 'Connected',
        isSandbox: true,
      },
      {
        orgId: '00D000000000001AAA',
        username: 'integration@example.com',
        alias: 'ci-sandbox',
        instanceUrl: SIGNED_IN.instanceUrl,
        accessToken: '00D000000000001AAA!integration-session',
        connectedStatus: 'Connected',
        isSandbox: true,
      },
    ],
  },
};

type ExecCallback = (error: Error | null, result: { stdout: string; stderr: string }) => void;
type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

/** The argv of every `execFile('sf', …)` start. */
let sfArgv: string[][];
/** The command line of every `exec` start. */
let sfCommands: string[];
/** What `sf org login jwt` prints and how it exits. */
let jwtAnswer: { stdout: string; error?: Error };
/** Whether `sf --version` succeeds. */
let cliPresent: boolean;

function wireCli(): void {
  sfArgv = [];
  sfCommands = [];
  cliPresent = true;
  jwtAnswer = { stdout: JSON.stringify({ status: 0, result: SIGNED_IN }) };
  // isCliAvailable and `sf org list` go through promisify(exec).
  vi.mocked(exec).mockImplementation(((
    command: string,
    _options: unknown,
    callback: ExecCallback,
  ) => {
    sfCommands.push(command);
    if (command === 'sf --version') {
      if (cliPresent) callback(null, { stdout: '@salesforce/cli/2.150.6', stderr: '' });
      else callback(new Error('spawn sf ENOENT'), { stdout: '', stderr: '' });
    } else if (command === 'sf org list --json') {
      callback(null, { stdout: JSON.stringify(ORG_LIST), stderr: '' });
    } else {
      callback(new Error(`unexpected command: ${command}`), { stdout: '', stderr: '' });
    }
    return {};
  }) as never);
  // The login itself goes through execFile, with argv.
  vi.mocked(execFile).mockImplementation(((
    file: string,
    args: string[],
    _options: unknown,
    callback: ExecFileCallback,
  ) => {
    sfArgv.push([file, ...args]);
    setImmediate(() => callback(jwtAnswer.error ?? null, jwtAnswer.stdout, ''));
    return { pid: 1, stdin: { once: vi.fn(), end: vi.fn() } };
  }) as never);
}

function createDeps(): HandlerDeps {
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: { updateState: vi.fn() } as unknown as HandlerDeps['stateSync'],
    orgManager: {
      getAllOrgs: vi.fn().mockReturnValue([]),
      getOrg: vi.fn(),
    } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {
      saveOrg: vi.fn().mockResolvedValue(undefined),
    } as unknown as HandlerDeps['orgRegistry'],
    configStore: {} as HandlerDeps['configStore'],
    secretVault: {} as HandlerDeps['secretVault'],
    authProvider: {} as HandlerDeps['authProvider'],
    sfdxBridge: new SfdxBridge(),
    nextId: vi.fn().mockReturnValue('gen-id'),
  };
}

function jwtConnect(payload: Record<string, unknown>) {
  return inboundRequest({
    id: 'req-jwt',
    type: 'org:connect',
    timestamp: Date.now(),
    payload: {
      orgId: '',
      authMethod: 'jwt',
      alias: 'ci-sandbox',
      loginUrl: 'https://test.salesforce.com',
      username: 'integration@example.com',
      clientId: '3MVG9FakeConsumerKey.ForTests_Only',
      ...payload,
    },
  });
}

/** Every message the handler posted to the webview. */
function posted(deps: HandlerDeps): Array<{
  type: string;
  correlationId?: string;
  payload: Record<string, unknown>;
}> {
  return (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls.map(
    (call) => call[0] as { type: string; correlationId?: string; payload: Record<string, unknown> },
  );
}

/** The argv of the `sf org login jwt` start. */
function jwtArgv(): string[] | undefined {
  return sfArgv.find((argv) => argv.slice(1, 4).join(' ') === 'org login jwt');
}

/** The file-system entry points that open or copy a file, on `fs` and `fs.promises`. */
const FS_OPENERS = [
  'open',
  'openSync',
  'readFile',
  'readFileSync',
  'createReadStream',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'openAsBlob',
] as const;
const FS_PROMISE_OPENERS = ['open', 'readFile', 'copyFile', 'cp'] as const;

/**
 * Watch every way Node offers to open or copy a file, named imports included
 * (`syncBuiltinESMExports` points them at the spies), and return the paths the
 * code under test asked for.
 */
function watchFileOpens(): { paths: () => string[]; stop: () => void } {
  const spies: Array<{ mock: { calls: unknown[][] } }> = [];
  const target = fs as unknown as Record<string, unknown>;
  for (const name of FS_OPENERS) {
    if (typeof target[name] === 'function') {
      spies.push(vi.spyOn(fs, name as never) as unknown as { mock: { calls: unknown[][] } });
    }
  }
  for (const name of FS_PROMISE_OPENERS) {
    spies.push(vi.spyOn(fs.promises, name as never) as unknown as { mock: { calls: unknown[][] } });
  }
  syncBuiltinESMExports();
  return {
    paths: () => spies.flatMap((spy) => spy.mock.calls.map((call) => String(call[0]))),
    stop: () => {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
    },
  };
}

// These read the argv sf receives from a POSIX spawn. On Windows the command
// goes through cmd.exe instead, quoted, and a path holding a quote is refused
// there: the Windows suite checks that path with the platform stubbed.
describe.skipIf(process.platform === 'win32')('org:connect with JWT', () => {
  let deps: HandlerDeps;
  let keyDir: string;
  let keyFile: string;

  beforeEach(() => {
    vi.clearAllMocks();
    wireCli();
    deps = createDeps();
    keyDir = mkdtempSync(join(tmpdir(), 'sandforge-jwt-'));
    // Spaces, quotes and a command substitution: all of it is the file's name,
    // and none of it may be read by a shell.
    keyFile = join(keyDir, 'server key "uat" $(touch pwned).key');
    writeFileSync(keyFile, KEY_PEM);
  });

  afterEach(() => {
    rmSync(keyDir, { recursive: true, force: true });
  });

  it('hands the key file path to sf as one argv entry, and never opens the file', async () => {
    const watch = watchFileOpens();
    try {
      await new OrgHandler(deps).handle(jwtConnect({ jwtKeyFile: keyFile }));
    } finally {
      watch.stop();
    }

    // The path reaches the CLI exactly as typed, right after its flag.
    const argv = jwtArgv() ?? [];
    expect(argv[0]).toBe('sf');
    expect(argv[argv.indexOf('--jwt-key-file') + 1]).toBe(keyFile);
    // No shell ran the login: no command line was ever written for it.
    expect(sfCommands.some((command) => command.includes('login'))).toBe(false);

    // Nothing in the host asked the file system for the key file.
    expect(watch.paths().filter((path) => path.includes('server key'))).toEqual([]);

    // And its content is nowhere: not in argv, not in anything posted to the
    // webview, logged, or saved with the org.
    const everythingObservable = JSON.stringify([
      sfArgv,
      sfCommands,
      (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls,
      (deps.log as ReturnType<typeof vi.fn>).mock.calls,
      (deps.orgRegistry.saveOrg as ReturnType<typeof vi.fn>).mock.calls,
    ]);
    expect(everythingObservable).not.toContain(KEY_SENTINEL);
    expect(everythingObservable).not.toContain('BEGIN PRIVATE KEY');

    // The file is still there, untouched.
    expect(readFileSync(keyFile, 'utf8')).toBe(KEY_PEM);
  });

  it('runs sf org login jwt with the username, consumer key, login origin and alias', async () => {
    await new OrgHandler(deps).handle(jwtConnect({ jwtKeyFile: keyFile }));

    expect(jwtArgv()).toEqual([
      'sf',
      'org',
      'login',
      'jwt',
      '--username',
      'integration@example.com',
      '--jwt-key-file',
      keyFile,
      '--client-id',
      '3MVG9FakeConsumerKey.ForTests_Only',
      '--instance-url',
      'https://test.salesforce.com',
      '--alias',
      'ci-sandbox',
      '--json',
    ]);
  });

  it('saves the org the CLI signed in to, as an SFDX import saves it, and answers the request', async () => {
    await new OrgHandler(deps).handle(jwtConnect({ jwtKeyFile: keyFile }));

    const saveOrg = deps.orgRegistry.saveOrg as ReturnType<typeof vi.fn>;
    expect(saveOrg).toHaveBeenCalledTimes(1);
    const [org, credentials] = saveOrg.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    // The user who signed in, not the other user of the same org listed first.
    expect(org).toMatchObject({
      id: '00D000000000001AAA',
      username: 'integration@example.com',
      alias: 'ci-sandbox',
      orgType: 'Sandbox',
      authMethod: 'sfdx_import',
    });
    // The CLI keeps the key; SandForge stores neither it nor its path.
    expect(JSON.stringify(credentials)).not.toContain('server key');

    const replies = posted(deps).filter((m) => m.type === 'org:statusChanged');
    expect(replies).toEqual([
      expect.objectContaining({
        correlationId: 'req-jwt',
        payload: { orgId: '00D000000000001AAA', status: 'connected' },
      }),
    ]);
  });

  it("answers with the CLI's own message when it refuses the login, and saves nothing", async () => {
    jwtAnswer = {
      stdout: JSON.stringify({
        status: 1,
        name: 'JwtGrantError',
        message:
          "We encountered a JSON web token error, which is likely not an issue with Salesforce CLI. Here's the error: invalid_client_id: client identifier invalid",
      }),
      error: new Error('Command failed: sf org login jwt'),
    };

    await new OrgHandler(deps).handle(jwtConnect({ jwtKeyFile: keyFile }));

    expect(deps.orgRegistry.saveOrg).not.toHaveBeenCalled();
    const error = posted(deps).find((m) => m.type === 'org:error');
    expect(error).toMatchObject({
      correlationId: 'req-jwt',
      payload: {
        code: 'JWT_LOGIN_FAILED',
        message:
          "We encountered a JSON web token error, which is likely not an issue with Salesforce CLI. Here's the error: invalid_client_id: client identifier invalid",
      },
    });
  });

  it('says so, with the install link, when the CLI is missing', async () => {
    cliPresent = false;

    await new OrgHandler(deps).handle(jwtConnect({ jwtKeyFile: keyFile }));

    expect(jwtArgv()).toBeUndefined();
    const error = posted(deps).find((m) => m.type === 'org:error');
    expect(error?.payload.code).toBe('SF_CLI_NOT_FOUND');
  });

  it.each([
    ['a relative key file path', { jwtKeyFile: 'keys/server.key' }, /absolute path/],
    ['no key file', { jwtKeyFile: '' }, /private key file is required/],
    ['a username with a space', { username: 'jane doe@example.com' }, /username/],
    ['a consumer key with a colon', { clientId: 'abc:def' }, /consumer key/],
    ['an alias with a space', { alias: 'my org' }, /alias/],
  ])('refuses %s before the CLI runs', async (_label, override, reason) => {
    await new OrgHandler(deps).handle(jwtConnect({ jwtKeyFile: keyFile, ...override }));

    expect(jwtArgv()).toBeUndefined();
    const error = posted(deps).find((m) => m.type === 'org:error');
    expect(error?.correlationId).toBe('req-jwt');
    expect(error?.payload.code).toBe('INVALID_PAYLOAD');
    expect(String(error?.payload.message)).toMatch(reason);
  });

  it('refuses a login host that is not Salesforce before the CLI runs', async () => {
    await new OrgHandler(deps).handle(
      jwtConnect({ jwtKeyFile: keyFile, loginUrl: 'https://login.salesforce.com.evil.io' }),
    );

    expect(jwtArgv()).toBeUndefined();
    expect(posted(deps).find((m) => m.type === 'org:error')?.payload.code).toBe(
      'INVALID_LOGIN_URL',
    );
  });

  it('fails the request when sf org list does not list the org it just signed in to', async () => {
    jwtAnswer = {
      stdout: JSON.stringify({
        status: 0,
        result: { ...SIGNED_IN, username: 'ghost@example.com' },
      }),
    };

    await new OrgHandler(deps).handle(jwtConnect({ jwtKeyFile: keyFile }));

    expect(deps.orgRegistry.saveOrg).not.toHaveBeenCalled();
    const error = posted(deps).find((m) => m.type === 'org:error');
    expect(error?.payload.message).toBe(
      'Signed in as ghost@example.com, but "sf org list" does not list that org as connected.',
    );
  });
});

describe('the modules a JWT sign-in runs through', () => {
  it('import no file system API, so none of them can open the key file', () => {
    const modules = [
      'OrgHandler.ts',
      '../../core/connection/SfdxBridge.ts',
      '../validatePayload.ts',
    ].map((file) => readFileSync(join(__dirname, file), 'utf8'));

    for (const source of modules) {
      expect(source).not.toMatch(/['"](?:node:)?fs(?:\/promises)?['"]/);
    }
  });
});
