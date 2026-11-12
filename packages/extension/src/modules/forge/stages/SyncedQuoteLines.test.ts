import { describe, it, expect, vi } from 'vitest';
import {
  copiesOfTheLines,
  fieldsTheCopyLacks,
  quoteLinesSoql,
  quoteLinesUnder,
  sameValue,
  syncCopiesNote,
  syncedQuoteWriteEdges,
  type QuoteLineToPair,
} from './SyncedQuoteLines.js';
import { selectRows, type FakeRow } from '../../../test/fakeSoql.js';

/** A fake id of eighteen characters: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const QUOTE = id('0Q0', 1);
const OTHER_QUOTE = id('0Q0', 2);
const PRODUCT_A = id('00k', 1);
const PRODUCT_B = id('00k', 2);

/** The source fields of the opportunity, as an org that syncs quotes describes them. */
const SYNCING = new Map([['Opportunity', [{ name: 'Id' }, { name: 'SyncedQuoteId' }]]]);

describe('syncedQuoteWriteEdges', () => {
  const ALL = new Set(['Opportunity', 'Quote', 'OpportunityLineItem', 'QuoteLineItem']);

  it('writes the quote before the opportunity’s products, so that the sync is on as they go in', () => {
    expect(syncedQuoteWriteEdges(ALL, SYNCING)).toEqual([
      {
        sourceObject: 'Quote',
        targetObject: 'OpportunityLineItem',
        relationshipName: 'QuoteBeforeOpportunityLineItem',
        type: 'lookup',
        required: true,
      },
    ]);
  });

  it('orders nothing where the opportunity cannot sync with a quote', () => {
    const without = new Map([['Opportunity', [{ name: 'Id' }, { name: 'Name' }]]]);

    expect(syncedQuoteWriteEdges(ALL, without)).toEqual([]);
    expect(syncedQuoteWriteEdges(ALL, new Map())).toEqual([]);
  });

  it('orders nothing for a run that writes no product, no quote or no opportunity', () => {
    for (const left of ['Opportunity', 'Quote', 'OpportunityLineItem']) {
      const objects = new Set([...ALL].filter((object) => object !== left));
      expect(syncedQuoteWriteEdges(objects, SYNCING)).toEqual([]);
    }
  });
});

describe('quoteLinesSoql', () => {
  it('reads the lines under the quotes paired with the products, with the fields asked besides those that pair them', () => {
    expect(
      quoteLinesSoql([QUOTE], [PRODUCT_A, PRODUCT_B], ['Quantity', 'QuoteId', 'Note__c']),
    ).toBe(
      `SELECT Id, QuoteId, OpportunityLineItemId, Quantity, Note__c FROM QuoteLineItem ` +
        `WHERE QuoteId IN ('${QUOTE}') AND OpportunityLineItemId IN ('${PRODUCT_A}', '${PRODUCT_B}')`,
    );
  });

  it('quotes the ids it is given as literals, and refuses a field that is no API name', () => {
    expect(quoteLinesSoql(["0Q0'x"], [PRODUCT_A], [])).toContain("QuoteId IN ('0Q0\\'x')");
    expect(() => quoteLinesSoql([QUOTE], [PRODUCT_A], ['Name FROM Account --'])).toThrow();
  });
});

