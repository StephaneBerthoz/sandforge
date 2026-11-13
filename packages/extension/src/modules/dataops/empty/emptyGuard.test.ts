import { describe, expect, it, vi } from 'vitest';
import type { Connection } from 'jsforce';

import {
  emptyPermissionsOf,
  guardEmpty,
  hardDeleteRefusal,
  namedPeople,
  peopleActiveIn,
  peopleActiveRefusal,
} from './emptyGuard.js';

/** An org whose statements `answer` answers, every one it was sent kept. */
function orgAnswering(answer: (soql: string) => Array<Record<string, unknown>> | Error): {
  conn: Pick<Connection, 'query'>;
  sent: string[];
} {
  const sent: string[] = [];
  const conn = {
    query: vi.fn(async (soql: string) => {
      sent.push(soql);
      const rows = answer(soql);
      if (rows instanceof Error) throw rows;
      return { totalSize: rows.length, done: true, records: rows };
    }),
  } as unknown as Pick<Connection, 'query'>;
  return { conn, sent };
}

const SANDBOX_ROW = { Id: '00D000000000001AAA', IsSandbox: true };

describe('guardEmpty', () => {
  it('refuses an org the registry does not know, or holds as production, and asks it nothing', async () => {
    const { conn, sent } = orgAnswering(() => [SANDBOX_ROW]);
    for (const registered of [undefined, { orgType: 'Production' }]) {
      const result = await guardEmpty(conn, { orgName: 'dev', registered, mode: 'objects' });
      expect(result.allowed).toBe(false);
      expect(!result.allowed && result.refusal.code).toBe('PRODUCTION');
      expect(!result.allowed && result.refusal.message).toContain('nothing lifts this');
    }
    expect(sent).toEqual([]);
  });

  it('refuses a registered sandbox that says live it is no sandbox, nor a Developer Edition', async () => {
    const { conn } = orgAnswering((soql) =>
      soql.includes('OrganizationType')
        ? [{ OrganizationType: 'Unlimited Edition' }]
        : [{ Id: '00D000000000001AAA', IsSandbox: false }],
    );
    const result = await guardEmpty(conn, {
      orgName: 'dev',
      registered: { orgType: 'Sandbox' },
      mode: 'objects',
    });
    expect(!result.allowed && result.refusal.message).toContain('edition Unlimited Edition');
  });

  it('takes an org that will not say what it is for a production org', async () => {
    const { conn } = orgAnswering(() => new Error('INVALID_SESSION_ID: Session expired'));
    const result = await guardEmpty(conn, {
      orgName: 'dev',
      registered: { orgType: 'Sandbox' },
      mode: 'objects',
    });
    expect(!result.allowed && result.refusal.code).toBe('PRODUCTION');
    expect(!result.allowed && result.refusal.message).toContain('Session expired');
  });

  it('lets a Developer Edition org through, its edition read live', async () => {
    const { conn } = orgAnswering((soql) =>
      soql.includes('OrganizationType')
        ? [{ OrganizationType: 'Developer Edition' }]
        : [{ Id: '00D000000000001AAA', IsSandbox: false }],
    );
    const result = await guardEmpty(conn, {
      orgName: 'de',
      registered: { orgType: 'Developer' },
      mode: 'org',
    });
    expect(result.allowed && result.tier).toBe('development');
  });

  it('refuses the whole of a sandbox marked Staging, and lets objects picked there through', async () => {
    const { conn } = orgAnswering(() => [SANDBOX_ROW]);
    const staging = { orgType: 'Sandbox', staging: true };
    const whole = await guardEmpty(conn, { orgName: 'uat', registered: staging, mode: 'org' });
    expect(!whole.allowed && whole.refusal.code).toBe('STAGING_ORG');

    const picked = await guardEmpty(conn, { orgName: 'uat', registered: staging, mode: 'objects' });
    expect(picked.allowed && picked.tier).toBe('staging');
  });
});

