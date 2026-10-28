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
 * Without the two, an act whose caller can tell the user who runs it (its
 * `userId`) reads what the user holds object by object: every row of
 * `ObjectPermissions` of their permission sets, OR over the rows
 * (`checkpointAccess.ts`). A Standard User reads them for themselves (P-B4:
 * `ObjectPermissions`, `PermissionSetAssignment`, `UserPermissionAccess`,
 * none refused). A permission set group is read by its aggregate, whose rows
 * reflect its muting (P-B5: Modify All muted read false there); the sets
 * assigned on their own, and the profile's, by the assignments that name no
 * group — so a group is never read through a set its assignment may name,
 * whichever that is. Where nothing gives Modify All on any object, nothing
 * could be held, and the act is refused as it was. A read the org refuses
 * refuses the act in its words: `PermissionSetAssignment` needs View Setup
 * and Configuration, among other permissions, since Summer '20. An act whose
 * caller gives no user id — one that cannot act object by object — is
 * refused without the two, as it always was; and so is an import, whatever
 * its caller gives: the file it keeps was read by another machine's user.
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
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import {
  isProductionTarget,
  typeTarget,
  type TypedTarget,
} from '../../core/precheck/orgKindLive.js';
import { coversAnyObject, grantsOf, type ObjectGrants } from './checkpointAccess.js';

/**
 * What a checkpoint is about to do to an org: an import keeps on this machine
 * a checkpoint of it another machine exported, and reads the org first.
 */
export type CheckpointAct = 'take' | 'preview' | 'rewind' | 'undo' | 'import';

/**
 * What the guard reads an org through: its queries, and the next pages of
 * one that runs past a page. Without `queryMore`, a read of the user's
 * permissions that runs past a page is one the guard could not read whole.
 */
export type CheckpointGuardConnection = Pick<Connection, 'query'> &
  Partial<Pick<Connection, 'queryMore'>>;

/** What the guard is given beside the connection. */
export interface CheckpointGuardDeps {
  /**
   * The id of the user the connection acts as (SOAP `getUserInfo`). Given, a
   * user without View All Data and Modify All Data is read object by object;
   * absent, such a user is refused, as an act that cannot hold an object by
   * its own permissions must refuse them.
   */
  userId?: () => Promise<string>;
}

/**
 * What the user may see and put back: every record of every object, with
 * View All Data and Modify All Data; or, without them, the objects their
 * permission rows give View All or Modify All, `requests` being what reading
 * them sent the org.
 */
export type CheckpointGrants =
  | { kind: 'org' }
  | {
      kind: 'perObject';
      viewAllData: boolean;
      modifyAllData: boolean;
      objects: ObjectGrants;
      requests: number;
    };

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
      grants: CheckpointGrants;
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
  | {
      missing: string[];
      viewAllData: boolean;
      modifyAllData: boolean;
      queryAllFiles: boolean;
      customizeApplication: boolean;
    }
  | { unread: string }
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
    viewAllData: row?.PermissionsViewAllData === true,
    modifyAllData: row?.PermissionsModifyAllData === true,
    queryAllFiles: row?.[QUERY_ALL_FILES] === true,
    customizeApplication: row?.[CUSTOMIZE_APPLICATION] === true,
  };
}

