import { describe, it, expect, vi } from 'vitest';
import { seedObjectAccess, type ObjectAccessConnection } from './seedObjectAccess';

const USER = '005000000000001AAA';

function org(options: { marketingUser?: boolean; campaignCreateable?: boolean } = {}) {
  const conn = {
    describeGlobal: vi.fn(async () => ({
      sobjects: [
        { name: 'Account', createable: true },
        { name: 'Campaign', createable: options.campaignCreateable ?? true },
        { name: 'OrgWideEmailAddress', createable: false },
      ],
    })),
    identity: vi.fn(async () => ({ user_id: USER })),
    query: vi.fn(async (soql: string) => {
      expect(soql).toBe(`SELECT UserPermissionsMarketingUser FROM User WHERE Id = '${USER}'`);
      return { records: [{ UserPermissionsMarketingUser: options.marketingUser ?? true }] };
    }),
  } satisfies ObjectAccessConnection;
  return conn;
}

describe('seedObjectAccess', () => {
  it('says an org without Knowledge has no article object, and names the feature', async () => {
    // A built-in template inserted a hundred articles into such an org: all refused.
    const access = seedObjectAccess(org());
    expect(await access('Knowledge__kav')).toEqual({
      access: 'absent',
      reason: 'Salesforce Knowledge is not turned on in it',
    });
    expect(await access('Missing__c')).toEqual({ access: 'absent' });
  });

  it('tells an object the user may create from one it may not', async () => {
    const access = seedObjectAccess(org());
    expect(await access('Account')).toEqual({ access: 'createable' });
    expect(await access('account')).toEqual({ access: 'createable' });
    expect(await access('OrgWideEmailAddress')).toEqual({ access: 'readOnly' });
  });

  it('refuses a campaign to a user without the Marketing User box, saying where to tick it', async () => {
    const conn = org({ marketingUser: false });
    const access = seedObjectAccess(conn);
    expect(await access('Campaign')).toEqual({
      access: 'readOnly',
      reason: 'a campaign needs the Marketing User box ticked on the user, in Setup > Users',
    });
    expect(await seedObjectAccess(org())('Campaign')).toEqual({ access: 'createable' });
  });

  it('reads the object list and the box once for the run', async () => {
    const conn = org();
    const access = seedObjectAccess(conn);
    await access('Account');
    await access('Campaign');
    await access('Campaign');
    expect(conn.describeGlobal).toHaveBeenCalledTimes(1);
    expect(conn.query).toHaveBeenCalledTimes(1);
  });

  it('takes a campaign for createable when the org will not say who the user is', async () => {
    const conn = {
      ...org(),
      identity: vi.fn(async () => Promise.reject(new Error('no identity'))),
    };
    expect(await seedObjectAccess(conn)('Campaign')).toEqual({ access: 'createable' });
  });
});
