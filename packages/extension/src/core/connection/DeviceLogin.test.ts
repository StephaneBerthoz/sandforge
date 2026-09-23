import { describe, it, expect } from 'vitest';
import { SF_DEVICE_CODE_LIFETIME_MS } from '@sandforge/shared';
import { DeviceLogin, DeviceLoginCancelledError } from './DeviceLogin';
import type { DeviceAuthorization, FetchLike } from './DeviceLogin';

const LOGIN = 'https://test.salesforce.com';
const CLIENT_ID = '3MVG9FakeConsumerKey.ForTests_Only';
const START = Date.UTC(2026, 8, 23, 10, 0, 0);

/** One request the fake token endpoint received. */
interface SentRequest {
  url: string;
  method: string | undefined;
  contentType: string | undefined;
  form: Record<string, string>;
}

/** An answer the fake endpoint gives: a JSON body and status, a raw page, or a network failure. */
type Answer = { status?: number; json: unknown } | { status: number; page: string } | Error;

/**
 * A token endpoint that answers from a script, and a clock that moves only
 * when the code under test sleeps.
 */
function harness(answers: Answer[]) {
  const sent: SentRequest[] = [];
  const sleeps: number[] = [];
  let clock = START;
  const fetch: FetchLike = async (url, init) => {
    const headers = new Headers(init.headers);
    sent.push({
      url,
      method: init.method,
      contentType: headers.get('Content-Type') ?? undefined,
      form: Object.fromEntries(new URLSearchParams(String(init.body))),
    });
    const answer = answers.shift();
    if (!answer) throw new Error('the script ran out of answers');
    if (answer instanceof Error) throw answer;
    if ('page' in answer) return new Response(answer.page, { status: answer.status });
    return new Response(JSON.stringify(answer.json), { status: answer.status ?? 200 });
  };
  const login = new DeviceLogin({
    fetch,
    now: () => clock,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw new DeviceLoginCancelledError();
      sleeps.push(ms);
      clock += ms;
    },
  });
  return { login, sent, sleeps, elapse: (ms: number) => (clock += ms) };
}

const CODE_ANSWER = {
  device_code: 'device-code-sentinel',
  user_code: 'AB12CD34',
  verification_uri: 'https://test.salesforce.com/setup/connect',
  interval: 5,
};

const APPROVED = {
  access_token: '00Dfake!access',
  refresh_token: '5Aep861.fake_refresh-token',
  instance_url: 'https://acme--uat.sandbox.my.salesforce.com',
  scope: 'refresh_token api',
};

const PENDING = { status: 400, json: { error: 'authorization_pending' } };

function authorization(overrides: Partial<DeviceAuthorization> = {}): DeviceAuthorization {
  return {
    deviceCode: 'device-code-sentinel',
    userCode: 'AB12CD34',
    verificationUri: 'https://test.salesforce.com/setup/connect',
    intervalMs: 5_000,
    expiresAt: START + SF_DEVICE_CODE_LIFETIME_MS,
    ...overrides,
  };
}

