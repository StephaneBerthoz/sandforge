import { describe, expect, it } from 'vitest';
import { EmptyFixtureOrg, salesOrg, type FixtureObject } from '../../../test/emptyFixtureOrg';
import { emptyOrderOf, orderConstraintsOf, type EmptyOrder } from './emptyOrder';
import {
  affectedBy,
  emptyDescribeSchema,
  relationsOf,
  type Affected,
  type EmptyDescribe,
} from './emptyRelations';

/** The objects of the sales org an emptying of the whole org empties. */
const WHOLE_ORG = [
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

/** The order of emptying `emptied` in `org`, every object of `worked` described. */
async function orderOf(
  org: EmptyFixtureOrg,
  emptied: readonly string[],
  worked: readonly string[],
): Promise<{ order: EmptyOrder; affected: Affected }> {
  const describes = new Map<string, EmptyDescribe>();
  for (const name of new Set([...worked, ...emptied])) {
    describes.set(name, emptyDescribeSchema.parse(await org.describe(name)));
  }
  const affected = affectedBy(emptied, worked, describes);
  return { order: emptyOrderOf(affected, relationsOf(describes)), affected };
}

/** Whether `first` comes before `then` among `order`'s passes. */
function before(order: EmptyOrder, first: string, then: string): boolean {
  const names = order.passes.map((pass) => pass.objectApiName);
  expect(names).toContain(first);
  expect(names).toContain(then);
  return names.indexOf(first) < names.indexOf(then);
}

describe('emptyOrderOf, the whole sales org', () => {
  it('has one pass per emptied object, and no constraint gives way', async () => {
    const { order } = await orderOf(salesOrg(), WHOLE_ORG, WHOLE_ORG);

    expect(order.passes.map((pass) => pass.objectApiName).sort()).toEqual([...WHOLE_ORG].sort());
    expect(order.unordered).toEqual([]);
  });

  it('deletes a parent before the records its delete takes along, so that they come back with it', async () => {
    const { order } = await orderOf(salesOrg(), WHOLE_ORG, WHOLE_ORG);

    for (const child of [
      'Contact',
      'Opportunity',
      'Order',
      'Contract',
      'Asset',
      'AccountContactRelation',
    ]) {
      expect(before(order, 'Account', child)).toBe(true);
    }
    expect(before(order, 'Opportunity', 'OpportunityLineItem')).toBe(true);
    expect(before(order, 'Opportunity', 'Quote')).toBe(true);
    expect(before(order, 'Quote', 'QuoteLineItem')).toBe(true);
    expect(before(order, 'Order', 'OrderItem')).toBe(true);
    expect(before(order, 'Case', 'CaseComment')).toBe(true);
    expect(before(order, 'Campaign', 'CampaignMember')).toBe(true);
  });

  it('deletes cases before their accounts and contacts, whose delete their lookups refuse', async () => {
    const { order } = await orderOf(salesOrg(), WHOLE_ORG, WHOLE_ORG);

    expect(before(order, 'Case', 'Account')).toBe(true);
    expect(before(order, 'Case', 'Contact')).toBe(true);
    expect(order.beforeParent).toEqual(
      expect.arrayContaining([
        { objectApiName: 'Case', field: 'AccountId', parent: 'Account', reason: 'restricted' },
        { objectApiName: 'Case', field: 'ContactId', parent: 'Contact', reason: 'restricted' },
      ]),
    );
  });

  it('deletes opportunities, quotes, orders and contracts before their price book, and order products, quote lines and assets before their product', async () => {
    const { order } = await orderOf(salesOrg(), WHOLE_ORG, WHOLE_ORG);

    for (const child of ['Opportunity', 'Quote', 'Order', 'Contract']) {
      expect(before(order, child, 'Pricebook2')).toBe(true);
    }
    for (const child of ['OrderItem', 'QuoteLineItem', 'Asset']) {
      expect(before(order, child, 'Product2')).toBe(true);
    }
  });

  it('deletes the lines naming a price before every object whose delete takes that price along', async () => {
    const { order } = await orderOf(salesOrg(), WHOLE_ORG, WHOLE_ORG);

    for (const line of ['OpportunityLineItem', 'QuoteLineItem', 'OrderItem']) {
      for (const carrier of ['PricebookEntry', 'Pricebook2', 'Product2']) {
        expect(before(order, line, carrier)).toBe(true);
      }
    }
  });

  it('deletes the custom price books before the products, so that custom prices go before standard ones, and says the pair', async () => {
    const { order } = await orderOf(salesOrg(), WHOLE_ORG, WHOLE_ORG);

    expect(before(order, 'Pricebook2', 'Product2')).toBe(true);
    expect(order.beforeParent).toContainEqual({
      objectApiName: 'PricebookEntry',
      field: 'Product2Id',
      parent: 'Product2',
      reason: 'customPrices',
    });
  });

  it('deletes an order before the contact it bills, but says no pair for an order and a contact one account deletes together', async () => {
    const { order } = await orderOf(salesOrg(), WHOLE_ORG, WHOLE_ORG);

    expect(before(order, 'Order', 'Contact')).toBe(true);
    expect(before(order, 'Account', 'Order')).toBe(true);
  });

  it('says what each pass leaves to its own deletes: the routes of the parents deleted before it', async () => {
    const { order } = await orderOf(salesOrg(), WHOLE_ORG, WHOLE_ORG);
    const contact = order.passes.find((pass) => pass.objectApiName === 'Contact');

    expect(contact?.goneBefore.map((route) => route.emptied)).toEqual(['Account']);
    expect(contact?.sentBeforeTheirParent).toEqual([]);
  });

  it('sets orders back to Draft before any delete, never contracts, which the org deletes as they stand', async () => {
    const { order } = await orderOf(salesOrg(), WHOLE_ORG, WHOLE_ORG);

    expect(order.toDraft).toEqual(['Order']);
  });
});

describe('emptyOrderOf, objects picked', () => {
  it('sets orders back to Draft when they only go along with their account', async () => {
    const { order } = await orderOf(salesOrg(), ['Account'], WHOLE_ORG);

    expect(order.toDraft).toEqual(['Order']);
    expect(order.passes.map((pass) => pass.objectApiName)).toEqual(['Account']);
  });

  it('deletes an account before a price book its opportunities name, the opportunities going along with it, and says they go before the price book', async () => {
    const { order } = await orderOf(salesOrg(), ['Account', 'Pricebook2'], WHOLE_ORG);

    expect(before(order, 'Account', 'Pricebook2')).toBe(true);
    expect(order.beforeParent).toContainEqual({
      objectApiName: 'Opportunity',
      field: 'Pricebook2Id',
      parent: 'Pricebook2',
      reason: 'restricted',
    });
  });

  it('places by what goes along, not by name: a zone whose deals name a book goes before the book', async () => {
    const objects: FixtureObject[] = [
      {
        name: 'Book__c',
        children: [{ childSObject: 'Deal__c', field: 'Book__c', restrictedDelete: true }],
      },
      {
        name: 'Zone__c',
        children: [{ childSObject: 'Deal__c', field: 'Zone__c', cascadeDelete: true }],
      },
      { name: 'Deal__c' },
    ];
    const names = objects.map((object) => object.name);
    const { order } = await orderOf(new EmptyFixtureOrg(objects), ['Book__c', 'Zone__c'], names);

    expect(order.passes.map((pass) => pass.objectApiName)).toEqual(['Zone__c', 'Book__c']);
    expect(order.beforeParent).toEqual([
      { objectApiName: 'Deal__c', field: 'Book__c', parent: 'Book__c', reason: 'restricted' },
    ]);
  });
});

describe('where objects point at each other', () => {
  it('lets a parent-first constraint give way before a refused delete, says it, and says the records then sent before their parent', async () => {
    // X takes Y along, Y names W through a lookup that refuses W's delete, W
    // takes V along, and V names X so: one of the four must give way.
    const objects: FixtureObject[] = [
      {
        name: 'X__c',
        children: [
          { childSObject: 'Y__c', field: 'X__c', cascadeDelete: true },
          { childSObject: 'V__c', field: 'Hold_X__c', restrictedDelete: true },
        ],
      },
      {
        name: 'W__c',
        children: [
          { childSObject: 'V__c', field: 'W__c', cascadeDelete: true },
          { childSObject: 'Y__c', field: 'Hold_W__c', restrictedDelete: true },
        ],
      },
      { name: 'Y__c' },
      { name: 'V__c' },
    ];
    const names = objects.map((object) => object.name);
    const { order } = await orderOf(new EmptyFixtureOrg(objects), names, names);

    expect(order.passes.map((pass) => pass.objectApiName)).toEqual([
      'V__c',
      'X__c',
      'Y__c',
      'W__c',
    ]);
    expect(order.unordered).toEqual([{ first: 'W__c', then: 'V__c', reason: 'cascade' }]);
    expect(order.passes[0].sentBeforeTheirParent.map((route) => route.emptied)).toEqual(['W__c']);
  });

  it('adds no constraint for a refusing lookup to an object that takes the record along itself: one delete takes both, and what crosses from one record to another is tried again', async () => {
    const objects: FixtureObject[] = [
      {
        name: 'Parent__c',
        children: [
          { childSObject: 'Child__c', field: 'Parent__c', cascadeDelete: true },
          { childSObject: 'Child__c', field: 'Hold__c', restrictedDelete: true },
        ],
      },
      { name: 'Child__c' },
    ];
    const names = objects.map((object) => object.name);
    const { order } = await orderOf(new EmptyFixtureOrg(objects), names, names);

    expect(order.passes.map((pass) => pass.objectApiName)).toEqual(['Parent__c', 'Child__c']);
    expect(order.unordered).toEqual([]);
    expect(order.beforeParent).toEqual([]);
  });

  it('keeps a parent first before a plain lookup that points the other way, and says the lookup that gave way', async () => {
    const objects: FixtureObject[] = [
      {
        name: 'Widget__c',
        children: [
          { childSObject: 'Gadget__c', field: 'Widget__c', cascadeDelete: true },
          { childSObject: 'Gadget__c', field: 'Other__c' },
        ],
      },
      { name: 'Gadget__c' },
    ];
    const names = objects.map((object) => object.name);
    const { order } = await orderOf(new EmptyFixtureOrg(objects), names, names);

    expect(order.passes.map((pass) => pass.objectApiName)).toEqual(['Widget__c', 'Gadget__c']);
    expect(order.unordered).toEqual([{ first: 'Gadget__c', then: 'Widget__c', reason: 'lookup' }]);
  });

  it('orders by a plain lookup where nothing else does, the record naming before the record named, as a removal does', async () => {
    const objects: FixtureObject[] = [
      { name: 'Alpha__c', children: [{ childSObject: 'Beta__c', field: 'Alpha__c' }] },
      { name: 'Beta__c' },
    ];
    const names = objects.map((object) => object.name);
    const { order } = await orderOf(new EmptyFixtureOrg(objects), names, names);

    expect(order.passes.map((pass) => pass.objectApiName)).toEqual(['Beta__c', 'Alpha__c']);
    expect(order.unordered).toEqual([]);
    expect(order.beforeParent).toEqual([]);
  });
});

describe('orderConstraintsOf', () => {
  it('says no constraint of an object nothing deletes: a portal user’s contact blocks, it does not order', async () => {
    const org = salesOrg();
    const describes = new Map<string, EmptyDescribe>();
    for (const name of [...WHOLE_ORG, 'User']) {
      describes.set(name, emptyDescribeSchema.parse(await org.describe(name)));
    }
    const affected = affectedBy(WHOLE_ORG, WHOLE_ORG, describes);

    const { constraints } = orderConstraintsOf(affected, relationsOf(describes));

    expect(
      constraints.some((constraint) => constraint.first === 'User' || constraint.then === 'User'),
    ).toBe(false);
  });
});