describe('emptyPermissionsOf', () => {
  it('reads View All Data, Modify All Data and Bulk API Hard Delete in one statement', async () => {
    const { conn, sent } = orgAnswering(() => [
      {
        PermissionsViewAllData: true,
        PermissionsModifyAllData: true,
        PermissionsBulkApiHardDelete: false,
      },
    ]);
    expect(await emptyPermissionsOf(conn)).toEqual({
      viewAllData: true,
      modifyAllData: true,
      hardDelete: false,
    });
    expect(sent).toEqual([
      'SELECT PermissionsViewAllData, PermissionsModifyAllData, PermissionsBulkApiHardDelete FROM UserPermissionAccess',
    ]);
  });

  it('takes an org that will not say for a user who may not delete for good, and says why', async () => {
    const { conn } = orgAnswering((soql) =>
      soql.includes('BulkApiHardDelete')
        ? new Error(
            "No such column 'PermissionsBulkApiHardDelete' on entity 'UserPermissionAccess'",
          )
        : [{ PermissionsViewAllData: true, PermissionsModifyAllData: true }],
    );
    const permissions = await emptyPermissionsOf(conn);
    expect(permissions).toMatchObject({
      viewAllData: true,
      modifyAllData: true,
      hardDelete: false,
    });
    expect(permissions.unread).toContain('No such column');
    expect(hardDeleteRefusal(permissions).message).toContain('could not be read to have it');
  });

  it('names no one in its refusal of a delete for good, and says nothing was deleted, not that nothing was read', () => {
    const refusal = hardDeleteRefusal({});

    expect(refusal.message).toContain("the user SandForge deletes as doesn't have it");
    expect(refusal.message).not.toMatch(/@/);
    expect(refusal.message).toContain('Nothing was deleted.');
    expect(refusal.message).not.toContain('No record was read');
  });
});

describe('peopleActiveIn', () => {
  it('counts the people other than its own writers who changed a record in the window, once each', async () => {
    const { conn, sent } = orgAnswering((soql) =>
      soql.includes('FROM Account')
        ? [
            {
              LastModifiedById: '005000000000002AAA',
              LastModifiedDate: '2026-11-12T09:10:00.000+0000',
            },
            {
              LastModifiedById: '005000000000002AAA',
              LastModifiedDate: '2026-11-12T09:40:00.000+0000',
            },
          ]
        : [
            {
              LastModifiedById: '005000000000003AAA',
              LastModifiedDate: '2026-11-12T09:20:00.000+0000',
            },
          ],
    );
    const active = await peopleActiveIn(
      conn as never,
      ['Account', 'Contact'],
      ['005000000000001AAA'],
      '2026-11-12T09:00:00.000Z',
    );
    expect(active.people).toEqual(['005000000000002', '005000000000003']);
    expect(sent[0]).toBe(
      "SELECT LastModifiedById, LastModifiedDate FROM Account WHERE LastModifiedDate >= 2026-11-12T09:00:00.000Z AND LastModifiedById NOT IN ('005000000000001') LIMIT 2000",
    );
    expect(peopleActiveRefusal('dev', active)?.message).toContain('2 people other than');
  });

  it('says of each person the records read and when they last changed one', async () => {
    const { conn } = orgAnswering((soql) =>
      soql.includes('FROM Account')
        ? [
            {
              LastModifiedById: '005000000000002AAA',
              LastModifiedDate: '2026-11-12T09:40:00.000+0000',
            },
            {
              LastModifiedById: '005000000000002AAA',
              LastModifiedDate: '2026-11-12T09:10:00.000+0000',
            },
          ]
        : [
            {
              LastModifiedById: '005000000000002AAA',
              LastModifiedDate: '2026-11-12T09:50:00.000+0000',
            },
          ],
    );
    const active = await peopleActiveIn(
      conn as never,
      ['Account', 'Contact'],
      [],
      '2026-11-12T09:00:00.000Z',
    );
    expect(active.who).toEqual([
      { userId: '005000000000002', records: 3, lastChangedAt: '2026-11-12T09:50:00.000+0000' },
    ]);
    expect(peopleActiveRefusal('dev', active)?.message).toContain(
      'in the last hour, the last at 2026-11-12T09:50:00.000+0000',
    );
  });

  it('names an object it could not read, and never takes it for one nobody changed', async () => {
    const { conn } = orgAnswering(() => new Error("No such column 'LastModifiedDate'"));
    const active = await peopleActiveIn(conn as never, ['Odd__c'], [], '2026-11-12T09:00:00.000Z');
    expect(active.people).toEqual([]);
    expect(active.unread).toEqual(["Odd__c: No such column 'LastModifiedDate'"]);
    expect(peopleActiveRefusal('dev', active)).toBeUndefined();
  });

  it('names the people for the page, one read, and shows an Id where the org gave no name', async () => {
    const { conn, sent } = orgAnswering((soql) =>
      soql.startsWith('SELECT Id, Name FROM User')
        ? [{ Id: '005000000000002AAA', Name: 'Ada Example' }]
        : [
            {
              LastModifiedById: '005000000000002AAA',
              LastModifiedDate: '2026-11-12T09:10:00.000+0000',
            },
            {
              LastModifiedById: '005000000000003AAA',
              LastModifiedDate: '2026-11-12T09:20:00.000+0000',
            },
          ],
    );
    const active = await peopleActiveIn(conn as never, ['Account'], [], '2026-11-12T09:00:00.000Z');
    const named = await namedPeople(conn as never, active);
    expect(sent.at(-1)).toBe(
      "SELECT Id, Name FROM User WHERE Id IN ('005000000000002', '005000000000003')",
    );
    expect(named.who.map((person) => [person.userId, person.name])).toEqual([
      ['005000000000002', 'Ada Example'],
      ['005000000000003', undefined],
    ]);
    // The refusal names how many and when, never who.
    expect(peopleActiveRefusal('dev', named)?.message).not.toContain('Ada Example');
  });

  it('names no one when the org refuses the read of their names, and reads none when nobody is at work', async () => {
    const refused = orgAnswering((soql) =>
      soql.startsWith('SELECT Id, Name FROM User')
        ? new Error('INSUFFICIENT_ACCESS')
        : [
            {
              LastModifiedById: '005000000000002AAA',
              LastModifiedDate: '2026-11-12T09:10:00.000+0000',
            },
          ],
    );
    const active = await peopleActiveIn(
      refused.conn as never,
      ['Account'],
      [],
      '2026-11-12T09:00:00.000Z',
    );
    expect((await namedPeople(refused.conn as never, active)).who[0]?.name).toBeUndefined();

    const nobody = orgAnswering(() => []);
    const none = await peopleActiveIn(
      nobody.conn as never,
      ['Account'],
      [],
      '2026-11-12T09:00:00.000Z',
    );
    await namedPeople(nobody.conn as never, none);
    expect(nobody.sent.some((soql) => soql.includes('FROM User'))).toBe(false);
  });

  it('says at least, past the rows one read answers', async () => {
    const rows = Array.from({ length: 2_000 }, () => ({ LastModifiedById: '005000000000002AAA' }));
    const { conn } = orgAnswering(() => rows);
    const active = await peopleActiveIn(conn as never, ['Account'], [], '2026-11-12T09:00:00.000Z');
    expect(active.atLeast).toBe(true);
    expect(peopleActiveRefusal('dev', active)?.message).toMatch(/^At least 1 person/);
  });
});

