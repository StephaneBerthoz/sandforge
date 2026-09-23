import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as vscode from 'vscode';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';
import { OrgHandler } from './OrgHandler';
import type { HandlerDeps } from './HandlerTypes';
import { DeviceLogin, DeviceLoginCancelledError } from '../../core/connection/DeviceLogin';
import type { FetchLike } from '../../core/connection/DeviceLogin';
import { SfdxBridge } from '../../core/connection/SfdxBridge';
import { ExternalBrowserAdapter } from '../../adapters/browser/ExternalBrowserAdapter';
import { inboundRequest } from '../../test/mockFactories.js';

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
}));

import { exec, execFile } from 'child_process';

/**
 * Device-flow sign-in through OrgHandler, with the real DeviceLogin speaking
 * to a scripted token endpoint, a stand-in browser, and the CLI stood in for
 * at SfdxBridge.
 */

const CLIENT_ID = '3MVG9FakeConsumerKey.ForTests_Only';
const REFRESH_SENTINEL = '5Aep861.REFRESH-SENTINEL_7d2e';
const ACCESS_SENTINEL = '00Dfake!ACCESS-SENTINEL';

const CODE_ANSWER = {
  device_code: 'DEVICE-CODE-SENTINEL',
  user_code: 'AB12CD34',
  verification_uri: 'https://test.salesforce.com/setup/connect',
  interval: 5,
};
const PENDING = { status: 400, body: { error: 'authorization_pending' } };
const APPROVED = {
  status: 200,
  body: {
    access_token: ACCESS_SENTINEL,
    refresh_token: REFRESH_SENTINEL,
    instance_url: 'https://acme--uat.sandbox.my.salesforce.com',
  },
};

const IMPORTED_ORG: SalesforceOrg = {
  id: '00D000000000001AAA',
  alias: 'uat',
  username: 'jane@example.com',
  instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
  orgId: '00D000000000001AAA',
  orgType: 'Sandbox',
  authMethod: 'sfdx_import',
  safetyTier: OrgSafetyTier.MEDIUM,
  appearance: { color: '#4a9eff', icon: 'cloud', position: 0 },
  metadata: { apiVersion: '62.0', edition: '', features: [] },
  status: 'connected',
  lastConnected: '2026-09-23T10:00:00.000Z',
  tags: [],
};

/**
 * A token endpoint answering from a script, and a sleep that only returns when
 * the test lets it — or rejects the moment the sign-in's signal aborts, as the
 * real one does.
 */
function tokenEndpoint(answers: Array<{ status: number; body: unknown }>) {
  const forms: Array<Record<string, string>> = [];
  let release: (() => void) | undefined;
  let sleeping: (() => void) | undefined;
  const asleep = new Promise<void>((resolve) => {
    sleeping = resolve;
  });
  const fetch: FetchLike = async (_url, init) => {
    forms.push(Object.fromEntries(new URLSearchParams(String(init.body))));
    const answer = answers.shift() ?? PENDING;
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  };
  const sleep = (_ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DeviceLoginCancelledError());
        return;
      }
      signal?.addEventListener('abort', () => reject(new DeviceLoginCancelledError()), {
        once: true,
      });
      release = resolve;
      sleeping?.();
    });
  return {
    login: new DeviceLogin({ fetch, sleep, now: () => Date.UTC(2026, 8, 23, 10, 0, 0) }),
    forms,
    /** Resolves once the sign-in is waiting between two polls. */
    asleep,
    /** Let the current wait end, so the next poll is sent. */
    wake: () => release?.(),
  };
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
    sfdxBridge: {
      isCliAvailable: vi.fn().mockResolvedValue(true),
      loginWithRefreshToken: vi.fn().mockResolvedValue({
        username: 'jane@example.com',
        orgId: '00D000000000001AAA',
        instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
      }),
      findOrg: vi.fn().mockResolvedValue({
        org: IMPORTED_ORG,
        credentials: {
          loginUrl: 'https://acme--uat.sandbox.my.salesforce.com',
          instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
          username: 'jane@example.com',
        },
      }),
    } as unknown as HandlerDeps['sfdxBridge'],
    nextId: vi.fn().mockReturnValue('gen-id'),
  };
}

function deviceConnect(payload: Record<string, unknown> = {}) {
  return inboundRequest({
    id: 'req-device',
    type: 'org:connect',
    timestamp: Date.now(),
    payload: {
      orgId: '',
      authMethod: 'oauth_device',
      alias: 'uat',
      loginUrl: 'https://test.salesforce.com',
      clientId: CLIENT_ID,
      ...payload,
    },
  });
}

