import { describe, it, expect, vi } from 'vitest';
import type { SeedObjectConfig, SeedTemplate } from '@sandforge/shared';
import {
  seedObjectAccess,
  templateTheOrgTakes,
  type ObjectAccessConnection,
} from './seedObjectAccess';

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

describe('templateTheOrgTakes', () => {
  const object = (objectApiName: string, optional?: true) =>
    ({
      objectApiName,
      recordCount: 100,
      fieldRules: [],
      ...(optional ? { optional } : {}),
    }) as unknown as SeedObjectConfig;
  const template = {
    objects: [object('Account'), object('Knowledge__kav', true), object('Campaign', true)],
    relations: [
      { childObject: 'Case', parentObject: 'Account' },
      { childObject: 'CaseArticle', parentObject: 'Knowledge__kav' },
    ],
  } as unknown as Pick<SeedTemplate, 'objects' | 'relations'>;

  it('leaves out an optional object the org does not have, and what hangs from it', async () => {
    const taken = await templateTheOrgTakes(template, seedObjectAccess(org()));

    expect(taken.objects.map((o) => o.objectApiName)).toEqual(['Account', 'Campaign']);
    expect(taken.relations?.map((r) => r.childObject)).toEqual(['Case']);
  });

  it('leaves out the objects of the template that hang from a closed one, as the run skips them', async () => {
    // Campaign closed to a user without the Marketing User box: the run skips
    // it, then its members, which have nothing to point at, then what a rule
    // of theirs points at. Counted, the gate refused a seed that fit, and the
    // fit cut the accounts for members never written.
    const member = object('CampaignMember');
    const note = {
      ...object('Note__c'),
      fieldRules: [
        {
          fieldApiName: 'Member__c',
          ruleType: 'reference',
          config: { referenceObject: 'CampaignMember' },
        },
      ],
    } as unknown as SeedObjectConfig;
    const generated = (childObject: string, parentObject: string) => ({
      childObject,
      parentObject,
      lookupField: `${parentObject}Id`,
      parents: { kind: 'generated' },
    });

    const taken = await templateTheOrgTakes(
      {
        objects: [object('Account'), object('Campaign', true), member, note, object('Contact')],
        relations: [generated('CampaignMember', 'Campaign'), generated('Contact', 'Account')],
      } as unknown as Pick<SeedTemplate, 'objects' | 'relations'>,
      seedObjectAccess(org({ marketingUser: false })),
    );

    expect(taken.objects.map((o) => o.objectApiName)).toEqual(['Account', 'Contact']);
    expect(taken.relations?.map((r) => r.childObject)).toEqual(['Contact']);
  });

  it('leaves out one the user may not create, and keeps an object the template requires', async () => {
    const taken = await templateTheOrgTakes(
      {
        objects: [object('Knowledge__kav'), object('Campaign', true)],
      } as unknown as Pick<SeedTemplate, 'objects' | 'relations'>,
      seedObjectAccess(org({ marketingUser: false })),
    );

    expect(taken.objects.map((o) => o.objectApiName)).toEqual(['Knowledge__kav']);
  });

  it('reads nothing of a template with no optional object, and counts one a read could not tell', async () => {
    const access = vi.fn(async () => {
      throw new Error('REQUEST_LIMIT_EXCEEDED');
    });

    const plain = { objects: [object('Account')] } as unknown as Pick<
      SeedTemplate,
      'objects' | 'relations'
    >;
    expect(await templateTheOrgTakes(plain, access)).toBe(plain);
    expect(access).not.toHaveBeenCalled();

    expect(await templateTheOrgTakes(template, access)).toBe(template);
  });
});

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
