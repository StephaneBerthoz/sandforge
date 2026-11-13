import { describe, expect, it } from 'vitest';
import { countedStorageBytes } from '../ForgeRunGate';
import {
  SMALL_PARENT_RECORDS,
  fieldsToRead,
  isRootRow,
  linkNamed,
  rootFilterOf,
  sampleLinksOf,
  type SampleField,
  type SampleLink,
  type SampleLinksInput,
  type SampleObjectInput,
} from './sampleLinks';

const KB = 1024;
const MB = 1024 * KB;

function lookup(
  name: string,
  referenceTo: string | string[],
  extra: Partial<SampleField> = {},
): SampleField {
  return {
    name,
    referenceTo: Array.isArray(referenceTo) ? referenceTo : [referenceTo],
    isMasterDetail: false,
    nillable: true,
    createable: true,
    updateable: true,
    ...extra,
  };
}

function object(
  objectApiName: string,
  rows: number | undefined,
  fields: SampleField[] = [],
  keyPrefix?: string,
): SampleObjectInput {
  return { objectApiName, rows, fields, ...(keyPrefix ? { keyPrefix } : {}) };
}

function linksOf(objects: SampleObjectInput[], extra: Partial<SampleLinksInput> = {}) {
  return sampleLinksOf({
    objects,
    roomBytes: 3.6 * MB,
    wholeBytes: (name, rows) => countedStorageBytes(name, { rows }),
    ...extra,
  });
}

function link(
  links: ReturnType<typeof linksOf>,
  objectApiName: string,
  field: string,
  parent?: string,
): SampleLink | undefined {
  return links.linksOf
    .get(objectApiName)
    ?.find((l) => l.field === field && (parent === undefined || l.parent === parent));
}

/** Accounts, contacts, cases and opportunities: a sales org in miniature. */
function salesObjects(rows = 5_000): SampleObjectInput[] {
  return [
    object(
      'Account',
      rows,
      [lookup('ParentId', 'Account'), lookup('PrimaryContact__c', 'Contact')],
      '001',
    ),
    object(
      'Contact',
      rows,
      [lookup('AccountId', 'Account'), lookup('ReportsToId', 'Contact')],
      '003',
    ),
    object(
      'Opportunity',
      rows,
      [lookup('AccountId', 'Account'), lookup('ContactId', 'Contact')],
      '006',
    ),
    object('Case', rows, [lookup('AccountId', 'Account'), lookup('ContactId', 'Contact')], '500'),
  ];
}

