/**
 * What `sandforge users` reads of an org before it plans: who the connection
 * is and whether it may manage users, each username of the file resolved,
 * and what those users hold — their logins, the profiles and licenses a run
 * would take, the permission sets, the groups of them, the groups and the
 * queues the file names, the accesses the users hold already, and the
 * address changes asked of them within the link's life.
 *
 * A username resolves without guessing. The org is read for the username as
 * given; failing that, for the usernames that are the given one followed by
 * a dot (`Username LIKE 'jane.qa@acme.com.%'`), and exactly one must answer.
 * Nothing is ever cut off a username: `ada@example.co.uk` names
 * `ada@example.co.uk.uat`, never the user `ada@example.co`.
 *
 * An address the API changes is asked, not changed: Salesforce mails a link
 * to the new address, the setup audit trail says `useremailchangesent`, and
 * `User.Email` stays under `.invalid` until the link is clicked. An address
 * still under `.invalid` with such a line, for this user and to the address
 * without `.invalid`, within the 72 hours the link lives, awaits its owner;
 * asking it again would only mail them again.
 *
 * Reads only: nothing here writes. The address of each user is held in
 * memory to write it back without `.invalid`, and goes no further: no answer
 * and no run file carries it.
 */

import { usernameKey, type UsersConfigUser } from '@sandforge/shared';

import {
  inChunks,
  soqlList,
  soqlStartsWithDot,
  soqlText,
  type UsersOrg,
  type UsersRow,
} from './usersOrg.js';
import type { UsersRunRecord } from './usersRunStore.js';

/** The hours the link Salesforce mails to an address asked back lives. */
export const ADDRESS_LINK_HOURS = 72;

/** Usernames read as given in one statement. */
const EXACT_PER_READ = 50;
/** Usernames read as prefixes in one statement. */
const PREFIXES_PER_READ = 20;
/** Ids of an `IN` in one statement. */
const IDS_PER_READ = 200;
/** Names of an `IN` in one statement. */
const NAMES_PER_READ = 100;

const INVALID = '.invalid';

/**
 * An address without the `.invalid` a sandbox's copy put after it, or
 * undefined when it ends otherwise.
 */
export function addressRestoredOf(email: string): string | undefined {
  const at = email.length - INVALID.length;
  if (at <= 0 || email.slice(at).toLowerCase() !== INVALID) return undefined;
  return email.slice(0, at);
}

// ─── What is read ────────────────────────────────────────────────────────────

/** A user as the org answers it. */
export interface UsersUserRead {
  id: string;
  username: string;
  isActive: boolean;
  profileId: string;
  profileName: string;
  /** The license of its profile. */
  licenseId?: string;
  /** Its address, held to write it back without `.invalid`: never answered, never journaled. */
  email: string;
}

/** What a username of the file names: one user, none, or several. */
export type UsernameResolution =
  | { given: string; kind: 'found'; user: UsersUserRead }
  | { given: string; kind: 'none' }
  | { given: string; kind: 'two'; usernames: string[] };

export interface UsersLoginRead {
  id: string;
  userId: string;
  isFrozen: boolean;
}

export interface UsersProfileRead {
  id: string;
  name: string;
  licenseId?: string;
}

export interface UsersLicenseRead {
  id: string;
  name: string;
  total: number;
  used: number;
}

export interface UsersPermissionSetRead {
  id: string;
  name: string;
  namespace?: string;
  /** The `UserLicense` or `PermissionSetLicense` the set needs. */
  licenseId?: string;
}

export interface UsersPermissionSetGroupRead {
  id: string;
  name: string;
  namespace?: string;
}

export interface UsersGroupRead {
  id: string;
  name: string;
  type: 'Regular' | 'Queue';
}

export interface UsersAssignmentRead {
  id: string;
  assigneeId: string;
  permissionSetId?: string;
  permissionSetGroupId?: string;
}

export interface UsersMembershipRead {
  id: string;
  groupId: string;
  userId: string;
}

