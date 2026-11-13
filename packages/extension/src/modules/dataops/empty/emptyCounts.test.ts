import { describe, expect, it } from 'vitest';
import {
  ASSET_CHILDREN,
  EmptyFixtureOrg,
  assetsOrg,
  salesOrg,
  type SalesOrgOptions,
} from '../../../test/emptyFixtureOrg';
import { countEmpty, KEPT_NAMED, type Counted, type EmptyCounts } from './emptyCounts';
import { emptyOrderOf } from './emptyOrder';
import { affectedBy, emptyDescribeSchema, relationsOf, type EmptyDescribe } from './emptyRelations';

/** The objects of the sales org people work in, and the user, whose lookup to a contact refuses its delete. */
const WORKED = [
  'Account',
  'AccountContactRelation',
  'Asset',
  'Campaign',
  'CampaignMember',
  'Case',
  'CaseComment',
  'Contact',
  'Contract',
  'Event',
  'Lead',
  'Opportunity',
  'OpportunityContactRole',
  'OpportunityLineItem',
  'Order',
  'OrderItem',
  'Pricebook2',
  'PricebookEntry',
  'Product2',
  'Quote',
  'QuoteLineItem',
  'Task',
];

/** Count an emptying of `emptied` in `org`, every object described as a dry run describes them. */
async function counted(
  org: EmptyFixtureOrg,
  emptied: readonly string[],
  options: { stopped?: () => boolean; undo?: boolean } = {},
): Promise<EmptyCounts> {
  const describes = new Map<string, EmptyDescribe>();
  for (const name of [...WORKED, 'User']) {
    describes.set(name, emptyDescribeSchema.parse(await org.describe(name)));
  }
  const affected = affectedBy(emptied, WORKED, describes);
  const relations = relationsOf(describes);
  const order = emptyOrderOf(affected, relations);
  return countEmpty({ affected, order, relations, describes }, org, options.stopped, {
    undo: options.undo ?? true,
  });
}

/** The records of an object's pass, by name. */
function passOf(counts: EmptyCounts, name: string): EmptyCounts['objects'][number] {
  const pass = counts.objects.find((object) => object.objectApiName === name);
  if (!pass) throw new Error(`No pass of ${name}`);
  return pass;
}

/** A count's number, for the assertions that read only it. */
function n(counted: Counted | undefined): number | undefined {
  return counted?.records;
}

/**
 * The sales org without its cases, which keep the two accounts and the
 * contacts they name, and so everything that hangs from those: what goes
 * along with an account is then read whole.
 */
function noCases(options: SalesOrgOptions = {}): EmptyFixtureOrg {
  return salesOrg({ ...options, emptyObjects: [...(options.emptyObjects ?? []), 'Case'] });
}

