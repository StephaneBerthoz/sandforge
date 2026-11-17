import { describe, expect, it } from 'vitest';
import { usersPlanAnswerSchema, type UsersConfigUser } from '@sandforge/shared';

import {
  ACME,
  acmeSetup,
  usersTestOrg,
  type TestUser,
  type UsersTestOrgSetup,
} from './usersOrg.fixtures.js';
import { usersOrgOf } from './usersOrg.js';
import {
  planUsers,
  usersPlanAnswerOf,
  usersRunRequestsOf,
  type UsersPlanOptions,
} from './usersPlan.js';
import { readUsersState } from './usersResolve.js';
import type { UsersRunRecord } from './usersRunStore.js';

/*
 * What a run of `sandforge users` would change, user by user, in the order
 * it writes — profile, activation, freeze, permission sets and their
 * groups, groups and queues, the address last —, and what refuses it before
 * its first write. Nothing the file does not name is ever taken away.
 */

const NOW = new Date('2026-11-20T08:14:00.000Z');

const ORG = {
  organizationId: ACME.organizationId,
  kind: 'sandbox' as const,
  alias: 'uat',
  username: 'admin@acme.com.uat',
};

async function planOf(
  users: UsersConfigUser[],
  setup: UsersTestOrgSetup = acmeSetup(),
  options: UsersPlanOptions = {},
) {
  const org = usersTestOrg(setup);
  const port = usersOrgOf(org.connection);
  const state = await readUsersState(port, users, {
    now: NOW,
    ...(options.previous ? { previous: options.previous } : {}),
  });
  const plan = planUsers(state, users, options);
  const answer = usersPlanAnswerOf(plan, ORG, port.requests());
  return { org, state, plan, answer };
}

function codes(plan: { refusals: Array<{ code: string }> }): string[] {
  return plan.refusals.map((refusal) => refusal.code);
}

describe('what a run would change', () => {
  it('says a user already as the file says has nothing to do', async () => {
    const { answer } = await planOf([
      { username: 'admin@acme.com.uat', active: true, frozen: false },
    ]);

    expect(answer.users).toEqual([
      { username: 'admin@acme.com.uat', userId: ACME.users.admin, changes: [] },
    ]);
    expect(answer.emailsToPeople).toBe(0);
    expect(answer.refusals).toBeUndefined();
  });

  it('adds what the file names and never takes away what it does not', async () => {
    const setup = acmeSetup({
      assignments: [
        {
          id: '0Pa000000000101AAA',
          assigneeId: ACME.users.jane,
          permissionSetId: ACME.permissionSets.reports,
        },
      ],
      memberships: [
        { id: '011000000000101AAA', groupId: ACME.groups.qaQueue, userId: ACME.users.jane },
      ],
    });
    const { answer, plan } = await planOf(
      [{ username: 'jane.qa@acme.com', permissionSets: ['QA_Tools'], groups: ['QA_Team'] }],
      setup,
    );

    expect(answer.users[0]).toEqual({
      username: 'jane.qa@acme.com.uat',
      given: 'jane.qa@acme.com',
      userId: ACME.users.jane,
      changes: [
        { what: 'permissionSet', name: 'QA_Tools', to: 'added' },
        { what: 'group', name: 'QA_Team', type: 'Regular', to: 'added' },
      ],
    });
    expect(plan.users[0].writes.unassign).toEqual([]);
    expect(plan.users[0].writes.leave).toEqual([]);
  });

  it('keeps an access the user holds already as found, never to create again', async () => {
    const setup = acmeSetup({
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
    });
    const { answer, plan } = await planOf(
      [{ username: 'jane.qa@acme.com.uat', permissionSets: ['QA_Tools'], groups: ['QA_Team'] }],
      setup,
    );

    expect(answer.users[0].changes).toEqual([]);
    expect(plan.users[0].found).toEqual({
      permissionSetAssignments: ['0Pa000000000101AAA'],
      groupMembers: ['011000000000101AAA'],
    });
  });

  it('lists the changes in the order a run writes them, the address last', async () => {
    const { answer } = await planOf([
      {
        username: 'paul.qa@acme.com',
        email: 'restore',
        active: true,
        frozen: true,
        profile: 'QA Tester',
        permissionSets: ['QA_Tools'],
        permissionSetGroups: ['Support_Bundle'],
        groups: ['QA_Queue'],
      },
    ]);

    expect(answer.users[0].changes).toEqual([
      { what: 'profile', from: 'Standard Platform User', to: 'QA Tester' },
      { what: 'active', from: false, to: true },
      { what: 'frozen', from: false, to: true },
      { what: 'permissionSet', name: 'QA_Tools', to: 'added' },
      { what: 'permissionSetGroup', name: 'Support_Bundle', to: 'added' },
      { what: 'group', name: 'QA_Queue', type: 'Queue', to: 'added' },
      { what: 'email', to: 'awaiting' },
    ]);
  });
});

