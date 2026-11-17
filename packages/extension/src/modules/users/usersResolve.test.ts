import { describe, expect, it } from 'vitest';
import type { UsersConfigUser } from '@sandforge/shared';

import { ACME, acmeSetup, usersTestOrg, type TestUser } from './usersOrg.fixtures.js';
import { usersOrgOf } from './usersOrg.js';
import { ADDRESS_LINK_HOURS, addressRestoredOf, readUsersState } from './usersResolve.js';

/*
 * What `sandforge users` reads of an org before it plans: each username of
 * the file resolved without guessing — as given, then as given followed by a
 * dot and the sandbox's name, exactly one user —, then the logins, the
 * profiles, the licenses, the permission sets, the groups and the accesses
 * of those users, and the address changes already asked.
 */

const NOW = new Date('2026-11-20T08:14:00.000Z');

function userOf(id: string, username: string, over: Partial<TestUser> = {}): TestUser {
  return {
    id,
    username,
    email: `${username.replace(/\.uat$/, '')}.invalid`,
    isActive: true,
    profileId: ACME.profiles.platform,
    ...over,
  };
}

async function read(users: UsersConfigUser[], extra: TestUser[] = [], now = NOW) {
  const org = usersTestOrg(acmeSetup({ users: [...acmeSetup().users, ...extra] }));
  const port = usersOrgOf(org.connection);
  const state = await readUsersState(port, users, { now });
  return { org, port, state };
}

describe('the usernames', () => {
  it('takes a username the org holds as given, in one read', async () => {
    const { org, state } = await read([{ username: 'jane.qa@acme.com.uat' }]);

    expect(state.resolutions).toEqual([
      expect.objectContaining({
        given: 'jane.qa@acme.com.uat',
        kind: 'found',
        user: expect.objectContaining({ id: ACME.users.jane, username: 'jane.qa@acme.com.uat' }),
      }),
    ]);
    expect(org.queries.filter((q) => q.includes('FROM User '))).toHaveLength(1);
  });

  it('takes production’s username as the one sandbox user it names, followed by a dot', async () => {
    const { org, state } = await read([{ username: 'jane.qa@acme.com' }]);

    expect(state.resolutions[0]).toMatchObject({
      kind: 'found',
      user: { id: ACME.users.jane, username: 'jane.qa@acme.com.uat' },
    });
    expect(org.queries.some((q) => q.includes("LIKE 'jane.qa@acme.com.%'"))).toBe(true);
  });

  it('keeps ada@example.co.uk whole: never the user ada@example.co, always ada@example.co.uk.uat', async () => {
    const extra = [
      userOf('005000000000021AAA', 'ada@example.co'),
      userOf('005000000000022AAA', 'ada@example.co.uk.uat'),
    ];
    const { state } = await read(
      [{ username: 'ada@example.co.uk' }, { username: 'ada@example.co.uk.uat' }],
      extra,
    );

    expect(state.resolutions.map((r) => (r.kind === 'found' ? r.user.id : r.kind))).toEqual([
      '005000000000022AAA',
      '005000000000022AAA',
    ]);
  });

  it('finds nobody for a username whose sandbox form is not there, however close another is', async () => {
    const { state } = await read(
      [{ username: 'ada@example.co.uk' }],
      [userOf('005000000000021AAA', 'ada@example.co')],
    );

    expect(state.resolutions).toEqual([{ given: 'ada@example.co.uk', kind: 'none' }]);
  });

  it('names both users a production username matches, rather than picking one', async () => {
    const { state } = await read(
      [{ username: 'jane.qa@acme.com' }],
      [userOf('005000000000023AAA', 'jane.qa@acme.com.au.uat')],
    );

    expect(state.resolutions).toEqual([
      {
        given: 'jane.qa@acme.com',
        kind: 'two',
        usernames: ['jane.qa@acme.com.au.uat', 'jane.qa@acme.com.uat'],
      },
    ]);
  });

  it('reads an underscore of the username as itself, not as any character', async () => {
    const { state } = await read(
      [{ username: 'jane_qa@acme.com' }],
      [userOf('005000000000024AAA', 'janeXqa@acme.com.uat')],
    );

    expect(state.resolutions[0].kind).toBe('none');
  });

  it('reads a username whatever its case, as Salesforce does', async () => {
    const { state } = await read([{ username: 'Jane.QA@ACME.com' }]);

    expect(state.resolutions[0]).toMatchObject({ kind: 'found', user: { id: ACME.users.jane } });
  });

  it('reads 120 usernames in parts the org takes: 50 a read as given, 20 a read of prefixes', async () => {
    const extra = Array.from({ length: 120 }, (_, at) =>
      userOf(`005${String(1000 + at).padStart(12, '0')}AAA`, `t${at}@acme.com.uat`),
    );
    const { org, state } = await read(
      extra.map((user) => ({ username: user.username.replace(/\.uat$/, '') })),
      extra,
    );

    expect(state.resolutions.every((r) => r.kind === 'found')).toBe(true);
    const userReads = org.queries.filter((q) => q.includes('FROM User '));
    expect(userReads.filter((q) => q.includes(' IN ('))).toHaveLength(3);
    expect(userReads.filter((q) => q.includes(' LIKE '))).toHaveLength(6);
  });
});

