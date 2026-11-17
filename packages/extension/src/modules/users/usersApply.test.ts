import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { usersApplyAnswerSchema, type UsersConfigUser } from '@sandforge/shared';

import { SasPathGuard, findRepoRoot } from '../frozendataset/SasPathGuard.js';
import {
  ACME,
  acmeSetup,
  usersTestOrg,
  type UsersTestOrg,
  type UsersTestOrgSetup,
} from './usersOrg.fixtures.js';
import { usersOrgOf } from './usersOrg.js';
import { applyUsers, planUsersIn, type UsersApplyInput } from './usersApply.js';
import { UsersRunStore } from './usersRunStore.js';

/*
 * A run of `sandforge users`: read, plan, refuse before the first write or
 * write in order — profile, activation, freeze, permission sets and their
 * groups, groups and queues, the address last —, journaling before its
 * first write and after each step what a removal will take back, then read
 * the users again. An address asked back awaits its owner: the run never
 * calls it restored.
 */

const NOW = new Date('2026-11-20T08:14:00.000Z');

const ORG = {
  organizationId: ACME.organizationId,
  kind: 'sandbox' as const,
  alias: 'uat',
  username: 'admin@acme.com.uat',
};

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function storeOf(): UsersRunStore {
  const root = mkdtempSync(join(tmpdir(), 'sandforge-users-apply-'));
  dirs.push(root);
  return new UsersRunStore({ root, guard: new SasPathGuard(findRepoRoot(process.cwd())) });
}

/** The testers of the design's file: jane unfrozen with her accesses, paul activated, erp frozen. */
const TESTERS: UsersConfigUser[] = [
  {
    username: 'jane.qa@acme.com',
    email: 'restore',
    frozen: false,
    permissionSets: ['QA_Tools'],
    groups: ['QA_Team'],
  },
  {
    username: 'paul.qa@acme.com',
    active: true,
    profile: 'QA Tester',
    permissionSetGroups: ['Support_Bundle'],
  },
  { username: 'erp.integration@acme.com', email: 'keep', frozen: true },
];

function runOf(
  setup: UsersTestOrgSetup | UsersTestOrg,
  over: Partial<UsersApplyInput> = {},
  store = storeOf(),
) {
  const org = 'connection' in setup ? setup : usersTestOrg(setup);
  const port = usersOrgOf(org.connection);
  return {
    org,
    port,
    store,
    outcome: applyUsers({
      org: port,
      organization: ORG,
      users: TESTERS,
      store,
      acceptUserEmails: true,
      now: () => NOW,
      ...over,
    }),
  };
}

