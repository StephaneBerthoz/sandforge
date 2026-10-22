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
 */

import type { Connection } from 'jsforce';
import { orgTypeOf, orgTypeToGuardTier } from '@sandforge/shared';

/** An org as a command types it: a sandbox, or not and its edition. */
export interface TypedTarget {
  id: string;
  sandbox: boolean;
  edition?: string;
}

/** What the org says it is. `IsSandbox` false and no edition is a production org's. */
export async function typeTarget(conn: Pick<Connection, 'query'>): Promise<TypedTarget> {
  const answer = await conn.query<{ Id?: string; IsSandbox?: boolean }>(
    'SELECT Id, IsSandbox FROM Organization LIMIT 1',
  );
  const row = answer.records[0];
  if (typeof row?.Id !== 'string') {
    throw new Error('The org gave no Organization record: whether it is a sandbox cannot be told.');
  }
  if (row.IsSandbox === true) return { id: row.Id, sandbox: true };
  try {
    const typed = await conn.query<{ OrganizationType?: string }>(
      'SELECT OrganizationType FROM Organization LIMIT 1',
    );
    const edition = typed.records[0]?.OrganizationType;
    return typeof edition === 'string' && edition !== ''
      ? { id: row.Id, sandbox: false, edition }
      : { id: row.Id, sandbox: false };
  } catch {
    return { id: row.Id, sandbox: false };
  }
}

/** Whether the panel's guard takes an org typed so for a production org. */
export function isProductionTarget(org: TypedTarget): boolean {
  const orgType = orgTypeOf({ isSandbox: org.sandbox, edition: org.edition });
  return orgTypeToGuardTier(orgType, org.edition) === 'production';
}

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