describe('the address', () => {
  it('asks an address under .invalid back, which awaits its owner: one email to a person', async () => {
    const { answer } = await planOf([{ username: 'jane.qa@acme.com', email: 'restore' }]);

    expect(answer.users[0]).toMatchObject({
      address: 'invalid',
      changes: [{ what: 'email', to: 'awaiting' }],
      emailsToPeople: 1,
    });
    expect(answer.emailsToPeople).toBe(1);
  });

  it('asks nothing again of an address already awaiting its owner’s click', async () => {
    const setup = acmeSetup({
      auditTrail: [
        {
          action: 'useremailchangesent',
          display:
            `Email change attempted for user Jane Tester (UserID: [${ACME.users.jane.slice(0, 15)}]) ` +
            'from jane.qa@acme.com.invalid to jane.qa@acme.com',
          createdDate: '2026-11-19T10:00:00.000Z',
        },
      ],
    });
    const { answer } = await planOf([{ username: 'jane.qa@acme.com', email: 'restore' }], setup);

    expect(answer.users[0]).toMatchObject({ address: 'awaiting', changes: [] });
    expect(answer.emailsToPeople).toBe(0);
  });

  it('reads an address without .invalid as restored, and keep as kept', async () => {
    const { answer } = await planOf([
      { username: 'admin@acme.com.uat', email: 'restore' },
      { username: 'erp.integration@acme.com', email: 'keep' },
    ]);

    expect(answer.users.map((user) => [user.address, user.changes])).toEqual([
      ['restored', []],
      ['kept', []],
    ]);
  });

  it('carries no address and no person’s name in what it answers', async () => {
    const { answer } = await planOf([
      { username: 'jane.qa@acme.com', email: 'restore', frozen: false },
    ]);

    const text = JSON.stringify(answer);
    expect(text).not.toContain('.invalid');
    expect(text).not.toContain('Jane Tester');
    expect(usersPlanAnswerSchema.parse(answer)).toEqual(answer);
  });
});