describe('countEmpty, the whole org', () => {
  it('counts every record of each emptied object, the standard price book apart, and archived tasks through queryAll', async () => {
    const counts = await counted(salesOrg(), WORKED);

    expect(
      Object.fromEntries(counts.objects.map((object) => [object.objectApiName, n(object.records)])),
    ).toEqual({
      Account: 4,
      AccountContactRelation: 6,
      Asset: 1,
      Campaign: 1,
      CampaignMember: 2,
      Case: 3,
      CaseComment: 1,
      Contact: 6,
      Contract: 1,
      Event: 1,
      Lead: 2,
      Opportunity: 3,
      OpportunityContactRole: 1,
      OpportunityLineItem: 2,
      Order: 2,
      OrderItem: 1,
      Pricebook2: 1,
      PricebookEntry: 3,
      Product2: 2,
      Quote: 1,
      QuoteLineItem: 1,
      Task: 5,
    });
    expect(n(passOf(counts, 'Task').archived)).toBe(1);
    expect(n(passOf(counts, 'Pricebook2').kept)).toBe(1);
  });

  it('leaves to each pass only what an earlier one does not take along: a contact under no account, an opportunity under none, a task on nothing', async () => {
    const counts = await counted(salesOrg(), WORKED);

    expect(
      Object.fromEntries(counts.objects.map((object) => [object.objectApiName, n(object.sent)])),
    ).toEqual({
      Account: 4,
      AccountContactRelation: 0,
      Asset: 0,
      Campaign: 1,
      CampaignMember: 0,
      Case: 3,
      CaseComment: 0,
      Contact: 1,
      Contract: 0,
      Event: 0,
      Lead: 2,
      Opportunity: 1,
      OpportunityContactRole: 0,
      OpportunityLineItem: 0,
      Order: 0,
      OrderItem: 0,
      Pricebook2: 1,
      PricebookEntry: 0,
      Product2: 2,
      Quote: 0,
      QuoteLineItem: 0,
      Task: 1,
    });
  });

  it('counts what no undo would bring back: cases before their accounts and contacts, what names a custom price book or a product before it goes, the custom prices that go with their book before their product', async () => {
    const counts = await counted(salesOrg(), WORKED);

    expect(
      counts.undoLost.map(({ objectApiName, field, parent, reason, records }) => [
        `${objectApiName}.${field} → ${parent} (${reason})`,
        n(records),
      ]),
    ).toEqual([
      ['Case.AccountId → Account (restricted)', 2],
      ['Case.ContactId → Contact (restricted)', 2],
      ['Order.BillToContactId → Contact (restricted)', 1],
      ['Opportunity.Pricebook2Id → Pricebook2 (restricted)', 2],
      ['Quote.Pricebook2Id → Pricebook2 (restricted)', 1],
      ['Order.Pricebook2Id → Pricebook2 (restricted)', 1],
      ['OpportunityLineItem.PricebookEntryId → PricebookEntry (restricted)', 2],
      ['QuoteLineItem.PricebookEntryId → PricebookEntry (restricted)', 1],
      ['OrderItem.PricebookEntryId → PricebookEntry (restricted)', 1],
      ['OrderItem.Product2Id → Product2 (restricted)', 1],
      ['QuoteLineItem.Product2Id → Product2 (restricted)', 1],
      ['Asset.Product2Id → Product2 (restricted)', 1],
      // The custom price goes with its book, before its product, and did not
      // come back with its book; the two standard ones went with their
      // products and came back with them.
      ['PricebookEntry.Product2Id → Product2 (restricted)', 1],
    ]);
  });

  it('names the portal user who keeps a contact, and the activated order the run sets back to Draft first', async () => {
    const counts = await counted(salesOrg(), WORKED);

    expect(counts.blockers).toEqual([
      {
        objectApiName: 'User',
        field: 'ContactId',
        parent: 'Contact',
        records: { records: 1 },
        keeps: { records: 1 },
      },
    ]);
    expect(counts.refusals).toEqual([
      { code: 'activatedOrder', objectApiName: 'Order', records: { records: 1 } },
      { code: 'standardPriceBook', objectApiName: 'Pricebook2', records: { records: 1 } },
    ]);
  });

  it('names no id in any statement but those of the records what blocks keeps: every count reads a whole table, a subquery included', async () => {
    const org = salesOrg();
    const counts = await counted(org, WORKED);

    const ids = org.ids();
    const kept = new Set([...counts.kept.values()].flatMap((each) => [...each]));
    const literals = org.sent.flatMap(({ soql }) =>
      (soql.match(/'[^']*'/g) ?? []).map((quoted) => quoted.slice(1, -1)),
    );
    expect(org.sent.length).toBeGreaterThan(0);
    // The portal user's contact, whose delete its user refuses.
    expect(counts.kept.get('Contact')).toEqual(['CP']);
    expect(literals.filter((literal) => ids.has(literal) && !kept.has(literal))).toEqual([]);
  });

  it('counts tasks and events through queryAll, the deleted ones left out by the statement', async () => {
    const org = salesOrg();
    await counted(org, WORKED);

    const activities = org.sent.filter(({ soql }) => / FROM (Task|Event)\b/.test(soql));
    expect(activities.length).toBeGreaterThan(0);
    for (const { soql, all } of activities) {
      expect(all).toBe(true);
      expect(soql).toContain('IsDeleted = false');
    }
  });
});

describe('countEmpty, objects picked', () => {
  it('counts, for an account alone, what goes along with it by object and by lookup', async () => {
    const counts = await counted(noCases(), ['Account']);

    expect(
      Object.fromEntries(counts.along.map((object) => [object.objectApiName, n(object.records)])),
    ).toEqual({
      AccountContactRelation: 6,
      Asset: 1,
      CampaignMember: 1,
      Contact: 5,
      Contract: 1,
      Event: 1,
      Opportunity: 2,
      OpportunityContactRole: 1,
      OpportunityLineItem: 2,
      Order: 2,
      OrderItem: 1,
      Quote: 1,
      QuoteLineItem: 1,
      Task: 3,
    });
    expect(counts.along.find((object) => object.objectApiName === 'Contact')?.via).toEqual([
      { field: 'AccountId', parent: 'Account', emptied: 'Account', records: { records: 5 } },
    ]);
  });

  it('says a count through a lookup to several objects may count more than goes', async () => {
    const counts = await counted(noCases(), ['Account']);
    const task = counts.along.find((object) => object.objectApiName === 'Task');

    expect(task?.records).toEqual({ records: 3, atMost: true });
    expect(task?.via.find((route) => route.parent === 'Account')?.records).toEqual({ records: 2 });
  });

  it('names the cases of an account and of its contacts and the portal user of its contact, whose lookups refuse their delete', async () => {
    const counts = await counted(salesOrg(), ['Account']);

    // The cases under an account keep it, counted apart; the case and the
    // portal user of a contact going along keep it, and through it its
    // account, which no statement of the account alone reads.
    expect(counts.blockers).toEqual([
      {
        objectApiName: 'Case',
        field: 'AccountId',
        parent: 'Account',
        records: { records: 2 },
        keeps: { records: 2 },
      },
      { objectApiName: 'Case', field: 'ContactId', parent: 'Contact', records: { records: 1 } },
      { objectApiName: 'User', field: 'ContactId', parent: 'Contact', records: { records: 1 } },
    ]);
    expect(passOf(counts, 'Account').blocked).toEqual({ records: 2 });
  });

  it('sets back to Draft the activated orders that go along with their account', async () => {
    const counts = await counted(noCases(), ['Account']);

    expect(counts.refusals).toEqual([
      { code: 'activatedOrder', objectApiName: 'Order', records: { records: 1 } },
    ]);
  });

  it('counts nothing that hangs from an account what blocks keeps as going along — its contacts, opportunities and their lines, orders, quotes, tasks and events stay with it — and sets none of its orders back to Draft', async () => {
    const org = salesOrg();
    const counts = await counted(org, ['Account']);
    const sent = org.sent.map(({ soql }) => soql);

    // A case keeps each of the first two accounts, as a case kept the account
    // of a clone on a scratch org: of what an account takes along, only the
    // person account's contact and its relation to it go.
    expect(counts.kept.get('Account')).toEqual(['A1', 'A2']);
    expect(passOf(counts, 'Account').blocked).toEqual({ records: 2 });
    expect(
      Object.fromEntries(counts.along.map((object) => [object.objectApiName, n(object.records)])),
    ).toEqual({ AccountContactRelation: 1, Contact: 1 });
    // Its activated order stays with it: none is set back to Draft.
    expect(counts.refusals).toEqual([]);
    expect(sent).toContain(
      "SELECT COUNT() FROM Order WHERE (AccountId != null AND AccountId NOT IN ('A1', 'A2')) AND (StatusCode != 'Draft')",
    );
    // A task read by the type of its contact leaves out those of the
    // contacts that stay with their account.
    expect(sent).toContain("SELECT Id FROM Contact WHERE AccountId IN ('A1', 'A2')");
    expect(
      sent.some((soql) =>
        soql.includes("(Who.Type = 'Contact' AND WhoId NOT IN ('C1', 'C2', 'C3', 'CP'))"),
      ),
    ).toBe(true);
  });

  it('says what hangs from more kept records than a count names may count more than goes, and sets back to Draft none of the orders going along, which it cannot tell apart', async () => {
    const many = Array.from({ length: KEPT_NAMED + 1 }, (_, at) => `AK${at}`);
    const org = noCases({
      extraRows: {
        Account: many.map((Id) => ({ Id })),
        Case: many.map((AccountId, at) => ({ Id: `CSK${at}`, AccountId })),
      },
    });
    const counts = await counted(org, ['Account']);

    expect(counts.kept.get('Account')).toBe('unnamed');
    expect(passOf(counts, 'Account').blocked).toEqual({ records: KEPT_NAMED + 1 });
    expect(counts.along.find((object) => object.objectApiName === 'Contact')?.records).toEqual({
      records: 5,
      atMost: true,
    });
    expect(counts.refusals).toEqual([
      {
        code: 'activatedOrderLeft',
        objectApiName: 'Order',
        records: { records: 1, atMost: true },
      },
    ]);
  });

  it('names an opportunity under no account that keeps a price book emptied with the accounts, and counts the ones that go with their account as lost to an undo', async () => {
    const counts = await counted(noCases(), ['Account', 'Pricebook2']);

    expect(counts.blockers).toContainEqual({
      objectApiName: 'Opportunity',
      field: 'Pricebook2Id',
      parent: 'Pricebook2',
      records: { records: 1 },
    });
    expect(counts.undoLost).toContainEqual({
      objectApiName: 'Opportunity',
      field: 'Pricebook2Id',
      parent: 'Pricebook2',
      reason: 'restricted',
      records: { records: 1 },
    });
    expect(counts.blockers.map((blocker) => blocker.objectApiName)).not.toContain('Quote');
  });

  it('says the direct relations of contacts to their accounts go only with their contacts', async () => {
    const counts = await counted(salesOrg(), ['AccountContactRelation']);

    expect(counts.refusals).toEqual([
      {
        code: 'directContactRelation',
        objectApiName: 'AccountContactRelation',
        records: { records: 5 },
      },
    ]);
  });

  it('says a person account’s contact goes only with its account, and names what keeps contacts', async () => {
    const counts = await counted(salesOrg(), ['Contact']);

    expect(counts.refusals).toEqual([
      { code: 'personAccountContact', objectApiName: 'Contact', records: { records: 1 } },
    ]);
    expect(counts.blockers).toEqual([
      {
        objectApiName: 'Case',
        field: 'ContactId',
        parent: 'Contact',
        records: { records: 2 },
        keeps: { records: 2 },
      },
      {
        objectApiName: 'Order',
        field: 'BillToContactId',
        parent: 'Contact',
        records: { records: 1 },
        keeps: { records: 1 },
      },
      {
        objectApiName: 'User',
        field: 'ContactId',
        parent: 'Contact',
        records: { records: 1 },
        keeps: { records: 1 },
      },
    ]);
    // Named by their ids, the contacts three lookups keep are counted once each.
    expect(passOf(counts, 'Contact').blocked).toEqual({ records: 4 });
  });
});

describe('countEmpty, a person account’s contact', () => {
  it('never sends one by the pass of the contacts, which reads them out, and counts it with its account when the account goes', async () => {
    const contactsAlone = await counted(salesOrg(), ['Contact']);
    const withAccounts = await counted(noCases(), ['Account', 'Contact']);

    // Five business contacts; the person account's stays, said so.
    expect(passOf(contactsAlone, 'Contact')).toMatchObject({
      rows: 'IsPersonAccount = false',
      records: { records: 5 },
      sent: { records: 5 },
    });
    // All six go, the person account's with it; the pass sends the one under no account.
    expect(passOf(withAccounts, 'Contact')).toMatchObject({
      rows: 'IsPersonAccount = false',
      records: { records: 6 },
      sent: { records: 1 },
    });
  });

  it('counts no record named through a person account’s contact as blocking or going along when its account stays: that contact stays too', async () => {
    const org = (): EmptyFixtureOrg =>
      salesOrg({
        extraRows: {
          Case: [{ Id: 'CS-PERSON', ContactId: 'PC1' }],
          OpportunityContactRole: [
            { Id: 'OCR-PERSON', OpportunityId: 'O2', ContactId: 'PC1' },
            { Id: 'OCR-C3', OpportunityId: 'O2', ContactId: 'C3' },
          ],
        },
      });
    const contactsAlone = await counted(org(), ['Contact']);
    const withAccounts = await counted(org(), ['Account', 'Contact']);

    // The two cases of business contacts, as before the person's was added.
    expect(contactsAlone.blockers).toContainEqual({
      objectApiName: 'Case',
      field: 'ContactId',
      parent: 'Contact',
      records: { records: 2 },
      keeps: { records: 2 },
    });
    // The role of a contact no case names goes; that of the first contact
    // stays with it, kept by its case, and the person's with its account.
    expect(
      contactsAlone.along.find((along) => along.objectApiName === 'OpportunityContactRole'),
    ).toMatchObject({ records: { records: 1 } });
    // The person account's contact goes with its account, and what names it blocks then.
    expect(withAccounts.blockers).toContainEqual({
      objectApiName: 'Case',
      field: 'ContactId',
      parent: 'Contact',
      records: { records: 3 },
      keeps: { records: 3 },
    });
  });

  it('names the tasks and events a contact’s or an account’s delete takes along, read by the type of what their lookup names', async () => {
    const contacts = await counted(noCases(), ['Contact']);
    const accounts = await counted(noCases(), ['Account']);
    const along = (counts: EmptyCounts, name: string): number | undefined =>
      n(counts.along.find((object) => object.objectApiName === name)?.records);

    expect(along(contacts, 'Task')).toBe(1);
    expect(along(accounts, 'Task')).toBeGreaterThan(0);
    expect(along(accounts, 'Event')).toBe(1);
  });

  it('reads every contact in an org with no person accounts', async () => {
    const org = salesOrg({ emptyObjects: ['Account'] });
    const counts = await counted(org, ['Contact']);

    expect(passOf(counts, 'Contact').rows).toBe('IsPersonAccount = false');
    expect(
      (await countedIn(businessOrg(), ['Contact'], ['Account', 'Contact'])).objects[0],
    ).not.toHaveProperty('rows');
  });
});

/** Count an emptying of `emptied` among `worked` in `org`, each described. */
async function countedIn(
  org: EmptyFixtureOrg,
  emptied: readonly string[],
  worked: readonly string[],
): Promise<EmptyCounts> {
  const describes = new Map<string, EmptyDescribe>();
  for (const name of worked) {
    describes.set(name, emptyDescribeSchema.parse(await org.describe(name)));
  }
  const affected = affectedBy(emptied, worked, describes);
  const relations = relationsOf(describes);
  return countEmpty(
    { affected, order: emptyOrderOf(affected, relations), relations, describes },
    org,
  );
}

/** An org of business accounts alone: its contacts' describe lists no `IsPersonAccount`. */
function businessOrg(): EmptyFixtureOrg {
  return new EmptyFixtureOrg([
    {
      name: 'Account',
      children: [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: true }],
      rows: [{ Id: 'A1' }],
    },
    {
      name: 'Contact',
      fields: [{ name: 'AccountId', referenceTo: ['Account'], relationshipName: 'Account' }],
      rows: [{ Id: 'C1', AccountId: 'A1' }, { Id: 'C2' }],
    },
  ]);
}

