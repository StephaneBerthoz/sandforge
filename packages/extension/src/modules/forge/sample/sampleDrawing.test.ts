import { describe, expect, it } from 'vitest';

import { SampleSourceOrg } from '../../../test/sampleSourceOrg.js';
import { ForgeRunGateError } from '../ForgeRunGate.js';
import { sampleLinksOf, type SampleField, type SampleObjectInput } from './sampleLinks.js';
import {
  SourceSampleReader,
  drawSampleOfTheOrg,
  sampleReportOf,
  type SampleBudgetTerms,
  type SampleDrawingInput,
} from './sampleDrawing.js';
import { SampleSourceReader } from './sampleReader.js';

/*
 * A sample drawn against an org in memory that refuses what the org refuses
 * (`test/sampleSourceOrg.ts`): the reads of the source put under the reader
 * the closure knows, then the whole draw, from the counts of the roots to the
 * cut.
 */

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

/** Columns as a scratch org without person accounts describes them. */
const DESCRIBED: Record<string, string[]> = {
  Account: ['Id', 'Name', 'ParentId', 'RecordTypeId', 'CreatedDate', 'IsDeleted'],
  Contact: ['Id', 'AccountId', 'CreatedDate', 'IsDeleted'],
  Region__c: ['Id', 'Name', 'IsDeleted'],
  Pricebook2: ['Id', 'Name', 'IsStandard', 'IsDeleted'],
  PricebookEntry: [
    'Id',
    'Pricebook2Id',
    'Product2Id',
    'CurrencyIsoCode',
    'UnitPrice',
    'IsActive',
    'IsDeleted',
  ],
  Product2: ['Id', 'Name', 'IsActive', 'IsDeleted'],
};

const lookup = (name: string, referenceTo: string, nillable = true): SampleField => ({
  name,
  referenceTo: [referenceTo],
  isMasterDetail: false,
  nillable,
  createable: true,
  updateable: true,
});

/** An org of `accounts` accounts, each with `contactsEach` contacts, and its describes. */
function orgOf(accounts: number, contactsEach: number): SampleSourceOrg {
  const org = new SampleSourceOrg();
  for (const [object, columns] of Object.entries(DESCRIBED)) org.columns.set(object, columns);
  let contact = 0;
  for (let n = 1; n <= accounts; n++) {
    org.add('Account', {
      Id: fakeId('001', n),
      Name: `A${n}`,
      ParentId: null,
      RecordTypeId: n === 2 ? '012000000000CLSAAA' : null,
      IsDeleted: false,
    });
    for (let c = 0; c < contactsEach; c++) {
      contact++;
      org.add('Contact', {
        Id: fakeId('003', contact),
        AccountId: fakeId('001', n),
        IsDeleted: false,
      });
    }
  }
  return org;
}

const OBJECTS = (accounts: number, contacts: number): SampleObjectInput[] => [
  {
    objectApiName: 'Account',
    rows: accounts,
    keyPrefix: '001',
    fields: [lookup('ParentId', 'Account')],
  },
  {
    objectApiName: 'Contact',
    rows: contacts,
    keyPrefix: '003',
    fields: [lookup('AccountId', 'Account')],
  },
];

/** A budget of `kb` KB, the room four times as large. */
function budgetOf(kb: number, maxTotal?: number): SampleBudgetTerms {
  return {
    budget: {
      bytes: kb * 1024,
      limitedBy: 'storage',
      ...(maxTotal !== undefined ? { maxTotal } : {}),
    },
    bytesLimit: 'storage',
    roomBytes: kb * 1024 * 4,
  };
}

function inputOf(
  org: SampleSourceOrg,
  overrides: Partial<SampleDrawingInput> = {},
): SampleDrawingInput {
  return {
    source: org.source(),
    objects: OBJECTS(org.rows.get('Account')?.length ?? 0, org.rows.get('Contact')?.length ?? 0),
    order: ['Account', 'Contact'],
    fieldsOf: (object) => org.columns.get(object)?.map((name) => ({ name })),
    options: { seed: 1, draw: 'uniform', parents: 'all', children: 100, floor: 1 },
    budget: budgetOf(1_000),
    ...overrides,
  };
}

