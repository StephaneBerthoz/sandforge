/**
 * What kind of org a command line writes to, and its refusal of a production
 * one.
 *
 * The clone, the backup, DataOps and Frozen command lines refused a production
 * target; Seed, Sync and Autopilot wrote to whatever org the alias named, and
 * the cleanup deleted there. Sync typed its target and handed the type to its
 * gate, whose command-line policy never read it: a CI alias left pointing at a
 * production org took the run's inserts and updates — and then Sync's own
 * `--remove`, which refuses a production org, could not take them back.
 *
 * The rule is the panel's (`orgTypeOf`, `orgTypeToGuardTier`): a sandbox, a
 * scratch org and a Developer Edition org are development orgs, any other a
 * production org, and so is one that will not say. Production Guard asks
 * before a write there and blocks a delete; a command line has nobody to ask,
 * and answers no to both, as `commandLineGuard` does for the commands that
 * drive a handler. No flag lifts it.
 *
 * How the org is typed lives in the extension (`core/precheck/orgKindLive.ts`),
 * which a checkpoint's guard reads too.
 */

import type { Connection } from 'jsforce';
import { isAuthError } from '../src/core/common/isAuthError.js';
import { isNetworkError } from '../src/core/common/isNetworkError.js';
import {
  isProductionTarget,
  typeTarget,
  type TypedTarget,
} from '../src/core/precheck/orgKindLive.js';

export { isProductionTarget, typeTarget, type TypedTarget };

/** What a command was about to do to the org: write records, or delete them. */
export type TargetAction = 'write' | 'delete';

/** The command that refuses, and the flag that runs it without writing, which a production org takes. */
export interface RefusingCommand {
  tool: string;
  action: TargetAction;
  /** `--dry-run`, or Autopilot's `--plan-only`. */
  readOnly: string;
}

/**
 * Why the command will not write to the org, or delete from it: it is a
 * production org. Nothing when it is not.
 */
export function productionTargetRefusal(
  alias: string,
  org: TypedTarget,
  command: RefusingCommand,
): string | undefined {
  if (!isProductionTarget(org)) return undefined;
  const said = org.edition
    ? `IsSandbox false, edition ${org.edition}`
    : 'IsSandbox false, and no edition';
  const what =
    command.action === 'write'
      ? `${command.tool} writes to sandboxes and Developer Edition orgs only. Nothing was written`
      : `${command.tool} deletes from sandboxes and Developer Edition orgs only. Nothing was deleted`;
  return (
    `${alias} is a production org (its Organization record says ${said}): ${what}; ` +
    `${command.readOnly}, which only reads, runs against it.`
  );
}

/**
 * Whether the org refused its Organization record to the user the session
 * signs in as: no access to the object, or an object the user's profile does
 * not show at all. Reading it takes View Setup and Configuration.
 */
function organizationRefused(err: unknown): boolean {
  const { errorCode, statusCode } = (typeof err === 'object' && err !== null ? err : {}) as {
    errorCode?: unknown;
    statusCode?: unknown;
  };
  const message = err instanceof Error ? err.message : String(err);
  return (
    statusCode === 403 ||
    (typeof errorCode === 'string' && /^INSUFFICIENT_ACCESS/.test(errorCode)) ||
    /\bINSUFFICIENT_ACCESS/.test(message) ||
    ((errorCode === 'INVALID_TYPE' || /\bINVALID_TYPE\b/.test(message)) &&
      /\bOrganization\b/.test(message))
  );
}

/**
 * Why the command will not write to an org it could not type, and what lets
 * it. It said "did not say what org it is" whatever the cause, which read as
 * final: a session the org refused is signed in again with `sf`, an org that
 * did not answer is tried again, and an Organization record the user may not
 * read takes View Setup and Configuration. An org that answered and said
 * nothing of itself keeps the first words. Exported so it can be tested.
 */
export function untypedTargetRefusal(
  alias: string,
  err: unknown,
  command: RefusingCommand,
): string {
  const why = err instanceof Error ? err.message : String(err);
  const nothing = `Nothing was ${command.action === 'write' ? 'written' : 'deleted'}.`;
  const refuses =
    `${command.tool} ${command.action === 'write' ? 'writes to' : 'deletes from'} no org it ` +
    'cannot tell from a production one';
  if (isAuthError(err)) {
    return (
      `${alias} refused the session sf gave for it (${why}), and ${refuses}. ` +
      `"sf org display --target-org ${alias}" says what sf holds for it; "sf org login web ` +
      `--alias ${alias}" signs in again (in a CI job, "sf org login jwt" or "sf org login ` +
      `sfdxurl"); then run the command again. ${nothing}`
    );
  }
  if (isNetworkError(err)) {
    return `${alias} did not answer (${why}), and ${refuses}. Run the command again once it answers. ${nothing}`;
  }
  if (organizationRefused(err)) {
    return (
      `${alias} would not show its Organization record (${why}), and ${refuses}. Reading it ` +
      'takes the View Setup and Configuration permission: give it to the user the alias signs ' +
      `in as, or name an alias of a user who has it. ${nothing}`
    );
  }
  return `${alias} did not say what org it is (${why}), and ${refuses}. ${nothing}`;
}

/** The exit code of a run refused before it wrote or deleted anything. */
export const REFUSED_EXIT = 1;

/**
 * Type the org a command is about to write to, or delete from, and stop the
 * command when it is a production org, or when it cannot be told from one:
 * said on stderr, exit {@link REFUSED_EXIT}, before anything is sent.
 *
 * @returns The org as typed, for the caller to name the run by its id.
 */
export async function refuseProductionTarget(
  conn: Pick<Connection, 'query'>,
  alias: string,
  command: RefusingCommand,
): Promise<TypedTarget> {
  let org: TypedTarget;
  try {
    org = await typeTarget(conn);
  } catch (err: unknown) {
    process.stderr.write(`${untypedTargetRefusal(alias, err, command)}\n`);
    process.exit(REFUSED_EXIT);
  }
  const refusal = productionTargetRefusal(alias, org, command);
  if (refusal !== undefined) {
    process.stderr.write(`${refusal}\n`);
    process.exit(REFUSED_EXIT);
  }
  return org;
}