describe('what refuses a run before its first write', () => {
  it('refuses a username no user has, and one two users have, with the way out', async () => {
    const extra: TestUser = {
      id: '005000000000023AAA',
      username: 'jane.qa@acme.com.au.uat',
      email: 'x@acme.com.invalid',
      isActive: true,
      profileId: ACME.profiles.platform,
    };
    const { plan, answer } = await planOf(
      [{ username: 'nobody@acme.com' }, { username: 'jane.qa@acme.com' }],
      acmeSetup({ users: [...acmeSetup().users, extra] }),
    );

    expect(plan.refusals).toEqual([
      {
        code: 'USERS_NO_USER',
        username: 'nobody@acme.com',
        message:
          'nobody@acme.com: no user has this username, nor this username followed by .<sandbox>: ' +
          'check the username, as Setup > Users gives it, or take it out of the file',
      },
      {
        code: 'USERS_TWO_USERS',
        username: 'jane.qa@acme.com',
        message:
          'jane.qa@acme.com names 2 users: write the sandbox’s username in full: ' +
          'jane.qa@acme.com.au.uat or jane.qa@acme.com.uat',
      },
    ]);
    expect(answer.users.map((user) => [user.username, user.userId])).toEqual([
      ['nobody@acme.com', undefined],
      ['jane.qa@acme.com', undefined],
    ]);
  });

  it('refuses when the connection may not manage users, or the org would not say', async () => {
    const no = await planOf(
      [{ username: 'jane.qa@acme.com.uat' }],
      acmeSetup({ manageUsers: false }),
    );
    const unread = await planOf(
      [{ username: 'jane.qa@acme.com.uat' }],
      acmeSetup({ manageUsers: 'unreadable' }),
    );

    expect(no.plan.refusals).toEqual([
      {
        code: 'USERS_NO_RIGHT',
        message:
          'admin@acme.com.uat cannot manage users here (Manage Users): give it Manage Users, or ' +
          'connect as a user who has it',
      },
    ]);
    expect(codes(unread.plan)).toEqual(['USERS_NO_RIGHT']);
    expect(unread.plan.refusals[0].message).toContain('the org would not say');
  });

  it('refuses to freeze, deactivate or change the profile of the user connected', async () => {
    const { plan } = await planOf([
      { username: 'admin@acme.com.uat', frozen: true, active: false, profile: 'Standard User' },
    ]);

    expect(plan.refusals).toEqual([
      {
        code: 'USERS_SELF',
        username: 'admin@acme.com.uat',
        message:
          'admin@acme.com.uat is the user connected, and the file would change its profile, ' +
          'deactivate it and freeze it: SandForge would lock itself out: take admin@acme.com.uat ' +
          'out of the file, or connect as another',
      },
    ]);
  });

  it('lets the file name the user connected as it is already', async () => {
    const { plan } = await planOf([
      {
        username: 'admin@acme.com.uat',
        frozen: false,
        active: true,
        profile: 'System Administrator',
      },
    ]);

    expect(plan.refusals).toEqual([]);
  });

  it('refuses production’s username and the sandbox’s both given for one user', async () => {
    const { plan, answer } = await planOf([
      { username: 'jane.qa@acme.com', frozen: false },
      { username: 'jane.qa@acme.com.uat', frozen: true },
    ]);

    expect(plan.refusals).toEqual([
      {
        code: 'USERS_SAME_USER',
        username: 'jane.qa@acme.com.uat',
        message:
          'jane.qa@acme.com.uat and jane.qa@acme.com name one user, jane.qa@acme.com.uat: one ' +
          'entry per user',
      },
    ]);
    expect(answer.users[1]).toEqual({ username: 'jane.qa@acme.com.uat', changes: [] });
  });

  it('refuses to freeze a user the org keeps no login of', async () => {
    const setup = acmeSetup();
    const { plan } = await planOf([{ username: 'erp.integration@acme.com', frozen: true }], {
      ...setup,
      users: setup.users.map((user) =>
        user.id === ACME.users.erp ? { ...user, loginId: null } : user,
      ),
    });

    expect(plan.refusals).toEqual([
      {
        code: 'USERS_NO_LOGIN',
        username: 'erp.integration@acme.com',
        message:
          'erp.integration@acme.com.uat: the org keeps no login of this user (UserLogin), which a ' +
          'freeze writes: take frozen off erp.integration@acme.com.uat',
      },
    ]);
  });

  it('refuses a profile no profile is named, listing the org’s own names, its language’s', async () => {
    const setup = acmeSetup({
      profiles: [
        {
          id: ACME.profiles.admin,
          name: 'Administrateur système',
          licenseId: ACME.licenses.salesforce,
        },
        {
          id: ACME.profiles.standard,
          name: 'Utilisateur standard',
          licenseId: ACME.licenses.salesforce,
        },
        {
          id: ACME.profiles.platform,
          name: 'Standard Platform User',
          licenseId: ACME.licenses.platform,
        },
      ],
    });
    const { plan } = await planOf(
      [{ username: 'jane.qa@acme.com', profile: 'System Administrator' }],
      setup,
    );

    expect(plan.refusals).toEqual([
      {
        code: 'USERS_PROFILE_UNKNOWN',
        username: 'jane.qa@acme.com',
        message:
          'profile System Administrator: no profile has this name: profiles are named as ' +
          'Setup > Profiles names them, in the org’s language: Administrateur système, ' +
          'Standard Platform User, Utilisateur standard',
      },
    ]);
  });

  it('takes a profile by its exact name only, never by its case', async () => {
    const { plan } = await planOf([{ username: 'jane.qa@acme.com', profile: 'qa tester' }]);

    expect(codes(plan)).toEqual(['USERS_PROFILE_UNKNOWN']);
    expect(plan.refusals[0].message).toContain('QA Tester');
  });

  it('refuses a permission set, a group of them or a group the org does not hold, by API name', async () => {
    const { plan } = await planOf([
      {
        username: 'jane.qa@acme.com',
        permissionSets: ['QA_Tool'],
        permissionSetGroups: ['Support'],
        groups: ['QA_Teams'],
      },
    ]);

    expect(plan.refusals).toEqual([
      {
        code: 'USERS_PERMISSION_SET_UNKNOWN',
        username: 'jane.qa@acme.com',
        message:
          'permission set QA_Tool: no permission set has this API name: names are API names ' +
          '(Setup > Permission Sets > API Name); close: QA_Tools',
      },
      {
        code: 'USERS_PERMISSION_SET_UNKNOWN',
        username: 'jane.qa@acme.com',
        message:
          'permission set group Support: no permission set group has this API name: names are API ' +
          'names (Setup > Permission Set Groups > API Name); close: Support_Bundle',
      },
      {
        code: 'USERS_GROUP_UNKNOWN',
        username: 'jane.qa@acme.com',
        message:
          'group QA_Teams: no public group or queue has this API name (DeveloperName); close: QA_Team',
      },
    ]);
  });

  it('refuses a permission set whose license the user will not have', async () => {
    const setup = acmeSetup({
      permissionSets: [
        { id: ACME.permissionSets.qaTools, name: 'QA_Tools', licenseId: ACME.licenses.salesforce },
        {
          id: ACME.permissionSets.reports,
          name: 'Report_Builder',
          licenseId: '0PL000000000001AAA',
        },
      ],
    });
    const refused = await planOf(
      [{ username: 'jane.qa@acme.com', permissionSets: ['QA_Tools', 'Report_Builder'] }],
      setup,
    );
    const moved = await planOf(
      [{ username: 'jane.qa@acme.com', profile: 'Standard User', permissionSets: ['QA_Tools'] }],
      setup,
    );
    const licensed = await planOf(
      [{ username: 'jane.qa@acme.com', permissionSets: ['Report_Builder'] }],
      {
        ...setup,
        licenseAssignments: [
          { assigneeId: ACME.users.jane, permissionSetLicenseId: '0PL000000000001AAA' },
        ],
      },
    );

    expect(refused.plan.refusals).toEqual([
      {
        code: 'USERS_PERMISSION_SET_LICENSE',
        username: 'jane.qa@acme.com',
        message:
          'jane.qa@acme.com.uat: permission set QA_Tools needs the license Salesforce, which this ' +
          'user will not have: assign the permission set license first, in Setup, or take the set out',
      },
      {
        code: 'USERS_PERMISSION_SET_LICENSE',
        username: 'jane.qa@acme.com',
        message:
          'jane.qa@acme.com.uat: permission set Report_Builder needs a permission set license this ' +
          'user does not hold: assign the permission set license first, in Setup, or take the set out',
      },
    ]);
    expect(moved.plan.refusals).toEqual([]);
    expect(licensed.plan.refusals).toEqual([]);
  });
});