describe('quoteLinesUnder', () => {
  it('reads the lines a list of two hundred products at a time, each statement naming only the quotes of those products’ lines', async () => {
    const lines: QuoteLineToPair[] = Array.from({ length: 450 }, (_, n) => ({
      index: n,
      quote: n < 200 ? QUOTE : OTHER_QUOTE,
      product: id('00k', n),
    }));
    const statements: string[] = [];
    const query = vi.fn(async (soql: string) => {
      statements.push(soql);
      return [{ Id: id('0QL', statements.length) }];
    });

    const read = await quoteLinesUnder(query, lines, []);

    expect(statements).toHaveLength(3);
    expect(statements.map((soql) => soql.match(/'00k/g)?.length)).toEqual([200, 200, 50]);
    expect(statements[0]).toContain(`QuoteId IN ('${QUOTE}')`);
    expect(statements[1]).toContain(`QuoteId IN ('${OTHER_QUOTE}')`);
    expect(read.map((row) => row.Id)).toEqual([id('0QL', 1), id('0QL', 2), id('0QL', 3)]);
  });

  it('reads one statement for one product named by two lines', async () => {
    const query = vi.fn(async () => []);

    await quoteLinesUnder(
      query,
      [
        { index: 0, quote: QUOTE, product: PRODUCT_A },
        { index: 1, quote: QUOTE, product: PRODUCT_A },
      ],
      [],
    );

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]).toEqual([expect.stringContaining(`IN ('${PRODUCT_A}')`)]);
  });

  it('throws what the target throws', async () => {
    const refused = new Error('INVALID_TYPE: sObject type QuoteLineItem is not supported');

    await expect(
      quoteLinesUnder(
        async () => Promise.reject(refused),
        [{ index: 0, quote: QUOTE, product: PRODUCT_A }],
        [],
      ),
    ).rejects.toBe(refused);
  });

  it('asks what a target of fake rows answers: the copies under the quote, paired with the products', async () => {
    const target: Record<string, FakeRow[]> = {
      QuoteLineItem: [
        { Id: id('0QL', 1), QuoteId: QUOTE, OpportunityLineItemId: PRODUCT_A },
        { Id: id('0QL', 2), QuoteId: OTHER_QUOTE, OpportunityLineItemId: PRODUCT_A },
        { Id: id('0QL', 3), QuoteId: QUOTE, OpportunityLineItemId: id('00k', 9) },
      ],
    };

    const read = await quoteLinesUnder(
      async (soql) => selectRows(target, soql),
      [{ index: 0, quote: QUOTE, product: PRODUCT_A }],
      [],
    );

    expect(read.map((row) => row.Id)).toEqual([id('0QL', 1)]);
  });
});

describe('copiesOfTheLines', () => {
  const copy = (n: number, quote: string, product: string | null) => ({
    Id: id('0QL', n),
    QuoteId: quote,
    OpportunityLineItemId: product,
  });

  it('pairs each line with the copy under its quote paired with its product, by the line’s index', () => {
    const paired = copiesOfTheLines(
      [
        { index: 3, quote: QUOTE, product: PRODUCT_A },
        { index: 7, quote: QUOTE, product: PRODUCT_B },
      ],
      [copy(2, QUOTE, PRODUCT_B), copy(1, QUOTE, PRODUCT_A)],
      new Set(),
    );

    expect([...paired].map(([index, row]) => [index, row.Id])).toEqual([
      [3, id('0QL', 1)],
      [7, id('0QL', 2)],
    ]);
  });

  it('pairs a copy whose ids the target writes in eighteen characters with a line that holds them in fifteen', () => {
    const paired = copiesOfTheLines(
      [{ index: 0, quote: QUOTE.slice(0, 15), product: PRODUCT_A.slice(0, 15) }],
      [copy(1, QUOTE, PRODUCT_A)],
      new Set(),
    );

    expect(paired.get(0)?.Id).toBe(id('0QL', 1));
  });

  it('gives no line a copy under another quote, one paired with no product, or one already taken', () => {
    const paired = copiesOfTheLines(
      [{ index: 0, quote: QUOTE, product: PRODUCT_A }],
      [copy(1, OTHER_QUOTE, PRODUCT_A), copy(2, QUOTE, null), copy(3, QUOTE, PRODUCT_A)],
      new Set([id('0QL', 3).slice(0, 15)]),
    );

    expect(paired.size).toBe(0);
  });

  it('gives a copy to one line only, the first: a second line of the same product goes in as written', () => {
    const paired = copiesOfTheLines(
      [
        { index: 0, quote: QUOTE, product: PRODUCT_A },
        { index: 1, quote: QUOTE, product: PRODUCT_A },
      ],
      [copy(1, QUOTE, PRODUCT_A)],
      new Set(),
    );

    expect([...paired.keys()]).toEqual([0]);
  });
});

describe('sameValue', () => {
  it('holds absent, null and no text for the same empty value, and none of them for a value', () => {
    expect(sameValue(undefined, null)).toBe(true);
    expect(sameValue('', null)).toBe(true);
    expect(sameValue(null, 'Oak')).toBe(false);
    expect(sameValue('Oak', undefined)).toBe(false);
    // Zero is a value, and so is the text of an empty one.
    expect(sameValue(0, null)).toBe(false);
    expect(sameValue('null', null)).toBe(false);
  });

  it('holds a number for the same however each side writes it', () => {
    expect(sameValue(2, '2')).toBe(true);
    expect(sameValue('2', 2.0)).toBe(true);
    expect(sameValue(2, '2.0')).toBe(true);
    expect(sameValue('2.50', 2.5)).toBe(true);
    expect(sameValue(2, 2.5)).toBe(false);
    expect(sameValue(2, 'two')).toBe(false);
  });

  it('holds two spellings of one instant for the same, and two dates for different', () => {
    expect(sameValue('2026-11-01T10:00:00.000+0000', '2026-11-01T10:00:00.000Z')).toBe(true);
    expect(sameValue('2026-11-01T10:00:00.000+0000', '2026-11-01T11:00:00.000+0000')).toBe(false);
    expect(sameValue('2026-11-01', '2026-11-02')).toBe(false);
  });

  it('holds texts for the same only when they are, and a flag for its text', () => {
    expect(sameValue('Oak', 'Oak')).toBe(true);
    expect(sameValue('Oak', 'oak')).toBe(false);
    expect(sameValue(true, 'true')).toBe(true);
    expect(sameValue(true, false)).toBe(false);
  });
});

describe('fieldsTheCopyLacks', () => {
  const copy = {
    Id: id('0QL', 1),
    QuoteId: QUOTE,
    OpportunityLineItemId: PRODUCT_A,
    Quantity: 2,
    Description: 'Desk',
    Engraving__c: null,
  };
  const anyField = (): boolean => true;

  it('names the fields the copy holds otherwise, with the line’s values, and none it holds the same', () => {
    const line = {
      QuoteId: QUOTE,
      OpportunityLineItemId: PRODUCT_A,
      Quantity: '2',
      Description: 'Desk',
      Engraving__c: 'Oak',
    };

    expect(fieldsTheCopyLacks(line, copy, anyField)).toEqual({ Engraving__c: 'Oak' });
  });

  it('empties a field the line leaves empty that the copy holds', () => {
    expect(fieldsTheCopyLacks({ Description: null }, copy, anyField)).toEqual({
      Description: null,
    });
  });

  it('never names the fields that pair the copy, one an update cannot set, or one the second pass owes', () => {
    const line = {
      Id: id('0QL', 9),
      QuoteId: OTHER_QUOTE,
      OpportunityLineItemId: PRODUCT_B,
      Engraving__c: 'Oak',
      Description: 'Chair',
      Kit__c: id('a02', 1),
    };

    expect(
      fieldsTheCopyLacks(line, copy, (field) => field !== 'Engraving__c', new Set(['Kit__c'])),
    ).toEqual({ Description: 'Chair' });
  });
});

describe('syncCopiesNote', () => {
  it('says how many lines were the platform’s copies, and how many were given fields', () => {
    expect(syncCopiesNote(2, 1, false)).toBe(
      "2 of them the platform's copies of their opportunity products, made as the quote syncs " +
        'with its opportunity: taken rather than written twice, 1 given the fields the copy lacked',
    );
    expect(syncCopiesNote(1, 0, false)).toBe(
      "1 of them the platform's copy of its opportunity product, made as the quote syncs with " +
        'its opportunity: taken rather than written twice',
    );
  });

  it('says on a simulation what the lines would be', () => {
    expect(syncCopiesNote(2, 0, true)).toBe(
      "2 of them would be the platform's copies of their opportunity products, made as the " +
        'quote syncs with its opportunity: taken rather than written twice',
    );
  });
});
