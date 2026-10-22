/**
 * What a checkpoint asks of an org before it reads a record of it or writes
 * one: that it is no production org, that it is still the org the checkpoint
 * was taken of, and that the user SandForge connects as sees and may put back
 * every record.
 *
 * Production. Every other write path asks Production Guard, and an override
 * lifts its refusal of a delete in production. A rewind deletes what was
 * created since, writes values back and brings records back from the recycle
 * bin, whoever made the changes: in a production org, that is the business's
 * own work since the checkpoint. So nothing lifts this refusal — no override,
 * no flag, no setting reaches it. The org passes only when the registry
 * (`isDevelopmentOrg`) and the org itself (`typeTarget`) both say it is a
 * sandbox, a scratch org or a Developer Edition org. Either can be wrong
 * alone: the registry holds what the org said when it was connected, and an
 * alias can be pointed at another org since; an org that will not answer, or
 * names no edition, shows nothing. An org either cannot place is a production
 * org, and the registry is read first, so an org it has as one is not asked
 * anything.
 *
 * The same org. A refreshed sandbox is a new org, with a new Organization Id,
 * under the same username and domain: the connection reaches it without a
 * word. Rewound to a checkpoint of the org before it, the copy would lose
 * every record that checkpoint does not hold.
 *
 * Permissions. SOQL applies the user's sharing: without View All Data, a
 * record the user cannot see reads as deleted since, then is brought back or
 * missed; without Modify All Data, what other users deleted cannot be taken
 * from the recycle bin. `UserPermissionAccess` answers for the running user,
 * and an org that will not say is taken for one whose user has neither. Every
 * act asks, the preview too: it writes nothing, but without View All Data it
 * would tell records the user cannot see as deleted since.
 */

import type { Connection } from 'jsforce';
import {
  isDevelopmentOrg,
  type CheckpointOrgTier,
  type CheckpointRefusal,
  type CheckpointRefusalCode,
  type OrgTypeAndEdition,
} from '@sandforge/shared';
import {
  isProductionTarget,
  typeTarget,
  type TypedTarget,
} from '../../core/precheck/orgKindLive.js';

/** What a checkpoint is about to do to an org. */
export type CheckpointAct = 'take' | 'preview' | 'rewind' | 'undo';

/** What the guard is asked about, whatever the act. */
interface CheckpointGuardBase {
  /** How the user knows the org: its alias, else its username. */
  orgName: string;
  /** The org as the registry holds it; undefined when it holds none. */
  registered: OrgTypeAndEdition | undefined;
  /** The user SandForge connects as, as a refusal names them. */
  username: string;
}

/** A take, which has no checkpoint yet, or an act on a checkpoint, of the org it names. */
export type CheckpointGuardRequest =
  | (CheckpointGuardBase & { act: 'take' })
  | (CheckpointGuardBase & {
      act: 'preview' | 'rewind' | 'undo';
      /** The Organization Id the checkpoint was taken of. */
      organizationId: string;
    });

/** The guard's answer: the org as it read, or why nothing may be read or written. */
export type CheckpointGuardResult =
  | {
      allowed: true;
      /** The org as it said it is, live. */
      org: TypedTarget;
      tier: CheckpointOrgTier;
    }
  | { allowed: false; refusal: CheckpointRefusal };

/** The two permissions, as `UserPermissionAccess` names them and as a person reads them. */
const PERMISSIONS = [
  { field: 'PermissionsViewAllData', label: 'View All Data' },
  { field: 'PermissionsModifyAllData', label: 'Modify All Data' },
] as const;

/** What a refusal says the guard did not do. */
const NOTHING_DONE = 'No record was read or written.';

/** A refusal under `code`, in `message`. */
function refused(code: CheckpointRefusalCode, message: string): CheckpointGuardResult {
  return { allowed: false, refusal: { code, message } };
}

/** The production refusal, `evidence` saying what showed the org is one or cannot be told from one. */
function productionRefusal(orgName: string, evidence: string): CheckpointGuardResult {
  return refused(
    'PRODUCTION',
    `${orgName} is a production org, or cannot be told from one: ${evidence}. Checkpoints are ` +
      'for sandboxes, scratch orgs and Developer Edition orgs: SandForge never takes a ' +
      `checkpoint of, or rewinds, a production org. ${NOTHING_DONE}`,
  );
}