/** What a plan is made from. */
export interface UsersOrgState {
  connected: { userId: string; organizationId: string; username: string };
  /** Whether the connection may manage users; undefined when the org would not say. */
  manageUsers: boolean | undefined;
  /** Each user of the file, in its order. */
  resolutions: UsernameResolution[];
  /** The users a run replaced held that no username of the file names now, read by id. */
  held: UsersUserRead[];
  logins: UsersLoginRead[];
  /** Every profile of the org; undefined when nothing asked for them. */
  profiles?: UsersProfileRead[];
  licenses: UsersLicenseRead[];
  permissionSets: UsersPermissionSetRead[];
  permissionSetGroups: UsersPermissionSetGroupRead[];
  groups: UsersGroupRead[];
  /** Every name of each kind, read only when a name of the file was not found: what the refusal lists. */
  knownNames: { permissionSets?: string[]; permissionSetGroups?: string[]; groups?: string[] };
  assignments: UsersAssignmentRead[];
  memberships: UsersMembershipRead[];
  /** Who holds which permission set license. */
  licenseAssignments: Array<{ assigneeId: string; permissionSetLicenseId: string }>;
  /** The users, by their first 15 characters, whose address was asked back and awaits its owner. */
  addressesAsked: string[];
  /** The requests the reads took. */
  requests: number;
}

/** What a read is told beside the file's users. */
export interface ReadUsersOptions {
  /** The clock the link's life is counted from. */
  now: Date;
  /** The run a run will replace: the users it held are read too. */
  previous?: UsersRunRecord;
}

