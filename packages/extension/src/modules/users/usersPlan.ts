/**
 * What a run of `sandforge users` would change, from what the org answered
 * (`usersResolve.ts`) and what the file asks: a pure function, no org asked.
 *
 * Per user, the changes come in the order a run writes them: profile,
 * activation, freeze, permission sets and their groups, groups and queues,
 * and the address last — a run refused on the way has then mailed nobody.
 *
 * The file adds; it never takes away. An assignment, a membership or a
 * permission set the file does not name stays, whoever gave it. What the
 * user holds already is found, never created again: a membership inserted
 * twice is answered with the id of the one there, as if created, and a
 * removal would then take back what it never gave.
 *
 * A run that replaces another converges on the file from what that one
 * held: it takes back what the environment had added and the file no longer
 * names, puts back as it was a user the file no longer lists, and keeps what
 * is still asked. What someone changed since is theirs: never put back.
 *
 * Before the first write, the plan refuses what the org would refuse or what
 * would harm: a username no user or two users have, a name of profile,
 * permission set or group the org does not hold, a permission set whose
 * license the user would lack, the user connected locked out, more licenses
 * than are free — counted on the whole plan, activations and profiles of
 * every user together —, and the emails Salesforce would send to people
 * unless the line accepts them.
 */

import {
  usernameKey,
  type UsersAddress,
  type UsersChange,
  type UsersConfigUser,
  type UsersPlanAnswer,
} from '@sandforge/shared';

import { USERS_COLLECTION_ROWS } from './usersOrg.js';
import {
  addressRestoredOf,
  apiNameOf,
  idKey,
  type UsersOrgState,
  type UsersProfileRead,
  type UsersUserRead,
} from './usersResolve.js';
import type { UsersHeldAccess, UsersHeldUser, UsersRunRecord } from './usersRunStore.js';

/** A refusal of a run, by its code, in words that name a way out. */
export type UsersRefusal = NonNullable<UsersPlanAnswer['refusals']>[number];

/** The org a plan or a run answers of. */
export type UsersOrgSummary = UsersPlanAnswer['org'];

/** What a user is on the three things a run writes of it. */
export interface UsersStanding {
  isActive: boolean;
  isFrozen: boolean;
  profileId: string;
}

/** A permission set or a group of them a run assigns. */
export interface UsersAssign {
  what: 'permissionSet' | 'permissionSetGroup';
  name: string;
  setId: string;
}

/** A group or a queue a run adds the user to. */
export interface UsersJoin {
  name: string;
  type: 'Regular' | 'Queue';
  groupId: string;
}

/** What a run writes of one user, step by step. */
export interface UsersWrites {
  profileId?: string;
  isActive?: boolean;
  isFrozen?: boolean;
  /** The user's `UserLogin`, which a freeze writes. */
  loginId?: string;
  assign: UsersAssign[];
  /** Assignments the environment created that a run takes back, by id. */
  unassign: UsersHeldAccess[];
  join: UsersJoin[];
  /** Memberships the environment created that a run takes back, by id. */
  leave: UsersHeldAccess[];
  /** The address without `.invalid`, asked back. */
  email?: string;
}

/** One user of a plan. */
export interface PlannedUser {
  /** The username the file gave; absent for a user the file no longer lists. */
  given?: string;
  /** The org's, or the given one when no single user has it. */
  username: string;
  userId?: string;
  /** Whether the file lists the user. */
  inFile: boolean;
  address?: UsersAddress;
  changes: UsersChange[];
  emailsToPeople: number;
  /** What the user was before the environment first changed it. */
  before?: UsersStanding;
  /** What the user is, as read. */
  current?: UsersStanding;
  /** The license of its profile, as read. */
  licenseId?: string;
  /** Per thing a run writes, what the environment wants of it; absent, it holds none. */
  target: Partial<UsersStanding>;
  writes: UsersWrites;
  /** What the user held of what the file names, which a run never takes back. */
  found: { permissionSetAssignments: string[]; groupMembers: string[] };
  /** What the run replaced created and the file still names, still there: held on. */
  carried: UsersHeldAccess[];
}

/** What the activations and the profiles of a plan take of a license. */
export interface UsersLicenseUse {
  name: string;
  total: number;
  used: number;
  toUse: number;
}