describe('the reads of a sample, as the closure takes them', () => {
  it('reads each record with the lookups of its object, its record type, and outside its filter marked', async () => {
    const org = orgOf(3, 1);
    const links = sampleLinksOf({
      objects: OBJECTS(3, 3),
      roomBytes: 1_000_000,
      wholeBytes: (_object, rows) => rows * 2048,
    });
    const reader = new SourceSampleReader(
      new SampleSourceReader(org.source(), {
        fieldsOf: (object) => org.columns.get(object),
        filterOf: (object) => (object === 'Account' ? "Name != 'A3'" : undefined),
      }),
      links,
      new Map(),
    );

    const rows = await reader.rows('Account', [
      fakeId('001', 1),
      fakeId('001', 2),
      fakeId('001', 3),
    ]);

    expect(rows).toEqual([
      { id: fakeId('001', 1), refs: { ParentId: null }, recordTypeId: null },
      { id: fakeId('001', 2), refs: { ParentId: null }, recordTypeId: '012000000000CLSAAA' },
      { id: fakeId('001', 3), refs: { ParentId: null }, recordTypeId: null, outsideFilter: true },
    ]);
    const children = await reader.children(
      { objectApiName: 'Contact', field: 'AccountId', parents: ['Account'], masterDetail: false },
      [fakeId('001', 1)],
      100,
    );
    expect(children.rows).toEqual([
      { id: fakeId('003', 1), refs: { AccountId: fakeId('001', 1) } },
    ]);
    expect(children.counts?.get(fakeId('001', 1))).toBe(1);
  });

  it('gives a price of its own book the standard price of its product and currency, and none where the source has none', async () => {
    const org = new SampleSourceOrg();
    for (const [object, columns] of Object.entries(DESCRIBED)) org.columns.set(object, columns);
    const std = fakeId('01s', 1);
    const own = fakeId('01s', 2);
    org.add(
      'Pricebook2',
      { Id: std, Name: 'Standard', IsStandard: true, IsDeleted: false },
      { Id: own, Name: 'Partners', IsStandard: false, IsDeleted: false },
    );
    const price = (n: number, book: string, product: number, currency: string) => ({
      Id: fakeId('01u', n),
      Pricebook2Id: book,
      Product2Id: fakeId('01t', product),
      CurrencyIsoCode: currency,
      IsActive: true,
      IsDeleted: false,
    });
    org.add(
      'PricebookEntry',
      price(1, std, 1, 'USD'),
      price(2, std, 1, 'EUR'),
      price(3, own, 1, 'EUR'),
      price(4, own, 2, 'USD'),
    );
    const links = sampleLinksOf({
      objects: [
        { objectApiName: 'Pricebook2', rows: 2, fields: [] },
        {
          objectApiName: 'PricebookEntry',
          rows: 4,
          fields: [lookup('Pricebook2Id', 'Pricebook2'), lookup('Product2Id', 'Product2')],
        },
      ],
      roomBytes: 0,
      wholeBytes: (_object, rows) => rows * 2048,
    });
    const reader = new SourceSampleReader(
      new SampleSourceReader(org.source(), { fieldsOf: (object) => org.columns.get(object) }),
      links,
      new Map(),
    );

    const books = await reader.rows('Pricebook2', [std, own]);
    const prices = await reader.rows('PricebookEntry', [
      fakeId('01u', 1),
      fakeId('01u', 3),
      fakeId('01u', 4),
    ]);

    expect(books.map((row) => row.matched === true)).toEqual([true, false]);
    // The standard price needs none; the EUR price of its own book needs the
    // standard EUR price of its product, not the USD one; the product with
    // no standard price leaves its price nothing it can be written with.
    expect(prices.map((row) => row.also)).toEqual([
      undefined,
      [{ objectApiName: 'PricebookEntry', id: fakeId('01u', 2) }],
      [{ objectApiName: 'PricebookEntry', id: null }],
    ]);
  });
});

