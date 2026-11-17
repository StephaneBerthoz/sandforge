import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { usersRemoveAnswerSchema, type UsersConfigUser } from '@sandforge/shared';

import { SasPathGuard, findRepoRoot } from '../frozendataset/SasPathGuard.js';
import {
  ACME,
  acmeSetup,
  usersTestOrg,
  type UsersTestOrg,
  type UsersTestOrgSetup,
} from './usersOrg.fixtures.js';
import { usersOrgOf } from './usersOrg.js';
import { applyUsers } from './usersApply.js';
import { removeUsersRun } from './usersRemoval.js';
import { UsersRunStore } from './usersRunStore.js';

/*
 * The removal of a run of `sandforge users`: what the run created deleted by
 * its id, what it found there never touched, each user put back as it was
 * where it is still as the run left it, and what someone changed since kept,
 * named. An address asked back is never put under .invalid again, and a user
 * is never deleted.
 */

const NOW = new Date('2026-11-20T08:14:00.000Z');

const ORG = {
  organizationId: ACME.organizationId,
  kind: 'sandbox' as const,
  alias: 'uat',
  username: 'admin@acme.com.uat',
};

const TESTERS: UsersConfigUser[] = [
  {
    username: 'jane.qa@acme.com',
    email: 'restore',
    frozen: false,
    permissionSets: ['QA_Tools'],
    groups: ['QA_Team', 'QA_Queue'],
  },
  { username: 'paul.qa@acme.com', active: true, profile: 'QA Tester' },
  { username: 'erp.integration@acme.com', frozen: true },
];

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function storeOf(): UsersRunStore {
  const root = mkdtempSync(join(tmpdir(), 'sandforge-users-remove-'));
  dirs.push(root);
  return new UsersRunStore({ root, guard: new SasPathGuard(findRepoRoot(process.cwd())) });
}

/** An org the testers' run was applied to, with its store. */
async function applied(setup: UsersTestOrgSetup = acmeSetup()) {
  const org = usersTestOrg(setup);
  const store = storeOf();
  const outcome = await applyUsers({
    org: usersOrgOf(org.connection),
    organization: ORG,
    users: TESTERS,
    store,
    acceptUserEmails: true,
    now: () => NOW,
  });
  if (outcome.kind !== 'applied') throw new Error('refused');
  org.writes.splice(0);
  return { org, store, answer: outcome.answer };
}

function remove(
  org: UsersTestOrg,
  store: UsersRunStore,
  over: { includeChanged?: boolean; run?: number } = {},
) {
  return removeUsersRun({
    org: usersOrgOf(org.connection),
    organization: ORG,
    store,
    run: over.run ?? 1,
    ...(over.includeChanged !== undefined ? { includeChanged: over.includeChanged } : {}),
    now: () => NOW,
  });
}

function userIn(org: UsersTestOrg, id: string) {
  const user = org.users.find((each) => each.id === id);
  if (!user) throw new Error(`no user ${id}`);
  return user;
}

