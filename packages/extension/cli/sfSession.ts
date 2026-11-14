/**
 * The session the headless tools share.
 *
 * Both CLIs authenticate the same way, and the way is not obvious: `sf org
 * display` answers with the org's CURRENT instance URL but dumps the STORED
 * access token, which Salesforce can refuse on an org the CLI happily lists
 * as "Connected". Only `sf org auth show-access-token` refreshes through the
 * stored OAuth session. The extension learnt that on a live org in 2026-08 and
 * says so at length in `core/connection/ConnectionHelper.ts`; the clone CLI
 * had to learn it a second time, in 2026-09, when every run of it ended in
 * `INVALID_AUTH_HEADER` before reading a single object.
 *
 * One copy, so the third tool does not have to learn it a third time: the
 * token comes from the extension's own CLI read.
 */

import { execFileSync } from 'node:child_process';
import jsforce from 'jsforce';
import { HttpProxyTransport } from 'jsforce/lib/transport';
import { expiredScratchDate } from '@sandforge/shared';
import type { Connection } from 'jsforce';
import {
  isUsableAccessToken,
  refreshTokenViaCli,
  type CliCredentials,
} from '../src/core/connection/ConnectionHelper.js';
import { SF_ALIAS_RE } from './commandLine.js';
import { sfDisplayFailure } from './sfFailure.js';

/** An authenticated org, as the `sf` CLI knows it. */
export interface SfOrg {
  alias: string;
  username: string;
  instanceUrl: string;
  accessToken: string;
  /**
   * The CLI shows a scratch org: `sf org display` names its Dev Hub. Absent
   * otherwise. A scratch org says `IsSandbox` true, as a sandbox does, and
   * nothing the org itself says tells the two apart.
   */
  scratch?: true;
}

/** Reads a live token for an org through the `sf` CLI. */
export type SfTokenReader = (alias: string) => Promise<CliCredentials>;

/**
 * Run `sf org display` for `alias`, its JSON document as `sf` printed it.
 *
 * @throws {SfSessionError} When `sf` is missing or answers with an error.
 */
function displayOf(alias: string): string {
  try {
    return execFileSync('sf', ['org', 'display', '--target-org', alias, '--json'], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      shell: process.platform === 'win32',
    });
  } catch (err: unknown) {
    throw sfDisplayFailure(alias, err);
  }
}

/**
 * The org an `sf` alias names, with a token Salesforce takes.
 *
 * @param alias - The `sf` alias of the org.
 * @param readToken - How the token is read; the extension's CLI read unless
 *   a test gives another.
 * @throws When the CLI gives no usable token; the message says what to do.
 */
export async function loadOrg(
  alias: string,
  readToken: SfTokenReader = refreshTokenViaCli,
): Promise<SfOrg> {
  // shell:true on Windows is required to resolve `.cmd` files but lets cmd.exe
  // interpret metacharacters (`&`, `|`, `>`, `^`, `"`). Validate alias before
  // passing — block any shell-injection vector via crafted CLI args.
  if (!SF_ALIAS_RE.test(alias)) {
    throw new Error(
      `Invalid SF org alias: "${alias}" (an alias or a username: letters, digits, _ . @ + and -, ` +
        'not starting with . @ + or -)',
    );
  }
  // The username and the org's current instance, from `sf org display`. Its
  // token is not read: CLI 2.150 prints "[REDACTED] Use 'sf org auth
  // show-access-token' to view" there, and this session used to fall back on
  // it whenever show-access-token did not answer, sending that sentence as the
  // token. The extension's read tries show-access-token first and takes
  // display's token only where it is a real one.
  const json = displayOf(alias);
  const parsed = JSON.parse(json) as {
    result?: {
      instanceUrl?: string;
      username?: string;
      devHubId?: unknown;
      status?: unknown;
      expirationDate?: unknown;
    };
  };
  // A scratch org past its expiration date is gone: Salesforce deletes it. Its
  // stored token still reads as one, and the first call came back HTTP 420
  // with an HTML page on an expired one (2026-11-13), the display saying
  // "Deleted". No sign-in brings it back, so the message names what does.
  const shown = parsed.result;
  if (typeof shown?.devHubId === 'string' && shown.devHubId !== '') {
    const expiredOn =
      typeof shown.expirationDate === 'string'
        ? expiredScratchDate(
            { orgType: 'Scratch', metadata: { expirationDate: shown.expirationDate } },
            new Date().toISOString().slice(0, 10),
          )
        : undefined;
    if (expiredOn !== undefined || shown.status === 'Deleted') {
      throw new Error(
        `The scratch org '${alias}' ${expiredOn !== undefined ? `expired on ${expiredOn}` : 'is deleted'}: ` +
          'Salesforce deletes a scratch org when it expires, and no sign-in brings it back. ' +
          'Create a new one ("sf org create scratch") and give its alias.',
      );
    }
  }
  if (!parsed.result?.instanceUrl) {
    throw new Error(`sf org display did not return a usable session for alias '${alias}'.`);
  }
  const live = await readToken(alias);
  if (!isUsableAccessToken(live.accessToken)) {
    // A CI job has no browser for `sf org login web`, which was the one way
    // the message named: it signs in with a JWT or an auth URL.
    throw new Error(
      `The Salesforce CLI showed no usable access token for alias '${alias}'. Sign in again ` +
        `with "sf org login web --alias ${alias}" where a browser opens; in a CI job, with ` +
        `"sf org login jwt --alias ${alias}" (a client id, a key file and a username) or ` +
        `"sf org login sfdxurl --alias ${alias} --sfdx-url-file <file>" (see ci-examples/README.md).`,
    );
  }
  return {
    alias,
    username: parsed.result.username ?? '',
    // The instance the token was read for, which the CLI reports afresh.
    instanceUrl: live.instanceUrl ?? parsed.result.instanceUrl,
    accessToken: live.accessToken,
    // The extension types a scratch org by the same word of the display
    // (`SfdxBridge.findOrg`).
    ...(typeof parsed.result.devHubId === 'string' && parsed.result.devHubId !== ''
      ? { scratch: true as const }
      : {}),
  };
}