describe('a run', () => {
  it('writes in the order of the design, each step one collection, the address last', async () => {
    const { org, outcome } = runOf(acmeSetup());
    const done = await outcome;

    expect(done.kind).toBe('applied');
    expect(org.writes.map((write) => [write.kind, write.object, write.rows])).toEqual([
      ['update', 'User', [{ Id: ACME.users.paul, ProfileId: ACME.profiles.qa }]],
      ['update', 'User', [{ Id: ACME.users.paul, IsActive: true }]],
      [
        'update',
        'UserLogin',
        [
          { Id: ACME.logins.jane, IsFrozen: false },
          { Id: ACME.logins.erp, IsFrozen: true },
        ],
      ],
      [
        'create',
        'PermissionSetAssignment',
        [
          { AssigneeId: ACME.users.jane, PermissionSetId: ACME.permissionSets.qaTools },
          { AssigneeId: ACME.users.paul, PermissionSetGroupId: ACME.permissionSetGroups.support },
        ],
      ],
      ['create', 'GroupMember', [{ GroupId: ACME.groups.qaTeam, UserOrGroupId: ACME.users.jane }]],
      ['update', 'User', [{ Id: ACME.users.jane, Email: 'jane.qa@acme.com' }]],
    ]);
    expect(org.writes.every((write) => write.allOrNone === false)).toBe(true);
  });

  it('answers each user’s changes, the address awaiting its owner and never restored', async () => {
    const { org, outcome, port } = runOf(acmeSetup());
    const done = await outcome;
    if (done.kind !== 'applied') throw new Error('refused');

    expect(usersApplyAnswerSchema.parse(done.answer)).toEqual(done.answer);
    expect(done.answer).toMatchObject({ run: 1, status: 'success', emailsToPeople: 1 });
    const [jane, paul, erp] = done.answer.users;
    expect(jane).toMatchObject({
      username: 'jane.qa@acme.com.uat',
      userId: ACME.users.jane,
      before: { isActive: true, isFrozen: true, profileId: ACME.profiles.platform },
      done: [
        { what: 'frozen', from: true, to: false },
        { what: 'permissionSet', name: 'QA_Tools', to: 'added' },
        { what: 'group', name: 'QA_Team', type: 'Regular', to: 'added' },
        { what: 'email', to: 'awaiting' },
      ],
      address: 'awaiting',
    });
    expect(jane.created.permissionSetAssignments).toHaveLength(1);
    expect(jane.created.groupMembers).toHaveLength(1);
    expect(paul.done).toEqual([
      { what: 'profile', from: 'Standard Platform User', to: 'QA Tester' },
      { what: 'active', from: false, to: true },
      { what: 'permissionSetGroup', name: 'Support_Bundle', to: 'added' },
    ]);
    expect(erp).toMatchObject({
      done: [{ what: 'frozen', from: false, to: true }],
      address: 'kept',
    });
    // The org holds the address under .invalid until its owner clicks the link it was sent.
    expect(org.users.find((user) => user.id === ACME.users.jane)?.email).toBe(
      'jane.qa@acme.com.invalid',
    );
    expect(org.emailsSent()).toBe(1);
    expect(done.answer.apiRequests).toBe(port.requests());
  });

  it('reads the address restored once its owner clicked, and asks nothing again meanwhile', async () => {
    const store = storeOf();
    const { org, outcome } = runOf(acmeSetup(), {}, store);
    await outcome;
    const writes = org.writes.length;

    const again = await planUsersIn({
      org: usersOrgOf(org.connection),
      organization: ORG,
      users: TESTERS,
      now: () => NOW,
    });
    org.confirmAddress(ACME.users.jane);
    const clicked = await planUsersIn({
      org: usersOrgOf(org.connection),
      organization: ORG,
      users: TESTERS,
      now: () => NOW,
    });

    expect(again.answer.users.map((user) => user.changes)).toEqual([[], [], []]);
    expect(again.answer.users[0].address).toBe('awaiting');
    expect(clicked.answer.users[0].address).toBe('restored');
    expect(org.writes).toHaveLength(writes);
  });

  it('writes nothing at all when every user is as the file says', async () => {
    const store = storeOf();
    const first = runOf(acmeSetup(), {}, store);
    await first.outcome;
    const writes = first.org.writes.length;

    const second = runOf(first.org, {}, store);
    const done = await second.outcome;

    expect(first.org.writes).toHaveLength(writes);
    expect(done).toMatchObject({
      kind: 'applied',
      answer: { run: 2, status: 'success', emailsToPeople: 0 },
    });
    if (done.kind === 'applied')
      expect(done.answer.users.every((user) => user.done.length === 0)).toBe(true);
  });

  it('writes nothing and keeps no run when the plan refuses it', async () => {
    const store = storeOf();
    const { org, outcome } = runOf(acmeSetup(), { acceptUserEmails: false }, store);
    const done = await outcome;

    expect(done.kind).toBe('refused');
    if (done.kind === 'refused') {
      expect(done.plan.refusals?.map((refusal) => refusal.code)).toEqual([
        'USERS_EMAILS_NOT_ACCEPTED',
      ]);
    }
    expect(org.writes).toEqual([]);
    expect(await store.list(ACME.organizationId)).toEqual([]);
  });
});