describe('DeviceLogin.authorize', () => {
  it('asks the login host for a device code with the consumer key, as a form', async () => {
    const { login, sent } = harness([{ json: CODE_ANSWER }]);

    await login.authorize(LOGIN, CLIENT_ID);

    expect(sent).toEqual([
      {
        url: 'https://test.salesforce.com/services/oauth2/token',
        method: 'POST',
        contentType: 'application/x-www-form-urlencoded',
        form: { response_type: 'device_code', client_id: CLIENT_ID },
      },
    ]);
  });

  it('returns the code, the page, the interval, and an expiry ten minutes out when Salesforce names none', async () => {
    const { login } = harness([{ json: CODE_ANSWER }]);

    expect(await login.authorize(LOGIN, CLIENT_ID)).toEqual({
      deviceCode: 'device-code-sentinel',
      userCode: 'AB12CD34',
      verificationUri: 'https://test.salesforce.com/setup/connect',
      intervalMs: 5_000,
      expiresAt: START + 10 * 60_000,
    });
  });

  it('takes the lifetime Salesforce gives the code when it gives one', async () => {
    const { login } = harness([{ json: { ...CODE_ANSWER, expires_in: 300 } }]);

    const result = await login.authorize(LOGIN, CLIENT_ID);

    expect(result.expiresAt).toBe(START + 300_000);
  });

  it('never waits past ten minutes, which is as long as the Org Manager waits', async () => {
    const { login } = harness([{ json: { ...CODE_ANSWER, expires_in: 1800 } }]);

    const result = await login.authorize(LOGIN, CLIENT_ID);

    expect(result.expiresAt).toBe(START + SF_DEVICE_CODE_LIFETIME_MS);
  });

  it("surfaces Salesforce's refusal in its own words", async () => {
    const { login } = harness([
      {
        status: 400,
        json: {
          error: 'invalid_grant',
          error_description: 'device flow is not enabled for this app',
        },
      },
    ]);

    await expect(login.authorize(LOGIN, CLIENT_ID)).rejects.toThrow(
      'Salesforce refused the device sign-in: device flow is not enabled for this app (invalid_grant)',
    );
  });

  it('refuses a verification page that is not on a Salesforce host, so it is never opened', async () => {
    const { login } = harness([
      { json: { ...CODE_ANSWER, verification_uri: 'https://salesforce.example.com/connect' } },
    ]);

    await expect(login.authorize(LOGIN, CLIENT_ID)).rejects.toThrow(/not on a Salesforce host/);
  });

  it('refuses a verification page that is not https', async () => {
    const { login } = harness([
      { json: { ...CODE_ANSWER, verification_uri: 'http://test.salesforce.com/setup/connect' } },
    ]);

    await expect(login.authorize(LOGIN, CLIENT_ID)).rejects.toThrow(/not on a Salesforce host/);
  });

  it('refuses an answer carrying no usable code', async () => {
    const { login } = harness([{ json: { ...CODE_ANSWER, user_code: 'AB 12<script>' } }]);

    await expect(login.authorize(LOGIN, CLIENT_ID)).rejects.toThrow(/without a usable code/);
  });

  it('says so when the host answers with a page instead of JSON', async () => {
    const { login } = harness([{ status: 503, page: '<html>Down for maintenance</html>' }]);

    await expect(login.authorize(LOGIN, CLIENT_ID)).rejects.toThrow(
      'Salesforce answered HTTP 503 with a page instead of JSON. Check the login URL.',
    );
  });

  it('sends nothing once the sign-in is already cancelled', async () => {
    const { login, sent } = harness([{ json: CODE_ANSWER }]);
    const controller = new AbortController();
    controller.abort();

    await expect(login.authorize(LOGIN, CLIENT_ID, controller.signal)).rejects.toBeInstanceOf(
      DeviceLoginCancelledError,
    );
    expect(sent).toHaveLength(0);
  });
});