/**
 * An account holding an entitlement and a case, as the scratch org whose
 * emptying the org refused: the account's describe flags the entitlement's
 * lookup both ways.
 */
function entitlementOrg(): EmptyFixtureOrg {
  return new EmptyFixtureOrg([
    {
      name: 'Account',
      children: [
        {
          childSObject: 'Entitlement',
          field: 'AccountId',
          cascadeDelete: true,
          restrictedDelete: true,
        },
        { childSObject: 'Case', field: 'AccountId', restrictedDelete: true },
      ],
      rows: [{ Id: 'A1' }, { Id: 'A2' }],
    },
    {
      name: 'Entitlement',
      fields: [{ name: 'AccountId', referenceTo: ['Account'], relationshipName: 'Account' }],
      rows: [{ Id: 'E1', AccountId: 'A1' }],
    },
    {
      name: 'Case',
      fields: [{ name: 'AccountId', referenceTo: ['Account'], relationshipName: 'Account' }],
      rows: [{ Id: 'CS1' }],
    },
  ]);
}

const ENTITLEMENT_WORKED = ['Account', 'Case', 'Entitlement'];

describe('countEmpty, an account’s entitlements', () => {
  it('names an entitlement as blocking its account emptied without it, where the dry run said it went along', async () => {
    const counts = await countedIn(entitlementOrg(), ['Account'], ENTITLEMENT_WORKED);

    expect(counts.along).toEqual([]);
    expect(counts.blockers).toEqual([
      {
        objectApiName: 'Entitlement',
        field: 'AccountId',
        parent: 'Account',
        records: { records: 1 },
        keeps: { records: 1 },
      },
    ]);
    expect(passOf(counts, 'Account').blocked).toEqual({ records: 1 });
  });

  it('sends the entitlements before their account when both are emptied, and says them beyond Undo', async () => {
    const counts = await countedIn(
      entitlementOrg(),
      ['Account', 'Entitlement'],
      ENTITLEMENT_WORKED,
    );

    expect(counts.objects.map((pass) => pass.objectApiName)).toEqual(['Entitlement', 'Account']);
    expect(counts.undoLost).toEqual([
      {
        objectApiName: 'Entitlement',
        field: 'AccountId',
        parent: 'Account',
        reason: 'restricted',
        records: { records: 1 },
      },
    ]);
  });
});

