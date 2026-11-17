/**
 * A run of `sandforge users`: it reads the org, plans, and refuses before
 * its first write what the plan refuses — nothing written, no run kept.
 * Otherwise it keeps the run first (`usersRunStore.ts`), with what each user
 * was, then writes step by step, every user of a step in one collection:
 *
 * 1. profiles;
 * 2. deactivations, then activations, so that a license given back is free
 *    for the activation after it;
 * 3. freezes and unfreezes (`UserLogin.IsFrozen`);
 * 4. permission sets and their groups, added, then those the environment
 *    holds and the file no longer names, taken back by id;
 * 5. groups and queues, the same, the memberships read again right before
 *    any is added: the org answers a membership added twice with the id of
 *    the one there, as if created, and only what was not there is the run's;
 * 6. addresses, last: a run stopped before has mailed nobody;
 * 7. a read of what it wrote.
 *
 * After each step the run file says what the run holds, so that a removal
 * takes back what a run cut short created. What the org refuses at a write
 * — a license taken since the plan, a deactivation it will not do — is no
 * blocking: the user is named with the org's code and words, the others go
 * on, and the run ends partial. An assignment the org calls a duplicate was
 * there before the write: found, never refused, never created.
 *
 * An address asked back awaits its owner: Salesforce mails a link to it and
 * keeps the old one until the link is clicked. The run says `awaiting`,
 * never `restored`, unless its read after holds the address restored.
 */

import type {
  UsersAddress,
  UsersAppliedUser,
  UsersApplyAnswer,
  UsersChange,
  UsersConfigUser,
  UsersPlanAnswer,
} from '@sandforge/shared';

import {
  inChunks,
  soqlList,
  wordsWithoutAddresses,
  type UsersOrg,
  type UsersSaveResult,
} from './usersOrg.js';
import {
  planUsers,
  usersPlanAnswerOf,
  type PlannedUser,
  type UsersOrgSummary,
  type UsersPlan,
  type UsersPlanOptions,
  type UsersStanding,
} from './usersPlan.js';
import { addressRestoredOf, idKey, readUsersState, type UsersOrgState } from './usersResolve.js';
import type { UsersHeldAccess, UsersRunRecord, UsersRunStore } from './usersRunStore.js';

/** What a plan of `sandforge users` is given. */
export interface UsersPlanInput extends UsersPlanOptions {
  org: UsersOrg;
  /** The org, as the answers name it: never a production org. */
  organization: UsersOrgSummary;
  /** The file's users, each with the defaults it does not override. */
  users: readonly UsersConfigUser[];
  now?: () => Date;
}

/** What a run of `sandforge users` is given. */
export interface UsersApplyInput extends UsersPlanInput {
  store: UsersRunStore;
  /** Once aborted, the run ends after the step under way: cancelled, its file saying what it holds. */
  signal?: AbortSignal;
}

/** How a run ended: refused before its first write, or run. */
export type UsersApplyOutcome =
  | { kind: 'refused'; plan: UsersPlanAnswer }
  | { kind: 'applied'; answer: UsersApplyAnswer; record: UsersRunRecord };

/** The plan of a run, read from the org: what `sandforge users plan` answers, and an apply's first part. */
export async function planUsersIn(
  input: UsersPlanInput,
): Promise<{ state: UsersOrgState; plan: UsersPlan; answer: UsersPlanAnswer }> {
  const now = input.now ?? (() => new Date());
  const state = await readUsersState(input.org, input.users, {
    now: now(),
    ...(input.previous ? { previous: input.previous } : {}),
  });
  const plan = planUsers(state, input.users, {
    ...(input.previous ? { previous: input.previous } : {}),
    ...(input.acceptUserEmails !== undefined ? { acceptUserEmails: input.acceptUserEmails } : {}),
    ...(input.deliverability !== undefined ? { deliverability: input.deliverability } : {}),
    ...(input.acceptEmails !== undefined ? { acceptEmails: input.acceptEmails } : {}),
  });
  return { state, plan, answer: usersPlanAnswerOf(plan, input.organization, state.requests) };
}