describe('DeviceLogin.awaitApproval', () => {
  it('polls once per interval with the device code until the user approves', async () => {
    const { login, sent, sleeps } = harness([PENDING, PENDING, { json: APPROVED }]);

    const approval = await login.awaitApproval(LOGIN, CLIENT_ID, authorization());

    expect(approval).toEqual({
      refreshToken: '5Aep861.fake_refresh-token',
      instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com',
    });
    expect(sleeps).toEqual([5_000, 5_000, 5_000]);
    expect(sent.map((request) => request.form)).toEqual([
      { grant_type: 'device', client_id: CLIENT_ID, code: 'device-code-sentinel' },
      { grant_type: 'device', client_id: CLIENT_ID, code: 'device-code-sentinel' },
      { grant_type: 'device', client_id: CLIENT_ID, code: 'device-code-sentinel' },
    ]);
    expect(sent.every((request) => request.url === `${LOGIN}/services/oauth2/token`)).toBe(true);
  });

  it('waits five seconds longer each time Salesforce says to slow down', async () => {
    const slowDown = { status: 400, json: { error: 'slow_down' } };
    const { login, sleeps } = harness([slowDown, slowDown, PENDING, { json: APPROVED }]);

    await login.awaitApproval(LOGIN, CLIENT_ID, authorization());

    expect(sleeps).toEqual([5_000, 10_000, 15_000, 15_000]);
  });

  it('stops with Salesforce’s words when the user denies access', async () => {
    const { login } = harness([
      PENDING,
      {
        status: 400,
        json: { error: 'access_denied', error_description: 'end-user denied authorization' },
      },
    ]);

    await expect(login.awaitApproval(LOGIN, CLIENT_ID, authorization())).rejects.toThrow(
      'Salesforce refused the device sign-in: end-user denied authorization (access_denied)',
    );
  });

  it('gives up when the code expires, without polling past its expiry', async () => {
    const answers: Answer[] = Array.from({ length: 200 }, () => PENDING);
    const { login, sent, sleeps } = harness(answers);

    await expect(
      login.awaitApproval(LOGIN, CLIENT_ID, authorization({ expiresAt: START + 12_000 })),
    ).rejects.toThrow(
      'The code expired before it was approved. Start the sign-in again for a new one.',
    );

    // Polls at +5 s and +10 s; the last wait is cut to the 2 s left, and no
    // request is sent once the code has expired.
    expect(sleeps).toEqual([5_000, 5_000, 2_000]);
    expect(sent).toHaveLength(2);
  });

  it('tries again at the next interval when a poll is lost in transit', async () => {
    const { login, sent } = harness([PENDING, new TypeError('fetch failed'), { json: APPROVED }]);

    const approval = await login.awaitApproval(LOGIN, CLIENT_ID, authorization());

    expect(approval.refreshToken).toBe('5Aep861.fake_refresh-token');
    expect(sent).toHaveLength(3);
  });

  it('stops when the host answers a poll with a page instead of JSON', async () => {
    const { login } = harness([PENDING, { status: 502, page: '<html>Bad gateway</html>' }]);

    await expect(login.awaitApproval(LOGIN, CLIENT_ID, authorization())).rejects.toThrow(
      /HTTP 502 with a page instead of JSON/,
    );
  });

  it('ends with a cancellation, and polls no more, once the sign-in is cancelled', async () => {
    const controller = new AbortController();
    const { login, sent } = harness([PENDING, PENDING, PENDING]);
    const fetchCount = (): number => sent.length;

    const waiting = login.awaitApproval(LOGIN, CLIENT_ID, authorization(), controller.signal);
    controller.abort();

    await expect(waiting).rejects.toBeInstanceOf(DeviceLoginCancelledError);
    expect(fetchCount()).toBeLessThanOrEqual(1);
  });

  it('asks for the refresh_token scope when Salesforce approves without a refresh token', async () => {
    const withoutRefresh = {
      access_token: APPROVED.access_token,
      instance_url: APPROVED.instance_url,
      scope: 'api',
    };
    const { login } = harness([{ json: withoutRefresh }]);

    await expect(login.awaitApproval(LOGIN, CLIENT_ID, authorization())).rejects.toThrow(
      /without a refresh token.*refresh_token, offline_access/,
    );
  });

  it('refuses an approval for an instance that is not a Salesforce host', async () => {
    const { login } = harness([
      { json: { ...APPROVED, instance_url: 'https://acme.example.com' } },
    ]);

    await expect(login.awaitApproval(LOGIN, CLIENT_ID, authorization())).rejects.toThrow(
      /instance that is not a Salesforce host/,
    );
  });

  it('refuses an approval whose instance URL carries a path', async () => {
    const { login } = harness([
      { json: { ...APPROVED, instance_url: 'https://acme.my.salesforce.com/evil@x' } },
    ]);

    await expect(login.awaitApproval(LOGIN, CLIENT_ID, authorization())).rejects.toThrow(
      /instance that is not a Salesforce host/,
    );
  });
});

describe('DeviceLogin with the real clock', () => {
  it('stops waiting between two polls the moment the sign-in is cancelled', async () => {
    let requests = 0;
    const login = new DeviceLogin({
      fetch: async () => {
        requests += 1;
        return new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 });
      },
    });
    const controller = new AbortController();
    const started = Date.now();

    const waiting = login.awaitApproval(
      LOGIN,
      CLIENT_ID,
      authorization({ intervalMs: 60_000, expiresAt: Date.now() + SF_DEVICE_CODE_LIFETIME_MS }),
      controller.signal,
    );
    setTimeout(() => controller.abort(), 10);

    await expect(waiting).rejects.toBeInstanceOf(DeviceLoginCancelledError);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(requests).toBe(0);
  });
});
