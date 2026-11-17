/**
 * The removal of a run of `sandforge users`: what `sandforge env destroy`
 * takes back of a users resource, and `sandforge users remove --run <n>`.
 *
 * It reads the org, then takes back in the reverse order of a run: the
 * memberships, then the assignments the environment created, each deleted
 * by its id — what the user held before the run is never touched —, then
 * each freeze, activation and profile put back as it was before the
 * environment first changed it.
 *
 * Only where the org still holds what the environment left. A user someone
 * put back already is said to have nothing to do; a profile someone changed
 * since is kept, named, unless `--include-changed` puts it back all the
 * same. The user connected is never frozen, deactivated or given another
 * profile: SandForge would lock itself out. What the org refuses — a
 * deactivation it will not do, a license taken since — is kept and named
 * in its code and words, and a later removal tries it again.
 *
 * Never undone: an address asked back, which is its owner's to confirm and
 * which SandForge never puts under `.invalid` again; and the user itself,
 * which Salesforce does not delete.
 */

import type { UsersChange, UsersRemoveAnswer } from '@sandforge/shared';

import { inChunks, soqlList, wordsWithoutAddresses, type UsersOrg } from './usersOrg.js';
import { noRightRefusal, type UsersOrgSummary, type UsersStanding } from './usersPlan.js';
import { idKey, manageUsersOf } from './usersResolve.js';
import type {
  UsersHeldAccess,
  UsersHeldUser,
  UsersRunRecord,
  UsersRunStore,
} from './usersRunStore.js';

/** What a removal is given. */
export interface UsersRemoveInput {
  org: UsersOrg;
  organization: UsersOrgSummary;
  store: UsersRunStore;
  run: number;
  /** Put back a profile someone changed since the run, all the same. */
  includeChanged?: boolean;
  now?: () => Date;
  /** Once aborted, the removal ends after the step under way. */
  signal?: AbortSignal;
}

/** What a removal makes of one user, from what the org holds of it now. */
export interface UsersUndo {
  leave: UsersHeldAccess[];
  unassign: UsersHeldAccess[];
  isFrozen?: { to: boolean; loginId: string; change: UsersChange };
  isActive?: { to: boolean; change: UsersChange };
  profileId?: { to: string; change: UsersChange };
  kept: Array<{ change: UsersChange; why: string }>;
}

/** What the org holds now of a user a run holds. */
export interface UsersNow {
  standing: UsersStanding;
  loginId?: string;
  /** The org's profiles, by id, for the words of a profile change. */
  profileNames: ReadonlyMap<string, string>;
  /** The accesses still there, by their first 15 characters. */
  present: ReadonlySet<string>;
}

/**
 * What a removal writes of one user, and what it keeps: see the module's
 * comment. Pure: the org is read before.
 */
export function undoOf(
  held: UsersHeldUser,
  now: UsersNow,
  options: { includeChanged: boolean; connected: { userId: string; username: string } },
): UsersUndo {
  const { before } = held.applied;
  const { after } = held;
  const current = now.standing;
  const self = idKey(held.applied.userId) === idKey(options.connected.userId);
  const selfWhy =
    `${options.connected.username} is the user connected: SandForge would lock itself out; ` +
    'connect as another to put it back';
  const undo: UsersUndo = {
    leave: held.accesses.filter((a) => a.what === 'group' && now.present.has(idKey(a.id))),
    unassign: held.accesses.filter((a) => a.what !== 'group' && now.present.has(idKey(a.id))),
    kept: [],
  };

  if (after.isFrozen !== before.isFrozen && current.isFrozen === after.isFrozen) {
    const change: UsersChange = { what: 'frozen', from: after.isFrozen, to: before.isFrozen };
    if (self && before.isFrozen) undo.kept.push({ change, why: selfWhy });
    else if (now.loginId === undefined) {
      undo.kept.push({ change, why: 'the org keeps no login of this user (UserLogin) to write' });
    } else undo.isFrozen = { to: before.isFrozen, loginId: now.loginId, change };
  }
  if (after.isActive !== before.isActive && current.isActive === after.isActive) {
    const change: UsersChange = { what: 'active', from: after.isActive, to: before.isActive };
    if (self && !before.isActive) undo.kept.push({ change, why: selfWhy });
    else undo.isActive = { to: before.isActive, change };
  }
  if (
    idKey(after.profileId) !== idKey(before.profileId) &&
    idKey(current.profileId) !== idKey(before.profileId)
  ) {
    const nameOf = (id: string): string => now.profileNames.get(idKey(id)) ?? id;
    const change: UsersChange = {
      what: 'profile',
      from: nameOf(current.profileId),
      to: nameOf(before.profileId),
    };
    const changedSince = idKey(current.profileId) !== idKey(after.profileId);
    if (self) undo.kept.push({ change, why: selfWhy });
    else if (changedSince && !options.includeChanged) {
      undo.kept.push({
        change,
        why:
          `its profile was changed since the run, to ${nameOf(current.profileId)}: ` +
          `--include-changed puts ${nameOf(before.profileId)} back`,
      });
    } else undo.profileId = { to: before.profileId, change };
  }
  return undo;
}

