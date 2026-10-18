import { describe, expect, it } from 'vitest';
import {
  CURRENCY_TYPES_SOQL,
  CurrencyReplacementTally,
  DATED_RATES_ON_SOQL,
  DATED_RATES_SOQL,
  conversionFactor,
  currencyFieldsOf,
  currencyReplacementsNote,
  datedRateOf,
  datedRatesOf,
  describeCurrencyReplaced,
  followParentCurrency,
  orgCurrenciesOf,
  parentCurrencyChange,
  readOrgCurrencies,
  readRunCurrencies,
  replaceRowCurrency,
  replacementCurrency,
  roundToScale,
  type CurrencyChange,
  type RunCurrencies,
} from './recordCurrencies.js';

/** The source of a real pass: USD corporate, EUR at 0.92, GBP at 0.79. */
const SOURCE_ROWS = [
  { IsoCode: 'USD', ConversionRate: 1, DecimalPlaces: 2, IsActive: true, IsCorporate: true },
  { IsoCode: 'EUR', ConversionRate: 0.92, DecimalPlaces: 2, IsActive: true, IsCorporate: false },
  { IsoCode: 'GBP', ConversionRate: 0.79, DecimalPlaces: 2, IsActive: true, IsCorporate: false },
];
/** Its target: USD corporate, EUR at 0.90, no GBP. */
const TARGET_ROWS = [
  { IsoCode: 'USD', ConversionRate: 1, DecimalPlaces: 2, IsActive: true, IsCorporate: true },
  { IsoCode: 'EUR', ConversionRate: 0.9, DecimalPlaces: 2, IsActive: true, IsCorporate: false },
];

function currencies(): RunCurrencies {
  return { source: orgCurrenciesOf(SOURCE_ROWS)!, target: orgCurrenciesOf(TARGET_ROWS)! };
}

const AMOUNT = new Map<string, number | undefined>([['Amount', 2]]);

describe('orgCurrenciesOf', () => {
  it('reads the active currencies, every rate, the decimals and the corporate currency', () => {
    const read = orgCurrenciesOf([
      ...TARGET_ROWS,
      { IsoCode: 'CHF', ConversionRate: '0.88', DecimalPlaces: 2, IsActive: 'false' },
    ])!;

    expect([...read.active]).toEqual(['USD', 'EUR']);
    expect(read.corporate).toBe('USD');
    expect(read.rates.get('CHF')).toBe(0.88);
    expect(read.decimals.get('EUR')).toBe(2);
  });

  it('answers nothing for no rows', () => {
    expect(orgCurrenciesOf([])).toBeUndefined();
  });
});

describe('readOrgCurrencies and readRunCurrencies', () => {
  it('asks each org its currencies once', async () => {
    const asked: string[] = [];
    const read = await readRunCurrencies(
      async (soql) => {
        asked.push(`source ${soql}`);
        return SOURCE_ROWS;
      },
      async (soql) => {
        asked.push(`target ${soql}`);
        return TARGET_ROWS;
      },
    );

    expect(asked).toEqual([
      `source ${CURRENCY_TYPES_SOQL}`,
      `target ${CURRENCY_TYPES_SOQL}`,
      `source ${DATED_RATES_ON_SOQL}`,
      `target ${DATED_RATES_ON_SOQL}`,
    ]);
    expect(read?.target.active.has('GBP')).toBe(false);
    expect(read?.source.dated).toBeUndefined();
  });

  it('answers nothing for an org with one currency, which refuses the query', async () => {
    const refused = async (): Promise<never> => {
      throw new Error("INVALID_TYPE: sObject type 'CurrencyType' is not supported.");
    };

    expect(await readOrgCurrencies(refused)).toBeUndefined();
    expect(await readRunCurrencies(async () => SOURCE_ROWS, refused)).toBeUndefined();
  });
});

describe('conversionFactor', () => {
  it("divides by the source's rate of the currency read and multiplies by the target's of the one written", () => {
    expect(5000.55 * conversionFactor('GBP', 'USD', currencies())!).toBeCloseTo(6329.810127, 5);
    // Into EUR, at the target's 0.90: the target values it at the same 6 329.81 USD.
    expect(5000.55 * conversionFactor('GBP', 'EUR', currencies())!).toBeCloseTo(5696.829114, 5);
  });

  it('goes from one corporate currency to the other at the rate either org holds', () => {
    const inEuros: RunCurrencies = {
      source: currencies().source,
      target: orgCurrenciesOf([
        { IsoCode: 'EUR', ConversionRate: 1, IsActive: true, IsCorporate: true },
        { IsoCode: 'USD', ConversionRate: 1.1, IsActive: true },
      ])!,
    };

    // 100 GBP is 126.58 USD to the source, which holds EUR at 0.92.
    expect(100 * conversionFactor('GBP', 'EUR', inEuros)!).toBeCloseTo(116.4557, 4);
  });

  it('answers nothing when the source holds no rate for the currency read', () => {
    expect(conversionFactor('JPY', 'USD', currencies())).toBeUndefined();
  });
});

