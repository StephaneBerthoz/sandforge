import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('../src/core/connection/ConnectionHelper.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/connection/ConnectionHelper.js')>()),
  refreshTokenViaCli: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { refreshTokenViaCli } from '../src/core/connection/ConnectionHelper.js';
import * as live from '../src/core/precheck/orgKindLive.js';
import { SfSessionError } from './sfFailure.js';
import { setDefaults as setRequestDefaults } from 'jsforce/lib/request';
import { countRequests, loadOrg, makeConn, proxyFor } from './sfSession.js';

const mockExecFileSync = vi.mocked(execFileSync);

/** What CLI 2.150 prints where `sf org display` used to print the token. */
const PLACEHOLDER = "[REDACTED] Use 'sf org auth show-access-token' to view";

/** A token of the shape Salesforce takes, and of no org. */
const LIVE_TOKEN = 'live-session-token';

/**
 * The `sf` CLI as CLI 2.150 answers: `org display` with the placeholder, and
 * `org auth show-access-token` with nothing usable, as when it fails or is
 * missing — the case the session used to fall back on display's token for.
 */
function cliHidingTheToken(): void {
  mockExecFileSync.mockImplementation(((_file: string, args: readonly string[]) => {
    if (args.includes('display')) {
      return JSON.stringify({
        result: {
          accessToken: PLACEHOLDER,
          instanceUrl: 'https://example.my.salesforce.com',
          username: 'user@example.com',
        },
      });
    }
    throw new Error('show-access-token failed');
  }) as unknown as typeof execFileSync);
}