function cancel(requestId: string) {
  return inboundRequest({
    id: 'req-cancel',
    type: 'org:connect:cancel',
    timestamp: Date.now(),
    payload: { requestId },
  });
}

type Posted = { type: string; correlationId?: string; payload: Record<string, unknown> };

function posted(deps: HandlerDeps): Posted[] {
  return (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls.map(
    (call) => call[0] as Posted,
  );
}

function browserThat(opens: boolean) {
  const openExternal = vi.fn<(target: vscode.Uri) => Thenable<boolean>>().mockResolvedValue(opens);
  const browser = new ExternalBrowserAdapter({
    openExternal,
    parseUri: (value: string) => ({ toString: () => value }) as unknown as vscode.Uri,
  });
  return { browser, openExternal };
}

describe('org:connect with the device flow', () => {
  let deps: HandlerDeps;

  beforeEach(() => {
    deps = createDeps();
  });

  it('shows the code and opens the verification page, then imports the org once it is approved', async () => {
    const endpoint = tokenEndpoint([{ status: 200, body: CODE_ANSWER }, PENDING, APPROVED]);
    const { browser, openExternal } = browserThat(true);
    const handler = new OrgHandler(deps, { browser, deviceLogin: endpoint.login });

    const signIn = handler.handle(deviceConnect());
    await endpoint.asleep;

    // While the user is still to approve: the code, correlated to the request.
    expect(posted(deps)).toEqual([
      expect.objectContaining({
        type: 'org:device-code',
        correlationId: 'req-device',
        payload: {
          userCode: 'AB12CD34',
          verificationUri: 'https://test.salesforce.com/setup/connect',
          expiresAt: Date.UTC(2026, 8, 23, 10, 10, 0),
        },
      }),
    ]);
    expect(String(openExternal.mock.calls[0][0])).toBe('https://test.salesforce.com/setup/connect');
    expect(endpoint.forms[0]).toEqual({ response_type: 'device_code', client_id: CLIENT_ID });

    endpoint.wake(); // pending
    await vi.waitFor(() => expect(endpoint.forms).toHaveLength(2));
    endpoint.wake(); // approved
    await signIn;

    expect(endpoint.forms[2]).toEqual({
      grant_type: 'device',
      client_id: CLIENT_ID,
      code: 'DEVICE-CODE-SENTINEL',
    });
    expect(deps.sfdxBridge.loginWithRefreshToken).toHaveBeenCalledWith({
      clientId: CLIENT_ID,
      refreshToken: REFRESH_SENTINEL,
      instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
      alias: 'uat',
    });
    expect(deps.sfdxBridge.findOrg).toHaveBeenCalledWith('jane@example.com');
    expect(deps.orgRegistry.saveOrg).toHaveBeenCalledWith(IMPORTED_ORG, expect.any(Object));
    expect(posted(deps).filter((m) => m.type === 'org:statusChanged')).toEqual([
      expect.objectContaining({
        correlationId: 'req-device',
        payload: { orgId: '00D000000000001AAA', status: 'connected' },
      }),
    ]);
  });

  it('keeps the tokens to the hand-off: nothing posted, logged or saved carries them', async () => {
    const endpoint = tokenEndpoint([{ status: 200, body: CODE_ANSWER }, APPROVED]);
    const handler = new OrgHandler(deps, {
      browser: browserThat(true).browser,
      deviceLogin: endpoint.login,
    });

    const signIn = handler.handle(deviceConnect());
    await endpoint.asleep;
    endpoint.wake();
    await signIn;

    const observable = JSON.stringify([
      (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls,
      (deps.log as ReturnType<typeof vi.fn>).mock.calls,
      (deps.orgRegistry.saveOrg as ReturnType<typeof vi.fn>).mock.calls,
    ]);
    expect(observable).not.toContain(REFRESH_SENTINEL);
    expect(observable).not.toContain(ACCESS_SENTINEL);
    expect(observable).not.toContain('DEVICE-CODE-SENTINEL');
  });

  it('stops waiting when its request is cancelled, and answers CANCELLED without a toast', async () => {
    const endpoint = tokenEndpoint([{ status: 200, body: CODE_ANSWER }]);
    const handler = new OrgHandler(deps, {
      browser: browserThat(true).browser,
      deviceLogin: endpoint.login,
    });

    const signIn = handler.handle(deviceConnect());
    await endpoint.asleep;
    await handler.handle(cancel('req-device'));
    await signIn;

    const error = posted(deps).find((m) => m.type === 'org:error');
    expect(error).toMatchObject({
      correlationId: 'req-device',
      payload: { code: 'CANCELLED', message: 'Sign-in cancelled.' },
    });
    expect(posted(deps).some((m) => m.type === 'notification')).toBe(false);
    // Only the code request went out: no poll after the cancel, no hand-off.
    expect(endpoint.forms).toHaveLength(1);
    expect(deps.sfdxBridge.loginWithRefreshToken).not.toHaveBeenCalled();
    expect(deps.orgRegistry.saveOrg).not.toHaveBeenCalled();
  });

  it('leaves a sign-in alone when the cancel names another request', async () => {
    const endpoint = tokenEndpoint([{ status: 200, body: CODE_ANSWER }, APPROVED]);
    const handler = new OrgHandler(deps, {
      browser: browserThat(true).browser,
      deviceLogin: endpoint.login,
    });

    const signIn = handler.handle(deviceConnect());
    await endpoint.asleep;
    await handler.handle(cancel('req-someone-else'));
    endpoint.wake();
    await signIn;

    expect(posted(deps).find((m) => m.type === 'org:statusChanged')?.correlationId).toBe(
      'req-device',
    );
    expect(posted(deps).some((m) => m.type === 'org:error')).toBe(false);
  });

  it('answers a cancel that arrives after the sign-in ended with nothing', async () => {
    const endpoint = tokenEndpoint([{ status: 200, body: CODE_ANSWER }, APPROVED]);
    const handler = new OrgHandler(deps, {
      browser: browserThat(true).browser,
      deviceLogin: endpoint.login,
    });
    const signIn = handler.handle(deviceConnect());
    await endpoint.asleep;
    endpoint.wake();
    await signIn;
    const before = posted(deps).length;

    await handler.handle(cancel('req-device'));

    expect(posted(deps)).toHaveLength(before);
  });

  it('carries on with the link on the page when the browser does not open', async () => {
    const endpoint = tokenEndpoint([{ status: 200, body: CODE_ANSWER }, APPROVED]);
    const handler = new OrgHandler(deps, {
      browser: browserThat(false).browser,
      deviceLogin: endpoint.login,
    });

    const signIn = handler.handle(deviceConnect());
    await endpoint.asleep;
    endpoint.wake();
    await signIn;

    expect(posted(deps).map((m) => m.type)).toContain('org:device-code');
    expect(posted(deps).find((m) => m.type === 'org:statusChanged')).toBeDefined();
    expect((deps.log as ReturnType<typeof vi.fn>).mock.calls.flat().join('\n')).toMatch(
      /verification page not opened/,
    );
  });

  it("answers with Salesforce's refusal when no code is issued, and posts no code", async () => {
    const endpoint = tokenEndpoint([
      {
        status: 400,
        body: { error: 'invalid_client_id', error_description: 'client identifier invalid' },
      },
    ]);
    const handler = new OrgHandler(deps, {
      browser: browserThat(true).browser,
      deviceLogin: endpoint.login,
    });

    await handler.handle(deviceConnect());

    expect(posted(deps).some((m) => m.type === 'org:device-code')).toBe(false);
    expect(posted(deps).find((m) => m.type === 'org:error')).toMatchObject({
      correlationId: 'req-device',
      payload: {
        code: 'OAUTH_DEVICE_FAILED',
        message:
          'Salesforce refused the device sign-in: client identifier invalid (invalid_client_id)',
      },
    });
  });

  it("answers with the CLI's message when it refuses the session", async () => {
    const endpoint = tokenEndpoint([{ status: 200, body: CODE_ANSWER }, APPROVED]);
    (deps.sfdxBridge.loginWithRefreshToken as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Error authenticating with the refresh token due to: invalid_client'),
    );
    const handler = new OrgHandler(deps, {
      browser: browserThat(true).browser,
      deviceLogin: endpoint.login,
    });

    const signIn = handler.handle(deviceConnect());
    await endpoint.asleep;
    endpoint.wake();
    await signIn;

    expect(posted(deps).find((m) => m.type === 'org:error')?.payload).toMatchObject({
      code: 'OAUTH_DEVICE_FAILED',
      message: 'Error authenticating with the refresh token due to: invalid_client',
    });
    expect(deps.orgRegistry.saveOrg).not.toHaveBeenCalled();
  });

  it('asks for no code when the CLI that has to keep the session is missing', async () => {
    const endpoint = tokenEndpoint([{ status: 200, body: CODE_ANSWER }]);
    (deps.sfdxBridge.isCliAvailable as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const handler = new OrgHandler(deps, {
      browser: browserThat(true).browser,
      deviceLogin: endpoint.login,
    });

    await handler.handle(deviceConnect());

    expect(endpoint.forms).toHaveLength(0);
    expect(posted(deps).find((m) => m.type === 'org:error')?.payload.code).toBe('SF_CLI_NOT_FOUND');
  });

  it.each([
    ['no consumer key', { clientId: '' }, 'INVALID_PAYLOAD'],
    ['a consumer key with a space', { clientId: 'abc def' }, 'INVALID_PAYLOAD'],
    [
      'a login host that is not Salesforce',
      { loginUrl: 'https://evil.example.com' },
      'INVALID_LOGIN_URL',
    ],
  ])('refuses %s before asking Salesforce for anything', async (_label, override, code) => {
    const endpoint = tokenEndpoint([{ status: 200, body: CODE_ANSWER }]);
    const handler = new OrgHandler(deps, {
      browser: browserThat(true).browser,
      deviceLogin: endpoint.login,
    });

    await handler.handle(deviceConnect(override));

    expect(endpoint.forms).toHaveLength(0);
    expect(posted(deps).find((m) => m.type === 'org:error')).toMatchObject({
      correlationId: 'req-device',
      payload: { code },
    });
  });
});

// These read the argv sf receives from a POSIX spawn. On Windows the command
// goes through cmd.exe instead, quoted, and a path holding a quote is refused
// there: the Windows suite checks that path with the platform stubbed.
describe.skipIf(process.platform === 'win32')(
  'org:connect with the device flow, through the real SfdxBridge',
  () => {
    /** Every `sf` start through execFile: its argv and what was written to its stdin. */
    let sfRuns: Array<{ argv: string[]; stdin: string }>;

    beforeEach(() => {
      sfRuns = [];
      // isCliAvailable and `sf org list` go through promisify(exec).
      vi.mocked(exec).mockImplementation(((
        command: string,
        _options: unknown,
        callback: (error: Error | null, result: { stdout: string; stderr: string }) => void,
      ) => {
        const stdout =
          command === 'sf org list --json'
            ? JSON.stringify({
                status: 0,
                result: {
                  nonScratchOrgs: [
                    {
                      orgId: '00D000000000001AAA',
                      username: 'jane@example.com',
                      alias: 'uat',
                      instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
                      connectedStatus: 'Connected',
                      isSandbox: true,
                    },
                  ],
                },
              })
            : '@salesforce/cli/2.150.6';
        callback(null, { stdout, stderr: '' });
        return {};
      }) as never);
      // The hand-off goes through execFile, its URL on stdin.
      vi.mocked(execFile).mockImplementation(((
        file: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        const run = { argv: [file, ...args], stdin: '' };
        sfRuns.push(run);
        setImmediate(() =>
          callback(
            null,
            JSON.stringify({
              status: 0,
              result: {
                username: 'jane@example.com',
                orgId: '00D000000000001AAA',
                instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
              },
            }),
            '',
          ),
        );
        return {
          pid: 1,
          stdin: {
            once: vi.fn(),
            end: (data?: string) => {
              run.stdin += data ?? '';
            },
          },
        };
      }) as never);
    });

    it('gives the refresh token to sf on its stdin and to nothing else, then saves the org', async () => {
      const deps = { ...createDeps(), sfdxBridge: new SfdxBridge() };
      const endpoint = tokenEndpoint([{ status: 200, body: CODE_ANSWER }, APPROVED]);
      const handler = new OrgHandler(deps, {
        browser: browserThat(true).browser,
        deviceLogin: endpoint.login,
      });

      const signIn = handler.handle(deviceConnect());
      await endpoint.asleep;
      endpoint.wake();
      await signIn;

      expect(sfRuns).toEqual([
        {
          argv: ['sf', 'org', 'login', 'sfdx-url', '--alias', 'uat', '--json', '--sfdx-url-stdin'],
          stdin: `force://${CLIENT_ID}::${REFRESH_SENTINEL}@acme--uat.sandbox.my.salesforce.com\n`,
        },
      ]);
      const elsewhere = JSON.stringify([
        sfRuns.map((run) => run.argv),
        vi.mocked(exec).mock.calls.map((call) => call[0]),
        (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls,
        (deps.log as ReturnType<typeof vi.fn>).mock.calls,
        (deps.orgRegistry.saveOrg as ReturnType<typeof vi.fn>).mock.calls,
      ]);
      expect(elsewhere).not.toContain(REFRESH_SENTINEL);
      expect(elsewhere).not.toContain(ACCESS_SENTINEL);

      expect(deps.orgRegistry.saveOrg).toHaveBeenCalledWith(
        expect.objectContaining({ id: '00D000000000001AAA', username: 'jane@example.com' }),
        expect.any(Object),
      );
      expect(posted(deps).find((m) => m.type === 'org:statusChanged')?.correlationId).toBe(
        'req-device',
      );
    });
  },
);
