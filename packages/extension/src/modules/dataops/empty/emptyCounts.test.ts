import { describe, expect, it } from 'vitest';
import { salesOrg, type EmptyFixtureOrg } from '../../../test/emptyFixtureOrg';
import { countEmpty, type Counted, type EmptyCounts } from './emptyCounts';
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

  it('counts what no undo would bring back: cases before their accounts and contacts, what names a custom price book or a product before it goes, the custom prices', async () => {
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
      ['PricebookEntry.Product2Id → Product2 (customPrices)', 1],
    ]);
  });

  it('names the portal user who keeps a contact, and the activated order the run sets back to Draft first', async () => {
    const counts = await counted(salesOrg(), WORKED);

    expect(counts.blockers).toEqual([
      { objectApiName: 'User', field: 'ContactId', parent: 'Contact', records: { records: 1 } },
    ]);
    expect(counts.refusals).toEqual([
      { code: 'activatedOrder', objectApiName: 'Order', records: { records: 1 } },
      { code: 'standardPriceBook', objectApiName: 'Pricebook2', records: { records: 1 } },
    ]);
  });

  it('names no id in any statement: every count reads a whole table', async () => {
    const org = salesOrg();
    await counted(org, WORKED);

    const ids = org.ids();
    const literals = org.sent.flatMap(({ soql }) =>
      (soql.match(/'[^']*'/g) ?? []).map((quoted) => quoted.slice(1, -1)),
    );
    expect(org.sent.length).toBeGreaterThan(0);
    expect(org.sent.filter(({ soql }) => /\bIN\s*\(/i.test(soql))).toEqual([]);
    expect(literals.filter((literal) => ids.has(literal))).toEqual([]);
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
    const counts = await counted(salesOrg(), ['Account']);

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
    const counts = await counted(salesOrg(), ['Account']);
    const task = counts.along.find((object) => object.objectApiName === 'Task');

    expect(task?.records).toEqual({ records: 3, atMost: true });
    expect(task?.via.find((route) => route.parent === 'Account')?.records).toEqual({ records: 2 });
  });

  it('names the cases of an account and of its contacts and the portal user of its contact, whose lookups refuse their delete', async () => {
    const counts = await counted(salesOrg(), ['Account']);

    expect(counts.blockers).toEqual([
      { objectApiName: 'Case', field: 'AccountId', parent: 'Account', records: { records: 2 } },
      { objectApiName: 'Case', field: 'ContactId', parent: 'Contact', records: { records: 1 } },
      { objectApiName: 'User', field: 'ContactId', parent: 'Contact', records: { records: 1 } },
    ]);
  });

  it('sets back to Draft the activated orders that go along with their account', async () => {
    const counts = await counted(salesOrg(), ['Account']);

    expect(counts.refusals).toEqual([
      { code: 'activatedOrder', objectApiName: 'Order', records: { records: 1 } },
    ]);
  });

  it('names an opportunity under no account that keeps a price book emptied with the accounts, and counts the ones that go with their account as lost to an undo', async () => {
    const counts = await counted(salesOrg(), ['Account', 'Pricebook2']);

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
      { objectApiName: 'Case', field: 'ContactId', parent: 'Contact', records: { records: 2 } },
      {
        objectApiName: 'Order',
        field: 'BillToContactId',
        parent: 'Contact',
        records: { records: 1 },
      },
      { objectApiName: 'User', field: 'ContactId', parent: 'Contact', records: { records: 1 } },
    ]);
  });
});

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