describe('countEmpty, an account’s closed won opportunities', () => {
  /** The sales org, the first account holding an opportunity closed won beside its open one. */
  const wonOrg = (): EmptyFixtureOrg =>
    salesOrg({ extraRows: { Opportunity: [{ Id: 'O-WON', AccountId: 'A1', IsWon: true }] } });

  it('names an opportunity closed won as blocking its account emptied without the opportunities, where it was counted along and nothing said ("some opportunities of this account were closed won")', async () => {
    const counts = await counted(wonOrg(), ['Account']);

    expect(counts.blockers).toContainEqual({
      objectApiName: 'Opportunity',
      field: 'AccountId',
      parent: 'Account',
      records: { records: 1 },
      keeps: { records: 1 },
    });
  });

  it('says beyond Undo, at least, the opportunities closed won emptied with their account: refused at first, the account goes once its opportunities went alone', async () => {
    const won = (): EmptyFixtureOrg =>
      noCases({ extraRows: { Opportunity: [{ Id: 'O-WON', AccountId: 'A1', IsWon: true }] } });
    const counts = await counted(won(), ['Account', 'Opportunity']);
    const recycledForGood = await counted(won(), ['Account', 'Opportunity'], { undo: false });

    expect(counts.undoLost).toContainEqual({
      objectApiName: 'Opportunity',
      field: 'AccountId',
      parent: 'Account',
      reason: 'restricted',
      records: { records: 1, atLeast: true },
    });
    expect(counts.blockers.map((blocker) => blocker.objectApiName)).not.toContain('Opportunity');
    expect(recycledForGood.undoLost).toEqual([]);
  });

  it('says nothing of an account none of whose opportunities is closed won', async () => {
    const counts = await counted(salesOrg(), ['Account', 'Opportunity']);
    const along = await counted(salesOrg(), ['Account']);

    expect(
      counts.undoLost.map((lost) => `${lost.objectApiName}.${lost.field ?? ''}`),
    ).not.toContain('Opportunity.AccountId');
    expect(along.blockers.map((blocker) => blocker.objectApiName)).not.toContain('Opportunity');
  });

  it('counts an opportunity closed won among what blocks, never among what goes along: it stays, said apart, and so does every opportunity of its account', async () => {
    const counts = await counted(
      noCases({ extraRows: { Opportunity: [{ Id: 'O-WON', AccountId: 'A1', IsWon: true }] } }),
      ['Account'],
    );
    const opportunities = counts.along.find((along) => along.objectApiName === 'Opportunity');

    // The one under the second account goes; the one closed won stays, and
    // keeps its account, and the open one beside it with it.
    expect(opportunities).toMatchObject({
      records: { records: 1 },
      via: [{ field: 'AccountId', parent: 'Account', records: { records: 1 } }],
      blocking: { records: 1 },
    });
  });

  it('counts the accounts what blocks keeps, each once, though a case and an opportunity closed won both keep one', async () => {
    const counts = await counted(wonOrg(), ['Account']);

    // A case keeps each of two accounts; the opportunity, the first of them.
    expect(passOf(counts, 'Account')).toMatchObject({
      records: { records: 4 },
      blocked: { records: 2 },
    });
  });
});