describe('loadOrg', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cliHidingTheToken();
  });

  it('takes the token from the CLI read, never the placeholder sf org display prints', async () => {
    const readToken = vi.fn().mockResolvedValue({
      accessToken: LIVE_TOKEN,
      instanceUrl: 'https://example.my.salesforce.com',
    });

    const org = await loadOrg('TARGET-DEV', readToken);

    expect(org).toEqual({
      alias: 'TARGET-DEV',
      username: 'user@example.com',
      instanceUrl: 'https://example.my.salesforce.com',
      accessToken: LIVE_TOKEN,
    });
    expect(readToken).toHaveBeenCalledWith('TARGET-DEV');
  });

  it('fails when the CLI read fails, rather than sending the placeholder as a token', async () => {
    const readToken = vi
      .fn()
      .mockRejectedValue(new Error('Neither show-access-token nor display returned a token'));

    await expect(loadOrg('TARGET-DEV', readToken)).rejects.toThrow(/returned a token/);
  });

  it('fails when the CLI read hands back the placeholder, and says how to sign in again', async () => {
    const readToken = vi.fn().mockResolvedValue({ accessToken: PLACEHOLDER });

    await expect(loadOrg('TARGET-DEV', readToken)).rejects.toThrow(
      /no usable access token for alias 'TARGET-DEV'.*sf org login web --alias TARGET-DEV/,
    );
  });

  it('names the sign-ins a CI job can run, which has no browser for a web login', async () => {
    const readToken = vi.fn().mockResolvedValue({ accessToken: PLACEHOLDER });

    const refusal = loadOrg('CI-TARGET', readToken);

    await expect(refusal).rejects.toThrow(/sf org login jwt --alias CI-TARGET/);
    await expect(refusal).rejects.toThrow(
      /sf org login sfdxurl --alias CI-TARGET --sfdx-url-file <file>/,
    );
  });

  it('reads the token as the extension does when no reader is given', async () => {
    vi.mocked(refreshTokenViaCli).mockResolvedValue({ accessToken: LIVE_TOKEN });

    const org = await loadOrg('TARGET-DEV');

    expect(refreshTokenViaCli).toHaveBeenCalledWith('TARGET-DEV');
    expect(org.accessToken).toBe(LIVE_TOKEN);
    expect(org.instanceUrl).toBe('https://example.my.salesforce.com');
  });

  it('says a scratch org is one when the display names its Dev Hub, and nothing of any other org', async () => {
    const shown = (devHubId?: unknown) =>
      mockExecFileSync.mockImplementation((() =>
        JSON.stringify({
          result: {
            instanceUrl: 'https://example.my.salesforce.com',
            username: 'user@example.com',
            ...(devHubId !== undefined ? { devHubId } : {}),
          },
        })) as unknown as typeof execFileSync);
    const readToken = vi.fn().mockResolvedValue({ accessToken: LIVE_TOKEN });

    shown('00Dxx0000000001EAA');
    expect((await loadOrg('SCRATCH', readToken)).scratch).toBe(true);
    shown('');
    expect(await loadOrg('SCRATCH', readToken)).not.toHaveProperty('scratch');
    shown();
    expect(await loadOrg('SCRATCH', readToken)).not.toHaveProperty('scratch');
  });

  it('says a scratch org past its date is gone, before reading a token no sign-in can renew', async () => {
    // What `sf org display` showed of an expired scratch org on 2026-11-13.
    const shown = (result: Record<string, unknown>) =>
      mockExecFileSync.mockImplementation((() =>
        JSON.stringify({
          result: {
            instanceUrl: 'https://example.my.salesforce.com',
            username: 'user@example.com',
            devHubId: '00Dxx0000000001EAA',
            ...result,
          },
        })) as unknown as typeof execFileSync);
    const readToken = vi.fn().mockResolvedValue({ accessToken: LIVE_TOKEN });

    shown({ status: 'Deleted', expirationDate: '2020-01-31' });
    await expect(loadOrg('OLD-SCRATCH', readToken)).rejects.toThrow(
      /The scratch org 'OLD-SCRATCH' expired on 2020-01-31: .*no sign-in brings it back.*sf org create scratch/,
    );
    shown({ status: 'Deleted' });
    await expect(loadOrg('OLD-SCRATCH', readToken)).rejects.toThrow(
      /The scratch org 'OLD-SCRATCH' is deleted/,
    );
    expect(readToken).not.toHaveBeenCalled();

    shown({ status: 'Active', expirationDate: '2999-01-31' });
    expect((await loadOrg('NEW-SCRATCH', readToken)).scratch).toBe(true);
  });

  it('never reads an org that is no scratch org as expired, whatever date it shows', async () => {
    mockExecFileSync.mockImplementation((() =>
      JSON.stringify({
        result: {
          instanceUrl: 'https://example.my.salesforce.com',
          username: 'user@example.com',
          expirationDate: '2020-01-31',
          status: 'Active',
        },
      })) as unknown as typeof execFileSync);
    const readToken = vi.fn().mockResolvedValue({ accessToken: LIVE_TOKEN });

    expect((await loadOrg('TRIAL', readToken)).accessToken).toBe(LIVE_TOKEN);
  });

  it('refuses an alias a shell could read as a command, before running anything', async () => {
    await expect(loadOrg('dev & calc', vi.fn())).rejects.toThrow(/Invalid SF org alias/);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('takes a username where an alias goes, as sf does, and still refuses a flag or a space', async () => {
    const readToken = vi.fn().mockResolvedValue({ accessToken: LIVE_TOKEN });

    expect((await loadOrg('ci+dev@example.com', readToken)).accessToken).toBe(LIVE_TOKEN);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'sf',
      ['org', 'display', '--target-org', 'ci+dev@example.com', '--json'],
      expect.anything(),
    );
    mockExecFileSync.mockClear();
    for (const word of ['--target-org', '-o', 'dev calc', 'dev|calc', '"dev"', '@dev']) {
      await expect(loadOrg(word, readToken), word).rejects.toThrow(/Invalid SF org alias/);
    }
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("says sf does not know the alias, in sf's own words read from stdout, not Node's", async () => {
    mockExecFileSync.mockImplementation((() => {
      throw Object.assign(new Error('Command failed: sf org display --target-org NOPE --json'), {
        status: 1,
        stdout: JSON.stringify({
          status: 1,
          name: 'NamedOrgNotFoundError',
          message: 'No authorization information found for NOPE.',
        }),
        stderr: '',
      });
    }) as unknown as typeof execFileSync);
    const readToken = vi.fn();

    const refusal = loadOrg('NOPE', readToken);

    await expect(refusal).rejects.toBeInstanceOf(SfSessionError);
    await expect(refusal).rejects.toThrow(
      'sf does not know NOPE: "sf org list" names the orgs it knows; "sf org login web --alias ' +
        'NOPE" adds it',
    );
    await expect(refusal).rejects.not.toThrow(/Command failed/);
    expect(readToken).not.toHaveBeenCalled();
  });

  it('says how to install sf when there is none to run', async () => {
    mockExecFileSync.mockImplementation((() => {
      throw Object.assign(new Error('spawnSync sf ENOENT'), { code: 'ENOENT', path: 'sf' });
    }) as unknown as typeof execFileSync);

    await expect(loadOrg('DEV', vi.fn())).rejects.toThrow(
      /^Salesforce CLI \(sf\) not found on PATH\. .*npm install -g @salesforce\/cli.*Nothing was read from DEV\.$/,
    );
  });
});

describe('the proxy a connection goes through', () => {
  it('takes HTTPS_PROXY for an https instance, HTTP_PROXY failing it, and none NO_PROXY names', () => {
    const at = 'https://acme.my.salesforce.com';
    expect(proxyFor(at, {})).toBeUndefined();
    expect(proxyFor(at, { HTTPS_PROXY: 'http://proxy:3128' })).toBe('http://proxy:3128');
    expect(
      proxyFor(at, { https_proxy: 'http://lower:3128', HTTPS_PROXY: 'http://upper:3128' }),
    ).toBe('http://lower:3128');
    expect(proxyFor(at, { HTTP_PROXY: 'http://plain:3128' })).toBe('http://plain:3128');
    expect(
      proxyFor('http://acme.example.com', { HTTPS_PROXY: 'http://proxy:3128' }),
    ).toBeUndefined();
    for (const noProxy of [
      'salesforce.com',
      '.salesforce.com',
      '*.my.salesforce.com',
      'localhost, acme.my.salesforce.com',
      '*',
      'salesforce.com:443',
    ]) {
      expect(
        proxyFor(at, { HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: noProxy }),
        noProxy,
      ).toBeUndefined();
    }
    for (const noProxy of ['force.com', 'salesforce.com:8443', 'acme.my', 'example.com']) {
      expect(proxyFor(at, { HTTPS_PROXY: 'http://proxy:3128', no_proxy: noProxy }), noProxy).toBe(
        'http://proxy:3128',
      );
    }
  });

  /** A server that answers every REST call with an empty list, counting them. */
  async function salesforce(): Promise<{ url: string; calls: () => number; close: () => void }> {
    let calls = 0;
    const server = createServer((_request, response) => {
      calls += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ totalSize: 0, done: true, records: [] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, calls: () => calls, close: () => server.close() };
  }

  /** A proxy that tunnels each CONNECT to where it asks, counting the tunnels it opened. */
  async function proxy(): Promise<{ url: string; tunnels: () => number; close: () => void }> {
    let tunnels = 0;
    const server = createServer((_request, response) => {
      response.writeHead(405);
      response.end();
    });
    server.on('connect', (request: IncomingMessage, client: Socket, head: Buffer) => {
      tunnels += 1;
      const [host = '', port = ''] = (request.url ?? '').split(':');
      const upstream = connect(Number(port), host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}`,
      tunnels: () => tunnels,
      close: () => {
        server.closeAllConnections();
        server.close();
      },
    };
  }

  it('sends the calls of a connection through the proxy, and around it for a host NO_PROXY names', async () => {
    const org = await salesforce();
    const relay = await proxy();
    try {
      const at = { alias: 'DEV', username: 'u', instanceUrl: org.url, accessToken: 'token' };

      await makeConn(at, { HTTP_PROXY: relay.url }).query('SELECT Id FROM Account');
      expect(relay.tunnels()).toBe(1);
      expect(org.calls()).toBe(1);

      await makeConn(at, { HTTP_PROXY: relay.url, NO_PROXY: '127.0.0.1' }).query(
        'SELECT Id FROM Account',
      );
      await makeConn(at, {}).query('SELECT Id FROM Account');
      expect(relay.tunnels()).toBe(1);
      expect(org.calls()).toBe(3);
    } finally {
      relay.close();
      org.close();
    }
  });

  it('goes around the proxy jsforce took from the environment as it loaded, for a host NO_PROXY names', async () => {
    // What jsforce 3.10.14 does as it loads (lib/transport.js): the proxy of
    // the environment becomes the default of every request, NO_PROXY unread.
    const loaded = {
      httpProxy:
        process.env.https_proxy ??
        process.env.http_proxy ??
        process.env.HTTPS_PROXY ??
        process.env.HTTP_PROXY ??
        undefined,
      timeout: process.env.HTTP_TIMEOUT ? parseInt(process.env.HTTP_TIMEOUT, 10) : undefined,
      followRedirect: true,
    };
    const org = await salesforce();
    const relay = await proxy();
    setRequestDefaults({ ...loaded, httpProxy: relay.url });
    try {
      const at = { alias: 'DEV', username: 'u', instanceUrl: org.url, accessToken: 'token' };

      await makeConn(at, { HTTP_PROXY: relay.url, NO_PROXY: '127.0.0.1' }).query(
        'SELECT Id FROM Account',
      );

      expect(relay.tunnels()).toBe(0);
      expect(org.calls()).toBe(1);
    } finally {
      setRequestDefaults(loaded);
      relay.close();
      org.close();
    }
  });
});

describe('countRequests', () => {
  it("is the extension's own count, SOAP calls included", () => {
    expect(countRequests).toBe(live.countRequests);
  });
});