describe('roundToScale', () => {
  it('rounds half away from zero, past the error of binary fractions', () => {
    expect(roundToScale(6329.810126582278, 2)).toBe(6329.81);
    expect(roundToScale(1.005, 2)).toBe(1.01);
    expect(roundToScale(-1.005, 2)).toBe(-1.01);
    expect(roundToScale(2.5, 0)).toBe(3);
  });
});

describe('currencyFieldsOf', () => {
  it('keeps the currency fields of a describe with their decimals', () => {
    expect(
      currencyFieldsOf([
        { name: 'Amount', type: 'currency', scale: 2 },
        { name: 'Fee__c', type: 'currency' },
        { name: 'Probability', type: 'percent', scale: 0 },
      ]),
    ).toEqual(
      new Map([
        ['Amount', 2],
        ['Fee__c', undefined],
      ]),
    );
  });
});

describe('replaceRowCurrency', () => {
  it("writes a row in a currency the target lacks in its corporate currency, its amounts converted at the source's rates", () => {
    const payload: Record<string, unknown> = { CurrencyIsoCode: 'GBP', Amount: 5000.55 };

    const change = replaceRowCurrency(
      payload,
      { read: 'GBP', currencyFields: AMOUNT },
      currencies(),
    );

    expect(payload).toEqual({ CurrencyIsoCode: 'USD', Amount: 6329.81 });
    expect(change).toEqual({
      from: 'GBP',
      to: 'USD',
      chosenBy: 'corporate',
      fields: ['Amount'],
      factor: 1 / 0.79,
    });
  });

  it("takes the record type's default when it is a currency the target holds", () => {
    const payload: Record<string, unknown> = { CurrencyIsoCode: 'GBP', Amount: 100 };

    const change = replaceRowCurrency(
      payload,
      { read: 'GBP', currencyFields: AMOUNT, recordTypeDefault: 'EUR' },
      currencies(),
    );

    expect(payload).toEqual({ CurrencyIsoCode: 'EUR', Amount: 113.92 });
    expect(change).toMatchObject({
      to: 'EUR',
      chosenBy: 'record-type-default',
      atTargetRate: true,
    });
  });

  it('leaves a row in a currency the target holds as it is', () => {
    const payload: Record<string, unknown> = { CurrencyIsoCode: 'EUR', Amount: 100 };

    expect(
      replaceRowCurrency(payload, { read: 'EUR', currencyFields: AMOUNT }, currencies()),
    ).toBeUndefined();
    expect(payload).toEqual({ CurrencyIsoCode: 'EUR', Amount: 100 });
  });

  it('converts a row the user mapped to another currency the target holds', () => {
    const payload: Record<string, unknown> = { CurrencyIsoCode: 'EUR', Amount: 79 };

    const change = replaceRowCurrency(
      payload,
      { read: 'GBP', currencyFields: AMOUNT },
      currencies(),
    );

    expect(payload['Amount']).toBe(90);
    expect(change?.chosenBy).toBe('decision');
  });

  it('touches nothing of a row that carries no currency to write: the user left it out', () => {
    const payload: Record<string, unknown> = { Amount: 100 };

    expect(
      replaceRowCurrency(payload, { read: 'GBP', currencyFields: AMOUNT }, currencies()),
    ).toBeUndefined();
    expect(payload).toEqual({ Amount: 100 });
  });

  it('writes the amounts as read, and says so, when the source holds no rate for the currency', () => {
    const payload: Record<string, unknown> = { CurrencyIsoCode: 'JPY', Amount: 1000 };

    const change = replaceRowCurrency(
      payload,
      { read: 'JPY', currencyFields: AMOUNT },
      currencies(),
    );

    expect(payload).toEqual({ CurrencyIsoCode: 'USD', Amount: 1000 });
    expect(change).toEqual({
      from: 'JPY',
      to: 'USD',
      chosenBy: 'corporate',
      fields: [],
      notConverted: true,
    });
  });

  it('rounds to the decimals of the currency written when the field does not say its own', () => {
    const payload: Record<string, unknown> = { CurrencyIsoCode: 'GBP', Fee__c: '10.005' };

    replaceRowCurrency(
      payload,
      { read: 'GBP', currencyFields: new Map([['Fee__c', undefined]]) },
      currencies(),
    );

    expect(payload['Fee__c']).toBe(12.66);
  });
});