describe('the licenses, counted on the whole plan', () => {
  const inactive = (n: number): TestUser => ({
    id: `005000000000${String(30 + n).padStart(3, '0')}AAA`,
    username: `extra${n}@acme.com.uat`,
    email: `extra${n}@acme.com.invalid`,
    isActive: false,
    profileId: ACME.profiles.platform,
  });

  it('says what an activation takes of its license', async () => {
    const { answer } = await planOf([{ username: 'paul.qa@acme.com', active: true }]);

    expect(answer.licenses).toEqual([{ name: 'Salesforce Platform', total: 3, used: 2, toUse: 1 }]);
    expect(answer.refusals).toBeUndefined();
  });

  it('refuses two activations where one license is left, naming each way out', async () => {
    const { plan } = await planOf(
      [
        { username: 'paul.qa@acme.com', active: true },
        { username: 'extra1@acme.com', active: true },
      ],
      acmeSetup({ users: [...acmeSetup().users, inactive(1)] }),
    );

    expect(plan.refusals).toEqual([
      {
        code: 'USERS_LICENSE',
        message:
          'Salesforce Platform: 2 of 3 used, and the file takes 2 more: deactivate a user who no ' +
          'longer needs it, or take active: true off paul.qa@acme.com.uat or extra1@acme.com.uat',
      },
    ]);
  });

  it('counts the license a deactivation of the same file gives back', async () => {
    const { plan, answer } = await planOf(
      [
        { username: 'paul.qa@acme.com', active: true },
        { username: 'extra1@acme.com', active: true },
        { username: 'erp.integration@acme.com', active: false },
      ],
      acmeSetup({ users: [...acmeSetup().users, inactive(1)] }),
    );

    expect(plan.refusals).toEqual([]);
    expect(answer.licenses).toEqual([{ name: 'Salesforce Platform', total: 3, used: 2, toUse: 1 }]);
  });

  it('counts a profile of another license given to an active user', async () => {
    const full = acmeSetup({
      licenses: [
        { id: ACME.licenses.salesforce, name: 'Salesforce', total: 2, outside: 1 },
        { id: ACME.licenses.platform, name: 'Salesforce Platform', total: 3 },
      ],
    });
    const { plan } = await planOf(
      [{ username: 'jane.qa@acme.com', profile: 'Standard User' }],
      full,
    );

    expect(plan.refusals).toEqual([
      {
        code: 'USERS_LICENSE',
        message:
          'Salesforce: 2 of 2 used, and the file takes 1 more: deactivate a user who no longer ' +
          'needs it, or take profile: Standard User off jane.qa@acme.com.uat',
      },
    ]);
  });

  it('takes no license for the profile of an inactive user', async () => {
    const full = acmeSetup({
      licenses: [
        { id: ACME.licenses.salesforce, name: 'Salesforce', total: 2, outside: 1 },
        { id: ACME.licenses.platform, name: 'Salesforce Platform', total: 3 },
      ],
    });
    const { plan } = await planOf(
      [{ username: 'paul.qa@acme.com', profile: 'Standard User' }],
      full,
    );

    expect(plan.refusals).toEqual([]);
  });
});