describe('sampleLinksOf: the objects copied whole', () => {
  it('copies whole the reference data the run matches by name, and the objects asked', () => {
    const links = linksOf(
      [...salesObjects(), object('BusinessHours', 3), object('Region__c', 4_000, [])],
      { referenceData: new Set(['BusinessHours']), whole: ['Region__c', 'NotInTheRun__c'] },
    );
    expect(links.whole).toEqual([
      { objectApiName: 'BusinessHours', why: 'referenceData' },
      { objectApiName: 'Region__c', why: 'asked' },
    ]);
    expect(links.classes.get('Account')).toEqual({ kind: 'drawn', rooted: true });
  });

  it('copies the catalog whole when it fits a quarter of the room and each object the records read whole', () => {
    const catalog = [
      object('Product2', 50),
      object('Pricebook2', 2),
      object('PricebookEntry', 100, [
        lookup('Product2Id', 'Product2', { nillable: false }),
        lookup('Pricebook2Id', 'Pricebook2', { nillable: false }),
      ]),
    ];
    const opportunityLines = object('OpportunityLineItem', 9_000, [
      lookup('OpportunityId', 'Opportunity', { nillable: false, isMasterDetail: true }),
      lookup('PricebookEntryId', 'PricebookEntry'),
    ]);
    const fits = linksOf([...salesObjects(), ...catalog, opportunityLines]);
    expect(fits.whole.filter((w) => w.why === 'catalog').map((w) => w.objectApiName)).toEqual([
      'Pricebook2',
      'PricebookEntry',
      'Product2',
    ]);
    expect(link(fits, 'OpportunityLineItem', 'PricebookEntryId')).toMatchObject({
      target: 'whole',
      carries: false,
    });

    // 152 records of 2 KB are 304 KB: more than a quarter of 1 MB.
    const tooBig = linksOf([...salesObjects(), ...catalog, opportunityLines], {
      roomBytes: 1 * MB,
    });
    expect(tooBig.whole.some((w) => w.why === 'catalog')).toBe(false);
    expect(tooBig.classes.get('PricebookEntry')).toEqual({ kind: 'drawn', rooted: false });
    // A catalog too big to copy whole is never drawn: what names it reads it up, and no draw goes down from it.
    expect(link(tooBig, 'OpportunityLineItem', 'PricebookEntryId')).toMatchObject({
      target: 'drawn',
      carries: false,
    });
    expect(tooBig.carriersInto.get('PricebookEntry')).toBeUndefined();

    const pastTheRecords = linksOf([...salesObjects(), ...catalog, opportunityLines], {
      maxRecordsPerObject: 60,
    });
    expect(pastTheRecords.whole.some((w) => w.why === 'catalog')).toBe(false);
  });

  it('copies whole a small parent that drawn objects name and that needs no drawn record, and no lookup to it carries the draw', () => {
    const links = linksOf(
      [...salesObjects(), object('Region__c', 30, [lookup('Manager__c', 'Contact')])].map((o) =>
        o.objectApiName === 'Account'
          ? { ...o, fields: [...o.fields, lookup('Region__c', 'Region__c')] }
          : o,
      ),
    );
    expect(links.classes.get('Region__c')).toEqual({ kind: 'whole', why: 'smallParent' });
    expect(link(links, 'Account', 'Region__c')).toMatchObject({ target: 'whole', carries: false });
    // The accounts that name a region stay roots of their own.
    expect(isRootRow(links, 'Account', { Region__c: 'a00000000000001', ParentId: null })).toBe(
      true,
    );
  });

  it('draws a small object that cannot be written without a drawn record, or that no drawn object names', () => {
    const links = linksOf([
      ...salesObjects(),
      object('Visit__c', 20, [lookup('Account__c', 'Account', { nillable: false })]),
      object('Note__c', 20, [lookup('Visit__c', 'Visit__c')]),
      object('Lonely__c', 10, []),
    ]);
    expect(links.classes.get('Visit__c')).toEqual({ kind: 'drawn', rooted: true });
    expect(links.classes.get('Lonely__c')).toEqual({ kind: 'drawn', rooted: true });
  });

  it('takes the small parents the smallest first, while they all fit a quarter of the room', () => {
    const named = ['A__c', 'B__c', 'C__c'];
    const children = object(
      'Child__c',
      9_000,
      named.map((name) => lookup(name, name)),
    );
    const links = linksOf(
      [object('A__c', 90), object('B__c', 40), object('C__c', 70), children],
      // A quarter of 400 KB holds 50 records of 2 KB: B (40) fits, and C (70) no longer.
      { roomBytes: 400 * KB },
    );
    expect(links.whole).toEqual([{ objectApiName: 'B__c', why: 'smallParent' }]);
  });

  it('counts as small up to a hundredth of the records the room holds, when that is more than a hundred', () => {
    const children = object('Child__c', 90_000, [lookup('Big__c', 'Big__c')]);
    const at = (rows: number, roomBytes: number) =>
      linksOf([object('Big__c', rows), children], { roomBytes }).classes.get('Big__c')?.kind;
    expect(at(SMALL_PARENT_RECORDS + 50, 3.6 * MB)).toBe('drawn');
    // 160 MB hold 81 920 records of 2 KB: a hundredth is 819.
    expect(at(800, 160 * MB)).toBe('whole');
    expect(at(900, 160 * MB)).toBe('drawn');
  });

  it('copies nothing whole of itself whose records nobody could count', () => {
    const links = linksOf([
      object('Region__c', undefined),
      object('Account', 100, [lookup('Region__c', 'Region__c')]),
    ]);
    expect(links.classes.get('Region__c')?.kind).toBe('drawn');
  });
});

