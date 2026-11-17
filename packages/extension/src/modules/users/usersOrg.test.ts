import { describe, expect, it } from 'vitest';

import { ACME, acmeSetup, usersTestOrg } from './usersOrg.fixtures.js';
import {
  USERS_COLLECTION_ROWS,
  inChunks,
  soqlList,
  soqlStartsWithDot,
  soqlText,
  usersOrgOf,
} from './usersOrg.js';

/*
 * The port of a jsforce connection `sandforge users` reads and writes
 * through: every page of a read, the writes of sObject Collections row by
 * row with allOrNone false, a call refused whole said for each of its rows,
 * and every request counted.
 */

describe('the reads', () => {
  it('reads every page of a statement, each page one request more', async () => {
    const setup = acmeSetup({ pageSize: 2 });
    const org = usersTestOrg(setup);
    const port = usersOrgOf(org.connection);

    const rows = await port.query('SELECT Id, Username FROM User');

    expect(rows.map((row) => row['Username'])).toEqual([
      'admin@acme.com.uat',
      'jane.qa@acme.com.uat',
      'paul.qa@acme.com.uat',
      'erp.integration@acme.com.uat',
    ]);
    expect(port.requests()).toBe(2);
  });

  it('answers a relationship as the nested record jsforce gives', async () => {
    const port = usersOrgOf(usersTestOrg(acmeSetup()).connection);

    const [row] = await port.query(
      `SELECT Id, Profile.Name FROM User WHERE Id = '${ACME.users.jane}'`,
    );

    expect(row['Profile']).toMatchObject({ Name: 'Standard Platform User' });
    expect(row['Profile.Name']).toBeUndefined();
  });

  it('lets the org refuse a column its object does not have', async () => {
    const port = usersOrgOf(usersTestOrg(acmeSetup()).connection);

    await expect(port.query('SELECT Id, IsFrozen FROM User')).rejects.toMatchObject({
      errorCode: 'INVALID_FIELD',
    });
  });

  it('says who the connection is, and counts that request', async () => {
    const port = usersOrgOf(usersTestOrg(acmeSetup()).connection);

    expect(await port.identity()).toEqual({
      userId: ACME.users.admin,
      organizationId: ACME.organizationId,
      username: 'admin@acme.com.uat',
    });
    expect(port.requests()).toBe(1);
  });
});

