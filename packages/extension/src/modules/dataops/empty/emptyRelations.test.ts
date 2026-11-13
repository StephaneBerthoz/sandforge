import { describe, expect, it } from 'vitest';
import {
  ASSET_CHILDREN,
  EmptyFixtureOrg,
  assetsOrg,
  salesOrg,
  type FixtureObject,
} from '../../../test/emptyFixtureOrg';
import {
  affectedBy,
  anyRouteCondition,
  carriersOf,
  countedWithArchived,
  deletedRowsOf,
  emptyDescribeSchema,
  hangsFromCondition,
  keptRowsOf,
  MOST_ROUTES,
  namesDeletedCondition,
  relationKindOf,
  relationsOf,
  stepsCondition,
  type EmptyDescribe,
} from './emptyRelations';

/** The describes `org` gives of `names`, those it refuses left out. */
async function describesOf(
  org: EmptyFixtureOrg,
  names: readonly string[],
): Promise<Map<string, EmptyDescribe>> {
  const describes = new Map<string, EmptyDescribe>();
  for (const name of names) {
    try {
      describes.set(name, emptyDescribeSchema.parse(await org.describe(name)));
    } catch {
      // Refused: left undescribed.
    }
  }
  return describes;
}

const SALES = [
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
  'User',
];

describe('relationKindOf', () => {
  it('reads a lookup flagged both ways as one that takes its records along, as the removal and the checkpoint read it', () => {
    expect(relationKindOf({ cascadeDelete: true, restrictedDelete: true })).toBe('cascade');
    expect(relationKindOf({ cascadeDelete: true })).toBe('cascade');
    expect(relationKindOf({ restrictedDelete: true })).toBe('restricted');
    expect(relationKindOf({})).toBe('lookup');
  });

  it('reads an entitlement’s account as a lookup that refuses the delete, flagged both ways as it is: the org refused the account while one lived', () => {
    const entitlement = {
      childSObject: 'Entitlement',
      field: 'AccountId',
      cascadeDelete: true,
      restrictedDelete: true,
    };

    expect(relationKindOf(entitlement, 'Account')).toBe('restricted');
    expect(relationKindOf({ ...entitlement, childSObject: 'entitlement' }, 'account')).toBe(
      'restricted',
    );
    // An order's account, flagged the same way, takes its orders along once
    // they are back to Draft; a price's product takes its standard prices.
    expect(relationKindOf({ ...entitlement, childSObject: 'Order' }, 'Account')).toBe('cascade');
    expect(
      relationKindOf(
        { ...entitlement, childSObject: 'PricebookEntry', field: 'Product2Id' },
        'Product2',
      ),
    ).toBe('cascade');
  });
});

describe('relationsOf', () => {
  it('lists every lookup the parents’ describes name, by the names the org gives the objects', async () => {
    const org = salesOrg();
    const describes = await describesOf(org, ['Pricebook2']);

    expect(relationsOf(describes, (name) => (name === 'quote' ? 'Quote' : name))).toEqual([
      { parent: 'Pricebook2', child: 'PricebookEntry', field: 'Pricebook2Id', kind: 'cascade' },
      { parent: 'Pricebook2', child: 'Opportunity', field: 'Pricebook2Id', kind: 'restricted' },
      { parent: 'Pricebook2', child: 'Quote', field: 'Pricebook2Id', kind: 'restricted' },
      { parent: 'Pricebook2', child: 'Order', field: 'Pricebook2Id', kind: 'restricted' },
      { parent: 'Pricebook2', child: 'Contract', field: 'Pricebook2Id', kind: 'restricted' },
    ]);
  });
});

describe('the rows an emptying keeps', () => {
  it('keeps the standard price book, read by IsStandard and never by its name, and deletes every other row of every object', () => {
    expect(keptRowsOf('Pricebook2')).toBe('IsStandard = true');
    expect(deletedRowsOf('pricebook2')).toBe('IsStandard = false');
    expect(keptRowsOf('Account')).toBeUndefined();
    expect(deletedRowsOf('Account')).toBeUndefined();
  });

  it('counts tasks and events through queryAll, which alone reads the archived ones', () => {
    expect(countedWithArchived('Task')).toBe(true);
    expect(countedWithArchived('Event')).toBe(true);
    expect(countedWithArchived('Case')).toBe(false);
  });
});