// ─── One user, as the run goes ───────────────────────────────────────────────

interface Working {
  planned: PlannedUser;
  userId: string;
  before: UsersStanding;
  /** What the user is, each write the org took written in. */
  standing: UsersStanding;
  done: UsersChange[];
  refused: NonNullable<UsersAppliedUser['refused']>;
  /** The accesses the environment holds of the user: carried, created, or not taken back yet. */
  accesses: UsersHeldAccess[];
  found: { permissionSetAssignments: string[]; groupMembers: string[] };
  address?: UsersAddress;
}

/** The change of a plan a write carries out. */
function changeOf(planned: PlannedUser, test: (change: UsersChange) => boolean): UsersChange {
  const change = planned.changes.find(test);
  if (!change) throw new Error(`No change of ${planned.username} for this write`);
  return change;
}

/** The first error of a row the org refused. */
function errorOf(answer: UsersSaveResult | undefined, usernames: readonly string[]) {
  const error = answer?.errors[0];
  return {
    code: error?.code ?? 'NO_ANSWER',
    message: wordsWithoutAddresses(error?.message ?? 'the org answered nothing for it', usernames),
  };
}

/** Codes of a delete whose record is gone already. */
const GONE = new Set(['ENTITY_IS_DELETED', 'NOT_FOUND', 'INVALID_CROSS_REFERENCE_KEY']);

/** What the environment left of a thing it writes: what it wants, where it holds it, else what it found. */
function afterOf(one: Working): UsersStanding {
  const { target } = one.planned;
  return {
    isActive: target.isActive !== undefined ? one.standing.isActive : one.before.isActive,
    isFrozen: target.isFrozen !== undefined ? one.standing.isFrozen : one.before.isFrozen,
    profileId: target.profileId !== undefined ? one.standing.profileId : one.before.profileId,
  };
}

/** Whether the environment still holds anything of a user. */
function holds(one: Working): boolean {
  const after = afterOf(one);
  return (
    one.accesses.length > 0 ||
    after.isActive !== one.before.isActive ||
    after.isFrozen !== one.before.isFrozen ||
    idKey(after.profileId) !== idKey(one.before.profileId)
  );
}

function appliedOf(one: Working): UsersAppliedUser {
  const found =
    one.found.permissionSetAssignments.length > 0 || one.found.groupMembers.length > 0
      ? { found: one.found }
      : {};
  return {
    username: one.planned.username,
    userId: one.userId,
    before: one.before,
    done: one.done,
    created: {
      permissionSetAssignments: one.accesses.filter((a) => a.what !== 'group').map((a) => a.id),
      groupMembers: one.accesses.filter((a) => a.what === 'group').map((a) => a.id),
    },
    ...found,
    ...(one.address !== undefined ? { address: one.address } : {}),
    ...(one.refused.length > 0 ? { refused: one.refused } : {}),
  };
}

// ─── The run ─────────────────────────────────────────────────────────────────