describe('the emails to people', () => {
  it('refuses an address asked back unless the line accepts the email it sends', async () => {
    const refused = await planOf(
      [{ username: 'jane.qa@acme.com', email: 'restore' }],
      acmeSetup(),
      {
        acceptUserEmails: false,
      },
    );
    const accepted = await planOf(
      [{ username: 'jane.qa@acme.com', email: 'restore' }],
      acmeSetup(),
      {
        acceptUserEmails: true,
      },
    );

    expect(refused.plan.refusals).toEqual([
      {
        code: 'USERS_EMAILS_NOT_ACCEPTED',
        message:
          'Salesforce would email 1 person: the confirmation of each address asked back, a system ' +
          'email, which only the line accepts: --accept-user-emails, once those people may receive them',
      },
    ]);
    expect(accepted.plan.refusals).toEqual([]);
  });

  it('refuses an address asked back in an org that delivers all email, until the line accepts it', async () => {
    const open = await planOf([{ username: 'jane.qa@acme.com', email: 'restore' }], acmeSetup(), {
      acceptUserEmails: true,
      deliverability: 'open',
    });
    const accepted = await planOf(
      [{ username: 'jane.qa@acme.com', email: 'restore' }],
      acmeSetup(),
      {
        acceptUserEmails: true,
        deliverability: 'open',
        acceptEmails: true,
      },
    );

    expect(open.plan.refusals).toEqual([
      {
        code: 'USERS_EMAILS_OPEN',
        message:
          'the org delivers all email, and 1 address would be asked back before the masking is ' +
          'done: set Setup > Deliverability to System email only until the masking is done, or ' +
          'accept with --accept-emails that what runs there emails these people',
      },
    ]);
    expect(accepted.plan.refusals).toEqual([]);
  });
});

describe('the requests', () => {
  it('counts the reads made and the writes and reads a run would add', async () => {
    const { plan, answer, org } = await planOf([
      {
        username: 'jane.qa@acme.com',
        frozen: false,
        permissionSets: ['QA_Tools'],
        email: 'restore',
      },
    ]);

    // Reads: identity, rights, users as given, users by prefix, logins, permission sets,
    // assignments, audit trail. A run adds: a freeze, an assignment, an address, and its
    // read after of users and logins.
    expect(org.queries.length + 1).toBe(8);
    expect(usersRunRequestsOf(plan)).toBe(5);
    expect(answer.apiRequests).toBe(13);
  });
});