/** A user id as it may go in a statement: 15 or 18 characters, `005` first. */
const USER_ID = /^005[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;

/** A permission set group's id as it may go in a statement. */
const GROUP_ID = /^0PG[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;

/** The columns of a permission row the guard reads. */
const GRANT_COLUMNS = 'SobjectType, PermissionsViewAllRecords, PermissionsModifyAllRecords';

/**
 * Every row of `soql`, page after page, and the requests that sent: a read
 * that runs past a page the connection cannot turn is not read whole.
 */
async function allRows(
  conn: CheckpointGuardConnection,
  soql: string,
): Promise<{ rows: Array<Record<string, unknown>>; requests: number }> {
  let page = await conn.query<Record<string, unknown>>(soql);
  let requests = 1;
  const rows = [...page.records];
  while (!page.done) {
    const next = page.nextRecordsUrl;
    if (next === undefined || conn.queryMore === undefined) {
      throw new Error(
        `the org answered ${rows.length} rows of ${page.totalSize}, and no next page`,
      );
    }
    page = await conn.queryMore<Record<string, unknown>>(next);
    requests++;
    rows.push(...page.records);
  }
  return { rows, requests };
}

/**
 * What the user holds object by object, from every row of `ObjectPermissions`
 * of their permission sets: those assigned on their own and the profile's,
 * by the assignments that name no group, then each group they are assigned
 * by its aggregate. Or why it could not be read, in the org's words.
 */
async function grantsByObject(
  conn: CheckpointGuardConnection,
  userId: () => Promise<string>,
): Promise<{ grants: ObjectGrants; requests: number } | { unread: string }> {
  let requests = 0;
  try {
    const id = await userId();
    requests++;
    if (!USER_ID.test(id)) throw new Error(`the org named the user ${JSON.stringify(id)}`);
    const own = await allRows(
      conn,
      `SELECT ${GRANT_COLUMNS} FROM ObjectPermissions WHERE ParentId IN (SELECT PermissionSetId ` +
        `FROM PermissionSetAssignment WHERE AssigneeId = '${id}' AND PermissionSetGroupId = null)`,
    );
    requests += own.requests;
    const assigned = await allRows(
      conn,
      'SELECT PermissionSetGroupId FROM PermissionSetAssignment ' +
        `WHERE AssigneeId = '${id}' AND PermissionSetGroupId != null`,
    );
    requests += assigned.requests;
    const groups = [
      ...new Set(
        assigned.rows
          .map((row) => row.PermissionSetGroupId)
          .filter((group): group is string => typeof group === 'string' && GROUP_ID.test(group)),
      ),
    ];
    const rows = [...own.rows];
    if (groups.length > 0) {
      const aggregates = await allRows(
        conn,
        `SELECT ${GRANT_COLUMNS} FROM ObjectPermissions WHERE Parent.PermissionSetGroupId IN ` +
          `(${groups.map((group) => `'${group}'`).join(', ')})`,
      );
      requests += aggregates.requests;
      rows.push(...aggregates.rows);
    }
    return { grants: grantsOf(rows), requests };
  } catch (err: unknown) {
    return { unread: extractErrorMessage(err) };
  }
}

/**
 * The acts that may hold an object by its own permissions. An import is not
 * one: it keeps another machine's export only for a user who sees every
 * record of the org, as its file holds what a user of the org could see,
 * whatever their permissions here.
 */
type PerObjectAct = Exclude<CheckpointAct, 'import'>;

/** The act, as a refusal of a user without the two who is read object by object opens with it. */
const PER_OBJECT_NEEDS: Readonly<Record<PerObjectAct, string>> = {
  take:
    'A checkpoint needs a user with View All Data and Modify All Data, or with View All and ' +
    'Modify All on each object it holds: a rewind to it must see and put back what everyone ' +
    'changed there.',
  preview:
    'A preview needs a user with View All Data and Modify All Data, or with View All and ' +
    'Modify All on each object it reads: a record the user cannot see would read as deleted ' +
    'since.',
  rewind:
    'Rewind needs a user with View All Data and Modify All Data, or with View All and Modify ' +
    'All on each object it puts back: it must see and put back what everyone changed there.',
  undo:
    'Undo needs a user with View All Data and Modify All Data, or with View All and Modify ' +
    'All on each object it takes back: it must see and put back what everyone changed there.',
};

/**
 * Ask the org, before anything of it is read or written, whether a checkpoint
 * may be taken of it, previewed, rewound to or undone, or imported from
 * another machine's export: before the file is decrypted, so this machine
 * never holds what its user could not see in the org.
 *
 * @param conn - The connection the act would read and write through.
 * @param request - The act, the org as the registry holds it, and the
 *   checkpoint's Organization Id for any act but a take.
 * @param deps - What else the guard reads the org through: the user's id,
 *   without which a user lacking View All Data and Modify All Data is refused.
 * @returns The org as it said it is, its kind and what the user may see and
 *   put back; or the refusal, with the code the panel words it by and the
 *   sentence a command line prints.
 */
export async function guardCheckpoint(
  conn: CheckpointGuardConnection,
  request: CheckpointGuardRequest,
  deps: CheckpointGuardDeps = {},
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
  const lacking = held.missing.length === PERMISSIONS.length ? 'them' : held.missing.join(' and ');
  const act = request.act;
  const userId = act === 'import' ? undefined : deps.userId;
  if (held.missing.length > 0 && userId === undefined) {
    return refused(
      'PERMISSIONS',
      `${opening} ${request.username} doesn't have ${lacking}. ${NOTHING_DONE}`,
    );
  }
  if (customize && !held.customizeApplication) return customizeRefusal(request);
  const allowed = {
    allowed: true,
    org,
    tier: tierOf(registered, org),
    queryAllFiles: held.queryAllFiles,
  } as const;
  if (held.missing.length === 0 || userId === undefined || act === 'import') {
    return { ...allowed, grants: { kind: 'org' } };
  }

  const perObject = await grantsByObject(conn, userId);
  if ('unread' in perObject) {
    return refused(
      'PERMISSIONS',
      `${PER_OBJECT_NEEDS[act]} ${request.username} doesn't have ${lacking}, and SandForge ` +
        'could not read which objects they have View All and Modify All on ' +
        `(${perObject.unread}). View Setup and Configuration lets a user read their own ` +
        'permissions; with View All Data and Modify All Data, nothing needs reading. ' +
        NOTHING_DONE,
    );
  }
  if (!coversAnyObject(perObject.grants)) {
    return refused(
      'PERMISSIONS',
      `${PER_OBJECT_NEEDS[act]} ${request.username} doesn't have ${lacking}, nor View All ` +
        'and Modify All on any object. Give the user View All and Modify All on the objects to ' +
        `hold, or View All Data and Modify All Data. ${NOTHING_DONE}`,
    );
  }
  return {
    ...allowed,
    grants: {
      kind: 'perObject',
      viewAllData: held.viewAllData,
      modifyAllData: held.modifyAllData,
      objects: perObject.grants,
      requests: perObject.requests,
    },
  };
}