describe('CurrencyReplacementTally and its words', () => {
  it('counts the rows of each object by currency read and written, and says them', () => {
    const tally = new CurrencyReplacementTally();
    const change = { from: 'GBP', to: 'USD', chosenBy: 'corporate' as const, fields: ['Amount'] };
    tally.add('Opportunity', change);
    tally.add('Opportunity', { ...change, fields: [] });
    tally.add('Opportunity', undefined);

    const [entry] = tally.list();
    expect(entry).toEqual({
      objectApiName: 'Opportunity',
      from: 'GBP',
      to: 'USD',
      chosenBy: 'corporate',
      rows: 2,
      fields: ['Amount'],
    });
    expect(describeCurrencyReplaced(entry)).toBe(
      "2 row(s) in GBP written in USD, the target's corporate currency, GBP not being active " +
        "there: amounts converted at the source's rates (Amount)",
    );
    expect(currencyReplacementsNote(tally.list())).toBe(
      `, written in another currency: ${describeCurrencyReplaced(entry)}`,
    );
    expect(currencyReplacementsNote([])).toBe('');
  });

  it('says amounts written as read, and the target rate where one was used', () => {
    expect(
      describeCurrencyReplaced({
        objectApiName: 'Account',
        from: 'JPY',
        to: 'USD',
        chosenBy: 'corporate',
        rows: 1,
        fields: [],
        notConverted: true,
      }),
    ).toContain('amounts written as read: no rate converts JPY into USD');
    expect(
      describeCurrencyReplaced({
        objectApiName: 'Account',
        from: 'GBP',
        to: 'EUR',
        chosenBy: 'record-type-default',
        rows: 1,
        fields: ['AnnualRevenue'],
        atTargetRate: true,
      }),
    ).toBe(
      '1 row(s) in GBP written in EUR, the default of their record type, GBP not being active in ' +
        "the target: amounts converted at the source's rate for GBP and the target's for EUR " +
        '(AnnualRevenue)',
    );
  });
});

/**
 * The dated rates of a source with advanced currency management on, as a real
 * org answered them: the first period starts before any date, and GBP moved
 * from 0.79 to 0.85 on 2026-01-01.
 */
const DATED_ROWS = [
  { IsoCode: 'EUR', ConversionRate: 0.92, StartDate: '0000-12-30', NextStartDate: '9999-12-31' },
  { IsoCode: 'GBP', ConversionRate: 0.85, StartDate: '2026-01-01', NextStartDate: '9999-12-31' },
  { IsoCode: 'GBP', ConversionRate: 0.79, StartDate: '0000-12-30', NextStartDate: '2026-01-01' },
  { IsoCode: 'USD', ConversionRate: 1, StartDate: '0000-12-30', NextStartDate: '9999-12-31' },
];

/** A source that answers its currencies, whether dated rates are on, and those rates. */
function sourceAnswering(
  on: boolean | 'refused',
): (soql: string) => Promise<Record<string, unknown>[]> {
  return async (soql) => {
    if (soql === CURRENCY_TYPES_SOQL) return SOURCE_ROWS;
    if (soql === DATED_RATES_ON_SOQL) {
      if (on === 'refused') throw new Error('INSUFFICIENT_ACCESS');
      return [{ RunningUserEntityAccess: { IsCreatable: on } }];
    }
    if (soql === DATED_RATES_SOQL) return DATED_ROWS;
    throw new Error(`unexpected ${soql}`);
  };
}