/** A held access's change, taken back. */
function removedOf(access: UsersHeldAccess): UsersChange {
  return access.what === 'group'
    ? { what: 'group', name: access.name, type: access.type ?? 'Regular', to: 'removed' }
    : { what: access.what, name: access.name, to: 'removed' };
}

/** A removal refused before anything was read of the users or written. */
function refusedAnswer(
  input: UsersRemoveInput,
  code: string,
  message: string,
  requests: number,
): UsersRemoveAnswer {
  return {
    org: input.organization,
    run: input.run,
    status: 'failure',
    users: [],
    apiRequests: requests,
    refusals: [{ code, message }],
  };
}

/** See the module's comment. */
export async function removeUsersRun(input: UsersRemoveInput): Promise<UsersRemoveAnswer> {
  const { org, store, run } = input;
  const now = input.now ?? (() => new Date());
  const startedRequests = org.requests();
  const requests = (): number => org.requests() - startedRequests;
  const connected = await org.identity();

  const record = await store.read(connected.organizationId, run);
  if (!record) {
    return refusedAnswer(
      input,
      'USERS_RUN_NOT_FOUND',
      `run ${run}: this machine keeps no run of that number for this org, whose Organization Id ` +
        `is ${connected.organizationId}: a sandbox refreshed since answers another, and its runs ` +
        'went with the copy they set up',
      requests(),
    );
  }
  const replacing = (await store.list(connected.organizationId)).find(
    (each) => each.replaces === run,
  );
  if (replacing) {
    return refusedAnswer(
      input,
      'USERS_RUN_REPLACED',
      `run ${run} was replaced by run ${replacing.run}, which holds what it set up: remove run ` +
        `${replacing.run}`,
      requests(),
    );
  }
  const manageUsers = await manageUsersOf(org);
  if (manageUsers !== true) {
    const refusal = noRightRefusal(connected.username, manageUsers);
    return refusedAnswer(input, refusal.code, refusal.message, requests());
  }

  // What the org holds now of each user the run holds.
  const held = record.users;
  const userIds = held.map((user) => user.applied.userId);
  const standings = new Map<string, UsersStanding>();
  for (const part of inChunks(userIds, 200)) {
    for (const row of await org.query(
      `SELECT Id, IsActive, ProfileId FROM User WHERE Id IN ${soqlList(part)}`,
    )) {
      standings.set(idKey(String(row['Id'])), {
        isActive: row['IsActive'] === true,
        isFrozen: false,
        profileId: String(row['ProfileId']),
      });
    }
  }
  const logins = new Map<string, string>();
  const frozenHeld = held.filter((user) => user.after.isFrozen !== user.applied.before.isFrozen);
  for (const part of inChunks(
    frozenHeld.map((user) => user.applied.userId),
    200,
  )) {
    for (const row of await org.query(
      `SELECT Id, UserId, IsFrozen FROM UserLogin WHERE UserId IN ${soqlList(part)}`,
    )) {
      const key = idKey(String(row['UserId']));
      logins.set(key, String(row['Id']));
      const standing = standings.get(key);
      if (standing) standing.isFrozen = row['IsFrozen'] === true;
    }
  }
  const present = new Set<string>();
  const ids = (what: 'assignments' | 'memberships') =>
    held.flatMap((user) =>
      user.accesses
        .filter((access) => (what === 'memberships') === (access.what === 'group'))
        .map((access) => access.id),
    );
  for (const [object, list] of [
    ['PermissionSetAssignment', ids('assignments')],
    ['GroupMember', ids('memberships')],
  ] as const) {
    for (const part of inChunks(list, 200)) {
      for (const row of await org.query(`SELECT Id FROM ${object} WHERE Id IN ${soqlList(part)}`)) {
        present.add(idKey(String(row['Id'])));
      }
    }
  }
  const profileIds = held
    .flatMap((user) =>
      idKey(user.after.profileId) !== idKey(user.applied.before.profileId)
        ? [
            user.applied.before.profileId,
            user.after.profileId,
            standings.get(idKey(user.applied.userId))?.profileId ?? '',
          ]
        : [],
    )
    .filter((id) => id !== '');
  const profileNames = new Map<string, string>();
  for (const part of inChunks([...new Set(profileIds)], 200)) {
    for (const row of await org.query(
      `SELECT Id, Name FROM Profile WHERE Id IN ${soqlList(part)}`,
    )) {
      profileNames.set(idKey(String(row['Id'])), String(row['Name']));
    }
  }

  const usernames = held.map((user) => user.applied.username);
  const removing = held.flatMap((user) => {
    const standing = standings.get(idKey(user.applied.userId));
    if (!standing) return [];
    const loginId = logins.get(idKey(user.applied.userId));
    return [
      {
        user,
        undo: undoOf(
          user,
          { standing, ...(loginId ? { loginId } : {}), profileNames, present },
          { includeChanged: input.includeChanged === true, connected },
        ),
        undone: [] as UsersChange[],
        refused: [] as Array<{ change: UsersChange; why: string; code: string }>,
      },
    ];
  });
  type Removing = (typeof removing)[number];
  const refusedOf = (
    one: Removing,
    change: UsersChange,
    error: { code: string; message: string } | undefined,
  ) => {
    const code = error?.code ?? 'NO_ANSWER';
    one.refused.push({
      change,
      code,
      why: `the org refused it: ${code} ${wordsWithoutAddresses(error?.message ?? 'the org answered nothing for it', usernames)}`,
    });
  };

  const deleteAll = async (
    object: 'GroupMember' | 'PermissionSetAssignment',
    of: (one: Removing) => UsersHeldAccess[],
  ) => {
    const rows = removing.flatMap((one) => of(one).map((access) => ({ one, access })));
    if (rows.length === 0) return;
    const answers = await org.destroy(
      object,
      rows.map(({ access }) => access.id),
    );
    rows.forEach(({ one, access }, at) => {
      const answer = answers[at];
      if (answer?.success === true) one.undone.push(removedOf(access));
      else if (!answer?.errors.some((error) => error.code === 'ENTITY_IS_DELETED')) {
        refusedOf(one, removedOf(access), answer?.errors[0]);
      }
    });
  };
  const updateAll = async (
    object: 'User' | 'UserLogin',
    of: (
      one: Removing,
    ) => { row: Record<string, unknown> & { Id: string }; change: UsersChange } | undefined,
  ) => {
    const rows = removing.flatMap((one) => {
      const write = of(one);
      return write ? [{ one, ...write }] : [];
    });
    if (rows.length === 0) return;
    const answers = await org.update(
      object,
      rows.map(({ row }) => row),
    );
    rows.forEach(({ one, change }, at) => {
      const answer = answers[at];
      if (answer?.success === true) one.undone.push(change);
      else refusedOf(one, change, answer?.errors[0]);
    });
  };

  const steps: Array<() => Promise<void>> = [
    () => deleteAll('GroupMember', (one) => one.undo.leave),
    () => deleteAll('PermissionSetAssignment', (one) => one.undo.unassign),
    () =>
      updateAll('UserLogin', (one) =>
        one.undo.isFrozen
          ? {
              row: { Id: one.undo.isFrozen.loginId, IsFrozen: one.undo.isFrozen.to },
              change: one.undo.isFrozen.change,
            }
          : undefined,
      ),
    async () => {
      // Deactivations first: the license each gives back is free for a user put back active.
      for (const to of [false, true]) {
        await updateAll('User', (one) =>
          one.undo.isActive?.to === to
            ? {
                row: { Id: one.user.applied.userId, IsActive: to },
                change: one.undo.isActive.change,
              }
            : undefined,
        );
      }
    },
    () =>
      updateAll('User', (one) =>
        one.undo.profileId
          ? {
              row: { Id: one.user.applied.userId, ProfileId: one.undo.profileId.to },
              change: one.undo.profileId.change,
            }
          : undefined,
      ),
  ];
  let cancelled = false;
  for (const step of steps) {
    await step();
    if (input.signal?.aborted) {
      cancelled = true;
      break;
    }
  }

  const users = removing.map((one) => {
    const kept = [...one.undo.kept, ...one.refused.map(({ change, why }) => ({ change, why }))];
    return {
      username: one.user.applied.username,
      userId: one.user.applied.userId,
      undone: one.undone,
      ...(kept.length > 0 ? { kept } : {}),
    };
  });
  const keptCount = users.reduce((sum, user) => sum + (user.kept?.length ?? 0), 0);
  const status: UsersRemoveAnswer['status'] = cancelled
    ? 'cancelled'
    : keptCount > 0
      ? 'partial'
      : 'success';
  const journaled: UsersRunRecord = {
    ...record,
    removals: [
      ...(record.removals ?? []),
      {
        at: now().toISOString(),
        status,
        undone: users.reduce((sum, user) => sum + user.undone.length, 0),
        kept: keptCount,
        codes: [
          ...new Set(removing.flatMap((one) => one.refused.map((refused) => refused.code))),
        ].slice(0, 50),
      },
    ],
  };
  await store.write(journaled);

  return {
    org: input.organization,
    run,
    status,
    users,
    apiRequests: requests(),
  };
}
