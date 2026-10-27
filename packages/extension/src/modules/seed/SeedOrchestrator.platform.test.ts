import { describe, it, expect, vi } from 'vitest';
import type { SeedTemplate } from '@sandforge/shared';
import {
  CRM_STARTER,
  LEADS_ACTIVITIES_STARTER,
  MINIMAL_DEMO,
  PREBUILT_SEED_TEMPLATES,
  SALES_CLOUD_STARTER,
  SERVICE_CLOUD_STARTER,
} from '@sandforge/shared';
import { SeedOrchestrator } from './SeedOrchestrator';
import type { InsertFn, SeedObjectAccess, SeedOrchestratorDependencies } from './SeedOrchestrator';
import { SeedValidator } from './SeedValidator';
import { DataPlanBuilder } from './DataPlanBuilder';
import { FieldMapper } from './FieldMapper';
import { FakerFallback } from './FakerFallback';
import { AIDataGenerator } from './AIDataGenerator';
import { ReferenceLinker } from './ReferenceLinker';

/** The standard price book of the org below. */
const STANDARD_BOOK = '01sSTANDARDBOOK0001';

type Row = Record<string, unknown>;

/**
 * A new Developer Edition, held to the platform rules the built-in templates
 * run into: a price needs the standard book first (STANDARD_PRICE_NOT_DEFINED)
 * and a book holds a product once (DUPLICATE_VALUE); a line item's price is
 * in its opportunity's book; a campaign holds a lead once; every lookup names
 * a record the org has. It has no Knowledge, and fills a case's account from
 * its contact, as an org does.
 */