describe('countEmpty, routes to a contact’s tasks', () => {
  /** Count an emptying of the contacts of {@link assetsOrg}. */
  const contacts = async (org = assetsOrg()): Promise<EmptyCounts> =>
    countedIn(
      org,
      ['Contact'],
      org.global().map((object) => object.name),
    );

  it('counts the task and the event that go with their contact by its own lookup, though its asset’s children name tasks first', async () => {
    const org = assetsOrg();
    const counts = await contacts(org);

    // Read live, every route of a task went up an asset's child, none up the
    // contact: the one task and the one event went with their contact unsaid.
    expect(org.sent.map(({ soql }) => soql)).toContain(
      "SELECT COUNT() FROM Task WHERE (Who.Type = 'Contact') AND (IsDeleted = false)",
    );
    for (const activity of ['Task', 'Event']) {
      expect(n(counts.along.find((along) => along.objectApiName === activity)?.records)).toBe(1);
    }
  });

  it('says a count whose routes were cut may count more, and through which objects they went', async () => {
    const counts = await contacts();
    const task = counts.along.find((along) => along.objectApiName === 'Task');

    expect(task?.records.atLeast).toBe(true);
    expect(task?.routesNotRead).toEqual([...ASSET_CHILDREN.slice(-3)].sort());
    expect(
      counts.along.find((along) => along.objectApiName === 'Task_Detail__c')?.routesNotRead,
    ).toEqual(['Task']);
  });
});

