import { describe, expect, it, vi } from 'vitest';
import type { Connection } from 'jsforce';

import {
  emptyPermissionsOf,
  guardEmpty,
  hardDeleteRefusal,
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
    expect(hardDeleteRefusal('admin', permissions).message).toContain(
      'could not be read to have it',
    );
  });
});

describe('peopleActiveIn', () => {
  it('counts the people other than its own writers who changed a record in the window, once each', async () => {
    const { conn, sent } = orgAnswering((soql) =>
      soql.includes('FROM Account')
        ? [{ LastModifiedById: '005000000000002AAA' }, { LastModifiedById: '005000000000002AAA' }]
        : [{ LastModifiedById: '005000000000003AAA' }],
    );
    const active = await peopleActiveIn(
      conn as never,
      ['Account', 'Contact'],
      ['005000000000001AAA'],
      '2026-11-12T09:00:00.000Z',
    );
    expect(active.people).toEqual(['005000000000002', '005000000000003']);
    expect(sent[0]).toBe(
      "SELECT LastModifiedById FROM Account WHERE LastModifiedDate >= 2026-11-12T09:00:00.000Z AND LastModifiedById NOT IN ('005000000000001') LIMIT 2000",
    );
    expect(peopleActiveRefusal('dev', active)?.message).toContain('2 people other than');
  });

  it('names an object it could not read, and never takes it for one nobody changed', async () => {
    const { conn } = orgAnswering(() => new Error("No such column 'LastModifiedDate'"));
    const active = await peopleActiveIn(conn as never, ['Odd__c'], [], '2026-11-12T09:00:00.000Z');
    expect(active.people).toEqual([]);
    expect(active.unread).toEqual(["Odd__c: No such column 'LastModifiedDate'"]);
    expect(peopleActiveRefusal('dev', active)).toBeUndefined();
  });

  it('says at least, past the rows one read answers', async () => {
    const rows = Array.from({ length: 2_000 }, () => ({ LastModifiedById: '005000000000002AAA' }));
    const { conn } = orgAnswering(() => rows);
    const active = await peopleActiveIn(conn as never, ['Account'], [], '2026-11-12T09:00:00.000Z');
    expect(active.atLeast).toBe(true);
    expect(peopleActiveRefusal('dev', active)?.message).toMatch(/^At least 1 person/);
  });
});