/** A variable of the environment as curl reads it: the lowercase name first, then the uppercase one. */
function variableOf(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = (env[name.toLowerCase()] ?? env[name.toUpperCase()] ?? '').trim();
  return value === '' ? undefined : value;
}

/**
 * Whether NO_PROXY sends `target` past the proxy: `*`, or an entry that is
 * its host or a domain above it (`salesforce.com`, `.salesforce.com` and
 * `*.salesforce.com` alike take `acme.my.salesforce.com`), on any port or the
 * one the entry names.
 */
function bypassesProxy(target: URL, noProxy: string | undefined): boolean {
  if (noProxy === undefined) return false;
  const host = target.hostname.toLowerCase();
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  return noProxy
    .split(/[\s,]+/)
    .filter((entry) => entry !== '')
    .some((entry) => {
      if (entry === '*') return true;
      const [, name = '', entryPort] = /^(.*?)(?::(\d+))?$/.exec(entry.toLowerCase()) ?? [];
      if (entryPort !== undefined && entryPort !== port) return false;
      const domain = name.replace(/^\*?\.?/, '');
      return domain !== '' && (host === domain || host.endsWith(`.${domain}`));
    });
}

/**
 * The proxy a connection to `url` goes through, or nothing for a direct one:
 * HTTPS_PROXY for an https address, HTTP_PROXY otherwise and when HTTPS_PROXY
 * is not set, as jsforce reads them; none for a host NO_PROXY names.
 *
 * jsforce 3.10.14 reads HTTPS_PROXY and HTTP_PROXY itself as it loads
 * (`lib/transport.js`, its request defaults) and never NO_PROXY: behind a
 * proxy that refuses Salesforce, with Salesforce in NO_PROXY as `sf` reads
 * it, `sf` signed in and every call of the command went to the proxy.
 * Exported so it can be tested.
 */
export function proxyFor(url: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return undefined;
  }
  const proxy =
    target.protocol === 'https:'
      ? (variableOf(env, 'https_proxy') ?? variableOf(env, 'http_proxy'))
      : variableOf(env, 'http_proxy');
  if (proxy === undefined) return undefined;
  return bypassesProxy(target, variableOf(env, 'no_proxy')) ? undefined : proxy;
}

/**
 * A connection to the org, through the proxy the environment names for its
 * instance ({@link proxyFor}), or straight to it. jsforce's own transport
 * would take its proxy from the environment as it loaded, NO_PROXY unread: a
 * direct connection is given a proxy transport with no proxy, which jsforce's
 * request reads as none.
 */
export function makeConn(org: SfOrg, env: NodeJS.ProcessEnv = process.env): Connection {
  const proxy = proxyFor(org.instanceUrl, env);
  const conn = new jsforce.Connection({
    instanceUrl: org.instanceUrl,
    accessToken: org.accessToken,
    version: '66.0',
    ...(proxy !== undefined ? { httpProxy: proxy } : {}),
  });
  if (proxy === undefined) conn._transport = new HttpProxyTransport('');
  return conn;
}

/**
 * Count each request a connection sends from now on, SOAP calls included: the
 * extension's count, which a checkpoint's runs read too.
 */
export { countRequests } from '../src/core/precheck/orgKindLive.js';