describe('the writes', () => {
  it('sends 200 rows a collection, allOrNone false, and answers every row', async () => {
    const users = Array.from({ length: 450 }, (_, at) => ({
      id: `005${String(100 + at).padStart(12, '0')}AAA`,
      username: `tester${at}@acme.com.uat`,
      email: `tester${at}@acme.com.invalid`,
      isActive: false,
      profileId: ACME.profiles.platform,
      loginId: `060${String(100 + at).padStart(12, '0')}AAA`,
    }));
    const org = usersTestOrg(acmeSetup({ users }));
    const port = usersOrgOf(org.connection);

    const answered = await port.update(
      'UserLogin',
      users.map((user) => ({ Id: user.loginId, IsFrozen: true })),
    );

    expect(answered).toHaveLength(450);
    expect(answered.every((row) => row.success)).toBe(true);
    expect(org.writes.map((write) => write.rows.length)).toEqual([200, 200, 50]);
    expect(org.writes.every((write) => write.allOrNone === false)).toBe(true);
    expect(port.requests()).toBe(3);
    expect(USERS_COLLECTION_ROWS).toBe(200);
  });

  it('answers the refusal of each row in the org’s code and words', async () => {
    const org = usersTestOrg(acmeSetup());
    const port = usersOrgOf(org.connection);

    const [created, twice] = await port.create('PermissionSetAssignment', [
      { AssigneeId: ACME.users.jane, PermissionSetId: ACME.permissionSets.qaTools },
      { AssigneeId: ACME.users.jane, PermissionSetId: ACME.permissionSets.qaTools },
    ]);

    expect(created).toMatchObject({ success: true, id: expect.stringMatching(/^0Pa/) });
    expect(twice).toEqual({
      success: false,
      errors: [
        {
          code: 'DUPLICATE_VALUE',
          message: expect.stringContaining('Duplicate PermissionSetAssignment'),
          fields: ['AssigneeId', 'PermissionSetId'],
        },
      ],
    });
  });

  it('says a call the org refused whole as the refusal of each of its rows', async () => {
    const refusal = Object.assign(new Error('Session expired or invalid'), {
      errorCode: 'INVALID_SESSION_ID',
    });
    const port = usersOrgOf({
      ...usersTestOrg(acmeSetup()).connection,
      sobject: () => ({
        update: async () => {
          throw refusal;
        },
      }),
    } as unknown as Parameters<typeof usersOrgOf>[0]);

    const answered = await port.update('User', [
      { Id: ACME.users.jane, IsActive: true },
      { Id: ACME.users.paul, IsActive: true },
    ]);

    expect(answered).toEqual([
      {
        success: false,
        errors: [
          {
            code: 'INVALID_SESSION_ID',
            message: expect.stringContaining('Session expired'),
            fields: [],
          },
        ],
      },
      {
        success: false,
        errors: [
          {
            code: 'INVALID_SESSION_ID',
            message: expect.stringContaining('Session expired'),
            fields: [],
          },
        ],
      },
    ]);
  });

  it('reads the code jsforce names errorCode as well as the REST statusCode', async () => {
    const port = usersOrgOf({
      ...usersTestOrg(acmeSetup()).connection,
      sobject: () => ({
        destroy: async () => [
          {
            id: 'x',
            success: false,
            errors: [{ errorCode: 'ENTITY_IS_DELETED', message: 'entity is deleted' }],
          },
        ],
      }),
    } as unknown as Parameters<typeof usersOrgOf>[0]);

    const [answer] = await port.destroy('GroupMember', ['011000000000001AAA']);

    expect(answer.errors).toEqual([
      { code: 'ENTITY_IS_DELETED', message: 'entity is deleted', fields: [] },
    ]);
  });

  it('says a row the org answered nothing for as refused, never as written', async () => {
    const port = usersOrgOf({
      ...usersTestOrg(acmeSetup()).connection,
      sobject: () => ({
        create: async () => [{ id: '0Pa000000000001AAA', success: true, errors: [] }],
      }),
    } as unknown as Parameters<typeof usersOrgOf>[0]);

    const answered = await port.create('PermissionSetAssignment', [{ a: 1 }, { a: 2 }]);

    expect(answered[0].success).toBe(true);
    expect(answered[1]).toMatchObject({ success: false, errors: [{ code: 'NO_ANSWER' }] });
  });
});

describe('the statements', () => {
  it('quotes a text with its quotes and backslashes escaped', () => {
    expect(soqlText("o'brien@acme.com")).toBe("'o\\'brien@acme.com'");
    expect(soqlList(['a@b.c', 'd@e.f'])).toBe("('a@b.c', 'd@e.f')");
  });

  it('matches a prefix then a dot, its own wildcards escaped', async () => {
    const org = usersTestOrg(
      acmeSetup({
        users: [
          ...acmeSetup().users,
          {
            id: '005000000000009AAA',
            username: 'janeXqa@acme.com.uat',
            email: 'x@acme.com',
            isActive: true,
            profileId: ACME.profiles.platform,
          },
        ],
      }),
    );
    const port = usersOrgOf(org.connection);

    expect(soqlStartsWithDot('jane_qa@acme.com')).toBe("'jane\\_qa@acme.com.%'");
    const rows = await port.query(
      `SELECT Username FROM User WHERE Username LIKE ${soqlStartsWithDot('jane_qa@acme.com')}`,
    );
    expect(rows).toEqual([]);
  });

  it('cuts a list into parts of a size, in order', () => {
    expect(inChunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(inChunks([], 2)).toEqual([]);
  });
});