export interface UsersPlan {
  users: PlannedUser[];
  licenses: UsersLicenseUse[];
  emailsToPeople: number;
  refusals: UsersRefusal[];
}

/** What a plan is told beside the org's answers and the file's users. */
export interface UsersPlanOptions {
  /** The run this one replaces, converging from what it held. */
  previous?: UsersRunRecord;
  /** The line accepts that Salesforce emails people: `--accept-user-emails`. */
  acceptUserEmails?: boolean;
  /** What the deliverability probe read of the org: `open` delivers all email. */
  deliverability?: 'open' | 'closed' | 'unread';
  /** The line accepts that what runs in the org emails people: `--accept-emails`. */
  acceptEmails?: boolean;
}

// ─── Words ───────────────────────────────────────────────────────────────────

/** `a`, `a and b`, `a, b and c`. */
function listed(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Texts in the order of their code points. */
function sorted(texts: Iterable<string>): string[] {
  return [...new Set(texts)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The edits between two texts, past `most` said as `most + 1`. */
function distance(a: string, b: string, most: number): number {
  if (Math.abs(a.length - b.length) > most) return most + 1;
  let row = Array.from({ length: b.length + 1 }, (_, at) => at);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length];
}

/** The words of a name of three letters or more. */
function wordsOf(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3);
}

/**
 * The names of `names` close to `name`: the same whatever the case, one
 * inside the other, a word in common, or two edits away. Never a guess: the
 * refusal lists them for a person to choose.
 */
export function closeNamesOf(name: string, names: readonly string[]): string[] {
  const wanted = name.toLowerCase();
  const wantedWords = new Set(wordsOf(name));
  return sorted(
    names.filter((candidate) => {
      const held = candidate.toLowerCase();
      return (
        held.includes(wanted) ||
        wanted.includes(held) ||
        wordsOf(candidate).some((word) => wantedWords.has(word)) ||
        distance(held, wanted, 2) <= 2
      );
    }),
  );
}

/** At most twenty names, then how many more. */
function someNames(names: readonly string[]): string {
  const shown = names.slice(0, 20).join(', ');
  return names.length > 20 ? `${shown}, and ${names.length - 20} more` : shown;
}

const SELF_WORDS = { profile: 'change its profile', active: 'deactivate it', frozen: 'freeze it' };

/**
 * The refusal of a connection that may not manage users, or of which the
 * org would not say: nothing of a user is written without Manage Users.
 */
export function noRightRefusal(username: string, manageUsers: boolean | undefined): UsersRefusal {
  return {
    code: 'USERS_NO_RIGHT',
    message:
      (manageUsers === false
        ? `${username} cannot manage users here (Manage Users)`
        : `the org would not say whether ${username} may manage users (Manage Users)`) +
      ': give it Manage Users, or connect as a user who has it',
  };
}

// ─── The plan ────────────────────────────────────────────────────────────────

/** Whether two ids are one, in 15 characters or 18. */
function sameId(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && idKey(a) === idKey(b);
}

/** A held access's change, taken back. */
function removedOf(access: UsersHeldAccess): UsersChange {
  return access.what === 'group'
    ? { what: 'group', name: access.name, type: access.type ?? 'Regular', to: 'removed' }
    : { what: access.what, name: access.name, to: 'removed' };
}

/** An empty set of writes. */
function noWrites(): UsersWrites {
  return { assign: [], unassign: [], join: [], leave: [] };
}

/** See the module's comment. */
export function planUsers(
  state: UsersOrgState,
  users: readonly UsersConfigUser[],
  options: UsersPlanOptions = {},
): UsersPlan {
  const refusals: UsersRefusal[] = [];
  const connected = state.connected;
  if (state.manageUsers !== true)
    refusals.push(noRightRefusal(connected.username, state.manageUsers));

  const previous = options.previous?.users ?? [];
  const heldOf = (userId: string): UsersHeldUser | undefined =>
    previous.find((held) => sameId(held.applied.userId, userId));
  const profileById = (id: string): UsersProfileRead | undefined =>
    state.profiles?.find((profile) => sameId(profile.id, id));
  const loginOf = (userId: string) => state.logins.find((login) => sameId(login.userId, userId));
  const assignmentPresent = (id: string): boolean =>
    state.assignments.some((assignment) => sameId(assignment.id, id));
  const membershipPresent = (id: string): boolean =>
    state.memberships.some((membership) => sameId(membership.id, id));

  /** What the environment wants of each thing a run writes, and the writes and changes it takes. */
  const standings = (
    user: UsersUserRead,
    held: UsersHeldUser | undefined,
    asked: Partial<UsersStanding>,
    planned: PlannedUser,
  ): void => {
    const current: UsersStanding = {
      isActive: user.isActive,
      isFrozen: loginOf(user.id)?.isFrozen ?? false,
      profileId: user.profileId,
    };
    const before = held?.applied.before ?? current;
    planned.current = current;
    planned.before = before;
    if (user.licenseId !== undefined) planned.licenseId = user.licenseId;
    const targetOf = <K extends keyof UsersStanding>(key: K): UsersStanding[K] | undefined => {
      if (asked[key] !== undefined) return asked[key];
      // What the environment changed and the file no longer asks goes back, unless someone changed it since.
      if (
        held &&
        held.after[key] !== held.applied.before[key] &&
        current[key] === held.after[key]
      ) {
        return before[key];
      }
      return undefined;
    };
    const profileId = targetOf('profileId');
    if (profileId !== undefined) {
      planned.target.profileId = profileId;
      if (!sameId(profileId, current.profileId)) {
        planned.writes.profileId = profileId;
        planned.changes.push({
          what: 'profile',
          from: user.profileName,
          to: profileById(profileId)?.name ?? profileId,
        });
      }
    }
    const isActive = targetOf('isActive');
    if (isActive !== undefined) {
      planned.target.isActive = isActive;
      if (isActive !== current.isActive) {
        planned.writes.isActive = isActive;
        planned.changes.push({ what: 'active', from: current.isActive, to: isActive });
      }
    }
    const isFrozen = targetOf('isFrozen');
    if (isFrozen !== undefined) {
      planned.target.isFrozen = isFrozen;
      if (isFrozen !== current.isFrozen) {
        const login = loginOf(user.id);
        planned.writes.isFrozen = isFrozen;
        if (login) planned.writes.loginId = login.id;
        planned.changes.push({ what: 'frozen', from: current.isFrozen, to: isFrozen });
      }
    }
  };

  /** The held accesses of a user the file no longer names: taken back where still there. */
  const takeBack = (accesses: readonly UsersHeldAccess[], planned: PlannedUser): void => {
    for (const access of accesses) {
      if (access.what === 'group') {
        if (membershipPresent(access.id)) planned.writes.leave.push(access);
      } else if (assignmentPresent(access.id)) {
        planned.writes.unassign.push(access);
      }
    }
  };

  const planned: PlannedUser[] = [];
  const seen = new Map<string, string>();
  users.forEach((user, at) => {
    const resolution = state.resolutions[at];
    if (resolution === undefined || resolution.kind !== 'found') {
      planned.push({
        given: user.username,
        username: user.username,
        inFile: true,
        changes: [],
        emailsToPeople: 0,
        target: {},
        writes: noWrites(),
        found: { permissionSetAssignments: [], groupMembers: [] },
        carried: [],
      });
      if (resolution?.kind === 'two') {
        refusals.push({
          code: 'USERS_TWO_USERS',
          username: user.username,
          message:
            `${user.username} names ${resolution.usernames.length} users: write the sandbox’s ` +
            `username in full: ${resolution.usernames.join(' or ')}`,
        });
      } else {
        refusals.push({
          code: 'USERS_NO_USER',
          username: user.username,
          message:
            `${user.username}: no user has this username, nor this username followed by ` +
            '.<sandbox>: check the username, as Setup > Users gives it, or take it out of the file',
        });
      }
      return;
    }
    const found = resolution.user;
    const earlier = seen.get(idKey(found.id));
    if (earlier !== undefined) {
      // Production's username and the sandbox's name one user: written twice, it would be refused.
      planned.push({
        given: user.username,
        username: found.username,
        inFile: true,
        changes: [],
        emailsToPeople: 0,
        target: {},
        writes: noWrites(),
        found: { permissionSetAssignments: [], groupMembers: [] },
        carried: [],
      });
      refusals.push({
        code: 'USERS_SAME_USER',
        username: user.username,
        message: `${user.username} and ${earlier} name one user, ${found.username}: one entry per user`,
      });
      return;
    }
    seen.set(idKey(found.id), user.username);
    const held = heldOf(found.id);
    const one: PlannedUser = {
      given: user.username,
      username: found.username,
      userId: found.id,
      inFile: true,
      changes: [],
      emailsToPeople: 0,
      target: {},
      writes: noWrites(),
      found: { permissionSetAssignments: [], groupMembers: [] },
      carried: [],
    };

    // The profile the file names, by its exact name.
    let askedProfileId: string | undefined;
    if (user.profile !== undefined) {
      const named = (state.profiles ?? []).filter((profile) => profile.name === user.profile);
      if (named.length === 1) {
        askedProfileId = named[0].id;
      } else {
        const names = (state.profiles ?? []).map((profile) => profile.name);
        const close = closeNamesOf(user.profile, names);
        refusals.push({
          code: 'USERS_PROFILE_UNKNOWN',
          username: user.username,
          message:
            `profile ${user.profile}: ` +
            (named.length === 0
              ? 'no profile has this name'
              : `${named.length} profiles have this name`) +
            ': profiles are named as Setup > Profiles names them, in the org’s language: ' +
            someNames(close.length > 0 ? close : sorted(names)),
        });
      }
    }
    standings(
      found,
      held,
      {
        ...(askedProfileId !== undefined ? { profileId: askedProfileId } : {}),
        ...(user.active !== undefined ? { isActive: user.active } : {}),
        ...(user.frozen !== undefined ? { isFrozen: user.frozen } : {}),
      },
      one,
    );

    // The license the user will have once its profile is written.
    const licenseAfter =
      (one.target.profileId !== undefined
        ? profileById(one.target.profileId)?.licenseId
        : undefined) ?? found.licenseId;
    const heldAccesses = held?.accesses ?? [];
    const heldNamed = (what: UsersHeldAccess['what'], name: string) =>
      heldAccesses.find(
        (access) => access.what === what && access.name.toLowerCase() === name.toLowerCase(),
      );

    // Permission sets and their groups.
    const assignPart = (
      what: 'permissionSet' | 'permissionSetGroup',
      names: readonly string[] | undefined,
    ): void => {
      for (const name of names ?? []) {
        const sets =
          what === 'permissionSet'
            ? state.permissionSets.map((set) => ({
                ...set,
                apiName: apiNameOf(set.name, set.namespace),
              }))
            : state.permissionSetGroups.map((group) => ({
                ...group,
                licenseId: undefined,
                apiName: apiNameOf(group.name, group.namespace),
              }));
        const set = sets.find((each) => each.apiName.toLowerCase() === name.toLowerCase());
        if (!set) {
          const known =
            (what === 'permissionSet'
              ? state.knownNames.permissionSets
              : state.knownNames.permissionSetGroups) ?? [];
          const close = closeNamesOf(name, known);
          refusals.push({
            code: 'USERS_PERMISSION_SET_UNKNOWN',
            username: user.username,
            message:
              (what === 'permissionSet'
                ? `permission set ${name}: no permission set has this API name: names are API names ` +
                  '(Setup > Permission Sets > API Name)'
                : `permission set group ${name}: no permission set group has this API name: names ` +
                  'are API names (Setup > Permission Set Groups > API Name)') +
              (close.length > 0 ? `; close: ${someNames(close)}` : ''),
          });
          continue;
        }
        const present = state.assignments.find(
          (assignment) =>
            sameId(assignment.assigneeId, found.id) &&
            (what === 'permissionSet'
              ? sameId(assignment.permissionSetId, set.id)
              : sameId(assignment.permissionSetGroupId, set.id)),
        );
        const ours = heldNamed(what, name);
        if (present) {
          if (ours && sameId(ours.id, present.id)) one.carried.push(ours);
          else one.found.permissionSetAssignments.push(present.id);
          continue;
        }
        const license = set.licenseId;
        if (license?.startsWith('100') && !sameId(license, licenseAfter)) {
          const licenseName =
            state.licenses.find((each) => sameId(each.id, license))?.name ?? license;
          refusals.push({
            code: 'USERS_PERMISSION_SET_LICENSE',
            username: user.username,
            message:
              `${found.username}: permission set ${name} needs the license ${licenseName}, which ` +
              'this user will not have: assign the permission set license first, in Setup, or ' +
              'take the set out',
          });
          continue;
        }
        if (
          license?.startsWith('0PL') &&
          !state.licenseAssignments.some(
            (each) =>
              sameId(each.assigneeId, found.id) && sameId(each.permissionSetLicenseId, license),
          )
        ) {
          refusals.push({
            code: 'USERS_PERMISSION_SET_LICENSE',
            username: user.username,
            message:
              `${found.username}: permission set ${name} needs a permission set license this user ` +
              'does not hold: assign the permission set license first, in Setup, or take the set out',
          });
          continue;
        }
        one.writes.assign.push({ what, name, setId: set.id });
      }
    };
    assignPart('permissionSet', user.permissionSets);
    assignPart('permissionSetGroup', user.permissionSetGroups);

    // Groups and queues.
    for (const name of user.groups ?? []) {
      const group = state.groups.find((each) => each.name.toLowerCase() === name.toLowerCase());
      if (!group) {
        const close = closeNamesOf(name, state.knownNames.groups ?? []);
        refusals.push({
          code: 'USERS_GROUP_UNKNOWN',
          username: user.username,
          message:
            `group ${name}: no public group or queue has this API name (DeveloperName)` +
            (close.length > 0 ? `; close: ${someNames(close)}` : ''),
        });
        continue;
      }
      const present = state.memberships.find(
        (membership) => sameId(membership.userId, found.id) && sameId(membership.groupId, group.id),
      );
      const ours = heldNamed('group', name);
      if (present) {
        if (ours && sameId(ours.id, present.id)) one.carried.push(ours);
        else one.found.groupMembers.push(present.id);
        continue;
      }
      one.writes.join.push({ name, type: group.type, groupId: group.id });
    }

    // What the environment holds and the file no longer names.
    const named = (access: UsersHeldAccess): boolean => {
      const names =
        access.what === 'permissionSet'
          ? user.permissionSets
          : access.what === 'permissionSetGroup'
            ? user.permissionSetGroups
            : user.groups;
      return (names ?? []).some((name) => name.toLowerCase() === access.name.toLowerCase());
    };
    takeBack(
      heldAccesses.filter((access) => !named(access)),
      one,
    );

    for (const assign of one.writes.assign) {
      one.changes.push({ what: assign.what, name: assign.name, to: 'added' });
    }
    for (const access of one.writes.unassign) one.changes.push(removedOf(access));
    for (const join of one.writes.join) {
      one.changes.push({ what: 'group', name: join.name, type: join.type, to: 'added' });
    }
    for (const access of one.writes.leave) one.changes.push(removedOf(access));

    // The address, last.
    if (user.email === 'keep') one.address = 'kept';
    if (user.email === 'restore') {
      const restored = addressRestoredOf(found.email);
      if (restored === undefined) one.address = 'restored';
      else if (state.addressesAsked.includes(idKey(found.id))) one.address = 'awaiting';
      else {
        one.address = 'invalid';
        one.writes.email = restored;
        one.emailsToPeople = 1;
        one.changes.push({ what: 'email', to: 'awaiting' });
      }
    }
    planned.push(one);
  });

  // The users the run replaced held and the file no longer lists: put back as they were.
  const inFile = new Set(planned.flatMap((one) => (one.userId ? [idKey(one.userId)] : [])));
  for (const held of previous) {
    if (inFile.has(idKey(held.applied.userId))) continue;
    const user = state.held.find((each) => sameId(each.id, held.applied.userId));
    if (!user) continue;
    const one: PlannedUser = {
      username: user.username,
      userId: user.id,
      inFile: false,
      changes: [],
      emailsToPeople: 0,
      target: {},
      writes: noWrites(),
      found: { permissionSetAssignments: [], groupMembers: [] },
      carried: [],
    };
    standings(user, held, {}, one);
    takeBack(held.accesses, one);
    for (const access of [...one.writes.unassign, ...one.writes.leave]) {
      one.changes.push(removedOf(access));
    }
    planned.push(one);
  }

  // A freeze writes the user's login.
  for (const one of planned) {
    if (one.writes.isFrozen === undefined || one.writes.loginId !== undefined) continue;
    refusals.push({
      code: 'USERS_NO_LOGIN',
      ...(one.given !== undefined ? { username: one.given } : {}),
      message:
        `${one.username}: the org keeps no login of this user (UserLogin), which a freeze writes` +
        (one.inFile ? `: take frozen off ${one.username}` : ''),
    });
  }

  // The user connected is never locked out.
  for (const one of planned) {
    if (!sameId(one.userId, connected.userId)) continue;
    const locks = [
      ...(one.writes.profileId !== undefined ? [SELF_WORDS.profile] : []),
      ...(one.writes.isActive === false ? [SELF_WORDS.active] : []),
      ...(one.writes.isFrozen === true ? [SELF_WORDS.frozen] : []),
    ];
    if (locks.length === 0) continue;
    refusals.push({
      code: 'USERS_SELF',
      ...(one.given !== undefined ? { username: one.given } : {}),
      message: one.inFile
        ? `${one.username} is the user connected, and the file would ${listed(locks)}: SandForge ` +
          `would lock itself out: take ${one.username} out of the file, or connect as another`
        : `${one.username} is the user connected, and putting it back as it was would ` +
          `${listed(locks)}: SandForge would lock itself out: connect as another`,
    });
  }

  const licenses = licenseUses(state, planned, refusals);

  const emailsToPeople = planned.reduce((sum, one) => sum + one.emailsToPeople, 0);
  if (emailsToPeople > 0 && options.acceptUserEmails !== true) {
    refusals.push({
      code: 'USERS_EMAILS_NOT_ACCEPTED',
      message:
        `Salesforce would email ${emailsToPeople} ${emailsToPeople === 1 ? 'person' : 'people'}: ` +
        'the confirmation of each address asked back, a system email, which only the line ' +
        'accepts: --accept-user-emails, once those people may receive them',
    });
  }
  // An org whose deliverability could not be read may deliver all email: it is
  // asked about as one that does, as every run reading the probe asks.
  const mayDeliver = options.deliverability === 'open' || options.deliverability === 'unread';
  if (emailsToPeople > 0 && mayDeliver && options.acceptEmails !== true) {
    refusals.push({
      code: 'USERS_EMAILS_OPEN',
      message:
        (options.deliverability === 'unread'
          ? "the org's deliverability could not be read, so it may deliver all email, and "
          : 'the org delivers all email, and ') +
        `${emailsToPeople} ` +
        `${emailsToPeople === 1 ? 'address' : 'addresses'} would be asked back before the ` +
        'masking is done: set Setup > Deliverability to System email only until the masking is ' +
        'done, or accept with --accept-emails that what runs there emails these people',
    });
  }

  return { users: planned, licenses, emailsToPeople, refusals };
}

/**
 * What the plan takes of each license, and the refusal of each license it
 * would take past its last free one. A run writes every profile first, then
 * every deactivation, then every activation: a profile of another license
 * given to an active user takes one of it and gives one back to the one it
 * leaves; a deactivation gives one back before the activations take theirs.
 */
function licenseUses(
  state: UsersOrgState,
  planned: readonly PlannedUser[],
  refusals: UsersRefusal[],
): UsersLicenseUse[] {
  interface Use {
    takesFirst: number;
    freesFirst: number;
    takesThen: number;
    freesThen: number;
    takers: Map<string, string[]>;
  }
  const uses = new Map<string, Use>();
  const useOf = (licenseId: string): Use => {
    const key = idKey(licenseId);
    let use = uses.get(key);
    if (!use) {
      use = { takesFirst: 0, freesFirst: 0, takesThen: 0, freesThen: 0, takers: new Map() };
      uses.set(key, use);
    }
    return use;
  };
  const licenseOfProfile = (profileId: string): string | undefined =>
    state.profiles?.find((profile) => idKey(profile.id) === idKey(profileId))?.licenseId;
  const take = (licenseId: string, why: string, username: string): void => {
    const takers = useOf(licenseId).takers;
    takers.set(why, [...(takers.get(why) ?? []), username]);
  };

  for (const one of planned) {
    const current = one.current;
    if (!current) continue;
    const licenseBefore = licenseOfProfile(current.profileId) ?? one.licenseId;
    const profileId = one.writes.profileId ?? current.profileId;
    const licenseAfter = licenseOfProfile(profileId) ?? licenseBefore;
    if (one.writes.profileId !== undefined && current.isActive && licenseAfter !== undefined) {
      if (licenseBefore === undefined || idKey(licenseBefore) !== idKey(licenseAfter)) {
        useOf(licenseAfter).takesFirst += 1;
        const name = one.changes.find((change) => change.what === 'profile');
        take(
          licenseAfter,
          `profile: ${name?.what === 'profile' ? name.to : profileId}`,
          one.username,
        );
        if (licenseBefore !== undefined) useOf(licenseBefore).freesFirst += 1;
      }
    }
    if (licenseAfter === undefined) continue;
    if (one.writes.isActive === true) {
      useOf(licenseAfter).takesThen += 1;
      take(licenseAfter, 'active: true', one.username);
    }
    if (one.writes.isActive === false) useOf(licenseAfter).freesThen += 1;
  }

  const answered: UsersLicenseUse[] = [];
  for (const license of state.licenses) {
    const use = uses.get(idKey(license.id));
    const takes = use ? use.takesFirst + use.takesThen : 0;
    if (!use || takes === 0) continue;
    const net = Math.max(0, takes - use.freesFirst - use.freesThen);
    const free = license.total - license.used;
    const refused =
      use.takesFirst > free ||
      use.takesThen > free - use.takesFirst + use.freesFirst + use.freesThen;
    answered.push({ name: license.name, total: license.total, used: license.used, toUse: net });
    if (refused) {
      const ways = [...use.takers].map(
        ([why, usernames]) => `${why} off ${usernames.join(' or ')}`,
      );
      refusals.push({
        code: 'USERS_LICENSE',
        message:
          `${license.name}: ${license.used} of ${license.total} used, and the file takes ${net} more: ` +
          `deactivate a user who no longer needs it, or take ${ways.join(', or ')}`,
      });
    }
  }
  return answered;
}

// ─── What a plan answers ─────────────────────────────────────────────────────

/** The calls `rows` take in collections. */
function callsOf(rows: number): number {
  return Math.ceil(rows / USERS_COLLECTION_ROWS);
}

/**
 * The requests a run of `plan` sends after its reads: each step's
 * collections, the read of the memberships right before any is added, and
 * the read of the users and their logins once written.
 */
export function usersRunRequestsOf(plan: UsersPlan): number {
  const count = (test: (one: PlannedUser) => boolean): number => plan.users.filter(test).length;
  const sum = (rows: (one: PlannedUser) => number): number =>
    plan.users.reduce((total, one) => total + rows(one), 0);
  const joining = count((one) => one.writes.join.length > 0);
  const frozen = count((one) => one.writes.isFrozen !== undefined);
  const written = count(
    (one) =>
      one.writes.profileId !== undefined ||
      one.writes.isActive !== undefined ||
      one.writes.isFrozen !== undefined ||
      one.writes.email !== undefined,
  );
  return (
    callsOf(count((one) => one.writes.profileId !== undefined)) +
    callsOf(count((one) => one.writes.isActive === false)) +
    callsOf(count((one) => one.writes.isActive === true)) +
    callsOf(frozen) +
    callsOf(sum((one) => one.writes.assign.length)) +
    callsOf(sum((one) => one.writes.unassign.length)) +
    callsOf(joining) +
    callsOf(sum((one) => one.writes.join.length)) +
    callsOf(sum((one) => one.writes.leave.length)) +
    callsOf(count((one) => one.writes.email !== undefined)) +
    callsOf(written) +
    callsOf(frozen)
  );
}

/** What `sandforge users plan --json` answers of `plan`, the reads having taken `readRequests`. */
export function usersPlanAnswerOf(
  plan: UsersPlan,
  organization: UsersOrgSummary,
  readRequests: number,
): UsersPlanAnswer {
  return {
    org: organization,
    users: plan.users.map((one) => ({
      username: one.username,
      ...(one.given !== undefined && usernameKey(one.given) !== usernameKey(one.username)
        ? { given: one.given }
        : {}),
      ...(one.userId !== undefined ? { userId: one.userId } : {}),
      ...(one.address !== undefined ? { address: one.address } : {}),
      changes: one.changes,
      ...(one.emailsToPeople > 0 ? { emailsToPeople: one.emailsToPeople } : {}),
    })),
    ...(plan.licenses.length > 0 ? { licenses: plan.licenses } : {}),
    emailsToPeople: plan.emailsToPeople,
    apiRequests: readRequests + usersRunRequestsOf(plan),
    ...(plan.refusals.length > 0 ? { refusals: plan.refusals } : {}),
  };
}