describe('affectedBy', () => {
  it('takes along, from an account, its contacts, opportunities, orders and what hangs from them, never its cases, whose lookup refuses its delete', async () => {
    const org = salesOrg();
    const describes = await describesOf(org, SALES);

    const affected = affectedBy(['Account'], SALES, describes);

    expect(affected.along).toEqual(
      [
        'AccountContactRelation',
        'Asset',
        'CampaignMember',
        'Contact',
        'Contract',
        'Event',
        'OpportunityContactRole',
        'OpportunityLineItem',
        'Opportunity',
        'Order',
        'OrderItem',
        'Quote',
        'QuoteLineItem',
        'Task',
      ].sort(),
    );
    expect(affected.routes.has('Case')).toBe(false);
    expect(affected.undescribed).toEqual([]);
  });

  it('reads a route up every lookup that takes records along, the emptied object at its top', async () => {
    const org = salesOrg();
    const describes = await describesOf(org, SALES);

    const affected = affectedBy(['Account'], SALES, describes);

    expect(affected.routes.get('QuoteLineItem')).toEqual([
      {
        object: 'QuoteLineItem',
        steps: [
          { object: 'QuoteLineItem', field: 'QuoteId', parent: 'Quote' },
          { object: 'Quote', field: 'OpportunityId', parent: 'Opportunity' },
          { object: 'Opportunity', field: 'AccountId', parent: 'Account' },
        ],
        emptied: 'Account',
      },
    ]);
  });

  it('ends a route at an emptied object: what hangs from it is read from it', async () => {
    const org = salesOrg();
    const describes = await describesOf(org, SALES);

    const affected = affectedBy(['Account', 'Opportunity'], SALES, describes);

    expect(affected.along).not.toContain('Opportunity');
    expect(affected.routes.get('Opportunity')?.map((route) => route.emptied)).toEqual(['Account']);
    expect(affected.routes.get('OpportunityLineItem')?.map((route) => route.emptied)).toEqual([
      'Opportunity',
    ]);
  });

  it('leaves out of what goes along the objects no one works in: histories, sharing, feeds', async () => {
    const org = salesOrg();
    const describes = await describesOf(org, SALES);

    const affected = affectedBy(['Account'], SALES, describes);

    expect(affected.routes.has('AccountHistory')).toBe(false);
    expect(affected.routes.has('AccountShare')).toBe(false);
    expect(affected.routes.has('AccountFeed')).toBe(false);
  });

  it('names the objects going along it could not read further for want of a describe', async () => {
    const org = salesOrg();
    const describes = await describesOf(org, ['Account']);

    const affected = affectedBy(['Account'], SALES, describes);

    expect(affected.undescribed).toContain('Contact');
    expect(affected.undescribed).toContain('Opportunity');
    expect(affected.routes.has('OpportunityLineItem')).toBe(false);
  });

  it('reads every lookup from an emptied object, however many: the cap cuts longer routes alone', async () => {
    const parents: FixtureObject[] = Array.from({ length: MOST_ROUTES + 2 }, (_, at) => ({
      name: `Parent${at}__c`,
      children: [{ childSObject: 'Child__c', field: `Parent${at}__c`, cascadeDelete: true }],
    }));
    const org = new EmptyFixtureOrg([...parents, { name: 'Child__c' }]);
    const names = [...parents.map((parent) => parent.name), 'Child__c'];
    const describes = await describesOf(org, names);

    const affected = affectedBy(
      parents.map((parent) => parent.name),
      names,
      describes,
    );

    expect(affected.routes.get('Child__c')).toHaveLength(MOST_ROUTES + 2);
    expect(affected.routesCut.size).toBe(0);
  });

  it('reads a contact’s own lookups before any longer path: its tasks and events by WhoId, though its asset’s children name them first', async () => {
    const org = assetsOrg();
    const names = org.global().map((object) => object.name);
    const describes = await describesOf(org, names);

    const affected = affectedBy(['Contact'], names, describes);

    // Read down each lookup in turn, the asset's children filled the routes
    // of a task and an event before their own lookup to the contact came.
    for (const activity of ['Task', 'Event']) {
      expect(affected.routes.get(activity)?.[0]).toEqual({
        object: activity,
        steps: [{ object: activity, field: 'WhoId', parent: 'Contact' }],
        emptied: 'Contact',
      });
    }
  });

  it('cuts the longer routes past the cap, and names the objects they went through, and so for what is read up a cut object, unless its lookup reads by type', async () => {
    const org = assetsOrg();
    const names = org.global().map((object) => object.name);
    const describes = await describesOf(org, names);

    const affected = affectedBy(['Contact'], names, describes);

    // Its own lookup, its asset's and its contact participant's, then the
    // asset's children's, up to the cap: the last three are left.
    expect(affected.routes.get('Task')).toHaveLength(MOST_ROUTES);
    expect(affected.routesCut.get('Task')).toEqual([...ASSET_CHILDREN.slice(-3)].sort());
    expect(affected.routesCut.get('Task_Detail__c')).toContain('Task');
    // An attachment is read by the type of what it hangs from, whichever way that goes.
    expect(affected.routesCut.has('Attachment')).toBe(false);
    expect(affected.routesCut.has('Asset')).toBe(false);
  });
});

