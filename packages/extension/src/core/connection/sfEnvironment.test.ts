import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  describeSfVariables,
  firstLineOf,
  isHostOnlyVariable,
  locateSf,
  sfChildEnv,
  withoutPersonalDetails,
} from './sfEnvironment';

vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

vi.mock('util', () => ({
  promisify: (fn: unknown) => fn,
}));

import { exec } from 'child_process';

const mockExec = vi.mocked(exec);

/**
 * The extension host's environment as VS Code 1.144 gives it on Windows,
 * values replaced: its own variables, then the user's.
 */
const HOST_ENV: NodeJS.ProcessEnv = {
  ELECTRON_RUN_AS_NODE: '1',
  ELECTRON_NO_ATTACH_CONSOLE: '1',
  VSCODE_PID: '4242',
  VSCODE_IPC_HOOK: '\\\\.\\pipe\\vscode-ipc',
  VSCODE_NLS_CONFIG: '{}',
  VSCODE_PORTABLE: 'D:\\code-data',
  VSCODE_SHELL_LOGIN: '1',
  SNAP: '/snap/code/1',
  GDK_PIXBUF_MODULE_FILE: '/snap/loaders.cache',
  Path: 'C:\\Windows\\system32;C:\\nvm4w\\nodejs',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  HTTPS_PROXY: 'http://user:secret@proxy.example:8080',
  no_proxy: 'localhost',
  SF_AUTOUPDATE_DISABLE: 'true',
  SFDX_DISABLE_TELEMETRY: 'true',
  NO_COLOR: '0',
};

describe('isHostOnlyVariable', () => {
  it.each([
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_NO_ATTACH_CONSOLE',
    'VSCODE_PID',
    'VSCODE_IPC_HOOK',
    'SNAP',
    'SNAP_NAME',
    'GDK_PIXBUF_MODULE_FILE',
  ])('takes %s for one of VS Code, which a terminal of the window does not get', (name) => {
    expect(isHostOnlyVariable(name)).toBe(true);
  });

  it.each([
    'VSCODE_PORTABLE',
    'VSCODE_SHELL_LOGIN',
    'VSCODE_ENV_APPEND',
    'PATH',
    'HTTPS_PROXY',
    'SF_AUTOUPDATE_DISABLE',
    'SNAPSHOT_DIR',
  ])('leaves %s to sf, as VS Code leaves it to a terminal', (name) => {
    expect(isHostOnlyVariable(name)).toBe(false);
  });
});

describe('sfChildEnv', () => {
  it('passes everything but the VS Code variables, with colours off', () => {
    const env = sfChildEnv(HOST_ENV);

    expect(Object.keys(env).sort()).toEqual(
      [
        'VSCODE_PORTABLE',
        'VSCODE_SHELL_LOGIN',
        'Path',
        'PATHEXT',
        'HTTPS_PROXY',
        'no_proxy',
        'SF_AUTOUPDATE_DISABLE',
        'SFDX_DISABLE_TELEMETRY',
        'NO_COLOR',
      ].sort(),
    );
    expect(env.Path).toBe(HOST_ENV.Path);
    expect(env.HTTPS_PROXY).toBe(HOST_ENV.HTTPS_PROXY);
    expect(env.NO_COLOR).toBe('1');
  });

  it('leaves the host environment as it was', () => {
    const host = { ...HOST_ENV };

    sfChildEnv(host);

    expect(host).toEqual(HOST_ENV);
  });
});

describe('describeSfVariables', () => {
  it('names the variables that matter and those kept from sf, never a value', () => {
    const said = describeSfVariables(HOST_ENV);

    expect(said).toBe(
      'set: HTTPS_PROXY, NO_PROXY; SF_/SFDX_: SFDX_DISABLE_TELEMETRY, SF_AUTOUPDATE_DISABLE; ' +
        'not passed to sf, as a terminal does not get them: ELECTRON_NO_ATTACH_CONSOLE, ' +
        'ELECTRON_RUN_AS_NODE, 5 VSCODE_ or other VS Code variables',
    );
    for (const value of ['secret', 'proxy.example', 'localhost', 'true']) {
      expect(said).not.toContain(value);
    }
  });

  it('says none were found in an environment without them', () => {
    expect(describeSfVariables({ PATH: '/usr/bin', EMPTY_PROXY: '' })).toBe(
      'set: none of HTTP_PROXY, HTTPS_PROXY, NO_PROXY, NODE_EXTRA_CA_CERTS, NODE_OPTIONS, ' +
        'NODE_TLS_REJECT_UNAUTHORIZED; SF_/SFDX_: none; ' +
        'not passed to sf, as a terminal does not get them: none',
    );
  });

  it('does not count a variable set to nothing as set', () => {
    expect(describeSfVariables({ HTTPS_PROXY: '' })).toContain('set: none of');
  });
});