describe('a run that replaces another', () => {
  function previousOf(over: Partial<UsersRunRecord['users'][number]> = {}): UsersRunRecord {
    return {
      version: 1,
      organizationId: ACME.organizationId,
      run: 1,
      status: 'success',
      startedAt: '2026-11-19T08:00:00.000Z',
      endedAt: '2026-11-19T08:01:00.000Z',
      emailsToPeople: 0,
      users: [
        {
          applied: {
            username: 'jane.qa@acme.com.uat',
            userId: ACME.users.jane,
            before: { isActive: true, isFrozen: true, profileId: ACME.profiles.platform },
            done: [
              { what: 'frozen', from: true, to: false },
              { what: 'permissionSet', name: 'QA_Tools', to: 'added' },
            ],
            created: { permissionSetAssignments: ['0Pa000000000201AAA'], groupMembers: [] },
          },
          after: { isActive: true, isFrozen: false, profileId: ACME.profiles.platform },
          accesses: [{ id: '0Pa000000000201AAA', what: 'permissionSet', name: 'QA_Tools' }],
          inFile: true,
          ...over,
        },
        {
          applied: {
            username: 'paul.qa@acme.com.uat',
            userId: ACME.users.paul,
            before: { isActive: false, isFrozen: false, profileId: ACME.profiles.platform },
            done: [{ what: 'active', from: false, to: true }],
            created: { permissionSetAssignments: [], groupMembers: ['011000000000201AAA'] },
          },
          after: { isActive: true, isFrozen: false, profileId: ACME.profiles.platform },
          accesses: [{ id: '011000000000201AAA', what: 'group', name: 'QA_Team', type: 'Regular' }],
          inFile: true,
        },
      ],
    };
  }

  /** The org as the previous run left it: jane unfrozen with QA_Tools, paul active in QA_Team. */
  function leftByPrevious(): UsersTestOrgSetup {
    const setup = acmeSetup();
    return {
      ...setup,
      users: setup.users.map((user) =>
        user.id === ACME.users.jane
          ? { ...user, frozen: false }
          : user.id === ACME.users.paul
            ? { ...user, isActive: true }
            : user,
      ),
      assignments: [
        {
          id: '0Pa000000000201AAA',
          assigneeId: ACME.users.jane,
          permissionSetId: ACME.permissionSets.qaTools,
        },
      ],
      memberships: [
        { id: '011000000000201AAA', groupId: ACME.groups.qaTeam, userId: ACME.users.paul },
      ],
    };
  }

  it('changes nothing when the file and the org are as the run replaced left them', async () => {
    const { answer } = await planOf(
      [
        { username: 'jane.qa@acme.com', frozen: false, permissionSets: ['QA_Tools'] },
        { username: 'paul.qa@acme.com', active: true, groups: ['QA_Team'] },
      ],
      leftByPrevious(),
      { previous: previousOf() },
    );

    expect(answer.users.map((user) => user.changes)).toEqual([[], []]);
  });

  it('takes back what the file no longer names, and puts back as it was a user taken out of it', async () => {
    const { answer, plan } = await planOf(
      [{ username: 'jane.qa@acme.com', groups: ['QA_Team'] }],
      leftByPrevious(),
      { previous: previousOf() },
    );

    expect(answer.users).toEqual([
      {
        username: 'jane.qa@acme.com.uat',
        given: 'jane.qa@acme.com',
        userId: ACME.users.jane,
        changes: [
          { what: 'frozen', from: false, to: true },
          { what: 'permissionSet', name: 'QA_Tools', to: 'removed' },
          { what: 'group', name: 'QA_Team', type: 'Regular', to: 'added' },
        ],
      },
      {
        username: 'paul.qa@acme.com.uat',
        userId: ACME.users.paul,
        changes: [
          { what: 'active', from: true, to: false },
          { what: 'group', name: 'QA_Team', type: 'Regular', to: 'removed' },
        ],
      },
    ]);
    expect(plan.users[0].before).toEqual({
      isActive: true,
      isFrozen: true,
      profileId: ACME.profiles.platform,
    });
  });

  it('never takes back what someone changed since the run it replaces', async () => {
    const setup = leftByPrevious();
    const refrozen = {
      ...setup,
      users: setup.users.map((user) =>
        user.id === ACME.users.jane ? { ...user, frozen: true } : user,
      ),
      assignments: [],
    };
    const { answer } = await planOf([{ username: 'jane.qa@acme.com' }], refrozen, {
      previous: previousOf(),
    });

    expect(answer.users[0].changes).toEqual([]);
  });

  it('adds again what the file names and someone took away since', async () => {
    const setup = leftByPrevious();
    const { answer } = await planOf(
      [
        { username: 'jane.qa@acme.com', frozen: false, permissionSets: ['QA_Tools'] },
        { username: 'paul.qa@acme.com', active: true, groups: ['QA_Team'] },
      ],
      { ...setup, assignments: [] },
      { previous: previousOf() },
    );

    expect(answer.users[0].changes).toEqual([
      { what: 'permissionSet', name: 'QA_Tools', to: 'added' },
    ]);
  });
});