describe('peopleActiveRefusal', () => {
  const ACTIVE = {
    people: ['005000000000002', '005000000000003'],
    who: [
      { userId: '005000000000002', records: 4, lastChangedAt: '2026-11-12T09:10:00.000Z' },
      { userId: '005000000000003', records: 1, lastChangedAt: '2026-11-12T09:30:00.000Z' },
    ],
  };

  it('is lifted by an acceptance of whoever is at work, and names the flag that gives it', () => {
    expect(peopleActiveRefusal('dev', ACTIVE)?.message).toContain(
      'or add --accept-people-active to empty all the same',
    );
    expect(peopleActiveRefusal('dev', ACTIVE, { accepted: true })).toBeUndefined();
  });

  it('covers the people a preview named alone: anyone else refuses the run, counted apart', () => {
    expect(
      peopleActiveRefusal('dev', ACTIVE, { accepted: ['005000000000002AAA', '005000000000003'] }),
    ).toBeUndefined();
    const refusal = peopleActiveRefusal('dev', ACTIVE, { accepted: ['005000000000002'] });
    expect(refusal?.code).toBe('PEOPLE_ACTIVE');
    expect(refusal?.message).toMatch(/^1 person the preview did not name other than the user/);
    expect(refusal?.message).toContain('the last at 2026-11-12T09:30:00.000Z');
  });

  it("names the page's box where the page asked, and says nothing was deleted", () => {
    const refusal = peopleActiveRefusal('dev', ACTIVE, { voice: 'page' });
    expect(refusal?.message).toContain('or tick the box that lets their work go');
    expect(refusal?.message).not.toContain('--accept-people-active');
    expect(refusal?.message).toMatch(/Nothing was deleted\.$/);
  });
});