describe('countEmpty, what no undo brings back, together', () => {
  it('counts each record once: an order product lost before its product and before its price is one record', async () => {
    const counts = await counted(salesOrg(), WORKED);
    const pairs = counts.undoLost.reduce((sum, lost) => sum + (lost.records.records ?? 0), 0);
    const orderProducts = counts.undoLost.filter((lost) => lost.objectApiName === 'OrderItem');

    expect(orderProducts.map((lost) => n(lost.records))).toEqual([1, 1]);
    // Read live, 22 said lost for 16 records.
    expect(counts.undoLostRecords).toEqual({ records: 13 });
    expect(pairs).toBe(17);
  });

  it('counts an opportunity closed won lost before its account and before its price book once, at least', async () => {
    const org = noCases({
      extraRows: {
        Opportunity: [{ Id: 'O-WON', AccountId: 'A1', IsWon: true, Pricebook2Id: 'PBC' }],
      },
    });
    const counts = await counted(org, ['Account', 'Opportunity', 'Pricebook2']);
    const opportunities = counts.undoLost.filter((lost) => lost.objectApiName === 'Opportunity');

    expect(opportunities.map((lost) => lost.parent).sort()).toEqual(['Account', 'Pricebook2']);
    expect(
      org.sent.some(
        ({ soql }) =>
          soql.startsWith('SELECT COUNT() FROM Opportunity WHERE (') && soql.includes(' OR '),
      ),
    ).toBe(true);
    expect(counts.undoLostRecords.atLeast).toBe(true);
  });

  it('counts an object lost under two lookups by one statement of both', async () => {
    const org = salesOrg();
    await counted(org, WORKED);

    expect(org.sent.map(({ soql }) => soql)).toContain(
      'SELECT COUNT() FROM OrderItem WHERE (PricebookEntryId != null) OR (Product2.Id != null)',
    );
  });
});

