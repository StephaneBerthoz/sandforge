import { describe, expect, it } from 'vitest';
import {
  CURRENCY_TYPES_SOQL,
  CurrencyReplacementTally,
  conversionFactor,
  currencyFieldsOf,
  currencyReplacementsNote,
  describeCurrencyReplaced,
  orgCurrenciesOf,
  readOrgCurrencies,
  readRunCurrencies,
  replaceRowCurrency,
  roundToScale,
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

    expect(asked).toEqual([`source ${CURRENCY_TYPES_SOQL}`, `target ${CURRENCY_TYPES_SOQL}`]);
    expect(read?.target.active.has('GBP')).toBe(false);
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
    expect(change).toEqual({ from: 'GBP', to: 'USD', chosenBy: 'corporate', fields: ['Amount'] });
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
