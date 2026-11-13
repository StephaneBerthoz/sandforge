/**
 * What an emptying asks of an org before it reads a record of it, and what
 * it reads of the user and of the people at work there.
 *
 * **Production.** An emptying deletes every record of the objects it is
 * given. In a production org that is the business itself, and nothing lifts
 * the refusal: not Production Guard's override of a delete in production
 * (`setProductionOverride`), which is never consulted, nor any setting, flag
 * or answer. The org passes only when the registry (`isDevelopmentOrg`) and
 * the org itself (`typeTarget`) both say it is a sandbox, a scratch org or a
 * Developer Edition org, as a checkpoint asks (`checkpointGuard.ts`): the
 * registry holds what the org said when it was connected, an alias can be
 * pointed at another org since, and an org that will not say what it is is
 * taken for a production org. The registry is read first, so an org it has
 * as one is asked nothing.
 *
 * **Staging.** A sandbox marked Staging holds real data — a full copy, UAT —
 * and an emptying of the whole of it is refused there, whatever is answered.
 * Objects picked there are asked of Production Guard, as every delete in a
 * staging org is.
 *
 * **The user.** View All Data and Modify All Data say whether the user sees
 * every record an emptying deletes and brings back what anyone deleted;
 * Bulk API Hard Delete, whether a job that deletes for good is taken: without
 * it the org refuses the job as it is opened (`FEATURENOTENABLED`, asked
 * live), and an emptying asked to delete for good is refused before it reads
 * a record. All three are read in one statement.
 *
 * **People at work.** An emptying takes back what everyone made, colleagues'
 * work of the morning included. As a rewind reads it (`activeLastHour`),
 * someone other than the user it deletes as and the org's Automated Process
 * who changed a record of the objects it deletes in the hour before is at
 * work there now. The emptying is refused then, unless their work is
 * accepted to go: a sandbox an integration writes to all day long could
 * otherwise never be emptied. What is accepted is said first — each person
 * and their last change on the page, beside its box; how many and the last
 * change in a dry run of the command line, before `--accept-people-active` —
 * and a run takes the work of the people its preview named, and of no one
 * else.
 */

import type { Connection } from 'jsforce';
import {
  guardTierOf,
  isDevelopmentOrg,
  type DataOpsEmptyPersonActive,
  type DataOpsEmptyRefusal,
  type DataOpsEmptyTier,
  type OrgTypeAndEdition,
} from '@sandforge/shared';
import { extractErrorMessage } from '../../../core/common/extractErrorMessage.js';
import { assertSoqlIdentifier } from '../../../core/common/soqlValidator.js';
import {
  isProductionTarget,
  typeTarget,
  type TypedTarget,
} from '../../../core/precheck/orgKindLive.js';
import type { EmptyMode } from './emptyScope.js';

/** What a refusal before anything was read says. */
export const NOTHING_READ = 'No record was read or deleted.';

/** What a refusal once the org was read says. */
const NOTHING_DELETED = 'Nothing was deleted.';

/** What the guard is asked. */
export interface EmptyGuardRequest {
  /** How the user knows the org: its alias, else its username. */
  orgName: string;
  /** The org as the registry holds it; undefined when it holds none, which is refused. */
  registered: OrgTypeAndEdition | undefined;
  mode: EmptyMode;
}

/** The guard's answer: the org as it read, or why nothing may be read or deleted. */
export type EmptyGuardResult =
  | { allowed: true; org: TypedTarget; tier: DataOpsEmptyTier }
  | { allowed: false; refusal: DataOpsEmptyRefusal };

/** The production refusal, `evidence` saying what showed the org is one or cannot be told from one. */
function productionRefusal(orgName: string, evidence: string): EmptyGuardResult {
  return {
    allowed: false,
    refusal: {
      code: 'PRODUCTION',
      message:
        `${orgName} is a production org, or cannot be told from one: ${evidence}. Emptying is for ` +
        'sandboxes, scratch orgs and Developer Edition orgs: SandForge never empties objects of ' +
        `a production org, and nothing lifts this. ${NOTHING_READ}`,
    },
  };
}