/**
 * Price books, products and prices as a scratch org held them: the standard
 * book and a custom one, two products, a standard and a custom price of each,
 * and 34 prices whose book and product the org no longer holds. A price is
 * not brought back from the recycle bin on its own (`undeletable: false`).
 */
function priceOrg(): EmptyFixtureOrg {
  return new EmptyFixtureOrg([
    {
      name: 'Pricebook2',
      fields: [{ name: 'IsStandard' }],
      children: [{ childSObject: 'PricebookEntry', field: 'Pricebook2Id', cascadeDelete: true }],
      rows: [
        { Id: 'PBS', IsStandard: true },
        { Id: 'PBC', IsStandard: false },
      ],
    },
    {
      name: 'Product2',
      children: [
        {
          childSObject: 'PricebookEntry',
          field: 'Product2Id',
          cascadeDelete: true,
          restrictedDelete: true,
        },
      ],
      rows: [{ Id: 'P1' }, { Id: 'P2' }],
    },
    {
      name: 'PricebookEntry',
      global: { undeletable: false },
      fields: [
        { name: 'Pricebook2Id', referenceTo: ['Pricebook2'], relationshipName: 'Pricebook2' },
        { name: 'Product2Id', referenceTo: ['Product2'], relationshipName: 'Product2' },
      ],
      rows: [
        { Id: 'PES1', Pricebook2Id: 'PBS', Product2Id: 'P1' },
        { Id: 'PES2', Pricebook2Id: 'PBS', Product2Id: 'P2' },
        { Id: 'PEC1', Pricebook2Id: 'PBC', Product2Id: 'P1' },
        { Id: 'PEC2', Pricebook2Id: 'PBC', Product2Id: 'P2' },
        ...Array.from({ length: 34 }, (_, at) => ({
          Id: `PE-ORPHAN-${at}`,
          Pricebook2Id: 'PB-GONE',
          Product2Id: 'P-GONE',
        })),
      ],
    },
  ]);
}

const PRICES = ['Pricebook2', 'PricebookEntry', 'Product2'];

