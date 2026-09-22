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
 * One copy, so the third tool does not have to learn it a third time.
 */

import { execFileSync } from 'node:child_process';
import jsforce from 'jsforce';
import type { Connection } from 'jsforce';

/** An authenticated org, as the `sf` CLI knows it. */
export interface SfOrg {
  alias: string;
  username: string;
  instanceUrl: string;
  accessToken: string;
}

/** SF alias = letters/digits/underscore/dash/dot. Defends against shell metachars. */
const SF_ALIAS_RE = /^[A-Za-z0-9_.-]+$/;

export function loadOrg(alias: string): SfOrg {
  // shell:true on Windows is required to resolve `.cmd` files but lets cmd.exe
  // interpret metacharacters (`&`, `|`, `>`, `^`, `"`). Validate alias before
  // passing — block any shell-injection vector via crafted CLI args.
  if (!SF_ALIAS_RE.test(alias)) {
    throw new Error(
      `Invalid SF org alias: "${alias}" (allowed: letters, digits, underscore, dash, dot)`,
    );
  }
  /*
   * Two commands, because they answer two different questions.
   *
   * `sf org display` gives the org's CURRENT instance URL — after a sandbox
   * refresh or a My Domain change the stored one points elsewhere, and even a
   * live token is rejected there. But its `accessToken` is the stored one,
   * dumped as-is: an org the CLI lists as "Connected" can hand out a token
   * Salesforce refuses. `sf org auth show-access-token` is the only command
   * that refreshes through the stored OAuth session.
   *
   * The extension learnt this on a live org in 2026-08 and says so at length
   * in `core/connection/ConnectionHelper.ts` ("Refresh credentials via the SF
   * CLI"). This script kept the display token, so every run of it ended in
   * INVALID_AUTH_HEADER before reading a single object — which is what a first
   * run against a real org found, the documented example in the header above
   * having never been executed.
   */
  const run = (args: string[]): string =>
    execFileSync('sf', args, {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      shell: process.platform === 'win32',
    });

  const json = run(['org', 'display', '--target-org', alias, '--json']);
  let liveToken: string | undefined;
  try {
    const shown = JSON.parse(run(['org', 'auth', 'show-access-token', '-o', alias, '--json'])) as {
      result?: { accessToken?: string } | string;
    };
    // The command answers with a bare string on some CLI versions.
    liveToken =
      typeof shown.result === 'string' ? shown.result : (shown.result?.accessToken ?? undefined);
  } catch {
    // Older CLI without the command: fall back to the stored token below.
    liveToken = undefined;
  }
  const parsed = JSON.parse(json) as {
    result?: { accessToken?: string; instanceUrl?: string; username?: string };
  };
  if (!parsed.result?.accessToken || !parsed.result?.instanceUrl) {
    throw new Error(`sf org display did not return a usable session for alias '${alias}'.`);
  }
  return {
    alias,
    username: parsed.result.username ?? '',
    instanceUrl: parsed.result.instanceUrl,
    accessToken: liveToken ?? parsed.result.accessToken,
  };
}

export function makeConn(org: SfOrg): Connection {
  return new jsforce.Connection({
    instanceUrl: org.instanceUrl,
    accessToken: org.accessToken,
    version: '66.0',
  });
}