describe('dated rates', () => {
  it('reads the dated rates of an org with advanced currency management on, each currency in order', async () => {
    const read = await readOrgCurrencies(sourceAnswering(true));

    expect(read?.dated?.get('GBP')).toEqual([
      { start: '0000-12-30', next: '2026-01-01', rate: 0.79 },
      { start: '2026-01-01', next: '9999-12-31', rate: 0.85 },
    ]);
    expect(read?.rates.get('GBP')).toBe(0.79);
  });

  it('reads none when it is off, or the org will not say, though the rows of an earlier time are there', async () => {
    expect((await readOrgCurrencies(sourceAnswering(false)))?.dated).toBeUndefined();
    expect((await readOrgCurrencies(sourceAnswering('refused')))?.dated).toBeUndefined();
  });

  it('leaves out a row without its dates or its rate', () => {
    expect(
      datedRatesOf([
        { IsoCode: 'GBP', ConversionRate: 0.85, StartDate: null, NextStartDate: '9999-12-31' },
        { IsoCode: 'GBP', ConversionRate: 0, StartDate: '2026-01-01', NextStartDate: '9999-12-31' },
      ]).size,
    ).toBe(0);
  });

  it("converts an opportunity at the rates of its close date, and an undated amount at CurrencyType's", async () => {
    const run: RunCurrencies = {
      source: (await readOrgCurrencies(sourceAnswering(true)))!,
      target: orgCurrenciesOf(TARGET_ROWS)!,
    };
    const thisYear: Record<string, unknown> = { CurrencyIsoCode: 'GBP', Amount: 850 };
    const lastYear: Record<string, unknown> = { CurrencyIsoCode: 'GBP', Amount: 790 };

    const dated = replaceRowCurrency(
      thisYear,
      {
        read: 'GBP',
        currencyFields: AMOUNT,
        ratesOn: datedRateOf('Opportunity', { CloseDate: '2026-03-31' }),
      },
      run,
    );
    replaceRowCurrency(
      lastYear,
      {
        read: 'GBP',
        currencyFields: AMOUNT,
        ratesOn: datedRateOf('Opportunity', { CloseDate: '2025-12-31' }),
      },
      run,
    );

    expect(thisYear['Amount']).toBe(1000);
    expect(dated).toMatchObject({ to: 'USD', datedBy: 'CloseDate', factor: 1 / 0.85 });
    // Its period ends the day the next one starts.
    expect(lastYear['Amount']).toBe(1000);
    expect(conversionFactor('GBP', 'USD', run)).toBe(1 / 0.79);
    expect(conversionFactor('GBP', 'USD', run, '2026-01-01')).toBe(1 / 0.85);
  });

  it('says dated by nothing when no dated rate covers the date: the rates of CurrencyType converted it', async () => {
    const run: RunCurrencies = {
      source: (await readOrgCurrencies(sourceAnswering(false)))!,
      target: orgCurrenciesOf(TARGET_ROWS)!,
    };
    const payload: Record<string, unknown> = { CurrencyIsoCode: 'GBP', Amount: 79 };

    const change = replaceRowCurrency(
      payload,
      { read: 'GBP', currencyFields: AMOUNT, ratesOn: { field: 'CloseDate', on: '2026-03-31' } },
      run,
    );

    expect(payload['Amount']).toBe(100);
    expect(change?.datedBy).toBeUndefined();
  });

  it('dates an opportunity by its close date and no other object', () => {
    expect(datedRateOf('Opportunity', { CloseDate: '2026-03-31' })).toEqual({
      field: 'CloseDate',
      on: '2026-03-31',
    });
    expect(datedRateOf('Opportunity', { CloseDate: null })).toBeUndefined();
    expect(datedRateOf('Account', { CloseDate: '2026-03-31' })).toBeUndefined();
  });

  it('says the rates were dated, and by which field', () => {
    const tally = new CurrencyReplacementTally();
    const change = { from: 'GBP', to: 'USD', chosenBy: 'corporate' as const, fields: ['Amount'] };
    tally.add('Opportunity', { ...change, datedBy: 'CloseDate' });
    tally.add('Opportunity', change);

    const [dated, undated] = tally.list();
    expect(describeCurrencyReplaced(dated)).toBe(
      "1 row(s) in GBP written in USD, the target's corporate currency, GBP not being active " +
        "there: amounts converted at the source's rates, dated by CloseDate (Amount)",
    );
    expect(undated.datedBy).toBeUndefined();
  });
});

describe('replacementCurrency', () => {
  it("takes the record type's default the target holds, then its corporate currency", () => {
    const { target } = currencies();

    expect(replacementCurrency('EUR', target)).toEqual({
      to: 'EUR',
      chosenBy: 'record-type-default',
    });
    expect(replacementCurrency('GBP', target)).toEqual({ to: 'USD', chosenBy: 'corporate' });
    expect(replacementCurrency(undefined, { ...target, corporate: undefined })).toBeUndefined();
  });
});

