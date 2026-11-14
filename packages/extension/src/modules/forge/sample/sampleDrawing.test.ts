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

  it('never says the whole org fits of a draw by recency that read no more roots than it could keep', async () => {
    const org = new SampleSourceOrg();
    org.columns.set('Account', DESCRIBED.Account);
    for (let n = 1; n <= 150; n++) {
      org.add('Account', {
        Id: fakeId('001', n),
        Name: `A${n}`,
        ParentId: null,
        RecordTypeId: null,
        CreatedDate: new Date(Date.UTC(2026, 10, 13, 9, 0, n)).toISOString(),
        IsDeleted: false,
      });
    }

    const drawing = await drawSampleOfTheOrg(
      inputOf(org, {
        objects: [OBJECTS(150, 0)[0]],
        order: ['Account'],
        budget: budgetOf(1_000, 10),
        options: { seed: 1, draw: 'recent', parents: 'all', children: 100, floor: 1 },
      }),
    );

    if (drawing.cut.kind !== 'sample') throw new Error('no sample');
    // Ten accounts of 150 read and kept: the 140 others were never read.
    expect(drawing.cut.ids.get('Account')).toHaveLength(10);
    expect(drawing.cut.limitedBy).toBe('maxTotal');
    expect(drawing.cut.share).toBeLessThan(1);
  });

  it('keeps under the cap the children made last, not the greatest ids, and names an object whose children it kept by their ids', async () => {
    /** A moment `seconds` after the first, as the org writes a record's dates. */
    const madeAt = (seconds: number): string =>
      new Date(Date.UTC(2026, 10, 13, 9, 0, seconds)).toISOString().replace('Z', '+0000');
    const draw = async (dated: boolean) => {
      const org = orgOf(150, 0);
      if (!dated) org.columns.set('Contact', ['Id', 'AccountId', 'IsDeleted']);
      // Five contacts of the first account, made the later the smaller the id.
      for (let n = 1; n <= 5; n++) {
        org.add('Contact', {
          Id: fakeId('003', n),
          AccountId: fakeId('001', 1),
          ...(dated ? { CreatedDate: madeAt(10 - n) } : {}),
          IsDeleted: false,
        });
      }
      const drawing = await drawSampleOfTheOrg(
        inputOf(org, {
          options: { seed: 1, draw: 'uniform', parents: 'all', children: 2, floor: 1 },
        }),
      );
      if (drawing.cut.kind !== 'sample') throw new Error('no sample');
      return { ids: drawing.cut.ids.get('Contact'), newestByIds: drawing.newestByIds };
    };

    expect(await draw(true)).toEqual({
      ids: [1, 2].map((n) => fakeId('003', n)),
      newestByIds: [],
    });
    expect(await draw(false)).toEqual({
      ids: [4, 5].map((n) => fakeId('003', n)),
      newestByIds: ['Contact'],
    });
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

  /*
   * The page said the run's stop as one past all the source has left: "about
   * 3 of its API requests, and it has 20 left today". What the drawing stops
   * at is a tenth of them, and the stop said nothing of it.
   */
  it('marks a stop of the drawing with the share it may read, and how it drew, and offers the newest only to a spread draw', async () => {
    const uniform = drawSampleOfTheOrg(inputOf(orgOf(150, 1), { sourceRequestsLeft: 20 }));
    await expect(uniform).rejects.toMatchObject({
      api: { estimate: 3, remaining: 20, drawing: { share: 0.1, draw: 'uniform' } },
      message: expect.stringContaining('Draw the most recent records (--fit-draw recent)'),
    });

    const recent = drawSampleOfTheOrg(
      inputOf(orgOf(150, 1), {
        sourceRequestsLeft: 20,
        options: { seed: 1, draw: 'recent', parents: 'all', children: 100, floor: 1 },
      }),
    );
    await expect(recent).rejects.toMatchObject({
      api: { drawing: { share: 0.1, draw: 'recent' } },
    });
    await expect(recent).rejects.not.toMatchObject({
      message: expect.stringContaining('--fit-draw recent'),
    });
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

/*
 * The roots a draw takes, chosen by a window of dates, a filter on the roots
 * of an object and strata: chosen among the roots alone, the records under
 * them and above them coming whatever their date or their values.
 */
describe('a sample whose roots are chosen', () => {
  const BUSINESS = '012000000000BUSAAA';
  const PARTNER = '012000000000PRTAAA';
  /** Describe types of the fields a stratum or a filter on the roots reads. */
  const TYPES: Record<string, string> = {
    Name: 'string',
    BillingCountry: 'string',
    RecordTypeId: 'reference',
    ParentId: 'reference',
    AccountId: 'reference',
    CreatedDate: 'datetime',
  };
  const COLUMNS: Record<string, string[]> = {
    Account: [
      'Id',
      'Name',
      'ParentId',
      'RecordTypeId',
      'BillingCountry',
      'CreatedDate',
      'IsDeleted',
    ],
    Contact: ['Id', 'AccountId', 'MailingCountry', 'CreatedDate', 'IsDeleted'],
    Note__c: ['Id', 'Name', 'IsDeleted'],
  };
  /** A moment `minutes` past the start of March of `year`, as the org writes a record's dates. */
  const madeIn = (year: number, minutes: number): string =>
    new Date(Date.UTC(year, 2, 1, 0, minutes)).toISOString().replace('Z', '+0000');

  /**
   * 150 accounts, the first fifty made in 2025, the others in 2026; every
   * third in France, the others in Germany; every tenth a partner, the
   * others businesses; the third names the fourth, in Germany, as its
   * parent. Each has a contact made in 2026, in Spain. Beside them, 150
   * notes no lookup names, whose describe lists no date.
   */
  function orgOfAccounts(): SampleSourceOrg {
    const org = new SampleSourceOrg();
    for (const [object, listed] of Object.entries(COLUMNS)) org.columns.set(object, listed);
    for (let n = 1; n <= 150; n++) {
      org.add('Account', {
        Id: fakeId('001', n),
        Name: `A${n}`,
        ParentId: n === 3 ? fakeId('001', 4) : null,
        RecordTypeId: n % 10 === 0 ? PARTNER : BUSINESS,
        BillingCountry: n % 3 === 0 ? 'France' : 'Germany',
        CreatedDate: n <= 50 ? madeIn(2025, n) : madeIn(2026, n),
        IsDeleted: false,
      });
      org.add('Contact', {
        Id: fakeId('003', n),
        AccountId: fakeId('001', n),
        MailingCountry: 'Spain',
        CreatedDate: madeIn(2026, 1_000 + n),
        IsDeleted: false,
      });
      org.add('Note__c', { Id: fakeId('a0N', n), Name: `N${n}`, IsDeleted: false });
    }
    return org;
  }

  const objectsOfAccounts = (withNotes = false): SampleObjectInput[] => [
    ...OBJECTS(150, 150),
    ...(withNotes ? [{ objectApiName: 'Note__c', rows: 150, keyPrefix: 'a0N', fields: [] }] : []),
  ];

  function chosenInput(
    org: SampleSourceOrg,
    options: Partial<SampleDrawingInput['options']>,
    overrides: Partial<SampleDrawingInput> = {},
  ): SampleDrawingInput {
    return inputOf(org, {
      objects: objectsOfAccounts(),
      fieldsOf: (object) =>
        org.columns
          .get(object)
          ?.map((name) => (TYPES[name] ? { name, type: TYPES[name] } : { name })),
      options: {
        seed: 1,
        draw: 'uniform',
        parents: 'all',
        children: 100,
        floor: 1,
        ...options,
      },
      ...overrides,
    });
  }

  const WINDOW_2025 = {
    field: 'CreatedDate' as const,
    from: '2025-01-01T00:00:00Z',
    to: '2026-01-01T00:00:00Z',
  };

  it('draws only the roots made in the window, brings their contacts whatever their date, and says the draw held it, never the whole org', async () => {
    const org = orgOfAccounts();

    const drawing = await drawSampleOfTheOrg(chosenInput(org, { window: WINDOW_2025 }));

    if (drawing.cut.kind !== 'sample') throw new Error('no sample');
    expect(drawing.cut.ids.get('Account')).toEqual(
      Array.from({ length: 50 }, (_, i) => fakeId('001', i + 1)),
    );
    // Made in 2026, each under an account of the window: all of them.
    expect(drawing.cut.ids.get('Contact')).toHaveLength(50);
    expect(drawing.cut.limitedBy).toBe('draw');
    expect(drawing.cut.share).toBe(1);
    const report = sampleReportOf(
      { ...drawing, cut: drawing.cut },
      chosenInput(org, { window: WINDOW_2025 }).options,
      budgetOf(1_000).budget,
    );
    expect(report.budget.limitedBy).toBe('draw');
    expect(report.roots).toEqual({ window: WINDOW_2025 });
    expect(report.objects.find((o) => o.objectApiName === 'Account')).toMatchObject({
      roots: 50,
      rootsInTheDraw: 50,
      rootsInTheSource: 150,
    });
    // The window is a term of the reads of the roots alone, never of the
    // contacts read under them.
    const underTheRoots = org.sent.filter(({ soql }) => soql.includes('AccountId IN'));
    expect(underTheRoots.length).toBeGreaterThan(0);
    expect(underTheRoots.some(({ soql }) => soql.includes('CreatedDate >='))).toBe(false);
    expect(
      org.sent.some(
        ({ soql }) => soql.startsWith('SELECT COUNT() FROM Account') && soql.includes('2025-01-01'),
      ),
    ).toBe(true);
  });

  it('draws the roots a filter on them chooses and brings the parent it does not choose, where the same text as a filter leaves the lookup empty', async () => {
    const french = "BillingCountry = 'France'";

    const chosen = await drawSampleOfTheOrg(
      chosenInput(orgOfAccounts(), { rootWhere: { Account: french } }),
    );
    const filtered = await drawSampleOfTheOrg(
      chosenInput(orgOfAccounts(), {}, { filterOf: (o) => (o === 'Account' ? french : undefined) }),
    );

    if (chosen.cut.kind !== 'sample' || filtered.cut.kind !== 'sample') {
      throw new Error('no sample');
    }
    // The fifty in France, and the account in Germany the third names as its parent.
    expect(chosen.cut.ids.get('Account')).toHaveLength(51);
    expect(chosen.cut.ids.get('Account')).toContain(fakeId('001', 4));
    expect(chosen.cut.leftEmpty).toEqual([]);
    expect(chosen.cut.dropped).toEqual([]);
    expect(chosen.cut.limitedBy).toBe('draw');
    expect(chosen.roots).toEqual({ where: [{ objectApiName: 'Account', where: french }] });
    // As a filter of the object, the parent is outside it: its lookup written empty.
    expect(filtered.cut.ids.get('Account')).not.toContain(fakeId('001', 4));
    expect(filtered.cut.leftEmpty).toEqual([
      { objectApiName: 'Account', field: 'ParentId', rows: 1 },
    ]);
  });

  it('refuses a window no root is made in, nothing read past the counts and no plan drawn', async () => {
    const org = orgOfAccounts();

    const drawn = drawSampleOfTheOrg(
      chosenInput(org, {
        window: { field: 'CreatedDate', from: '2020-01-01T00:00:00Z', to: '2021-01-01T00:00:00Z' },
      }),
    );

    await expect(drawn).rejects.toBeInstanceOf(ForgeRunGateError);
    await expect(drawn).rejects.toMatchObject({
      code: 'SAMPLE_DRAW_EMPTY',
      sample: { requests: org.requests },
      message: expect.stringContaining('Widen the window (--fit-window), or draw without them.'),
    });
    expect(org.sent.length).toBeGreaterThan(0);
    expect(org.sent.every(({ soql }) => soql.startsWith('SELECT COUNT() FROM'))).toBe(true);
  });

  it('refuses a stratum of a text field before any request, with the fields of few values it has', async () => {
    const org = orgOfAccounts();

    const drawn = drawSampleOfTheOrg(chosenInput(org, { strata: ['Account.Name'] }));

    await expect(drawn).rejects.toMatchObject({
      code: 'SAMPLE_DRAW_INVALID',
      sample: { requests: 0 },
      message: expect.stringContaining('RecordTypeId'),
    });
    expect(org.sent).toEqual([]);
  });

  it('keeps the same share of each record type, the rare one its floor at least, and names each by its label', async () => {
    const draw = async () => {
      const org = orgOfAccounts();
      const drawing = await drawSampleOfTheOrg(
        chosenInput(
          org,
          { strata: ['Account.RecordTypeId'] },
          {
            budget: budgetOf(1_000, 40),
            labelsOf: async (object, field) =>
              object === 'Account' && field === 'RecordTypeId'
                ? (value) =>
                    value === BUSINESS ? 'Business' : value === PARTNER ? 'Partner' : undefined
                : undefined,
          },
        ),
      );
      if (drawing.cut.kind !== 'sample') throw new Error('no sample');
      return { drawing, cut: drawing.cut };
    };

    const { drawing, cut } = await draw();

    expect(cut.limitedBy).toBe('maxTotal');
    const accounts = cut.ids.get('Account') ?? [];
    const partners = accounts.filter((id) => Number(id.slice(3, 15)) % 10 === 0);
    // Each value keeps the roots ranked within the share, (i + ½)/N, its
    // floor at least: its part of the share.
    const keeps = (roots: number): number =>
      Math.max(
        1,
        Array.from({ length: roots }, (_, i) => (i + 0.5) / roots).filter((r) => r <= cut.share)
          .length,
      );
    expect(partners).toHaveLength(keeps(15));
    expect(accounts.length - partners.length).toBe(keeps(135));
    expect(drawing.roots?.strata).toEqual([
      {
        objectApiName: 'Account',
        field: 'RecordTypeId',
        values: [
          { value: BUSINESS, label: 'Business', roots: 135, kept: keeps(135) },
          { value: PARTNER, label: 'Partner', roots: 15, kept: keeps(15) },
        ],
      },
    ]);
    expect(drawing.strataFloors).toEqual({ roots: 2, values: 2 });
    // Strata keep every root in the draw: no object's roots counted apart.
    expect(drawing.rootsCounted.size).toBe(0);
    expect(cut.ids).toEqual((await draw()).cut.ids);
  });

  it('draws the oldest roots first by the date they were made, and names an object it read by its ids as the oldest, not the newest', async () => {
    const dated = orgOfAccounts();

    const drawing = await drawSampleOfTheOrg(
      chosenInput(dated, { draw: 'oldest' }, { budget: budgetOf(1_000, 20) }),
    );

    if (drawing.cut.kind !== 'sample') throw new Error('no sample');
    expect(drawing.cut.ids.get('Account')).toEqual(
      Array.from({ length: 10 }, (_, i) => fakeId('001', i + 1)),
    );
    expect(
      dated.sent.some(({ soql }) => /FROM Account .*ORDER BY CreatedDate ASC, Id ASC/.test(soql)),
    ).toBe(true);
    expect(drawing.oldestByIds).toEqual([]);

    const undated = orgOfAccounts();
    undated.columns.set('Account', ['Id', 'Name', 'ParentId', 'RecordTypeId', 'IsDeleted']);
    const byIds = await drawSampleOfTheOrg(
      chosenInput(undated, { draw: 'oldest' }, { budget: budgetOf(1_000, 20) }),
    );
    expect(byIds.oldestByIds).toEqual(['Account']);
    expect(byIds.newestByIds).not.toContain('Account');
    if (byIds.cut.kind !== 'sample') throw new Error('no sample');
    const report = sampleReportOf(
      { ...byIds, cut: byIds.cut },
      chosenInput(undated, { draw: 'oldest' }).options,
      budgetOf(1_000).budget,
    );
    expect(report.oldestByIds).toEqual(['Account']);
    expect(report.newestByIds ?? []).not.toContain('Account');
  });

  it('reads no root of an object the window cannot date, and says it has none in the draw rather than none in the source', async () => {
    const org = orgOfAccounts();

    const drawing = await drawSampleOfTheOrg(
      chosenInput(org, { window: WINDOW_2025 }, { objects: objectsOfAccounts(true) }),
    );

    expect(org.sent.some(({ soql }) => soql.includes('FROM Note__c'))).toBe(false);
    if (drawing.cut.kind !== 'sample') throw new Error('no sample');
    const report = sampleReportOf(
      { ...drawing, cut: drawing.cut },
      chosenInput(org, { window: WINDOW_2025 }).options,
      budgetOf(1_000).budget,
    );
    expect(report.roots).toEqual({ window: WINDOW_2025, notWindowed: ['Note__c'] });
    expect(report.noRecordDrawn).toEqual([
      { objectApiName: 'Note__c', sourceRows: 150, noRootInTheDraw: true },
    ]);
  });

  it('offers a draw spread over the org the oldest and fewer roots, and a restricted draw by date narrower ones, when reading the roots costs too much', async () => {
    const uniform = drawSampleOfTheOrg(
      chosenInput(orgOfAccounts(), {}, { sourceRequestsLeft: 20 }),
    );
    await expect(uniform).rejects.toMatchObject({
      code: 'API_BUDGET_EXCEEDED',
      message: expect.stringContaining(
        'Draw the most recent records (--fit-draw recent) or the oldest (--fit-draw oldest), ' +
          'draw among fewer roots (--fit-window, --fit-where)',
      ),
    });

    const recent = drawSampleOfTheOrg(
      chosenInput(
        orgOfAccounts(),
        { draw: 'recent', window: WINDOW_2025 },
        { sourceRequestsLeft: 20 },
      ),
    );
    await expect(recent).rejects.toMatchObject({
      api: { drawing: { share: 0.1, draw: 'recent', restricted: true } },
      message: expect.stringContaining(
        'Narrow the window or the filters on the roots (--fit-window, --fit-where)',
      ),
    });
  });
});