/** What the org's own Organization record said, as a refusal quotes it. */
function liveEvidence(org: TypedTarget): string {
  return org.edition
    ? `its Organization record says IsSandbox false, edition ${org.edition}`
    : 'its Organization record says IsSandbox false, and no edition';
}

/** Whether two Organization Ids name one org: the 15-character id and its 18-character form alike. */
function sameOrganization(a: string, b: string): boolean {
  return a.slice(0, 15) === b.slice(0, 15);
}

/** What kind of development org it is: a scratch org says it is a sandbox, so the registry tells it apart. */
function tierOf(registered: OrgTypeAndEdition, org: TypedTarget): CheckpointOrgTier {
  if (registered.orgType === 'Scratch') return 'scratch';
  return org.sandbox ? 'sandbox' : 'developer';
}

/** The act, as its permissions refusal opens with it. */
const NEEDS: Readonly<Record<CheckpointAct, string>> = {
  take: 'A checkpoint needs a user with View All Data and Modify All Data: a rewind to it must',
  preview:
    'A preview needs a user with View All Data and Modify All Data: a record the user cannot ' +
    'see would read as deleted since, and the rewind it shows must',
  rewind: 'Rewind needs a user with View All Data and Modify All Data: it must',
  undo: 'Undo needs a user with View All Data and Modify All Data: it must',
};

/**
 * The permissions of the two the running user lacks, by the names a person
 * reads, or why they could not be read.
 */
async function missingPermissions(
  conn: Pick<Connection, 'query'>,
): Promise<{ missing: string[] } | { unread: string }> {
  try {
    const answer = await conn.query<Record<string, unknown>>(
      `SELECT ${PERMISSIONS.map((p) => p.field).join(', ')} FROM UserPermissionAccess`,
    );
    const row = answer.records[0];
    return { missing: PERMISSIONS.filter((p) => row?.[p.field] !== true).map((p) => p.label) };
  } catch (err: unknown) {
    return { unread: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Ask the org, before anything of it is read or written, whether a checkpoint
 * may be taken of it, previewed, rewound to or undone.
 *
 * @param conn - The connection the act would read and write through.
 * @param request - The act, the org as the registry holds it, and the
 *   checkpoint's Organization Id for any act but a take.
 * @returns The org as it said it is, and its kind; or the refusal, with the
 *   code the panel words it by and the sentence a command line prints.
 */
export async function guardCheckpoint(
  conn: Pick<Connection, 'query'>,
  request: CheckpointGuardRequest,
): Promise<CheckpointGuardResult> {
  const { orgName, registered } = request;
  if (registered === undefined) {
    return productionRefusal(orgName, 'SandForge has no record of what kind of org it is');
  }
  if (!isDevelopmentOrg(registered)) {
    return productionRefusal(orgName, 'SandForge has it registered as a production org');
  }

  let org: TypedTarget;
  try {
    org = await typeTarget(conn);
  } catch (err: unknown) {
    const why = err instanceof Error ? err.message : String(err);
    return productionRefusal(orgName, `it did not say what org it is (${why})`);
  }
  if (isProductionTarget(org)) return productionRefusal(orgName, liveEvidence(org));

  if (request.act !== 'take' && !sameOrganization(org.id, request.organizationId)) {
    return refused(
      'OTHER_ORG',
      `${orgName} is another org than the one this checkpoint was taken of: its Organization ` +
        "Id has changed, as a sandbox's does when it is refreshed. This checkpoint is of the " +
        `org before it, and can only be deleted. ${NOTHING_DONE}`,
    );
  }

  const held = await missingPermissions(conn);
  const opening = `${NEEDS[request.act]} see and put back what everyone changed.`;
  if ('unread' in held) {
    return refused(
      'PERMISSIONS',
      `${opening} SandForge could not read whether ${request.username} has them ` +
        `(${held.unread}), and takes an org that will not say for a user who has neither. ` +
        NOTHING_DONE,
    );
  }
  if (held.missing.length > 0) {
    const lacking =
      held.missing.length === PERMISSIONS.length ? 'them' : held.missing.join(' and ');
    return refused(
      'PERMISSIONS',
      `${opening} ${request.username} doesn't have ${lacking}. ${NOTHING_DONE}`,
    );
  }

  return { allowed: true, org, tier: tierOf(registered, org) };
}