describe('a row whose currency is its parent', () => {
  const PRICES = new Map<string, number | undefined>([
    ['UnitPrice', 2],
    ['TotalPrice', 2],
  ]);
  /** An opportunity of the source read in GBP and written in USD. */
  function opportunityChange(): CurrencyChange {
    const opportunity: Record<string, unknown> = { CurrencyIsoCode: 'GBP', Amount: 158 };
    return replaceRowCurrency(opportunity, { read: 'GBP', currencyFields: AMOUNT }, currencies())!;
  }

  it("converts a product's prices by the factor its opportunity's amount was converted by", () => {
    const line: Record<string, unknown> = { UnitPrice: 79, Quantity: 2 };

    const change = followParentCurrency(
      line,
      { read: 'GBP', parent: opportunityChange(), currencyFields: PRICES },
      currencies(),
    );

    expect(line).toEqual({ UnitPrice: 100, Quantity: 2 });
    expect(change).toEqual({
      from: 'GBP',
      to: 'USD',
      chosenBy: 'parent',
      fields: ['UnitPrice'],
      factor: 1 / 0.79,
    });
  });

  it('takes the dated rate its parent was converted at', () => {
    const line: Record<string, unknown> = { UnitPrice: 85 };
    const parent: CurrencyChange = {
      from: 'GBP',
      to: 'USD',
      chosenBy: 'corporate',
      fields: [],
      factor: 1 / 0.85,
      datedBy: 'CloseDate',
    };

    const change = followParentCurrency(
      line,
      { read: 'GBP', parent, currencyFields: PRICES },
      currencies(),
    );

    expect(line['UnitPrice']).toBe(100);
    expect(change?.datedBy).toBe('CloseDate');
  });

  it('leaves the prices as read, and says so, when the parent kept its amounts as read', () => {
    const line: Record<string, unknown> = { UnitPrice: 1000 };
    const parent: CurrencyChange = {
      from: 'JPY',
      to: 'USD',
      chosenBy: 'corporate',
      fields: [],
      notConverted: true,
    };

    const change = followParentCurrency(
      line,
      { read: 'JPY', parent, currencyFields: PRICES },
      currencies(),
    );

    expect(line['UnitPrice']).toBe(1000);
    expect(change).toMatchObject({ chosenBy: 'parent', notConverted: true, fields: [] });
  });

  it('touches nothing when the parent kept its currency, or was read in another', () => {
    const line: Record<string, unknown> = { UnitPrice: 79 };

    expect(
      followParentCurrency(line, { read: 'GBP', parent: undefined, currencyFields: PRICES }),
    ).toBeUndefined();
    expect(
      followParentCurrency(line, {
        read: 'EUR',
        parent: opportunityChange(),
        currencyFields: PRICES,
      }),
    ).toBeUndefined();
    expect(line['UnitPrice']).toBe(79);
  });

  it('finds the parent by the lookup the platform takes the currency from, then among the lookups of a detail object', () => {
    const changes = new Map<string, CurrencyChange>([['006A', opportunityChange()]]);
    const changeOf = (id: string): CurrencyChange | undefined => changes.get(id);

    expect(
      parentCurrencyChange(
        'OpportunityLineItem',
        { CurrencyIsoCode: 'GBP', OpportunityId: '006A', PricebookEntryId: '01uA' },
        [],
        changeOf,
      )?.to,
    ).toBe('USD');
    // Its other lookups say nothing of its currency.
    expect(
      parentCurrencyChange(
        'OpportunityLineItem',
        { CurrencyIsoCode: 'GBP', OpportunityId: '006B', Custom__c: '006A' },
        ['Custom__c'],
        changeOf,
      ),
    ).toBeUndefined();
    expect(
      parentCurrencyChange(
        'Detail__c',
        { CurrencyIsoCode: 'GBP', Other__c: 'a01', Master__c: '006A' },
        ['Other__c', 'Master__c'],
        changeOf,
      )?.to,
    ).toBe('USD');
    expect(
      parentCurrencyChange('Detail__c', { Master__c: '006A' }, ['Master__c'], changeOf),
    ).toBeUndefined();
  });

  it('says the rows went in the currency of the record they belong to', () => {
    expect(
      describeCurrencyReplaced({
        objectApiName: 'OpportunityLineItem',
        from: 'GBP',
        to: 'USD',
        chosenBy: 'parent',
        rows: 2,
        fields: ['UnitPrice'],
      }),
    ).toBe(
      '2 row(s) in GBP written in USD, the currency of the record they belong to: amounts ' +
        "converted at the source's rates (UnitPrice)",
    );
  });
});