describe('countEmpty, prices', () => {
  it('counts the prices under the custom book it deletes, not those whose book the org no longer holds', async () => {
    const counts = await countedIn(priceOrg(), ['Pricebook2'], PRICES);

    expect(counts.along).toEqual([
      {
        objectApiName: 'PricebookEntry',
        records: { records: 2 },
        via: [
          {
            field: 'Pricebook2Id',
            parent: 'Pricebook2',
            emptied: 'Pricebook2',
            records: { records: 2 },
          },
        ],
      },
    ]);
  });

  it('counts the prices of the products it deletes, not those whose product the org no longer holds, and has the pass of the prices send those', async () => {
    const products = await countedIn(priceOrg(), ['Product2'], PRICES);
    const withPrices = await countedIn(priceOrg(), ['Product2', 'PricebookEntry'], PRICES);

    expect(products.along).toEqual([
      {
        objectApiName: 'PricebookEntry',
        records: { records: 4 },
        via: [
          {
            field: 'Product2Id',
            parent: 'Product2',
            emptied: 'Product2',
            records: { records: 4 },
          },
        ],
      },
    ]);
    // The 34 no product holds are the prices' own pass to send, beyond Undo.
    expect(passOf(withPrices, 'PricebookEntry')).toMatchObject({
      records: { records: 38 },
      sent: { records: 34 },
    });
    expect(withPrices.undoLost).toContainEqual({
      objectApiName: 'PricebookEntry',
      reason: 'notRestorable',
      records: { records: 34 },
    });
  });

  it('says beyond Undo the custom prices that go with their book before their product, not the standard ones, which came back with their product (seen live twice), nor those of a book emptied alone', async () => {
    const counts = await countedIn(priceOrg(), ['Pricebook2', 'Product2'], PRICES);
    const bookAlone = await countedIn(priceOrg(), ['Pricebook2'], PRICES);

    expect(counts.objects.map((pass) => pass.objectApiName)).toEqual(['Pricebook2', 'Product2']);
    expect(counts.undoLost).toEqual([
      {
        objectApiName: 'PricebookEntry',
        field: 'Product2Id',
        parent: 'Product2',
        reason: 'restricted',
        records: { records: 2 },
      },
    ]);
    // Seen live: with the products staying, the custom prices came back with their book.
    expect(bookAlone.undoLost).toEqual([]);
  });

  it('says beyond Undo what the pass of the prices sends itself, those no book held among them', async () => {
    const alone = await countedIn(priceOrg(), ['PricebookEntry'], PRICES);
    const withBook = await countedIn(priceOrg(), ['Pricebook2', 'PricebookEntry'], PRICES);

    expect(alone.undoLost).toEqual([
      { objectApiName: 'PricebookEntry', reason: 'notRestorable', records: { records: 38 } },
    ]);
    // The custom prices go with their book, and come back with it; the
    // standard ones and those no book held are sent alone.
    expect(passOf(withBook, 'PricebookEntry')).toMatchObject({
      records: { records: 38 },
      sent: { records: 36 },
    });
    expect(withBook.undoLost).toEqual([
      { objectApiName: 'PricebookEntry', reason: 'notRestorable', records: { records: 36 } },
    ]);
  });

  it('says nothing beyond Undo of records deleted for good, which none brings back', async () => {
    const counts = await countEmptyFor(priceOrg(), PRICES, { undo: false });

    expect(counts.undoLost).toEqual([]);
  });
});

/** {@link countedIn} of the prices, with the options of a count. */
async function countEmptyFor(
  org: EmptyFixtureOrg,
  emptied: readonly string[],
  options: { undo: boolean },
): Promise<EmptyCounts> {
  const describes = new Map<string, EmptyDescribe>();
  for (const name of PRICES) {
    describes.set(name, emptyDescribeSchema.parse(await org.describe(name)));
  }
  const affected = affectedBy(emptied, PRICES, describes);
  const relations = relationsOf(describes);
  return countEmpty(
    { affected, order: emptyOrderOf(affected, relations), relations, describes },
    org,
    undefined,
    options,
  );
}

describe('countEmpty, what it cannot count', () => {
  it('keeps the org’s words for a count it refused, never a zero, and says what goes with it as unknown', async () => {
    const org = salesOrg();
    org.refusals.set('Contact', 'QUERY_TIMEOUT: Your query request was running for too long.');

    const counts = await counted(org, ['Account', 'Contact']);

    expect(passOf(counts, 'Contact').records).toEqual({
      unread: 'QUERY_TIMEOUT: Your query request was running for too long.',
    });
    expect(passOf(counts, 'Contact').sent.records).toBeUndefined();
  });

  it('sends nothing more once stopped, and says it stopped', async () => {
    const org = salesOrg();
    let asked = 0;
    const counts = await counted(org, WORKED, { stopped: () => ++asked > 3 });

    expect(counts.stopped).toBe(true);
    expect(org.sent).toHaveLength(3);
    expect(
      counts.objects.filter((object) => object.records.records === undefined).length,
    ).toBeGreaterThan(0);
  });

  it('asks nothing more of an object that holds no record: nothing goes along with it', async () => {
    const held = salesOrg();
    const withRecords = await counted(held, ['Campaign']);
    const empty = salesOrg({ emptyObjects: ['Campaign'] });

    const without = await counted(empty, ['Campaign']);

    expect(withRecords.along.map((object) => object.objectApiName)).toEqual(['CampaignMember']);
    expect(held.sent.length).toBeGreaterThan(1);
    expect(without.along).toEqual([]);
    expect(empty.sent).toEqual([{ soql: 'SELECT COUNT() FROM Campaign', all: false }]);
    expect(without.statements).toBe(1);
  });

  it('counts nothing an undo would lose for records deleted for good', async () => {
    const counts = await counted(salesOrg(), WORKED, { undo: false });

    expect(counts.undoLost).toEqual([]);
  });
});