/**
 * Ask the org, before anything of it is read, whether it may be emptied: see
 * the module's comment. Production Guard is not asked here, and its override
 * is read nowhere on the way.
 */
export async function guardEmpty(
  conn: Pick<Connection, 'query'>,
  request: EmptyGuardRequest,
): Promise<EmptyGuardResult> {
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
    return productionRefusal(
      orgName,
      `it did not say what org it is (${extractErrorMessage(err)})`,
    );
  }
  if (isProductionTarget(org)) {
    return productionRefusal(
      orgName,
      org.edition
        ? `its Organization record says IsSandbox false, edition ${org.edition}`
        : 'its Organization record says IsSandbox false, and no edition',
    );
  }
  const tier = guardTierOf(registered);
  if (tier === 'production') {
    return productionRefusal(orgName, 'SandForge has it registered as a production org');
  }
  if (tier === 'staging' && request.mode === 'org') {
    return {
      allowed: false,
      refusal: {
        code: 'STAGING_ORG',
        message:
          `${orgName} is a sandbox marked Staging: it holds real data, and SandForge never ` +
          'empties the whole of it. Pick the objects to empty instead, which Production Guard ' +
          `asks about, or unmark it in Org Manager if it holds nobody's work. ${NOTHING_READ}`,
      },
    };
  }
  return { allowed: true, org, tier };
}

/** What the user an emptying deletes as may do. */
export interface EmptyPermissions {
  viewAllData: boolean;
  modifyAllData: boolean;
  /** Bulk API Hard Delete: without it, no job deletes for good. */
  hardDelete: boolean;
  /** Why they could not be read: an org that will not say is taken for a user with none. */
  unread?: string;
}

/** The three, as `UserPermissionAccess` names them. */
const PERMISSION_COLUMNS = [
  'PermissionsViewAllData',
  'PermissionsModifyAllData',
  'PermissionsBulkApiHardDelete',
] as const;

/**
 * What the user may do, as `UserPermissionAccess` answers for the user the
 * connection acts as. Asked live on two test orgs, it lists Bulk API Hard
 * Delete, false for an admin until a permission set grants it. An org that
 * refuses the statement is asked the two without it, and its user is then
 * taken for one who may not delete for good.
 */
export async function emptyPermissionsOf(
  conn: Pick<Connection, 'query'>,
): Promise<EmptyPermissions> {
  const read = async (columns: readonly string[]): Promise<Record<string, unknown>> => {
    const answer = await conn.query<Record<string, unknown>>(
      `SELECT ${columns.join(', ')} FROM UserPermissionAccess`,
    );
    return answer.records[0] ?? {};
  };
  let row: Record<string, unknown>;
  let unread: string | undefined;
  try {
    row = await read(PERMISSION_COLUMNS);
  } catch (err: unknown) {
    try {
      row = await read(PERMISSION_COLUMNS.slice(0, 2));
      unread = `whether the user has Bulk API Hard Delete could not be read: ${extractErrorMessage(err)}`;
    } catch (again: unknown) {
      return {
        viewAllData: false,
        modifyAllData: false,
        hardDelete: false,
        unread: extractErrorMessage(again),
      };
    }
  }
  return {
    viewAllData: row.PermissionsViewAllData === true,
    modifyAllData: row.PermissionsModifyAllData === true,
    hardDelete: row.PermissionsBulkApiHardDelete === true,
    ...(unread !== undefined ? { unread } : {}),
  };
}

/**
 * The refusal of a delete for good the user may not send. It names no one:
 * the user SandForge deletes as is said so, never by a username, which the
 * output a person copies into a ticket or a channel would carry with it.
 * Said once the org was read, it says nothing was deleted.
 */
