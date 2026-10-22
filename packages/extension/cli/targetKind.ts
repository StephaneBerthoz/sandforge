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
    const why = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `${alias} did not say what org it is (${why}), and ${command.tool} ` +
        `${command.action === 'write' ? 'writes to' : 'deletes from'} no org it cannot tell ` +
        `from a production one. Nothing was ${command.action === 'write' ? 'written' : 'deleted'}.\n`,
    );
    process.exit(REFUSED_EXIT);
  }
  const refusal = productionTargetRefusal(alias, org, command);
  if (refusal !== undefined) {
    process.stderr.write(`${refusal}\n`);
    process.exit(REFUSED_EXIT);
  }
  return org;
}