describe('drawing a sample of the whole org', () => {
  it('keeps every record when the whole org fits, with each contact under its account, and says the whole org fits', async () => {
    // Past a hundred, accounts are no small parent copied whole: drawn.
    const org = orgOf(150, 2);

    const drawing = await drawSampleOfTheOrg(inputOf(org));

    expect(drawing.cut.kind).toBe('sample');
    if (drawing.cut.kind !== 'sample') return;
    expect(drawing.cut.limitedBy).toBe('whole');
    expect(drawing.cut.ids.get('Account')).toHaveLength(150);
    expect(drawing.cut.ids.get('Contact')).toHaveLength(300);
    expect(drawing.planRequests).toBe(org.requests);
    const report = sampleReportOf(
      { ...drawing, cut: drawing.cut },
      inputOf(org).options,
      budgetOf(1_000).budget,
    );
    expect(report.objects.find((o) => o.objectApiName === 'Contact')).toMatchObject({
      kept: 300,
      below: 300,
      roots: 0,
    });
    expect(report.planRequests).toEqual({ source: org.requests });
    expect(report.budget.limitedBy).toBe('whole');
  });

  it('keeps a part of the roots within the budget, with their children, the same ids for the same seed', async () => {
    const draw = async (seed: number) => {
      const org = orgOf(40, 2);
      const drawing = await drawSampleOfTheOrg(
        inputOf(org, {
          budget: budgetOf(60),
          options: { seed, draw: 'uniform', parents: 'all', children: 100, floor: 1 },
        }),
      );
      if (drawing.cut.kind !== 'sample') throw new Error('no sample');
      return drawing.cut;
    };

    const first = await draw(1);
    const again = await draw(1);
    const other = await draw(7);

    expect(first.limitedBy).toBe('storage');
    expect(first.storageBytes).toBeLessThanOrEqual(60 * 1024);
    const accounts = first.ids.get('Account') ?? [];
    expect(accounts.length).toBeGreaterThan(0);
    expect(accounts.length).toBeLessThan(40);
    // Each account kept brings its two contacts: none without its account.
    expect(first.ids.get('Contact')).toHaveLength(accounts.length * 2);
    expect(again.ids).toEqual(first.ids);
    expect(other.ids.get('Account')).not.toEqual(accounts);
  });

  it('reads the newest roots first when drawn by recency, and names the objects read in the order of their ids', async () => {
    const org = orgOf(10, 0);
    // No creation date the org lists: read by their ids.
    org.columns.set('Account', ['Id', 'Name', 'ParentId', 'IsDeleted']);

    const drawing = await drawSampleOfTheOrg(
      inputOf(org, {
        objects: [OBJECTS(10, 0)[0]],
        order: ['Account'],
        budget: budgetOf(8),
        options: { seed: 1, draw: 'recent', parents: 'all', children: 100, floor: 1 },
      }),
    );

    expect(drawing.newestByIds).toEqual(['Account']);
    if (drawing.cut.kind !== 'sample') throw new Error('no sample');
    // 8 KB hold four accounts: the four greatest ids.
    expect(drawing.cut.ids.get('Account')).toEqual([7, 8, 9, 10].map((n) => fakeId('001', n)));
    expect(org.sent.some(({ soql }) => / ORDER BY Id DESC LIMIT \d+$/.test(soql))).toBe(true);
  });

  it('refuses a read of the roots past a tenth of what the source has left today, before an id is read', async () => {
    const org = orgOf(150, 1);

    // Two counts and a page of the accounts' ids: three, past a tenth of 20.
    const drawn = drawSampleOfTheOrg(inputOf(org, { sourceRequestsLeft: 20 }));

    await expect(drawn).rejects.toBeInstanceOf(ForgeRunGateError);
    await expect(drawn).rejects.toMatchObject({
      code: 'API_BUDGET_EXCEEDED',
      api: { kind: 'requests', org: 'source', estimate: 3, remaining: 20 },
    });
    // The counts alone were sent.
    expect(org.sent.every(({ soql }) => soql.startsWith('SELECT COUNT() FROM'))).toBe(true);
  });

  it('reads a relation in lists, never counted by parent, where the describe says the org will not count the object’s ids', async () => {
    const draw = async (aggregatable: boolean | undefined) => {
      const org = orgOf(150, 1);
      await drawSampleOfTheOrg(
        inputOf(org, {
          // Discovery counted more contacts than a list of parents reads at once.
          objects: OBJECTS(150, 1_000_000_000),
          fieldsOf: (object) =>
            org.columns
              .get(object)
              ?.map((name) =>
                name === 'Id' && object === 'Contact' && aggregatable !== undefined
                  ? { name, aggregatable }
                  : { name, groupable: true },
              ),
        }),
      );
      return org.sent.filter(({ soql }) => soql.includes('COUNT(Id)')).length;
    };

    expect(await draw(undefined)).toBeGreaterThan(0);
    expect(await draw(false)).toBe(0);
  });

  it('holds the records of a closed record type out of the sample, with what cannot be written without them', async () => {
    const org = orgOf(150, 1);

    const drawing = await drawSampleOfTheOrg(
      inputOf(org, {
        recordTypeVerdict: (object, type) =>
          object === 'Account' && type === '012000000000CLSAAA' ? 'heldBack' : undefined,
      }),
    );

    if (drawing.cut.kind !== 'sample') throw new Error('no sample');
    const kept = (object: string) =>
      drawing.cut.kind === 'sample' ? (drawing.cut.ids.get(object) ?? []) : [];
    expect(kept('Account')).toHaveLength(149);
    expect(kept('Account')).not.toContain(fakeId('001', 2));
    // Its contact is never read under it.
    expect(kept('Contact')).toHaveLength(149);
    expect(kept('Contact')).not.toContain(fakeId('003', 2));
    expect(drawing.cut.dropped).toEqual([
      { objectApiName: 'Account', rows: 1, reason: 'heldBack' },
    ]);
  });
});