describe('what the plan reads beside the users', () => {
  it('reads each user’s login, profile, license and accesses, through columns the org has', async () => {
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
    const org = usersTestOrg(setup);
    const state = await readUsersState(
      usersOrgOf(org.connection),
      [
        {
          username: 'jane.qa@acme.com',
          profile: 'QA Tester',
          active: true,
          frozen: false,
          permissionSets: ['QA_Tools'],
          permissionSetGroups: ['Support_Bundle'],
          groups: ['QA_Team', 'QA_Queue'],
        },
      ],
      { now: NOW },
    );

    expect(state.connected).toEqual({
      userId: ACME.users.admin,
      organizationId: ACME.organizationId,
      username: 'admin@acme.com.uat',
    });
    expect(state.manageUsers).toBe(true);
    expect(state.logins).toEqual([
      { id: ACME.logins.jane, userId: ACME.users.jane, isFrozen: true },
    ]);
    expect(state.profiles?.map((p) => p.name)).toContain('QA Tester');
    expect(state.licenses).toEqual(
      expect.arrayContaining([
        { id: ACME.licenses.platform, name: 'Salesforce Platform', total: 3, used: 2 },
      ]),
    );
    expect(state.permissionSets.map((s) => s.name)).toEqual(['QA_Tools']);
    expect(state.permissionSetGroups.map((g) => g.name)).toEqual(['Support_Bundle']);
    expect(state.groups.map((g) => [g.name, g.type])).toEqual([
      ['QA_Team', 'Regular'],
      ['QA_Queue', 'Queue'],
    ]);
    expect(state.assignments.map((a) => a.id)).toEqual(['0Pa000000000101AAA']);
    expect(state.memberships.map((m) => m.id)).toEqual(['011000000000101AAA']);
    expect(state.requests).toBe(org.queries.length + 1);
  });

  it('reads nothing of permission sets, groups or licenses the file does not name', async () => {
    const { org } = await read([{ username: 'jane.qa@acme.com.uat', frozen: false }]);

    expect(
      org.queries.some((q) => /FROM (PermissionSet|Group|UserLicense|Profile)\b/.test(q)),
    ).toBe(false);
  });

  it('says the org would not say whether the connection may manage users', async () => {
    const org = usersTestOrg(acmeSetup({ manageUsers: 'unreadable' }));
    const state = await readUsersState(
      usersOrgOf(org.connection),
      [{ username: 'jane.qa@acme.com.uat' }],
      {
        now: NOW,
      },
    );

    expect(state.manageUsers).toBeUndefined();
  });

  it('reads that the connection may not manage users', async () => {
    const org = usersTestOrg(acmeSetup({ manageUsers: false }));
    const state = await readUsersState(
      usersOrgOf(org.connection),
      [{ username: 'jane.qa@acme.com.uat' }],
      {
        now: NOW,
      },
    );

    expect(state.manageUsers).toBe(false);
  });
});

describe('the address asked back', () => {
  function trailLine(userId: string, to: string, hoursAgo: number) {
    return {
      action: 'useremailchangesent',
      display:
        `Email change attempted for user Jane Tester (UserID: [${userId.slice(0, 15)}]) from ` +
        `${to}.invalid to ${to}`,
      createdDate: new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString(),
    };
  }

  async function readWith(auditTrail: ReturnType<typeof trailLine>[]) {
    const org = usersTestOrg(acmeSetup({ auditTrail }));
    return readUsersState(
      usersOrgOf(org.connection),
      [{ username: 'jane.qa@acme.com.uat', email: 'restore' }],
      { now: NOW },
    );
  }

  it('reads an address whose change was asked within the link’s 72 hours as awaiting its owner', async () => {
    const state = await readWith([trailLine(ACME.users.jane, 'jane.qa@acme.com', 30)]);

    expect(ADDRESS_LINK_HOURS).toBe(72);
    expect(state.addressesAsked).toEqual([ACME.users.jane.slice(0, 15)]);
  });

  it('reads an address asked longer ago than the link lasts as never asked', async () => {
    const state = await readWith([trailLine(ACME.users.jane, 'jane.qa@acme.com', 80)]);

    expect(state.addressesAsked).toEqual([]);
  });

  it('reads an address asked for another address, or for another user, as never asked', async () => {
    const state = await readWith([
      trailLine(ACME.users.jane, 'someone.else@acme.com', 2),
      trailLine(ACME.users.paul, 'jane.qa@acme.com', 2),
    ]);

    expect(state.addressesAsked).toEqual([]);
  });

  it('reads no audit trail when no address of the file is under .invalid', async () => {
    const org = usersTestOrg(acmeSetup());
    await readUsersState(
      usersOrgOf(org.connection),
      [{ username: 'admin@acme.com.uat', email: 'restore' }],
      { now: NOW },
    );

    expect(org.queries.some((q) => q.includes('SetupAuditTrail'))).toBe(false);
  });

  it('takes the copy’s .invalid off an address, and nothing else', () => {
    expect(addressRestoredOf('jane.qa@acme.com.invalid')).toBe('jane.qa@acme.com');
    expect(addressRestoredOf('ada@example.co.uk.INVALID')).toBe('ada@example.co.uk');
    expect(addressRestoredOf('jane.qa@acme.com')).toBeUndefined();
    expect(addressRestoredOf('.invalid')).toBeUndefined();
  });
});