export function hardDeleteRefusal(
  permissions: Pick<EmptyPermissions, 'unread'>,
): DataOpsEmptyRefusal {
  return {
    code: 'HARD_DELETE_NOT_PERMITTED',
    message:
      'Deleting for good needs Bulk API Hard Delete, and the user SandForge deletes as ' +
      (permissions.unread !== undefined
        ? `could not be read to have it (${permissions.unread}). `
        : "doesn't have it: Salesforce refuses the job as it is opened. ") +
      'Give the user a permission set with Bulk API Hard Delete, or empty to the recycle bin, ' +
      'which Undo brings back. Nothing was deleted.',
  };
}

/** The hour before a read in which someone who changed a record is at work in the org now. */
export const ACTIVE_WINDOW_MS = 60 * 60_000;

/** Rows one object's read of who changed it is answered with, at most. */
const ACTIVE_ROWS = 2_000;

/** A user Id, as it may go in a statement. */
const USER_ID = /^005[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/;

/** What was read of the people at work. */
export interface PeopleActive {
  /**
   * The people other than the run's own writers who changed a record, by
   * their user Id as the org gave it — eighteen characters over the API, as
   * every other id a command line prints —, each once whatever its case.
   */
  people: string[];
  /** Set when a read reached its row limit: there may be more people than counted. */
  atLeast?: true;
  /** Each of them, in the order of {@link people}: the records of theirs read, and their last change. */
  who: DataOpsEmptyPersonActive[];
  /** The objects whose read the org refused, each with its words. */
  unread: string[];
}

/** What reading the people at work needs of an org. */
export interface PeopleActiveOrg {
  query(soql: string): Promise<{ records: unknown[] }>;
}

/**
 * The people other than `own` — the user the emptying deletes as and the
 * org's Automated Process — who changed a record of `objects` since `since`
 * (an ISO date-time on the org's clock): one read per object, its last
 * modifier and when, two thousand rows at most. An object the org will not
 * read so is named, and counts no one: its read never passes for one that
 * found nobody. `LastModifiedDate` is the column the statement already
 * filters on: an object that answers it gives it.
 */
export async function peopleActiveIn(
  org: PeopleActiveOrg,
  objects: readonly string[],
  own: readonly string[],
  since: string,
): Promise<PeopleActive> {
  const ownKeys = own.filter((id) => USER_ID.test(id)).map((id) => id.slice(0, 15));
  const notOwn =
    ownKeys.length > 0
      ? ` AND LastModifiedById NOT IN (${ownKeys.map((key) => `'${key}'`).join(', ')})`
      : '';
  const who = new Map<string, DataOpsEmptyPersonActive>();
  const unread: string[] = [];
  let atLeast = false;
  for (const objectApiName of objects) {
    const object = assertSoqlIdentifier(objectApiName);
    try {
      const answer = await org.query(
        `SELECT LastModifiedById, LastModifiedDate FROM ${object} WHERE LastModifiedDate >= ` +
          `${since}${notOwn} LIMIT ${ACTIVE_ROWS}`,
      );
      if (answer.records.length >= ACTIVE_ROWS) atLeast = true;
      for (const row of answer.records) {
        const { LastModifiedById: by, LastModifiedDate: at } = row as {
          LastModifiedById?: unknown;
          LastModifiedDate?: unknown;
        };
        if (typeof by !== 'string' || !USER_ID.test(by)) continue;
        // One person by the first fifteen characters of their id, given as
        // the org gave it: a JSON of fifteen matched none of the ids of
        // eighteen the API gives everywhere else.
        const key = by.slice(0, 15);
        const when = typeof at === 'string' && !Number.isNaN(Date.parse(at)) ? at : '';
        const known = who.get(key);
        if (!known) {
          who.set(key, { userId: by, records: 1, lastChangedAt: when });
          continue;
        }
        known.records += 1;
        if (
          when !== '' &&
          (known.lastChangedAt === '' || Date.parse(when) > Date.parse(known.lastChangedAt))
        ) {
          known.lastChangedAt = when;
        }
      }
    } catch (err: unknown) {
      unread.push(`${objectApiName}: ${extractErrorMessage(err)}`);
    }
  }
  const keys = [...who.keys()].sort();
  return {
    people: keys.map((key) => (who.get(key) as DataOpsEmptyPersonActive).userId),
    ...(atLeast ? { atLeast: true as const } : {}),
    who: keys.map((key) => who.get(key) as DataOpsEmptyPersonActive),
    unread,
  };
}

/** People named at most, in one read of their names. */
const NAMED_AT_MOST = 200;

/**
 * `active` with its people's names (`User.Name`), for the page, which shows
 * whose work its acceptance lets go: one read. A read the org refuses names
 * no one, and the page shows their Ids.
 */
export async function namedPeople(
  org: PeopleActiveOrg,
  active: PeopleActive,
): Promise<PeopleActive> {
  const ids = active.who.map((person) => person.userId).slice(0, NAMED_AT_MOST);
  if (ids.length === 0) return active;
  let records: unknown[];
  try {
    records = (
      await org.query(
        `SELECT Id, Name FROM User WHERE Id IN (${ids.map((id) => `'${id}'`).join(', ')})`,
      )
    ).records;
  } catch {
    return active;
  }
  const names = new Map<string, string>();
  for (const row of records) {
    const { Id: id, Name: name } = row as { Id?: unknown; Name?: unknown };
    if (typeof id === 'string' && typeof name === 'string' && name.trim() !== '') {
      names.set(id.slice(0, 15), name.trim());
    }
  }
  return {
    ...active,
    who: active.who.map((person) => {
      const name = names.get(person.userId.slice(0, 15));
      return name !== undefined ? { ...person, name } : person;
    }),
  };
}

/** When the last of `who` changed a record, on the org's clock; undefined when none was dated. */
export function lastChangeOf(who: readonly DataOpsEmptyPersonActive[]): string | undefined {
  let last: string | undefined;
  for (const person of who) {
    if (person.lastChangedAt === '') continue;
    if (last === undefined || Date.parse(person.lastChangedAt) > Date.parse(last)) {
      last = person.lastChangedAt;
    }
  }
  return last;
}

/** Whose words a refusal of people at work names what lifts it in. */
export type PeopleActiveVoice = 'flags' | 'page';

/**
 * The refusal of an emptying while people are at work, unless their work is
 * accepted to go. `accepted` is the people an acceptance covers — those the
 * preview the run acts on named, by their key — or `true`, whoever is at work:
 * a dry run asked with the acceptance, or the resume of a run, which has no
 * preview. Someone the acceptance does not cover refuses the run all the
 * same: it never takes the work of a person nobody was shown.
 *
 * Named by how many they are and when the last of them changed a record,
 * never by who: the command line's output and the audit trail keep the
 * refusal. The preview names them for the page, beside its box.
 */
export function peopleActiveRefusal(
  orgName: string,
  active: Pick<PeopleActive, 'people' | 'atLeast' | 'who'>,
  options: { accepted?: true | readonly string[]; voice?: PeopleActiveVoice } = {},
): DataOpsEmptyRefusal | undefined {
  if (options.accepted === true) return undefined;
  const covered = new Set((options.accepted ?? []).map((id) => id.slice(0, 15)));
  const others = active.people.filter((id) => !covered.has(id.slice(0, 15)));
  if (others.length === 0) return undefined;
  const count = others.length;
  const people = `${active.atLeast ? 'At least ' : ''}${count} ${count === 1 ? 'person' : 'people'}`;
  const last = lastChangeOf(active.who.filter((person) => others.includes(person.userId)));
  const unnamed = covered.size > 0 ? ' the preview did not name' : '';
  const lift =
    options.voice === 'page'
      ? 'or tick the box that lets their work go, to empty all the same'
      : 'or add --accept-people-active to empty all the same';
  return {
    code: 'PEOPLE_ACTIVE',
    message:
      `${people}${unnamed} other than the user SandForge deletes as changed records of these ` +
      `objects in ${orgName} in the last hour${last !== undefined ? `, the last at ${last}` : ''}: ` +
      `emptying them would take their work. Empty once they have stopped, ${lift}. ` +
      NOTHING_DELETED,
  };
}