describe('a removal', () => {
  it('puts each user back as it was and deletes by id what the run created', async () => {
    const { org, store } = await applied();

    const answer = await remove(org, store);

    expect(usersRemoveAnswerSchema.parse(answer)).toEqual(answer);
    expect(answer.status).toBe('success');
    expect(userIn(org, ACME.users.jane).frozen).toBe(true);
    expect(userIn(org, ACME.users.paul)).toMatchObject({
      isActive: false,
      profileId: ACME.profiles.platform,
    });
    expect(userIn(org, ACME.users.erp).frozen).toBe(false);
    expect(org.assignments).toEqual([]);
    expect(org.memberships).toEqual([]);
    expect(answer.users.map((user) => [user.username, user.undone])).toEqual([
      [
        'jane.qa@acme.com.uat',
        [
          { what: 'group', name: 'QA_Team', type: 'Regular', to: 'removed' },
          { what: 'group', name: 'QA_Queue', type: 'Queue', to: 'removed' },
          { what: 'permissionSet', name: 'QA_Tools', to: 'removed' },
          { what: 'frozen', from: false, to: true },
        ],
      ],
      [
        'paul.qa@acme.com.uat',
        [
          { what: 'active', from: true, to: false },
          { what: 'profile', from: 'QA Tester', to: 'Standard Platform User' },
        ],
      ],
      ['erp.integration@acme.com.uat', [{ what: 'frozen', from: true, to: false }]],
    ]);
  });

  it('never puts an address asked back under .invalid again, and deletes no user', async () => {
    const { org, store } = await applied();
    org.confirmAddress(ACME.users.jane);

    await remove(org, store);

    expect(userIn(org, ACME.users.jane).email).toBe('jane.qa@acme.com');
    expect(org.writes.some((write) => write.rows.some((row) => 'Email' in row))).toBe(false);
    expect(org.writes.some((write) => write.kind === 'destroy' && write.object === 'User')).toBe(
      false,
    );
    expect(org.users).toHaveLength(4);
  });

  it('never touches an access the user held before the run', async () => {
    const { org, store } = await applied(
      acmeSetup({
        assignments: [
          {
            id: '0Pa000000000101AAA',
            assigneeId: ACME.users.jane,
            permissionSetId: ACME.permissionSets.qaTools,
          },
        ],
        memberships: [
          { id: '011000000000101AAA', groupId: ACME.groups.qaTeam, userId: ACME.users.jane },
        ],
      }),
    );

    await remove(org, store);

    expect(org.assignments.map((a) => a.id)).toEqual(['0Pa000000000101AAA']);
    expect(org.memberships.map((m) => m.id)).toEqual(['011000000000101AAA']);
  });

  it('says nothing to do for what someone already put back, or took away, since', async () => {
    const { org, store } = await applied();
    userIn(org, ACME.users.jane).frozen = true;
    org.assignments.splice(0);

    const answer = await remove(org, store);

    expect(answer.status).toBe('success');
    expect(answer.users[0].undone).toEqual([
      { what: 'group', name: 'QA_Team', type: 'Regular', to: 'removed' },
      { what: 'group', name: 'QA_Queue', type: 'Queue', to: 'removed' },
    ]);
    expect(answer.users[0].kept).toBeUndefined();
    expect(org.writes.some((write) => write.object === 'PermissionSetAssignment')).toBe(false);
    expect(
      org.writes.some(
        (write) =>
          write.object === 'UserLogin' && write.rows.some((row) => row['Id'] === ACME.logins.jane),
      ),
    ).toBe(false);
  });

  it('keeps a profile someone changed since, unless --include-changed', async () => {
    const changed = async () => {
      const { org, store } = await applied();
      userIn(org, ACME.users.paul).profileId = ACME.profiles.standard;
      return { org, store };
    };

    const kept = await changed();
    const keptAnswer = await remove(kept.org, kept.store);
    const forced = await changed();
    const forcedAnswer = await remove(forced.org, forced.store, { includeChanged: true });

    expect(keptAnswer.status).toBe('partial');
    expect(keptAnswer.users[1].kept).toEqual([
      {
        change: { what: 'profile', from: 'Standard User', to: 'Standard Platform User' },
        why:
          'its profile was changed since the run, to Standard User: --include-changed puts ' +
          'Standard Platform User back',
      },
    ]);
    expect(userIn(kept.org, ACME.users.paul).profileId).toBe(ACME.profiles.standard);
    expect(forcedAnswer.users[1].undone).toContainEqual({
      what: 'profile',
      from: 'Standard User',
      to: 'Standard Platform User',
    });
    expect(userIn(forced.org, ACME.users.paul).profileId).toBe(ACME.profiles.platform);
  });

  it('names a user the org will not put back, in its code and words, and keeps it for another removal', async () => {
    const { org, store } = await applied();
    // A license taken since: erp's unfreeze passes, paul's deactivation is refused.
    const refusing = usersTestOrg({
      ...acmeSetup(),
      users: org.users,
      assignments: org.assignments,
      memberships: org.memberships,
      refuse: ({ object, row }) =>
        object === 'User' && row['IsActive'] === false
          ? { code: 'CANNOT_DEACTIVATE_USER', message: 'This user owns a queue’s records.' }
          : undefined,
    });

    const answer = await remove(refusing, store);

    expect(answer.status).toBe('partial');
    expect(answer.users[1].kept).toEqual([
      {
        change: { what: 'active', from: true, to: false },
        why: 'the org refused it: CANNOT_DEACTIVATE_USER This user owns a queue’s records.',
      },
    ]);
    const again = await remove(usersTestOrg({ ...acmeSetup(), users: refusing.users }), store);
    expect(again.users[1].undone).toContainEqual({ what: 'active', from: true, to: false });
  });

  it('keeps the user connected rather than lock it out', async () => {
    const setup = acmeSetup();
    const org = usersTestOrg({
      ...setup,
      users: setup.users.map((user) =>
        user.id === ACME.users.admin ? { ...user, frozen: true } : user,
      ),
    });
    const store = storeOf();
    const outcome = await applyUsers({
      org: usersOrgOf(org.connection),
      organization: ORG,
      users: [{ username: 'admin@acme.com.uat', frozen: false }],
      store,
      now: () => NOW,
    });
    if (outcome.kind !== 'applied') throw new Error('refused');

    const answer = await remove(org, store);

    expect(answer.users[0].kept).toEqual([
      {
        change: { what: 'frozen', from: false, to: true },
        why: 'admin@acme.com.uat is the user connected: SandForge would lock itself out; connect as another to put it back',
      },
    ]);
    expect(userIn(org, ACME.users.admin).frozen).toBe(false);
  });

  it('refuses a run this machine does not keep for this org, writing nothing', async () => {
    const { org, store } = await applied();

    const answer = await remove(org, store, { run: 7 });

    expect(answer).toMatchObject({ status: 'failure', users: [] });
    expect(answer.refusals).toEqual([
      {
        code: 'USERS_RUN_NOT_FOUND',
        message:
          'run 7: this machine keeps no run of that number for this org, whose Organization Id ' +
          `is ${ACME.organizationId}: a sandbox refreshed since answers another, and its runs ` +
          'went with the copy they set up',
      },
    ]);
    expect(org.writes).toEqual([]);
  });

  it('refuses a run another replaced, naming the one that holds what it set up', async () => {
    const { org, store } = await applied();
    const replaced = await store.read(ACME.organizationId, 1);
    if (!replaced) throw new Error('no run');
    const outcome = await applyUsers({
      org: usersOrgOf(org.connection),
      organization: ORG,
      users: TESTERS,
      store,
      previous: replaced,
      acceptUserEmails: true,
      now: () => NOW,
    });
    if (outcome.kind !== 'applied') throw new Error('refused');
    org.writes.splice(0);

    const answer = await remove(org, store, { run: 1 });

    expect(answer.refusals).toEqual([
      {
        code: 'USERS_RUN_REPLACED',
        message: 'run 1 was replaced by run 2, which holds what it set up: remove run 2',
      },
    ]);
    expect(org.writes).toEqual([]);
  });

  it('refuses when the connection may not manage users, writing nothing', async () => {
    const { org, store } = await applied();
    const withoutRight = usersTestOrg({
      ...acmeSetup({ manageUsers: false }),
      users: org.users,
      assignments: org.assignments,
      memberships: org.memberships,
    });

    const answer = await remove(withoutRight, store);

    expect(answer.refusals?.map((refusal) => refusal.code)).toEqual(['USERS_NO_RIGHT']);
    expect(withoutRight.writes).toEqual([]);
  });

  it('journals each removal in the run’s file, codes and counts only', async () => {
    const { org, store } = await applied();

    await remove(org, store);

    expect((await store.read(ACME.organizationId, 1))?.removals).toEqual([
      { at: NOW.toISOString(), status: 'success', undone: 7, kept: 0, codes: [] },
    ]);
  });
});