describe('sampleLinksOf: what each lookup does', () => {
  const links = linksOf(salesObjects());

  it('carries the draw down a lookup whose parent is written first: an account brings its contacts', () => {
    expect(link(links, 'Contact', 'AccountId')).toMatchObject({
      target: 'drawn',
      carries: true,
      owed: false,
      required: false,
    });
    expect(links.carriersInto.get('Account')?.map((l) => `${l.objectApiName}.${l.field}`)).toEqual([
      'Case.AccountId',
      'Contact.AccountId',
      'Opportunity.AccountId',
    ]);
  });

  it('owes a lookup at its own object, or at an object written after, to the second pass, and carries nothing down it', () => {
    expect(link(links, 'Account', 'ParentId')).toMatchObject({ owed: true, carries: false });
    expect(link(links, 'Account', 'PrimaryContact__c')).toMatchObject({
      owed: true,
      carries: false,
    });
    expect(links.order.indexOf('Account')).toBeLessThan(links.order.indexOf('Contact'));
  });

  it('carries the draw down a lookup a record cannot be written without, and a master-detail, whatever the order', () => {
    const own = linksOf([
      object('Opportunity', 5_000, [lookup('SyncedQuoteId', 'Quote')]),
      object('Quote', 5_000, [lookup('OpportunityId', 'Opportunity', { nillable: false })]),
      object('QuoteLineItem', 5_000, [
        lookup('QuoteId', 'Quote', { nillable: false, isMasterDetail: true }),
      ]),
    ]);
    expect(own.order).toEqual(['Opportunity', 'Quote', 'QuoteLineItem']);
    expect(link(own, 'Quote', 'OpportunityId')).toMatchObject({ required: true, carries: true });
    expect(link(own, 'QuoteLineItem', 'QuoteId')).toMatchObject({
      required: true,
      masterDetail: true,
      carries: true,
    });
    expect(link(own, 'Opportunity', 'SyncedQuoteId')).toMatchObject({ owed: true, carries: false });
  });

  it('reads a lookup the platform alone fills as none, and one at an object outside the run as none', () => {
    const own = linksOf([
      object('Account', 100, [
        lookup('PersonContactId', 'Contact', { createable: false, updateable: false }),
        lookup('OwnerId', 'User', { nillable: false }),
      ]),
      object('Contact', 100, [lookup('AccountId', 'Account')]),
    ]);
    expect(own.linksOf.get('Account')).toEqual([]);
    expect(fieldsToRead(own, 'Contact')).toEqual(['AccountId']);
  });

  it('keeps a lookup a record cannot be written without at an object the user left out, as one its record goes with', () => {
    const own = linksOf(
      [
        object('Case', 100, [
          lookup('Asset__c', 'Asset__c', { nillable: false }),
          lookup('Optional__c', 'Asset__c'),
        ]),
      ],
      { excluded: new Map([['Asset__c', 'a01']]) },
    );
    expect(own.linksOf.get('Case')).toEqual([
      expect.objectContaining({
        field: 'Asset__c',
        target: 'excluded',
        required: true,
        carries: false,
      }),
    ]);
  });

  it('tells a lookup that may name several objects value by value, by the key prefix', () => {
    const own = linksOf([
      ...salesObjects(),
      object('Lead', 5_000, [], '00Q'),
      object(
        'Task',
        9_000,
        [
          lookup('WhatId', ['Account', 'Opportunity', 'Custom__c']),
          lookup('WhoId', ['Contact', 'Lead']),
        ],
        '00T',
      ),
    ]);
    expect(own.linksOf.get('Task')?.map((l) => [l.field, l.parent, l.prefix, l.carries])).toEqual([
      ['WhatId', 'Account', '001', true],
      ['WhatId', 'Opportunity', '006', true],
      ['WhoId', 'Contact', '003', true],
      ['WhoId', 'Lead', '00Q', true],
    ]);
    expect(rootFilterOf(own, 'Task')).toEqual({ empty: [], told: ['WhatId', 'WhoId'] });
    expect(rootFilterOf(own, 'Contact')).toEqual({ empty: ['AccountId'], told: [] });
    // A task on an account is reached under it; one on a record of an object outside the run, or on nothing, is a root.
    expect(isRootRow(own, 'Task', { WhatId: '001000000000001AAA', WhoId: null })).toBe(false);
    expect(isRootRow(own, 'Task', { WhatId: 'a07000000000001AAA', WhoId: null })).toBe(true);
    expect(isRootRow(own, 'Task', { WhatId: null, WhoId: null })).toBe(true);
    expect(linkNamed(own, 'Task', 'WhoId', '00Q000000000001AAA')?.parent).toBe('Lead');
    expect(linkNamed(own, 'Task', 'WhoId', 'a07000000000001AAA')).toBeUndefined();
  });

  it('never tells a lookup that may name several objects at an object whose key prefix is unknown', () => {
    const own = linksOf([
      object('Account', 5_000),
      object('Task', 5_000, [lookup('WhatId', ['Account', 'Opportunity'])]),
      object('Opportunity', 5_000, [], '006'),
    ]);
    expect(link(own, 'Task', 'WhatId', 'Account')?.prefix).toBeNull();
    expect(isRootRow(own, 'Task', { WhatId: '001000000000001AAA' })).toBe(true);
  });

  it('orders a cycle by what its records cannot be written without, and by name where nothing decides', () => {
    expect(links.order).toEqual(['Account', 'Contact', 'Case', 'Opportunity']);
    const given = linksOf(salesObjects(), { order: ['Contact', 'Account', 'Case', 'Opportunity'] });
    expect(link(given, 'Contact', 'AccountId')).toMatchObject({ owed: true, carries: false });
    expect(link(given, 'Account', 'PrimaryContact__c')).toMatchObject({
      owed: false,
      carries: true,
    });
  });
});
