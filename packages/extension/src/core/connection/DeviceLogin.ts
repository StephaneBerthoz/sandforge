import { z } from 'zod';
import { SF_DEVICE_CODE_LIFETIME_MS } from '@sandforge/shared';
import { parseHttpsUrl } from '../common/parseHttpsUrl.js';
import { isSalesforceLoginHost } from '../common/salesforceLoginHost.js';

/**
 * The OAuth 2.0 device flow, spoken to Salesforce directly.
 *
 * The Salesforce CLI no longer offers it: `sf org login device` was hidden in
 * 2.103.7 and removed in 2.119.8 (January 2026), after Salesforce blocked the
 * device flow for the CLI's own connected app on 28 August 2025. On CLI
 * 2.150.6, `sf org login device --json` answers "org login device is not a sf
 * command" and exits 127. The flow still works from the user's own external
 * client app with the device flow enabled, and nothing in the CLI drives that
 * any more, so SandForge asks for the code and waits for the approval itself.
 * The session it gets is then handed to the CLI (see
 * `SfdxBridge.loginWithRefreshToken`), which keeps and refreshes it as it
 * does for every org SandForge imports.
 *
 * Endpoint, parameters and error codes follow Salesforce's "OAuth 2.0 Device
 * Flow for IoT Integration" and "OAuth 2.0 Authorization Errors" pages, and
 * the requests the CLI sent before the command was removed.
 */

/** How often to poll when Salesforce names no interval, as RFC 8628 says. */
const DEFAULT_INTERVAL_SECONDS = 5;

/** What RFC 8628 adds to the polling interval each time the server answers `slow_down`. */
const SLOW_DOWN_STEP_MS = 5_000;

/** Longest one request to the token endpoint may take before it counts as lost. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Salesforce's answer to a device authorization request. */
const deviceAuthorizationSchema = z.object({
  device_code: z.string().min(1).max(4096),
  // Documented as an 8-character alphanumeric code; the bound only keeps a
  // malformed answer off the page.
  user_code: z.string().regex(/^[A-Za-z0-9-]{4,32}$/),
  verification_uri: z.string().min(1).max(2048),
  interval: z.number().int().positive().max(300).optional(),
  expires_in: z.number().int().positive().optional(),
});

/** An approved device: the tokens Salesforce issues once the user has entered the code. */
const tokenAnswerSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  instance_url: z.string().min(1).max(2048),
});

/** An OAuth refusal, or the `authorization_pending` / `slow_down` of a device still waiting. */
const oauthErrorSchema = z.object({
  error: z.string().min(1),
  error_description: z.string().optional(),
});

/** What Salesforce answered a device authorization request with, checked. */
export interface DeviceAuthorization {
  /** Proves to the token endpoint which authorization is being polled. Never shown. */
  deviceCode: string;
  /** The code the user types on the verification page. */
  userCode: string;
  /** Salesforce's verification page, on a Salesforce login host. */
  verificationUri: string;
  /** How long to wait between two polls. */
  intervalMs: number;
  /** When Salesforce stops accepting the code, in epoch milliseconds. */
  expiresAt: number;
}

/** What an approved sign-in leaves to hand to the CLI. */
export interface DeviceApproval {
  /** Lets the CLI open sessions for the org from now on. Kept in memory only. */
  refreshToken: string;
  /** The org's own https origin. */
  instanceUrl: string;
}

/** The part of `fetch` this uses. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** What {@link DeviceLogin} takes from its environment; the defaults are the real ones. */
export interface DeviceLoginEnvironment {
  fetch?: FetchLike;
  now?: () => number;
  /** Waits `ms`, and rejects with {@link DeviceLoginCancelledError} once `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** The sign-in was cancelled from the Org Manager before it finished. */
export class DeviceLoginCancelledError extends Error {
  constructor() {
    super('Sign-in cancelled.');
    this.name = 'DeviceLoginCancelledError';
  }
}

/**
 * The host answered, but not with OAuth JSON. Unlike a request lost in
 * transit, asking again at the next interval would get the same page.
 */
class RefusedByHostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefusedByHostError';
  }
}

/** Wait `ms`, or stop at once when `signal` aborts. */
function sleepUnlessCancelled(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DeviceLoginCancelledError());
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DeviceLoginCancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The address a Salesforce answer points at, if it is an `https:` URL on a
 * Salesforce host. The verification page is opened in the user's browser and
 * the instance becomes the org's session host, so neither is taken on trust
 * even from the login host that sent it.
 */
function salesforceUrl(raw: string): URL | undefined {
  const parsed = parseHttpsUrl(raw);
  if (!parsed.ok || parsed.url.username !== '' || parsed.url.password !== '') return undefined;
  if (parsed.url.port !== '' || !isSalesforceLoginHost(parsed.url.hostname)) return undefined;
  return parsed.url;
}

/** Salesforce's refusal, in its own words. */
function describeRefusal(refusal: z.infer<typeof oauthErrorSchema>): string {
  const detail = refusal.error_description
    ? `${refusal.error_description} (${refusal.error})`
    : refusal.error;
  return `Salesforce refused the device sign-in: ${detail}`;
}

/**
 * Asks Salesforce for a device code, then waits until the user approves it in
 * the browser, refuses it, lets it expire, or the sign-in is cancelled.
 */