describe('carriersOf', () => {
  it('names every emptied object whose deletes take an object’s records away, up the lookups that take them along', async () => {
    const org = salesOrg();
    const describes = await describesOf(org, SALES);
    const affected = affectedBy(
      ['Account', 'Opportunity', 'OpportunityLineItem'],
      SALES,
      describes,
    );

    expect([...carriersOf('OpportunityLineItem', affected)].sort()).toEqual([
      'Account',
      'Opportunity',
      'OpportunityLineItem',
    ]);
    expect([...carriersOf('Quote', affected)].sort()).toEqual(['Account', 'Opportunity']);
    expect([...carriersOf('Case', affected)]).toEqual([]);
  });
});

describe('the conditions of a count', () => {
  it('reads a path of lookups by their relationship names, the last lookup filled', async () => {
    const org = salesOrg();
    const describes = await describesOf(org, SALES);
    const affected = affectedBy(['Account'], SALES, describes);
    const route = affected.routes.get('QuoteLineItem')?.[0];
    if (!route) throw new Error('A quote line goes with its account');

    expect(stepsCondition(route.steps, describes)).toEqual({
      soql: 'Quote.Opportunity.AccountId != null',
      exact: true,
    });
  });

  it('reads a lookup to several objects by the type of what it names, and goes no further through it, saying it may count more', async () => {
    const org = salesOrg();
    const describes = await describesOf(org, SALES);

    expect(
      stepsCondition([{ object: 'Task', field: 'WhatId', parent: 'Account' }], describes),
    ).toEqual({ soql: "What.Type = 'Account'", exact: true });
    expect(
      stepsCondition(
        [
          { object: 'Task', field: 'WhoId', parent: 'Contact' },
          { object: 'Contact', field: 'AccountId', parent: 'Account' },
        ],
        describes,
      ),
    ).toEqual({ soql: "Who.Type = 'Contact'", exact: false });
  });

  it('leaves out what names, by its last lookup, a record that stays — or where a lookup to several objects stops it, one that hangs from such a record —, and says it may count more where those records were too many to name', async () => {
    const org = salesOrg();
    const describes = await describesOf(org, SALES);
    const kept = (ids: Record<string, readonly string[] | 'unnamed'>) => (name: string) =>
      ids[name];
    const line = [
      { object: 'QuoteLineItem', field: 'QuoteId', parent: 'Quote' },
      { object: 'Quote', field: 'OpportunityId', parent: 'Opportunity' },
      { object: 'Opportunity', field: 'AccountId', parent: 'Account' },
    ];
    const task = [
      { object: 'Task', field: 'WhoId', parent: 'Contact' },
      { object: 'Contact', field: 'AccountId', parent: 'Account' },
    ];

    expect(stepsCondition(line, describes, deletedRowsOf, kept({ Account: ['A1', 'A2'] }))).toEqual(
      {
        soql: "Quote.Opportunity.AccountId != null AND Quote.Opportunity.AccountId NOT IN ('A1', 'A2')",
        exact: true,
      },
    );
    expect(stepsCondition(line, describes, deletedRowsOf, kept({ Account: 'unnamed' }))).toEqual({
      soql: 'Quote.Opportunity.AccountId != null',
      exact: false,
    });
    expect(stepsCondition(task, describes, deletedRowsOf, kept({ Contact: ['C1'] }))).toEqual({
      soql: "Who.Type = 'Contact' AND WhoId NOT IN ('C1')",
      exact: false,
    });
  });

  it('reads which records hang from given ones up a route, where it reads to its last lookup', async () => {
    const org = salesOrg();
    const describes = await describesOf(org, SALES);

    expect(
      hangsFromCondition(
        [
          { object: 'Quote', field: 'OpportunityId', parent: 'Opportunity' },
          { object: 'Opportunity', field: 'AccountId', parent: 'Account' },
        ],
        describes,
        ['A1'],
      ),
    ).toBe("Opportunity.AccountId IN ('A1')");
    // Past a lookup to several objects, no statement reads which.
    expect(
      hangsFromCondition(
        [
          { object: 'Task', field: 'WhatId', parent: 'Opportunity' },
          { object: 'Opportunity', field: 'AccountId', parent: 'Account' },
        ],
        describes,
        ['A1'],
      ),
    ).toBeUndefined();
  });

  it('reads a lookup to the price book as one to a price book it deletes, there to be read: the standard one is kept', async () => {
    const org = salesOrg();
    const describes = await describesOf(org, SALES);

    // The org reads `Pricebook2.IsStandard = false` true of a record naming no
    // book it holds: an opportunity under none, a price whose book is gone.
    expect(
      stepsCondition(
        [{ object: 'Opportunity', field: 'Pricebook2Id', parent: 'Pricebook2' }],
        describes,
      ),
    ).toEqual({ soql: 'Pricebook2.Id != null AND Pricebook2.IsStandard = false', exact: true });
  });

  it('reads a lookup to a product with its product there, as the book’s, every row of it deleted; and a lookup to a contact with the rows an emptying says it deletes', async () => {
    const org = salesOrg();
    const describes = await describesOf(org, SALES);

    expect(
      stepsCondition(
        [{ object: 'PricebookEntry', field: 'Product2Id', parent: 'Product2' }],
        describes,
      ),
    ).toEqual({ soql: 'Product2.Id != null', exact: true });
    const contact = [{ object: 'Case', field: 'ContactId', parent: 'Contact' }];
    expect(stepsCondition(contact, describes)).toEqual({ soql: 'ContactId != null', exact: true });
    expect(
      stepsCondition(contact, describes, (name) =>
        name === 'Contact' ? 'IsPersonAccount = false' : undefined,
      ),
    ).toEqual({ soql: 'Contact.Id != null AND Contact.IsPersonAccount = false', exact: true });
  });

  it('counts the prices under the book it deletes, not those whose book the org no longer holds, nor an opportunity under no book', async () => {
    const org = salesOrg({
      extraRows: {
        PricebookEntry: Array.from({ length: 34 }, (_, at) => ({
          Id: `PE-ORPHAN-${at}`,
          Pricebook2Id: 'PB-GONE',
          Product2Id: 'P-GONE',
        })),
      },
    });
    const describes = await describesOf(org, SALES);
    const prices = stepsCondition(
      [{ object: 'PricebookEntry', field: 'Pricebook2Id', parent: 'Pricebook2' }],
      describes,
    );
    const opportunities = stepsCondition(
      [{ object: 'Opportunity', field: 'Pricebook2Id', parent: 'Pricebook2' }],
      describes,
    );

    // The custom book holds one price; the org read the orphans along too.
    expect(await org.count(`SELECT COUNT() FROM PricebookEntry WHERE ${prices?.soql}`)).toBe(1);
    expect(
      await org.count('SELECT COUNT() FROM PricebookEntry WHERE Pricebook2.IsStandard = false'),
    ).toBe(35);
    // Two opportunities in the custom book, one in the standard one.
    expect(await org.count(`SELECT COUNT() FROM Opportunity WHERE ${opportunities?.soql}`)).toBe(2);
  });

  it('reads a lookup its describe flags as pointing at several objects by the type of what it names, though it names one', async () => {
    const objects: FixtureObject[] = [
      {
        name: 'Account',
        children: [{ childSObject: 'Asset', field: 'AccountId', cascadeDelete: true }],
        rows: [{ Id: 'A1' }],
      },
      {
        name: 'Asset',
        fields: [{ name: 'AccountId', referenceTo: ['Account'], relationshipName: 'Account' }],
        children: [
          { childSObject: 'AsyncOperationLog', field: 'RelatedRecordId', cascadeDelete: true },
        ],
        rows: [{ Id: 'AS1', AccountId: 'A1' }],
      },
      {
        name: 'AsyncOperationLog',
        fields: [
          {
            name: 'RelatedRecordId',
            referenceTo: ['Asset'],
            relationshipName: 'RelatedRecord',
            polymorphic: true,
          },
        ],
        rows: [{ Id: 'LOG1', RelatedRecordId: 'AS1' }, { Id: 'LOG2' }],
      },
    ];
    const org = new EmptyFixtureOrg(objects);
    const names = objects.map((object) => object.name);
    const describes = await describesOf(org, names);
    const route = affectedBy(['Account'], names, describes).routes.get('AsyncOperationLog')?.[0];
    if (!route) throw new Error('A log goes with the asset its account takes along');
    const condition = stepsCondition(route.steps, describes);

    expect(condition).toEqual({ soql: "RelatedRecord.Type = 'Asset'", exact: false });
    expect(await org.count(`SELECT COUNT() FROM AsyncOperationLog WHERE ${condition?.soql}`)).toBe(
      1,
    );
    // Read as a lookup to one object, the path the org refused.
    await expect(
      org.count('SELECT COUNT() FROM AsyncOperationLog WHERE RelatedRecord.AccountId != null'),
    ).rejects.toThrow("No such column 'AccountId' on entity 'Name'");
  });

  it('reads nothing through a lookup the user cannot see, and the lookup alone of an object not described', async () => {
    const org = salesOrg();
    const describes = await describesOf(org, ['Contact']);

    expect(
      stepsCondition([{ object: 'Contact', field: 'Hidden__c', parent: 'Account' }], describes),
    ).toBe(undefined);
    expect(
      stepsCondition([{ object: 'User', field: 'ContactId', parent: 'Contact' }], describes),
    ).toEqual({
      soql: 'ContactId != null',
      exact: false,
    });
  });

  it('joins the routes into one object by OR, each in parentheses', async () => {
    const org = salesOrg();
    const describes = await describesOf(org, SALES);
    const affected = affectedBy(['Opportunity', 'Contact'], SALES, describes);

    expect(
      anyRouteCondition(affected.routes.get('OpportunityContactRole') ?? [], describes),
    ).toEqual({
      soql: '(OpportunityId != null) OR (ContactId != null)',
      exact: true,
    });
  });

  it('reads a lookup to an object going along through that object’s own routes', async () => {
    const org = salesOrg();
    const describes = await describesOf(org, SALES);
    const affected = affectedBy(['Account'], SALES, describes);

    expect(namesDeletedCondition('Case', 'ContactId', 'Contact', affected, describes)).toEqual({
      soql: 'Contact.AccountId != null',
      exact: true,
    });
    expect(namesDeletedCondition('Case', 'AccountId', 'Account', affected, describes)).toEqual({
      soql: 'AccountId != null',
      exact: true,
    });
  });
});