describe('what the org refuses at the write', () => {
  it('names the user whose activation the org refused, in its code and words, and does the rest', async () => {
    const setup = acmeSetup({
      refuse: ({ object, row }) =>
        object === 'User' && row['IsActive'] === true
          ? {
              code: 'LICENSE_LIMIT_EXCEEDED',
              message: 'License Limit Exceeded - Salesforce Platform',
            }
          : undefined,
    });
    const { outcome } = runOf(setup);
    const done = await outcome;
    if (done.kind !== 'applied') throw new Error('refused');

    expect(done.answer.status).toBe('partial');
    const paul = done.answer.users[1];
    expect(paul.refused).toEqual([
      {
        change: { what: 'active', from: false, to: true },
        code: 'LICENSE_LIMIT_EXCEEDED',
        message: 'License Limit Exceeded - Salesforce Platform',
      },
    ]);
    expect(paul.done).toEqual([
      { what: 'profile', from: 'Standard Platform User', to: 'QA Tester' },
      { what: 'permissionSetGroup', name: 'Support_Bundle', to: 'added' },
    ]);
    expect(done.record.users[1].after.isActive).toBe(false);
    expect(done.answer.users[0].done).toHaveLength(4);
  });
});

describe('what was there before the run', () => {
  it('never journals a membership the user held before as created, the org answering success for it', async () => {
    const setup = acmeSetup({
      memberships: [
        { id: '011000000000101AAA', groupId: ACME.groups.qaTeam, userId: ACME.users.jane },
      ],
    });
    const { org, outcome } = runOf(setup);
    const done = await outcome;
    if (done.kind !== 'applied') throw new Error('refused');

    expect(org.writes.some((write) => write.object === 'GroupMember')).toBe(false);
    expect(done.answer.users[0].created.groupMembers).toEqual([]);
    expect(done.answer.users[0].found?.groupMembers).toEqual(['011000000000101AAA']);
  });

  it('reads the memberships again right before it adds any: one that came meanwhile is found, not created', async () => {
    const late: { org?: UsersTestOrg } = {};
    const setup = acmeSetup({
      refuse: ({ object }) => {
        if (object === 'UserLogin' && late.org && late.org.memberships.length === 0) {
          late.org.memberships.push({
            id: '011000000000102AAA',
            groupId: ACME.groups.qaTeam,
            userId: ACME.users.jane,
          });
        }
        return undefined;
      },
    });
    late.org = usersTestOrg(setup);
    const { outcome } = runOf(late.org);
    const done = await outcome;
    if (done.kind !== 'applied') throw new Error('refused');

    expect(done.answer.users[0].created.groupMembers).toEqual([]);
    expect(done.answer.users[0].found?.groupMembers).toEqual(['011000000000102AAA']);
    expect(done.answer.users[0].done).not.toContainEqual(
      expect.objectContaining({ what: 'group' }),
    );
  });

  it('takes an assignment the org calls a duplicate as found there, never as refused', async () => {
    const late: { org?: UsersTestOrg } = {};
    const setup = acmeSetup({
      refuse: ({ object }) => {
        if (object === 'UserLogin' && late.org && late.org.assignments.length === 0) {
          late.org.assignments.push({
            id: '0Pa000000000102AAA',
            assigneeId: ACME.users.jane,
            permissionSetId: ACME.permissionSets.qaTools,
          });
        }
        return undefined;
      },
    });
    late.org = usersTestOrg(setup);
    const { outcome } = runOf(late.org);
    const done = await outcome;
    if (done.kind !== 'applied') throw new Error('refused');

    expect(done.answer.status).toBe('success');
    expect(done.answer.users[0].refused).toBeUndefined();
    expect(done.answer.users[0].created.permissionSetAssignments).toEqual([]);
    expect(done.answer.users[0].found?.permissionSetAssignments).toEqual(['0Pa000000000102AAA']);
  });
});