function newOrg(
  options: {
    access?: Record<string, SeedObjectAccess>;
    noStandardBook?: boolean;
    /** A text field of the org's own every account must carry. */
    requiredOnAccount?: string;
  } = {},
) {
  const records = new Map<string, Row & { Id: string }>();
  const byObject = new Map<string, string[]>();
  let next = 0;
  const exists = (id: unknown): boolean =>
    typeof id === 'string' && (records.has(id) || id === STANDARD_BOOK);

  function refusal(objectApiName: string, row: Row): string | undefined {
    const mustCarry = options.requiredOnAccount;
    if (objectApiName === 'Account' && mustCarry && typeof row[mustCarry] !== 'string') {
      return `REQUIRED_FIELD_MISSING: Required fields are missing: [${mustCarry}]`;
    }
    for (const [field, value] of Object.entries(row)) {
      if (field.endsWith('Id') && value !== null && value !== undefined && !exists(value)) {
        return `INVALID_CROSS_REFERENCE_KEY: ${field}`;
      }
    }
    if (objectApiName === 'PricebookEntry') {
      if (row['Pricebook2Id'] !== STANDARD_BOOK) return 'STANDARD_PRICE_NOT_DEFINED';
      const taken = (byObject.get('PricebookEntry') ?? []).some((id) => {
        const entry = records.get(id);
        return (
          entry?.['Pricebook2Id'] === row['Pricebook2Id'] &&
          entry?.['Product2Id'] === row['Product2Id']
        );
      });
      if (taken) return 'DUPLICATE_VALUE: this price book entry already exists';
    }
    if (objectApiName === 'Opportunity' && row['Pricebook2Id'] !== undefined) {
      if (row['Pricebook2Id'] !== STANDARD_BOOK) return 'FIELD_INTEGRITY_EXCEPTION: price book';
    }
    if (objectApiName === 'OpportunityLineItem') {
      const opportunity = records.get(String(row['OpportunityId']));
      const entry = records.get(String(row['PricebookEntryId']));
      if (!entry) return 'REQUIRED_FIELD_MISSING: PricebookEntryId';
      if (opportunity?.['Pricebook2Id'] && opportunity['Pricebook2Id'] !== entry['Pricebook2Id']) {
        return 'FIELD_INTEGRITY_EXCEPTION: price book entry is in a different price book';
      }
    }
    if (objectApiName === 'CampaignMember') {
      const taken = (byObject.get('CampaignMember') ?? []).some((id) => {
        const member = records.get(id);
        return member?.['CampaignId'] === row['CampaignId'] && member?.['LeadId'] === row['LeadId'];
      });
      if (taken) return 'DUPLICATE_VALUE: Already a campaign member.';
    }
    return undefined;
  }

  const insert = vi.fn<InsertFn>(async (_orgId, objectApiName, rows) => {
    const successIds: string[] = [];
    const errors: string[] = [];
    for (const row of rows) {
      const refused = refusal(objectApiName, row);
      if (refused) {
        errors.push(refused);
        continue;
      }
      const id = `${objectApiName.slice(0, 3)}${String(++next).padStart(12, '0')}`;
      const kept: Row & { Id: string } = { ...row, Id: id };
      // The platform files a case under its contact's account.
      if (objectApiName === 'Case' && kept['AccountId'] === undefined) {
        kept['AccountId'] = records.get(String(row['ContactId']))?.['AccountId'];
      }
      records.set(id, kept);
      byObject.set(objectApiName, [...(byObject.get(objectApiName) ?? []), id]);
      successIds.push(id);
    }
    return { successIds, errors };
  });

  const readExistingParentIds = vi.fn(async (objectApiName: string, where: string | undefined) =>
    objectApiName === 'Pricebook2' && where === 'IsStandard = true' && !options.noStandardBook
      ? [STANDARD_BOOK]
      : [],
  );
  const objectAccess = vi.fn(
    async (objectApiName: string): Promise<SeedObjectAccess> =>
      options.access?.[objectApiName] ??
      (objectApiName === 'Knowledge__kav'
        ? { access: 'absent', reason: 'Salesforce Knowledge is not turned on in it' }
        : { access: 'createable' }),
  );
  /** The picklists of a new org, as its describe lists them. */
  const describePicklistValues = vi.fn(async (objectApiName: string) => {
    const lists: Record<string, Record<string, string[]>> = {
      Account: {
        Type: ['Prospect', 'Customer - Direct', 'Customer - Channel', 'Channel Partner / Reseller'],
        Industry: ['Agriculture', 'Banking'],
      },
    };
    return new Map(Object.entries(lists[objectApiName] ?? {}));
  });

  /** What the org requires of a record, as its describe says. */
  const describeRequiredFields = vi.fn(async (objectApiName: string) =>
    objectApiName === 'Account' && options.requiredOnAccount
      ? [
          {
            fieldApiName: options.requiredOnAccount,
            type: 'string',
            picklistValues: [],
            referenceTo: [],
            length: 40,
            objectApiName,
            required: true,
          },
          // A name the template fills already is left to its rule.
          {
            fieldApiName: 'Name',
            type: 'string',
            picklistValues: [],
            referenceTo: [],
            length: 255,
            objectApiName,
            required: true,
          },
        ]
      : [],
  );

  const rowsOf = (objectApiName: string): Array<Row & { Id: string }> =>
    (byObject.get(objectApiName) ?? []).map((id) => records.get(id) as Row & { Id: string });
  return {
    insert,
    readExistingParentIds,
    objectAccess,
    describePicklistValues,
    describeRequiredFields,
    rowsOf,
  };
}

function orchestrator(org: ReturnType<typeof newOrg>): SeedOrchestrator {
  const deps: SeedOrchestratorDependencies = {
    validator: new SeedValidator(),
    planBuilder: new DataPlanBuilder(),
    fieldMapper: new FieldMapper({
      aiGenerator: new AIDataGenerator(() => {
        throw new Error('no AI here');
      }),
      fakerFallback: new FakerFallback('en_US'),
    }),
    referenceLinker: new ReferenceLinker(),
    insert: org.insert,
    readExistingParentIds: org.readExistingParentIds,
    objectAccess: org.objectAccess,
    describePicklistValues: org.describePicklistValues,
    describeRequiredFields: org.describeRequiredFields,
    generateId: () => 'op-1',
    now: () => '2026-10-20T00:00:00.000Z',
  };
  return new SeedOrchestrator(deps);
}