export class DeviceLogin {
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(environment: DeviceLoginEnvironment = {}) {
    this.fetchFn = environment.fetch ?? ((input, init) => fetch(input, init));
    this.now = environment.now ?? Date.now;
    this.sleep = environment.sleep ?? sleepUnlessCancelled;
  }

  /**
   * Ask for a device code.
   *
   * @param loginUrl - A checked Salesforce login origin (no path).
   * @param clientId - Consumer key of an app with the device flow enabled.
   * @param signal - Aborts the request when the sign-in is cancelled.
   */
  async authorize(
    loginUrl: string,
    clientId: string,
    signal?: AbortSignal,
  ): Promise<DeviceAuthorization> {
    const body = await this.post(
      loginUrl,
      { response_type: 'device_code', client_id: clientId },
      signal,
    );

    const refusal = oauthErrorSchema.safeParse(body);
    if (refusal.success) throw new Error(describeRefusal(refusal.data));

    const parsed = deviceAuthorizationSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error('Salesforce answered the device sign-in without a usable code.');
    }
    const verification = salesforceUrl(parsed.data.verification_uri);
    if (!verification) {
      throw new Error('Salesforce sent a verification page that is not on a Salesforce host.');
    }

    // Never past the documented ten minutes: the Org Manager stops waiting on
    // that bound, and a longer wait here would outlive the page's request.
    const lifetimeMs = Math.min(
      (parsed.data.expires_in ?? Number.POSITIVE_INFINITY) * 1000,
      SF_DEVICE_CODE_LIFETIME_MS,
    );
    return {
      deviceCode: parsed.data.device_code,
      userCode: parsed.data.user_code,
      verificationUri: verification.href,
      intervalMs: (parsed.data.interval ?? DEFAULT_INTERVAL_SECONDS) * 1000,
      expiresAt: this.now() + lifetimeMs,
    };
  }

  /**
   * Poll until the device is approved.
   *
   * Polls once per interval, never after the code has expired. A poll that
   * fails in transit is tried again at the next interval: the login host
   * answered the authorization moments before, and one dropped request over a
   * ten-minute wait is not a reason to throw the approval away. A refusal from
   * Salesforce ends the wait with its own words.
   *
   * @param loginUrl - The origin the authorization was asked from.
   * @param clientId - The consumer key it was asked with.
   * @param authorization - What {@link authorize} returned.
   * @param signal - Ends the wait with {@link DeviceLoginCancelledError}.
   */
  async awaitApproval(
    loginUrl: string,
    clientId: string,
    authorization: DeviceAuthorization,
    signal?: AbortSignal,
  ): Promise<DeviceApproval> {
    let intervalMs = authorization.intervalMs;
    for (;;) {
      const left = authorization.expiresAt - this.now();
      if (left <= 0) break;
      await this.sleep(Math.min(intervalMs, left), signal);
      if (this.now() >= authorization.expiresAt) break;

      let body: unknown;
      try {
        body = await this.post(
          loginUrl,
          { grant_type: 'device', client_id: clientId, code: authorization.deviceCode },
          signal,
        );
      } catch (err: unknown) {
        if (signal?.aborted) throw new DeviceLoginCancelledError();
        if (err instanceof RefusedByHostError) throw err;
        continue;
      }

      const refusal = oauthErrorSchema.safeParse(body);
      if (refusal.success) {
        if (refusal.data.error === 'authorization_pending') continue;
        if (refusal.data.error === 'slow_down') {
          intervalMs += SLOW_DOWN_STEP_MS;
          continue;
        }
        throw new Error(describeRefusal(refusal.data));
      }
      return toApproval(body);
    }
    throw new Error(
      'The code expired before it was approved. Start the sign-in again for a new one.',
    );
  }

  /**
   * POST a form to the org's token endpoint and read the JSON answer.
   * Throws {@link DeviceLoginCancelledError} when `signal` aborted it.
   */
  private async post(
    loginUrl: string,
    form: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) throw new DeviceLoginCancelledError();
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchFn(`${loginUrl}/services/oauth2/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams(form).toString(),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err: unknown) {
      if (signal?.aborted) throw new DeviceLoginCancelledError();
      throw err;
    }
    const text = await response.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // An HTML page instead of JSON: a login host that is down, behind a
      // proxy's page, or not serving OAuth at all.
      throw new RefusedByHostError(
        `Salesforce answered HTTP ${response.status} with a page instead of JSON. Check the login URL.`,
      );
    }
  }
}

/** The approval, checked: a refresh token and the org's Salesforce origin. */
function toApproval(body: unknown): DeviceApproval {
  const parsed = tokenAnswerSchema.safeParse(body);
  if (!parsed.success) {
    throw new Error('Salesforce approved the sign-in without an access token and an instance URL.');
  }
  if (!parsed.data.refresh_token) {
    throw new Error(
      'Salesforce signed you in without a refresh token, so the Salesforce CLI could not keep the session. ' +
        'Give the external client app the "Perform requests at any time (refresh_token, offline_access)" scope, then sign in again.',
    );
  }
  const instance = salesforceUrl(parsed.data.instance_url);
  if (!instance || instance.pathname !== '/' || instance.search !== '' || instance.hash !== '') {
    throw new Error(
      'Salesforce approved the sign-in for an instance that is not a Salesforce host.',
    );
  }
  return { refreshToken: parsed.data.refresh_token, instanceUrl: instance.origin };
}
