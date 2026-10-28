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
 *
 * Custom settings. A checkpoint that holds custom settings — a take that
 * names any, an act on a checkpoint that holds one — asks for Customize
 * Application too, in the same statement. View All Custom Settings lets a
 * user read them and never write them (P-C2-perm: a Standard User given it
 * read every row and was refused each insert and update,
 * `CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY`, its own hierarchy row among them),
 * so a rewind could not put back what the take held. Whether Modify All Data
 * alone lets a user write them was not probed: the rule may refuse a user who
 * could have, never the other way. An act that holds none asks nothing more.
 *
 * Query All Files is read in the same statement, and its absence refuses
 * nothing. Without it, a user with View All Data still does not see a file
 * someone else owns in a read of the files that names no id, even linked to
 * a record the user sees (P-A7, a scratch org); named by its id, through the
 * link to that record, the file is seen, deleted and brought back. A
 * checkpoint reads its files so, and what it cannot reach — a file of a
 * library the user is not a member of, linked to no record it holds — is a
 * blind spot it names. Asked for, it would refuse a checkpoint of each of the
 * test orgs, whose admins all lack it, and of most orgs.
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

/**
 * What a checkpoint is about to do to an org: an import keeps on this machine
 * a checkpoint of it another machine exported, and reads the org first.
 */
export type CheckpointAct = 'take' | 'preview' | 'rewind' | 'undo' | 'import';

/** What the guard is asked about, whatever the act. */
interface CheckpointGuardBase {
  /** How the user knows the org: its alias, else its username. */
  orgName: string;
  /** The org as the registry holds it; undefined when it holds none. */
  registered: OrgTypeAndEdition | undefined;
  /** The user SandForge connects as, as a refusal names them. */
  username: string;
  /**
   * Whether the act keeps or writes custom settings: a take that names any,
   * an act on a checkpoint that holds one (`holdsCustomSettings`). Customize
   * Application is then asked too.
   */
  customSettings?: boolean;
}

/** A take, which has no checkpoint yet, or an act on a checkpoint, of the org it names. */
export type CheckpointGuardRequest =
  | (CheckpointGuardBase & { act: 'take' })
  | (CheckpointGuardBase & {
      act: 'preview' | 'rewind' | 'undo' | 'import';
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
      /**
       * Whether the user has Query All Files: without it, files the user does
       * not own are seen only by their id or through a link to a record.
       */
      queryAllFiles: boolean;
    }
  | { allowed: false; refusal: CheckpointRefusal };

/** The two permissions, as `UserPermissionAccess` names them and as a person reads them. */
const PERMISSIONS = [
  { field: 'PermissionsViewAllData', label: 'View All Data' },
  { field: 'PermissionsModifyAllData', label: 'Modify All Data' },
] as const;

/** Query All Files, as `UserPermissionAccess` names it: read with the two, refusing nothing. */
const QUERY_ALL_FILES = 'PermissionsQueryAllFiles';

/** Customize Application, as `UserPermissionAccess` names it: asked where custom settings are held. */
const CUSTOMIZE_APPLICATION = 'PermissionsCustomizeApplication';

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
  import:
    'An import needs a user with View All Data and Modify All Data: SandForge never keeps on ' +
    'this machine records its user could not see in the org, and a rewind to it must',
};

/**
 * What a refusal for want of Customize Application says, act by act, beside
 * what lifts it.
 */
const CUSTOMIZE_LIFTS: Readonly<Record<CheckpointAct, string>> = {
  take: 'Leave the custom settings out of the checkpoint, or give the user Customize Application.',
  preview: 'This checkpoint holds custom settings: give the user Customize Application.',
  rewind: 'This checkpoint holds custom settings: give the user Customize Application.',
  undo: 'This checkpoint holds custom settings: give the user Customize Application.',
  import: 'This checkpoint holds custom settings: give the user Customize Application.',
};

/** The refusal of an act that keeps or writes custom settings, the user lacking Customize Application. */
function customizeRefusal(request: CheckpointGuardRequest): CheckpointGuardResult {
  return refused(
    'PERMISSIONS',
    `${request.username} needs Customize Application to keep and rewind custom settings, and ` +
      "doesn't have it: View All Custom Settings lets a user read them, never write them. " +
      `${CUSTOMIZE_LIFTS[request.act]} ${NOTHING_DONE}`,
  );
}

/**
 * The permissions of the two the running user lacks, by the names a person
 * reads, whether the user has Query All Files, and, when `customize` asks,
 * whether they have Customize Application; or why the two could not be read.
 *
 * Query All Files is asked in the statement that asks the two. An org that
 * refuses that statement is asked the two alone, and its user is then taken
 * for one without Query All Files: a field the org does not know would
 * otherwise refuse every checkpoint of it, for a permission that refuses
 * none. Customize Application is asked in both statements, and only when
 * custom settings are held: a statement that asks it of an act that holds
 * none would be one more field the org could refuse.
 */
async function permissionsOf(
  conn: Pick<Connection, 'query'>,
  customize: boolean,
): Promise<
  { missing: string[]; queryAllFiles: boolean; customizeApplication: boolean } | { unread: string }
> {
  const asked = [...PERMISSIONS.map((p) => p.field), ...(customize ? [CUSTOMIZE_APPLICATION] : [])];
  const read = async (fields: readonly string[]): Promise<Record<string, unknown> | undefined> => {
    const answer = await conn.query<Record<string, unknown>>(
      `SELECT ${fields.join(', ')} FROM UserPermissionAccess`,
    );
    return answer.records[0];
  };
  let row: Record<string, unknown> | undefined;
  try {
    row = await read([...asked, QUERY_ALL_FILES]);
  } catch {
    try {
      row = await read(asked);
    } catch (err: unknown) {
      return { unread: err instanceof Error ? err.message : String(err) };
    }
  }
  return {
    missing: PERMISSIONS.filter((p) => row?.[p.field] !== true).map((p) => p.label),
    queryAllFiles: row?.[QUERY_ALL_FILES] === true,
    customizeApplication: row?.[CUSTOMIZE_APPLICATION] === true,
  };
}

/**
 * Ask the org, before anything of it is read or written, whether a checkpoint
 * may be taken of it, previewed, rewound to or undone, or imported from
 * another machine's export: before the file is decrypted, so this machine
 * never holds what its user could not see in the org.
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
      request.act === 'import'
        ? `${orgName} is another org than the one this file holds a checkpoint of: it is ` +
            'imported for the org it was taken of alone, under any alias of it. Nothing was ' +
            'imported.'
        : `${orgName} is another org than the one this checkpoint was taken of: its Organization ` +
            "Id has changed, as a sandbox's does when it is refreshed. This checkpoint is of the " +
            `org before it, and can only be deleted. ${NOTHING_DONE}`,
    );
  }

  const customize = request.customSettings === true;
  const held = await permissionsOf(conn, customize);
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
  if (customize && !held.customizeApplication) return customizeRefusal(request);

  return { allowed: true, org, tier: tierOf(registered, org), queryAllFiles: held.queryAllFiles };
}