/** Each object a template writes, against what the run wrote of it. */
function written(template: SeedTemplate, result: Awaited<ReturnType<SeedOrchestrator['execute']>>) {
  return Object.fromEntries(
    template.objects.map((o) => [
      o.objectApiName,
      result.objectResults.find((r) => r.objectApiName === o.objectApiName)?.recordsCreated ?? 0,
    ]),
  );
}

describe('the built-in templates on a new Developer Edition', () => {
  it.each([
    ['CRM Starter', CRM_STARTER],
    ['Leads & Activities Starter', LEADS_ACTIVITIES_STARTER],
    ['Minimal Demo', MINIMAL_DEMO],
    ['Sales Cloud Starter', SALES_CLOUD_STARTER],
  ])('writes %s whole: every object, every record, every lookup', async (_name, template) => {
    const org = newOrg();
    const result = await orchestrator(org).execute(template, 'org-1');

    expect(result.objectResults.flatMap((r) => r.errors)).toEqual([]);
    expect(result.status).toBe('success');
    expect(written(template, result)).toEqual(
      Object.fromEntries(template.objects.map((o) => [o.objectApiName, o.recordCount])),
    );
  });

  it('prices each product once in the standard book, and puts every line item on a priced opportunity', async () => {
    // The template wrote a custom book named "Standard Price Book": every
    // price in it was refused, and the 4,000 line items were skipped.
    const org = newOrg();
    await orchestrator(org).execute(CRM_STARTER, 'org-1');

    const entries = org.rowsOf('PricebookEntry');
    expect(entries.every((e) => e['Pricebook2Id'] === STANDARD_BOOK)).toBe(true);
    expect(new Set(entries.map((e) => e['Product2Id'])).size).toBe(entries.length);
    expect(org.rowsOf('Opportunity').every((o) => o['Pricebook2Id'] === STANDARD_BOOK)).toBe(true);
    expect(org.rowsOf('OpportunityLineItem')).toHaveLength(75);
    // The book is read once for the run.
    expect(org.readExistingParentIds).toHaveBeenCalledTimes(1);
  });

  it("files every case under its contact's account, and every contact under one account", async () => {
    const org = newOrg();
    await orchestrator(org).execute(CRM_STARTER, 'org-1');
    const contacts = new Map(org.rowsOf('Contact').map((c) => [c.Id, c]));
    for (const kase of org.rowsOf('Case')) {
      expect(kase['AccountId']).toBe(contacts.get(String(kase['ContactId']))?.['AccountId']);
    }
    const perAccount = new Map<unknown, number>();
    for (const contact of contacts.values()) {
      perAccount.set(contact['AccountId'], (perAccount.get(contact['AccountId']) ?? 0) + 1);
    }
    expect([...perAccount.values()].every((n) => n === 3)).toBe(true);
  });

  it('makes each lead a member of one campaign, which the campaign holds once', async () => {
    const org = newOrg();
    await orchestrator(org).execute(LEADS_ACTIVITIES_STARTER, 'org-1');
    const members = org.rowsOf('CampaignMember');
    expect(members).toHaveLength(40);
    expect(new Set(members.map((m) => m['LeadId'])).size).toBe(40);
  });

  it('skips the articles of an org without Knowledge, saying why, and writes the rest whole', async () => {
    const org = newOrg();
    const result = await orchestrator(org).execute(SERVICE_CLOUD_STARTER, 'org-1');

    const articles = result.objectResults.find((r) => r.objectApiName === 'Knowledge__kav');
    expect(articles?.errors).toEqual([
      'Skipped: this org has no Knowledge__kav object (Salesforce Knowledge is not turned on in it).',
    ]);
    // Nothing was sent for them: the run used to try, and every one was refused.
    expect(
      org.insert.mock.calls.some(([, objectApiName]) => objectApiName === 'Knowledge__kav'),
    ).toBe(false);
    const { Knowledge__kav: none, ...rest } = written(SERVICE_CLOUD_STARTER, result);
    expect(none).toBe(0);
    expect(rest).toEqual({ Account: 200, Contact: 500, Case: 1000, CaseComment: 2000 });
    // The articles are optional: a new Developer Edition has no Knowledge, and
    // every run of the template on one ended partial on them.
    expect(articles?.optional).toBe(true);
    expect(result.status).toBe('success');
  });

  it('keeps a run partial when an object the org lacks is one its template does not mark optional', async () => {
    const strict = {
      ...SERVICE_CLOUD_STARTER,
      objects: SERVICE_CLOUD_STARTER.objects.map((o) => ({ ...o, optional: false })),
    };
    const result = await orchestrator(newOrg()).execute(strict, 'org-1');
    const articles = result.objectResults.find((r) => r.objectApiName === 'Knowledge__kav');
    expect(articles?.errors[0]).toMatch(/^Skipped: this org has no Knowledge__kav object/);
    expect(articles?.optional).toBeUndefined();
    expect(result.status).toBe('partial');
  });

  it('skips the campaigns of a user who may not create one, and what hangs on them, saying why', async () => {
    const org = newOrg({
      access: {
        Campaign: {
          access: 'readOnly',
          reason: 'a campaign needs the Marketing User box ticked on the user, in Setup > Users',
        },
      },
    });
    const result = await orchestrator(org).execute(LEADS_ACTIVITIES_STARTER, 'org-1');
    const said = (name: string): string[] =>
      result.objectResults.find((r) => r.objectApiName === name)?.errors ?? [];
    expect(said('Campaign')[0]).toMatch(/may not create Campaign records \(.*Marketing User/);
    expect(said('CampaignMember')[0]).toMatch(/^Skipped: Campaign wrote no records/);
    expect(written(LEADS_ACTIVITIES_STARTER, result)).toMatchObject({
      Lead: 40,
      Task: 20,
      Event: 10,
    });
  });

  it('skips the prices of an org whose standard price book this user cannot see, and the line items after them', async () => {
    const org = newOrg({ noStandardBook: true });
    const result = await orchestrator(org).execute(CRM_STARTER, 'org-1');
    const said = (name: string): string[] =>
      result.objectResults.find((r) => r.objectApiName === name)?.errors ?? [];
    expect(said('PricebookEntry')[0]).toBe(
      "Skipped: PricebookEntry points at the org's standard price book, and the org shows none to this user.",
    );
    expect(said('OpportunityLineItem')[0]).toMatch(/^Skipped: PricebookEntry/);
    expect(org.insert.mock.calls.some(([, name]) => name === 'PricebookEntry')).toBe(false);
  });

  it("keeps a random pick to the values the org's picklist has, or takes the org's own", async () => {
    const org = newOrg();
    await orchestrator(org).execute(MINIMAL_DEMO, 'org-1');
    const accounts = org.rowsOf('Account');
    // 'Technology Partner' is not in this org's list; none of the template's
    // industries are, so the org's own are drawn.
    expect(new Set(accounts.map((a) => a['Type']))).not.toContain('Technology Partner');
    expect(accounts.every((a) => ['Agriculture', 'Banking'].includes(String(a['Industry'])))).toBe(
      true,
    );
    // A picklist the org does not describe keeps the rule's values.
    expect(accounts.every((a) => ['Hot', 'Warm', 'Cold'].includes(String(a['Rating'])))).toBe(true);
  });

  it('fills a field the org requires and the template names no rule for, and says so', async () => {
    // An org with a required text field of its own on Account refused every
    // account of the template, and skipped every record after them.
    const org = newOrg({ requiredOnAccount: 'Region__c' });
    const result = await orchestrator(org).execute(CRM_STARTER, 'org-1');

    expect(written(CRM_STARTER, result)).toMatchObject({ Account: 25, Contact: 75, Case: 50 });
    expect(org.rowsOf('Account').every((a) => typeof a['Region__c'] === 'string')).toBe(true);
    expect(result.objectResults.find((r) => r.objectApiName === 'Account')?.errors).toEqual([
      'Written with Region__c, which this org requires and the template names no rule for.',
    ]);
    // The template's own name rule stands.
    expect(org.rowsOf('Account').every((a) => !/lorem/.test(String(a['Name'])))).toBe(true);
  });

  it('runs every built-in template the gallery lists', () => {
    expect(PREBUILT_SEED_TEMPLATES).toHaveLength(5);
  });
});