describe('the journal', () => {
  it('is written before the first write, with what each user was', async () => {
    const store = storeOf();
    let seen: string | undefined;
    const setup = acmeSetup({
      refuse: () => {
        seen ??= readFileSync(store.fileOf(ACME.organizationId, 1), 'utf8');
        return undefined;
      },
    });
    const { outcome } = runOf(setup, {}, store);
    await outcome;

    expect(JSON.parse(seen ?? '{}')).toMatchObject({
      run: 1,
      status: 'running',
      users: [
        { applied: { userId: ACME.users.jane, before: { isFrozen: true }, done: [] } },
        { applied: { userId: ACME.users.paul, before: { isActive: false } } },
        { applied: { userId: ACME.users.erp } },
      ],
    });
  });

  it('holds ids and usernames, never an address nor a person’s name', async () => {
    const store = storeOf();
    const { outcome } = runOf(acmeSetup(), {}, store);
    await outcome;

    const text = readFileSync(store.fileOf(ACME.organizationId, 1), 'utf8');
    expect(text).toContain(ACME.users.jane);
    expect(text).toContain('jane.qa@acme.com.uat');
    expect(text).not.toContain('.invalid');
    expect(text).not.toContain('"jane.qa@acme.com"');
    expect(text).not.toMatch(/Jane Tester|Paul Tester|Erp Integration/);
  });

  it('ends cancelled after the step a stop came in, and sends nothing more', async () => {
    const stop = new AbortController();
    const setup = acmeSetup({
      refuse: ({ object }) => {
        if (object === 'UserLogin') stop.abort();
        return undefined;
      },
    });
    const { org, outcome, store } = runOf(setup, { signal: stop.signal });
    const done = await outcome;

    expect(done).toMatchObject({ kind: 'applied', answer: { status: 'cancelled' } });
    expect(org.writes.map((write) => write.object)).toEqual(['User', 'User', 'UserLogin']);
    expect((await store.read(ACME.organizationId, 1))?.status).toBe('cancelled');
    expect(existsSync(store.fileOf(ACME.organizationId, 1))).toBe(true);
  });
});

describe('a run that replaces another', () => {
  it('holds what the run it replaces created and still names, and takes back the rest', async () => {
    const store = storeOf();
    const first = runOf(acmeSetup(), {}, store);
    const one = await first.outcome;
    if (one.kind !== 'applied') throw new Error('refused');
    const janeAssignment = one.answer.users[0].created.permissionSetAssignments[0];
    const janeMembership = one.answer.users[0].created.groupMembers[0];

    const replaced = await store.read(ACME.organizationId, 1);
    const second = runOf(
      first.org,
      {
        users: [{ username: 'jane.qa@acme.com', frozen: false, permissionSets: ['QA_Tools'] }],
        ...(replaced ? { previous: replaced } : {}),
      },
      store,
    );
    const two = await second.outcome;
    if (two.kind !== 'applied') throw new Error('refused');

    expect(two.record.replaces).toBe(1);
    expect(two.answer.users.map((user) => [user.username, user.done])).toEqual([
      [
        'jane.qa@acme.com.uat',
        [{ what: 'group', name: 'QA_Team', type: 'Regular', to: 'removed' }],
      ],
      [
        'paul.qa@acme.com.uat',
        [
          { what: 'profile', from: 'QA Tester', to: 'Standard Platform User' },
          { what: 'active', from: true, to: false },
          { what: 'permissionSetGroup', name: 'Support_Bundle', to: 'removed' },
        ],
      ],
      ['erp.integration@acme.com.uat', [{ what: 'frozen', from: true, to: false }]],
    ]);
    expect(two.answer.users[0].created.permissionSetAssignments).toEqual([janeAssignment]);
    expect(first.org.memberships.some((m) => m.id === janeMembership)).toBe(false);
    // A user put back as it was holds nothing more: the run keeps only jane.
    expect(two.record.users.map((user) => user.applied.username)).toEqual(['jane.qa@acme.com.uat']);
  });
});
