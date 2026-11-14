/**
 * What `sf` said when it could not show an org, read as what to do about it.
 *
 * Kept apart from the session (`sfSession.ts`), which builds jsforce
 * connections: a command that relays the refusal tells it from any other
 * failure by its class, and the tests that stand a session of their own in
 * for the real one keep this file as it is.
 */

import { z } from 'zod';
import { SF_CLI_INSTALL_URL, SF_CLI_MISSING_MESSAGE } from '@sandforge/shared';

/**
 * Why `sf` could not show an org, said as what to do about it: the CLI is
 * missing, does not know the alias, or said why itself. `reason` leaves out
 * what was not done, which a command that relays it says in its own words;
 * the message says it of the org alone, which a verification reads after the
 * target it has already read.
 */
export class SfSessionError extends Error {
  constructor(
    readonly alias: string,
    readonly reason: string,
  ) {
    super(`${reason} Nothing was read from ${alias}.`);
    this.name = 'SfSessionError';
    // A refusal, not a fault: the clone and the cleanup print a fault's stack
    // after FATAL, and the frames of this one would bury what to do.
    this.stack = this.message;
  }
}

/** The `--json` document `sf` prints as it fails: the error's name and its message. */
const sfFailureSchema = z
  .object({ name: z.string().optional(), message: z.string().optional() })
  .loose();

/** The document a stream of `sf` holds, colours and warnings before it left out; nothing when it holds none. */
function sfDocumentOf(text: unknown): z.infer<typeof sfFailureSchema> | undefined {
  if (typeof text !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex -- the colour codes a terminal's sf may print
  const plain = text.replace(/\u001b\[[0-9;]*m/g, '');
  const start = plain.indexOf('{');
  if (start === -1) return undefined;
  try {
    const parsed = sfFailureSchema.safeParse(JSON.parse(plain.slice(start)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether `sf` could not be started at all. Node says ENOENT; on Windows the
 * line goes through `cmd.exe`, which starts, knows no `sf` and ends on 9009.
 */
export function sfIsMissing(err: unknown, platform: NodeJS.Platform = process.platform): boolean {
  const failed = (typeof err === 'object' && err !== null ? err : {}) as {
    code?: unknown;
    status?: unknown;
    stderr?: unknown;
  };
  if (failed.code === 'ENOENT') return true;
  return (
    platform === 'win32' &&
    (failed.status === 9009 ||
      /is not recognized as an internal or external command/i.test(String(failed.stderr ?? '')))
  );
}

/**
 * Why `sf org display` gave nothing for `alias`, as a refusal that says what
 * to do. The command used to end on Node's "Command failed: sf org display
 * --target-org … --json" for an alias `sf` does not know, the reason in the
 * JSON document `sf` prints on stdout and nobody read; and on "spawnSync sf
 * ENOENT" where the CLI is not installed.
 *
 * @param err - What `execFileSync` threw: its `stdout` and `stderr` hold what sf said.
 */
export function sfDisplayFailure(
  alias: string,
  err: unknown,
  platform: NodeJS.Platform = process.platform,
): SfSessionError {
  if (sfIsMissing(err, platform)) {
    return new SfSessionError(
      alias,
      `${SF_CLI_MISSING_MESSAGE} SandForge reads each org through the Salesforce CLI: install it ` +
        `with "npm install -g @salesforce/cli" (${SF_CLI_INSTALL_URL}), sign in to the org with ` +
        `"sf org login web --alias ${alias}", and run again.`,
    );
  }
  const failed = (typeof err === 'object' && err !== null ? err : {}) as {
    stdout?: unknown;
    stderr?: unknown;
  };
  const document = sfDocumentOf(failed.stdout) ?? sfDocumentOf(failed.stderr);
  if (
    document?.name === 'NamedOrgNotFoundError' ||
    /^No authorization information found for /.test(document?.message ?? '')
  ) {
    return new SfSessionError(
      alias,
      `sf does not know ${alias}: "sf org list" names the orgs it knows; ` +
        `"sf org login web --alias ${alias}" adds it (in a CI job, "sf org login jwt" or ` +
        '"sf org login sfdxurl").',
    );
  }
  const stderrLine =
    typeof failed.stderr === 'string'
      ? failed.stderr.split(/\r?\n/).find((line) => line.trim() !== '')
      : undefined;
  const said =
    document?.message?.trim() ||
    stderrLine?.trim() ||
    (err instanceof Error ? err.message : String(err));
  return new SfSessionError(alias, `sf could not show ${alias}: ${said}`);
}
