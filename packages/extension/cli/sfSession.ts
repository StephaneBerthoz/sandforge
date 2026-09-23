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
import type { Connection } from 'jsforce';
import {
  isUsableAccessToken,
  refreshTokenViaCli,
  type CliCredentials,
} from '../src/core/connection/ConnectionHelper.js';

/** An authenticated org, as the `sf` CLI knows it. */
export interface SfOrg {
  alias: string;
  username: string;
  instanceUrl: string;
  accessToken: string;
}

/** Reads a live token for an org through the `sf` CLI. */
export type SfTokenReader = (alias: string) => Promise<CliCredentials>;

/** SF alias = letters/digits/underscore/dash/dot. Defends against shell metachars. */
const SF_ALIAS_RE = /^[A-Za-z0-9_.-]+$/;

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
      `Invalid SF org alias: "${alias}" (allowed: letters, digits, underscore, dash, dot)`,
    );
  }
  // The username and the org's current instance, from `sf org display`. Its
  // token is not read: CLI 2.150 prints "[REDACTED] Use 'sf org auth
  // show-access-token' to view" there, and this session used to fall back on
  // it whenever show-access-token did not answer, sending that sentence as the
  // token. The extension's read tries show-access-token first and takes
  // display's token only where it is a real one.
  const json = execFileSync('sf', ['org', 'display', '--target-org', alias, '--json'], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  const parsed = JSON.parse(json) as { result?: { instanceUrl?: string; username?: string } };
  if (!parsed.result?.instanceUrl) {
    throw new Error(`sf org display did not return a usable session for alias '${alias}'.`);
  }
  const live = await readToken(alias);
  if (!isUsableAccessToken(live.accessToken)) {
    throw new Error(
      `The Salesforce CLI showed no usable access token for alias '${alias}'. Sign in again with "sf org login web --alias ${alias}".`,
    );
  }
  return {
    alias,
    username: parsed.result.username ?? '',
    // The instance the token was read for, which the CLI reports afresh.
    instanceUrl: live.instanceUrl ?? parsed.result.instanceUrl,
    accessToken: live.accessToken,
  };
}

export function makeConn(org: SfOrg): Connection {
  return new jsforce.Connection({
    instanceUrl: org.instanceUrl,
    accessToken: org.accessToken,
    version: '66.0',
  });
}