/** An id by its first 15 characters, as the org compares one. */
export function idKey(id: string): string {
  return id.slice(0, 15);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

const USER_COLUMNS =
  'Id, Username, Email, IsActive, ProfileId, Profile.Name, Profile.UserLicenseId';

function userOf(row: UsersRow): UsersUserRead {
  const profile = (row['Profile'] ?? undefined) as UsersRow | undefined;
  const licenseId = text(profile?.['UserLicenseId']);
  return {
    id: String(row['Id']),
    username: String(row['Username']),
    isActive: row['IsActive'] === true,
    profileId: String(row['ProfileId']),
    profileName: text(profile?.['Name']) ?? String(row['ProfileId']),
    ...(licenseId ? { licenseId } : {}),
    email: text(row['Email']) ?? '',
  };
}

/** A permission set's API name, split into its namespace and its own name. */
export function namespacedOf(name: string): { namespace?: string; own: string } {
  const at = name.indexOf('__');
  // `ns__Name` names `Name` of the namespace `ns`; an API name holds no other `__`.
  return at > 0 && !name.slice(at + 2).includes('__')
    ? { namespace: name.slice(0, at), own: name.slice(at + 2) }
    : { own: name };
}

/** A name as the file writes it: the namespace before `__`, when there is one. */
export function apiNameOf(own: string, namespace: string | undefined): string {
  return namespace ? `${namespace}__${own}` : own;
}

// ─── The reads ───────────────────────────────────────────────────────────────

/** Each username of `givens`, resolved: see the module's comment. */
async function resolveUsernames(
  org: UsersOrg,
  givens: readonly string[],
): Promise<UsernameResolution[]> {
  const exact = new Map<string, UsersUserRead>();
  const unique = [...new Map(givens.map((given) => [usernameKey(given), given])).values()];
  for (const part of inChunks(unique, EXACT_PER_READ)) {
    const rows = await org.query(
      `SELECT ${USER_COLUMNS} FROM User WHERE Username IN ${soqlList(part)}`,
    );
    for (const row of rows) {
      const user = userOf(row);
      exact.set(usernameKey(user.username), user);
    }
  }
  const unresolved = unique.filter((given) => !exact.has(usernameKey(given)));
  const prefixed = new Map<string, UsersUserRead[]>();
  for (const part of inChunks(unresolved, PREFIXES_PER_READ)) {
    const where = part.map((given) => `Username LIKE ${soqlStartsWithDot(given)}`).join(' OR ');
    const rows = (await org.query(`SELECT ${USER_COLUMNS} FROM User WHERE ${where}`)).map(userOf);
    for (const given of part) {
      // The org's LIKE is the filter; this keeps only what it is said to select.
      const prefix = `${usernameKey(given)}.`;
      const users = [
        ...new Map(
          rows
            .filter((user) => usernameKey(user.username).startsWith(prefix))
            .map((user) => [user.id, user]),
        ).values(),
      ];
      prefixed.set(usernameKey(given), users);
    }
  }
  return givens.map((given): UsernameResolution => {
    const found = exact.get(usernameKey(given));
    if (found) return { given, kind: 'found', user: found };
    const users = prefixed.get(usernameKey(given)) ?? [];
    if (users.length === 1) return { given, kind: 'found', user: users[0] };
    if (users.length === 0) return { given, kind: 'none' };
    return {
      given,
      kind: 'two',
      usernames: users.map((user) => user.username).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    };
  });
}

/** Rows of `object` whose `field` is one of `ids`, in statements of {@link IDS_PER_READ}. */
async function rowsByIds(
  org: UsersOrg,
  columns: string,
  object: string,
  field: string,
  ids: readonly string[],
  also = '',
): Promise<UsersRow[]> {
  const rows: UsersRow[] = [];
  for (const part of inChunks([...new Set(ids)], IDS_PER_READ)) {
    rows.push(
      ...(await org.query(
        `SELECT ${columns} FROM ${object} WHERE ${field} IN ${soqlList(part)}${also}`,
      )),
    );
  }
  return rows;
}

/** Rows of `object` whose `field` is one of `names`, in statements of {@link NAMES_PER_READ}. */
async function rowsByNames(
  org: UsersOrg,
  columns: string,
  object: string,
  field: string,
  names: readonly string[],
  also = '',
): Promise<UsersRow[]> {
  const rows: UsersRow[] = [];
  for (const part of inChunks([...new Set(names)], NAMES_PER_READ)) {
    rows.push(
      ...(await org.query(
        `SELECT ${columns} FROM ${object} WHERE ${field} IN ${soqlList(part)}${also}`,
      )),
    );
  }
  return rows;
}

/** Whether the connection may manage users; undefined when the org would not say. */
export async function manageUsersOf(org: UsersOrg): Promise<boolean | undefined> {
  try {
    const [row] = await org.query('SELECT PermissionsManageUsers FROM UserPermissionAccess');
    const value = row?.['PermissionsManageUsers'];
    return typeof value === 'boolean' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** The names of `names` no row of `found` answers, compared whatever their case. */
function missingOf(names: readonly string[], found: readonly string[]): string[] {
  const held = new Set(found.map((name) => name.toLowerCase()));
  return names.filter((name) => !held.has(name.toLowerCase()));
}

/**
 * The users of an address asked back within the link's life, by their first
 * 15 characters: a line `useremailchangesent` of the setup audit trail that
 * names the user's id and ends with the address without `.invalid`. An
 * audit trail the connection may not read asks nothing back: the address is
 * asked again.
 */
async function addressesAskedOf(
  org: UsersOrg,
  candidates: readonly UsersUserRead[],
  now: Date,
): Promise<string[]> {
  if (candidates.length === 0) return [];
  const since = new Date(now.getTime() - ADDRESS_LINK_HOURS * 3_600_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
  let lines: UsersRow[];
  try {
    lines = await org.query(
      'SELECT Display, CreatedDate FROM SetupAuditTrail WHERE Action = ' +
        `${soqlText('useremailchangesent')} AND CreatedDate >= ${since}`,
    );
  } catch {
    return [];
  }
  const displays = lines.map((line) => (text(line['Display']) ?? '').trim().toLowerCase());
  return candidates
    .filter((user) => {
      const target = addressRestoredOf(user.email)?.toLowerCase();
      if (target === undefined) return false;
      const id = `[${idKey(user.id).toLowerCase()}]`;
      return displays.some((display) => display.includes(id) && display.endsWith(` ${target}`));
    })
    .map((user) => idKey(user.id));
}

/** What a plan of `users` reads of the org: see the module's comment. */
export async function readUsersState(
  org: UsersOrg,
  users: readonly UsersConfigUser[],
  options: ReadUsersOptions,
): Promise<UsersOrgState> {
  const startedAt = org.requests();
  const connected = await org.identity();
  const manageUsers = await manageUsersOf(org);
  const resolutions = await resolveUsernames(
    org,
    users.map((user) => user.username),
  );
  const found = resolutions.flatMap((r) => (r.kind === 'found' ? [r.user] : []));
  const foundIds = new Set(found.map((user) => idKey(user.id)));

  const previous = options.previous?.users ?? [];
  const heldIds = previous
    .map((user) => user.applied.userId)
    .filter((id) => !foundIds.has(idKey(id)));
  const held = (await rowsByIds(org, USER_COLUMNS, 'User', 'Id', heldIds)).map(userOf);
  const userIds = [...found, ...held].map((user) => user.id);

  const named = (pick: (user: UsersConfigUser) => readonly string[] | undefined): string[] => [
    ...new Map(
      users.flatMap((user) => pick(user) ?? []).map((name) => [name.toLowerCase(), name]),
    ).values(),
  ];
  const setNames = named((user) => user.permissionSets);
  const setGroupNames = named((user) => user.permissionSetGroups);
  const groupNames = named((user) => user.groups);
  const holds = previous.length > 0;

  const logins =
    users.some((user) => user.frozen !== undefined) || holds
      ? (await rowsByIds(org, 'Id, UserId, IsFrozen', 'UserLogin', 'UserId', userIds)).map(
          (row): UsersLoginRead => ({
            id: String(row['Id']),
            userId: String(row['UserId']),
            isFrozen: row['IsFrozen'] === true,
          }),
        )
      : [];

  const profiles =
    users.some((user) => user.profile !== undefined) || holds
      ? (await org.query('SELECT Id, Name, UserLicenseId FROM Profile')).map(
          (row): UsersProfileRead => {
            const licenseId = text(row['UserLicenseId']);
            return {
              id: String(row['Id']),
              name: String(row['Name']),
              ...(licenseId ? { licenseId } : {}),
            };
          },
        )
      : undefined;

  const knownNames: UsersOrgState['knownNames'] = {};
  const permissionSets: UsersPermissionSetRead[] = [];
  if (setNames.length > 0) {
    const rows = await rowsByNames(
      org,
      'Id, Name, NamespacePrefix, LicenseId',
      'PermissionSet',
      'Name',
      setNames.map((name) => namespacedOf(name).own),
      ' AND IsOwnedByProfile = false',
    );
    for (const row of rows) {
      const namespace = text(row['NamespacePrefix']);
      const licenseId = text(row['LicenseId']);
      permissionSets.push({
        id: String(row['Id']),
        name: String(row['Name']),
        ...(namespace ? { namespace } : {}),
        ...(licenseId ? { licenseId } : {}),
      });
    }
    const apiNames = permissionSets.map((set) => apiNameOf(set.name, set.namespace));
    if (missingOf(setNames, apiNames).length > 0) {
      knownNames.permissionSets = (
        await org.query(
          'SELECT Name, NamespacePrefix FROM PermissionSet WHERE IsOwnedByProfile = false',
        )
      ).map((row) => apiNameOf(String(row['Name']), text(row['NamespacePrefix'])));
    }
  }

  const permissionSetGroups: UsersPermissionSetGroupRead[] = [];
  if (setGroupNames.length > 0) {
    const rows = await rowsByNames(
      org,
      'Id, DeveloperName, NamespacePrefix',
      'PermissionSetGroup',
      'DeveloperName',
      setGroupNames.map((name) => namespacedOf(name).own),
    );
    for (const row of rows) {
      const namespace = text(row['NamespacePrefix']);
      permissionSetGroups.push({
        id: String(row['Id']),
        name: String(row['DeveloperName']),
        ...(namespace ? { namespace } : {}),
      });
    }
    const apiNames = permissionSetGroups.map((group) => apiNameOf(group.name, group.namespace));
    if (missingOf(setGroupNames, apiNames).length > 0) {
      knownNames.permissionSetGroups = (
        await org.query('SELECT DeveloperName, NamespacePrefix FROM PermissionSetGroup')
      ).map((row) => apiNameOf(String(row['DeveloperName']), text(row['NamespacePrefix'])));
    }
  }

  const groups: UsersGroupRead[] = [];
  if (groupNames.length > 0) {
    const rows = await rowsByNames(
      org,
      'Id, DeveloperName, Type',
      'Group',
      'DeveloperName',
      groupNames,
      ` AND Type IN ${soqlList(['Regular', 'Queue'])}`,
    );
    for (const row of rows) {
      const type = row['Type'];
      if (type !== 'Regular' && type !== 'Queue') continue;
      groups.push({ id: String(row['Id']), name: String(row['DeveloperName']), type });
    }
    if (
      missingOf(
        groupNames,
        groups.map((group) => group.name),
      ).length > 0
    ) {
      knownNames.groups = (
        await org.query(
          `SELECT DeveloperName FROM Group WHERE Type IN ${soqlList(['Regular', 'Queue'])}`,
        )
      ).map((row) => String(row['DeveloperName']));
    }
  }

  const licenses =
    users.some((user) => user.active === true || user.profile !== undefined) ||
    holds ||
    permissionSets.some((set) => set.licenseId?.startsWith('100'))
      ? (await org.query('SELECT Id, Name, TotalLicenses, UsedLicenses FROM UserLicense')).map(
          (row): UsersLicenseRead => ({
            id: String(row['Id']),
            name: String(row['Name']),
            total: Number(row['TotalLicenses'] ?? 0),
            used: Number(row['UsedLicenses'] ?? 0),
          }),
        )
      : [];

  const assignments =
    setNames.length > 0 || setGroupNames.length > 0 || holds
      ? (
          await rowsByIds(
            org,
            'Id, AssigneeId, PermissionSetId, PermissionSetGroupId',
            'PermissionSetAssignment',
            'AssigneeId',
            userIds,
          )
        ).map((row): UsersAssignmentRead => {
          const permissionSetId = text(row['PermissionSetId']);
          const permissionSetGroupId = text(row['PermissionSetGroupId']);
          return {
            id: String(row['Id']),
            assigneeId: String(row['AssigneeId']),
            ...(permissionSetId ? { permissionSetId } : {}),
            ...(permissionSetGroupId ? { permissionSetGroupId } : {}),
          };
        })
      : [];

  const memberships =
    groupNames.length > 0 || holds
      ? (
          await rowsByIds(
            org,
            'Id, GroupId, UserOrGroupId',
            'GroupMember',
            'UserOrGroupId',
            userIds,
          )
        ).map((row): UsersMembershipRead => ({
          id: String(row['Id']),
          groupId: String(row['GroupId']),
          userId: String(row['UserOrGroupId']),
        }))
      : [];

  const licenseAssignments = permissionSets.some((set) => set.licenseId?.startsWith('0PL'))
    ? (
        await rowsByIds(
          org,
          'AssigneeId, PermissionSetLicenseId',
          'PermissionSetLicenseAssign',
          'AssigneeId',
          userIds,
        )
      ).map((row) => ({
        assigneeId: String(row['AssigneeId']),
        permissionSetLicenseId: String(row['PermissionSetLicenseId']),
      }))
    : [];

  const restoring = resolutions.flatMap((resolution, at) =>
    resolution.kind === 'found' &&
    users[at]?.email === 'restore' &&
    addressRestoredOf(resolution.user.email) !== undefined
      ? [resolution.user]
      : [],
  );
  const addressesAsked = await addressesAskedOf(org, restoring, options.now);

  return {
    connected,
    manageUsers,
    resolutions,
    held,
    logins,
    ...(profiles ? { profiles } : {}),
    licenses,
    permissionSets,
    permissionSetGroups,
    groups,
    knownNames,
    assignments,
    memberships,
    licenseAssignments,
    addressesAsked,
    requests: org.requests() - startedAt,
  };
}