/** See the module's comment. */
export async function applyUsers(input: UsersApplyInput): Promise<UsersApplyOutcome> {
  const { org, store, signal } = input;
  const now = input.now ?? (() => new Date());
  const startedRequests = org.requests();
  const { state, plan, answer: planned } = await planUsersIn(input);
  if (plan.refusals.length > 0) return { kind: 'refused', plan: planned };
  if (idKey(state.connected.organizationId) !== idKey(input.organization.organizationId)) {
    throw new Error(
      `The connection is to ${state.connected.organizationId}, not to ` +
        `${input.organization.organizationId}: nothing was written`,
    );
  }

  const working: Working[] = plan.users.flatMap((one) =>
    one.userId !== undefined && one.current !== undefined && one.before !== undefined
      ? [
          {
            planned: one,
            userId: one.userId,
            before: one.before,
            standing: { ...one.current },
            done: [],
            refused: [],
            accesses: [...one.carried, ...one.writes.unassign, ...one.writes.leave],
            found: {
              permissionSetAssignments: [...one.found.permissionSetAssignments],
              groupMembers: [...one.found.groupMembers],
            },
            ...(one.address !== undefined ? { address: one.address } : {}),
          },
        ]
      : [],
  );
  const usernames = working.map((one) => one.planned.username);
  let emailsSent = 0;
  const startedAt = now().toISOString();

  const bodyOf = (status: UsersRunRecord['status'], ended: boolean) => ({
    ...(input.previous ? { replaces: input.previous.run } : {}),
    status,
    startedAt,
    ...(ended ? { endedAt: now().toISOString() } : {}),
    emailsToPeople: emailsSent,
    users: working
      .filter((one) => one.planned.inFile || holds(one))
      .map((one) => ({
        applied: appliedOf(one),
        after: afterOf(one),
        accesses: one.accesses,
        inFile: one.planned.inFile,
      })),
  });
  const recordOf = (
    run: number,
    status: UsersRunRecord['status'],
    ended: boolean,
  ): UsersRunRecord => ({
    version: 1,
    organizationId: state.connected.organizationId,
    run,
    ...bodyOf(status, ended),
  });

  const begun = await store.begin(state.connected.organizationId, bodyOf('running', false));
  const run = begun.run;
  const duplicates = new Set<Working>();

  /** Update one field of each user of `rows`, as one collection: what the org took, written in. */
  const updateUsers = async (
    rows: Working[],
    write: (one: Working) => Record<string, unknown> & { Id: string },
    test: (change: UsersChange) => boolean,
    object: 'User' | 'UserLogin',
    took: (one: Working) => void,
  ): Promise<void> => {
    if (rows.length === 0) return;
    const answers = await org.update(object, rows.map(write));
    rows.forEach((one, at) => {
      const change = changeOf(one.planned, test);
      if (answers[at]?.success === true) {
        took(one);
        one.done.push(change);
      } else {
        one.refused.push({ change, ...errorOf(answers[at], usernames) });
      }
    });
  };

  const steps: Array<() => Promise<void>> = [
    // 1. Profiles.
    () =>
      updateUsers(
        working.filter((one) => one.planned.writes.profileId !== undefined),
        (one) => ({ Id: one.userId, ProfileId: one.planned.writes.profileId }),
        (change) => change.what === 'profile',
        'User',
        (one) => {
          one.standing.profileId = one.planned.writes.profileId ?? one.standing.profileId;
        },
      ),
    // 2. Deactivations, then activations.
    async () => {
      for (const isActive of [false, true]) {
        await updateUsers(
          working.filter((one) => one.planned.writes.isActive === isActive),
          (one) => ({ Id: one.userId, IsActive: isActive }),
          (change) => change.what === 'active',
          'User',
          (one) => {
            one.standing.isActive = isActive;
          },
        );
      }
    },
    // 3. Freezes and unfreezes.
    () =>
      updateUsers(
        working.filter((one) => one.planned.writes.isFrozen !== undefined),
        (one) => ({ Id: one.planned.writes.loginId ?? '', IsFrozen: one.planned.writes.isFrozen }),
        (change) => change.what === 'frozen',
        'UserLogin',
        (one) => {
          one.standing.isFrozen = one.planned.writes.isFrozen ?? one.standing.isFrozen;
        },
      ),
    // 4. Permission sets and their groups.
    async () => {
      const rows = working.flatMap((one) =>
        one.planned.writes.assign.map((assign) => ({ one, assign })),
      );
      if (rows.length > 0) {
        const answers = await org.create(
          'PermissionSetAssignment',
          rows.map(({ one, assign }) =>
            assign.what === 'permissionSet'
              ? { AssigneeId: one.userId, PermissionSetId: assign.setId }
              : { AssigneeId: one.userId, PermissionSetGroupId: assign.setId },
          ),
        );
        rows.forEach(({ one, assign }, at) => {
          const answer = answers[at];
          const change = changeOf(
            one.planned,
            (c) => c.what === assign.what && c.name === assign.name && c.to === 'added',
          );
          if (answer?.success === true && answer.id !== undefined) {
            one.accesses.push({ id: answer.id, what: assign.what, name: assign.name });
            one.done.push(change);
          } else if (answer?.errors[0]?.code === 'DUPLICATE_VALUE') {
            duplicates.add(one);
          } else {
            one.refused.push({ change, ...errorOf(answer, usernames) });
          }
        });
      }
      await takeBack('PermissionSetAssignment', (one) => one.planned.writes.unassign);
    },
    // 5. Groups and queues.
    async () => {
      const joining = working.filter((one) => one.planned.writes.join.length > 0);
      if (joining.length > 0) {
        const there = new Map<string, string>();
        for (const part of inChunks(
          joining.map((one) => one.userId),
          200,
        )) {
          const rows = await org.query(
            `SELECT Id, GroupId, UserOrGroupId FROM GroupMember WHERE UserOrGroupId IN ${soqlList(part)}`,
          );
          for (const row of rows) {
            there.set(
              `${idKey(String(row['UserOrGroupId']))}:${idKey(String(row['GroupId']))}`,
              String(row['Id']),
            );
          }
        }
        const rows = joining.flatMap((one) =>
          one.planned.writes.join.flatMap((join) => {
            const present = there.get(`${idKey(one.userId)}:${idKey(join.groupId)}`);
            if (present !== undefined) {
              // Added since the plan's read, by someone else: theirs.
              one.found.groupMembers.push(present);
              return [];
            }
            return [{ one, join }];
          }),
        );
        if (rows.length > 0) {
          const known = new Set([...there.values()].map(idKey));
          const answers = await org.create(
            'GroupMember',
            rows.map(({ one, join }) => ({ GroupId: join.groupId, UserOrGroupId: one.userId })),
          );
          rows.forEach(({ one, join }, at) => {
            const answer = answers[at];
            const change = changeOf(
              one.planned,
              (c) => c.what === 'group' && c.name === join.name && c.to === 'added',
            );
            if (answer?.success === true && answer.id !== undefined) {
              if (known.has(idKey(answer.id))) {
                one.found.groupMembers.push(answer.id);
                return;
              }
              one.accesses.push({ id: answer.id, what: 'group', name: join.name, type: join.type });
              one.done.push(change);
            } else {
              one.refused.push({ change, ...errorOf(answer, usernames) });
            }
          });
        }
      }
      await takeBack('GroupMember', (one) => one.planned.writes.leave);
    },
    // 6. Addresses, last.
    () =>
      updateUsers(
        working.filter((one) => one.planned.writes.email !== undefined),
        (one) => ({ Id: one.userId, Email: one.planned.writes.email }),
        (change) => change.what === 'email',
        'User',
        (one) => {
          emailsSent += 1;
          one.address = 'awaiting';
        },
      ),
  ];

  /** Delete by id the accesses the environment holds and the file no longer names. */
  async function takeBack(
    object: 'PermissionSetAssignment' | 'GroupMember',
    of: (one: Working) => readonly UsersHeldAccess[],
  ): Promise<void> {
    const rows = working.flatMap((one) => of(one).map((access) => ({ one, access })));
    if (rows.length === 0) return;
    const answers = await org.destroy(
      object,
      rows.map(({ access }) => access.id),
    );
    rows.forEach(({ one, access }, at) => {
      const answer = answers[at];
      const change = changeOf(
        one.planned,
        (c) =>
          c.what === access.what && 'name' in c && c.name === access.name && c.to === 'removed',
      );
      const gone = answer?.errors.some((error) => GONE.has(error.code)) === true;
      if (answer?.success === true || gone) {
        one.accesses = one.accesses.filter((held) => held.id !== access.id);
        if (answer?.success === true) one.done.push(change);
      } else {
        one.refused.push({ change, ...errorOf(answer, usernames) });
      }
    });
  }

  let status: UsersRunRecord['status'] = 'success';
  for (const step of steps) {
    if (signal?.aborted) {
      status = 'cancelled';
      break;
    }
    await step();
    await store.write(recordOf(run, 'running', false));
  }

  if (status !== 'cancelled') await readBack(org, working, duplicates);
  if (status !== 'cancelled' && working.some((one) => one.refused.length > 0)) status = 'partial';
  const record = recordOf(run, status, true);
  await store.write(record);

  const answer: UsersApplyAnswer = {
    org: input.organization,
    run,
    status,
    users: working.map(appliedOf),
    emailsToPeople: emailsSent,
    apiRequests: org.requests() - startedRequests,
  };
  return { kind: 'applied', answer, record };
}