describe('withoutPersonalDetails', () => {
  it('writes a Windows home folder as ~, whatever its case', () => {
    expect(
      withoutPersonalDetails(
        'c:\\users\\jdoe\\AppData\\Roaming\\npm\\sf.cmd',
        'C:\\Users\\jdoe',
        'jdoe',
      ),
    ).toBe('~\\AppData\\Roaming\\npm\\sf.cmd');
  });

  it('writes the user name as <user> where it is a folder outside the home folder', () => {
    expect(
      withoutPersonalDetails('D:\\Profiles\\JDoe\\tools\\sf.cmd', 'C:\\Users\\jdoe', 'jdoe'),
    ).toBe('D:\\Profiles\\<user>\\tools\\sf.cmd');
  });

  it('leaves a path that only contains the user name inside a folder name', () => {
    expect(withoutPersonalDetails('/opt/jdoe-tools/sf', '/home/jdoe', 'jdoe')).toBe(
      '/opt/jdoe-tools/sf',
    );
  });

  it('hides an org username and an access token', () => {
    expect(
      withoutPersonalDetails(
        'No authorization for admin@acme.example.com, token 00D000000000001!AQEAQfake.token',
        '/home/jdoe',
        'jdoe',
      ),
    ).toBe('No authorization for <username>, token <token>');
  });

  it('replaces nothing for a user name or home folder too short to be told apart', () => {
    expect(withoutPersonalDetails('C:\\a\\b\\sf.cmd', 'C:\\', 'a')).toBe('C:\\a\\b\\sf.cmd');
  });
});

describe('firstLineOf', () => {
  it('is the first line that holds anything, trimmed', () => {
    expect(firstLineOf('\r\n  \r\n  Blocked by policy \r\nmore')).toBe('Blocked by policy');
  });

  it('is undefined for blank text', () => {
    expect(firstLineOf(' \r\n\n')).toBeUndefined();
  });
});

describe('locateSf', () => {
  const realPlatform = process.platform;
  const savedElectron = process.env.ELECTRON_RUN_AS_NODE;

  beforeEach(() => {
    mockExec.mockReset();
    process.env.ELECTRON_RUN_AS_NODE = '1';
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
    if (savedElectron === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = savedElectron;
  });

  it('asks which -a for both names on POSIX, in the environment sf runs in', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    mockExec.mockResolvedValueOnce({
      stdout: '/usr/local/bin/sf\n/usr/bin/sf\n/usr/local/bin/node\n',
      stderr: '',
    } as never);

    const found = await locateSf();

    expect(found).toEqual({
      sf: ['/usr/local/bin/sf', '/usr/bin/sf'],
      node: ['/usr/local/bin/node'],
      runs: '/usr/local/bin/sf',
    });
    const [command, options] = mockExec.mock.calls[0] as unknown as [
      string,
      { env: NodeJS.ProcessEnv; windowsHide: boolean; timeout: number },
    ];
    expect(command).toBe('which -a sf node');
    expect(options.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(options.windowsHide).toBe(true);
    expect(options.timeout).toBe(10_000);
  });

  it('asks where on Windows, and names the first sf cmd.exe runs, not the shell script', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    mockExec.mockResolvedValueOnce({
      stdout:
        'C:\\nvm4w\\nodejs\\sf\r\nC:\\nvm4w\\nodejs\\sf.cmd\r\nC:\\tools\\sf.exe\r\n' +
        'C:\\nvm4w\\nodejs\\node.exe\r\n',
      stderr: '',
    } as never);

    const found = await locateSf();

    expect(mockExec.mock.calls[0][0]).toBe('where sf node');
    expect(found.runs).toBe('C:\\nvm4w\\nodejs\\sf.cmd');
    expect(found.sf).toHaveLength(3);
    expect(found.node).toEqual(['C:\\nvm4w\\nodejs\\node.exe']);
  });

  it('reads what it printed when one of the names is not found and it exits 1', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    mockExec.mockRejectedValueOnce(
      Object.assign(new Error('Command failed: which -a sf node'), {
        code: 1,
        stdout: '/usr/local/bin/sf\n',
      }) as never,
    );

    const found = await locateSf();

    expect(found).toEqual({ sf: ['/usr/local/bin/sf'], node: [], runs: '/usr/local/bin/sf' });
  });

  it('says why when it could not run at all', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    mockExec.mockRejectedValueOnce(
      Object.assign(new Error('spawn /bin/sh ENOENT'), { stdout: '' }) as never,
    );

    const found = await locateSf();

    expect(found).toEqual({ sf: [], node: [], failure: 'spawn /bin/sh ENOENT' });
  });
});