/**
 * Read what the run wrote: each user's profile, activation and address, and
 * its login where it was frozen or unfrozen. A write the org answered
 * success for and does not hold is said refused; an address asked back is
 * restored only once read without `.invalid`. The assignments the org
 * called duplicates are read for their ids: found there.
 */
async function readBack(
  org: UsersOrg,
  working: readonly Working[],
  duplicates: ReadonlySet<Working>,
): Promise<void> {
  const written = working.filter(
    (one) =>
      one.planned.writes.profileId !== undefined ||
      one.planned.writes.isActive !== undefined ||
      one.planned.writes.isFrozen !== undefined ||
      one.planned.writes.email !== undefined,
  );
  const byId = new Map(working.map((one) => [idKey(one.userId), one]));
  /** A change the org said it took and does not hold: refused after all. */
  const notHeld = (one: Working, what: UsersChange['what']): void => {
    const at = one.done.findIndex((change) => change.what === what);
    if (at < 0) return;
    const [change] = one.done.splice(at, 1);
    one.refused.push({
      change,
      code: 'NOT_HELD',
      message: 'the org answered success, and its read after the run holds the user otherwise',
    });
  };

  for (const part of inChunks(
    written.map((one) => one.userId),
    200,
  )) {
    const rows = await org.query(
      `SELECT Id, Email, IsActive, ProfileId FROM User WHERE Id IN ${soqlList(part)}`,
    );
    for (const row of rows) {
      const one = byId.get(idKey(String(row['Id'])));
      if (!one) continue;
      const isActive = row['IsActive'] === true;
      const profileId = String(row['ProfileId']);
      if (one.planned.writes.isActive !== undefined && isActive !== one.standing.isActive) {
        notHeld(one, 'active');
      }
      if (
        one.planned.writes.profileId !== undefined &&
        idKey(profileId) !== idKey(one.standing.profileId)
      ) {
        notHeld(one, 'profile');
      }
      one.standing.isActive = isActive;
      one.standing.profileId = profileId;
      if (one.address === 'awaiting' && typeof row['Email'] === 'string') {
        if (addressRestoredOf(row['Email']) === undefined) one.address = 'restored';
      }
    }
  }

  const frozen = written.filter((one) => one.planned.writes.isFrozen !== undefined);
  for (const part of inChunks(
    frozen.map((one) => one.userId),
    200,
  )) {
    const rows = await org.query(
      `SELECT Id, UserId, IsFrozen FROM UserLogin WHERE UserId IN ${soqlList(part)}`,
    );
    for (const row of rows) {
      const one = byId.get(idKey(String(row['UserId'])));
      if (!one) continue;
      const isFrozen = row['IsFrozen'] === true;
      if (isFrozen !== one.standing.isFrozen) notHeld(one, 'frozen');
      one.standing.isFrozen = isFrozen;
    }
  }

  if (duplicates.size === 0) return;
  const rows = await org.query(
    'SELECT Id, AssigneeId, PermissionSetId, PermissionSetGroupId FROM PermissionSetAssignment ' +
      `WHERE AssigneeId IN ${soqlList([...duplicates].map((one) => one.userId))}`,
  );
  for (const one of duplicates) {
    for (const assign of one.planned.writes.assign) {
      const row = rows.find(
        (each) =>
          idKey(String(each['AssigneeId'])) === idKey(one.userId) &&
          idKey(
            String(
              (assign.what === 'permissionSet'
                ? each['PermissionSetId']
                : each['PermissionSetGroupId']) ?? '',
            ),
          ) === idKey(assign.setId),
      );
      const id = row ? String(row['Id']) : undefined;
      if (
        id !== undefined &&
        !one.accesses.some((access) => idKey(access.id) === idKey(id)) &&
        !one.found.permissionSetAssignments.includes(id)
      ) {
        one.found.permissionSetAssignments.push(id);
      }
    }
  }
}
