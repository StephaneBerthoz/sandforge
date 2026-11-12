import { describe, expect, it } from 'vitest';

import {
  quoteSyncCopiesAmong,
  quoteSyncCopiesOf,
  quoteSyncCopyObjectsOf,
  type QuoteSyncReading,
  type QuoteSyncRun,
} from './quoteSyncCopies.js';

/** A fake record id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const RUN_STARTED = '2026-09-20T10:00:00.000Z';
const RUN_ENDED = '2026-09-20T10:05:00.000Z';
/** When the run wrote its line items, and the platform copied them onto the synced quote. */
const LINE_ITEMS_WRITTEN = '2026-09-20T10:02:00.000+0000';
/** A second later, when the run wrote its own quote lines. */
const QUOTE_LINES_WRITTEN = '2026-09-20T10:02:01.000+0000';
const AFTER_RUN = '2026-09-20T11:00:00.000+0000';
const BEFORE_RUN = '2026-09-19T09:00:00.000+0000';

/** The user the run wrote as. */
const RUN_USER = id('005', 1);
/** Someone else working in the org. */
const COLLEAGUE = id('005', 2);

const OPPORTUNITY = id('006', 1);
const QUOTE = id('0Q0', 1);
const LINE_ITEMS = [1, 2].map((n) => id('00k', n));
const RUN_QUOTE_LINES = [1, 2].map((n) => id('0QL', n));
const COPIES = [3, 4].map((n) => id('0QL', n));

/** The run that cloned an opportunity, its synced quote and two lines on each. */
function runOf(overrides: Partial<QuoteSyncRun> = {}): QuoteSyncRun {
  const keys = new Set(
    [OPPORTUNITY, QUOTE, ...LINE_ITEMS, ...RUN_QUOTE_LINES].map((recordId) =>
      recordId.slice(0, 15),
    ),
  );
  return {
    has: (key) => keys.has(key),
    start: Date.parse(RUN_STARTED),
    end: Date.parse(RUN_ENDED),
    ...overrides,
  };
}

/**
 * What the org holds once the run is through: the run's two line items, the
 * two quote lines the platform copied from them as they went in, and the
 * run's own two quote lines, each paired with the same line item as a copy.
 */
function reading(): QuoteSyncReading {
  return {
    syncing: [{ Id: OPPORTUNITY, SyncedQuoteId: QUOTE }],
    opportunityLines: LINE_ITEMS.map((Id) => ({
      Id,
      OpportunityId: OPPORTUNITY,
      CreatedById: RUN_USER,
      CreatedDate: LINE_ITEMS_WRITTEN,
      LastModifiedDate: LINE_ITEMS_WRITTEN,
    })),
    quoteLines: [
      ...COPIES.map((Id, n) => ({
        Id,
        QuoteId: QUOTE,
        OpportunityLineItemId: LINE_ITEMS[n],
        CreatedById: RUN_USER,
        CreatedDate: LINE_ITEMS_WRITTEN,
        LastModifiedDate: LINE_ITEMS_WRITTEN,
      })),
      ...RUN_QUOTE_LINES.map((Id, n) => ({
        Id,
        QuoteId: QUOTE,
        OpportunityLineItemId: LINE_ITEMS[n],
        CreatedById: RUN_USER,
        CreatedDate: QUOTE_LINES_WRITTEN,
        LastModifiedDate: QUOTE_LINES_WRITTEN,
      })),
    ],
  };
}

/** `reading()` with the quote lines changed where `change` says. */
function withQuoteLines(
  change: (row: Record<string, unknown>) => Record<string, unknown>,
): QuoteSyncReading {
  const read = reading();
  return { ...read, quoteLines: read.quoteLines.map((row) => change({ ...row })) };
}

describe('quoteSyncCopiesAmong', () => {
  it('tells the quote lines the platform copied from the run line items, never the run own', () => {
    expect(quoteSyncCopiesAmong(reading(), runOf())).toEqual([
      {
        objectApiName: 'QuoteLineItem',
        copies: COPIES.map((copy) => ({ id: copy, modified: Date.parse(LINE_ITEMS_WRITTEN) })),
      },
    ]);
  });

  it('leaves a line a colleague added, paired with a line item of the run', () => {
    const read = withQuoteLines((row) =>
      row.Id === COPIES[0] ? { ...row, CreatedById: COLLEAGUE } : row,
    );

    const copies = quoteSyncCopiesAmong(read, runOf());

    expect(copies.flatMap((object) => object.copies.map((copy) => copy.id))).toEqual([COPIES[1]]);
  });

  it('leaves a line added after the run, or dated before it', () => {
    const read = withQuoteLines((row) =>
      row.Id === COPIES[0]
        ? { ...row, CreatedDate: AFTER_RUN }
        : row.Id === COPIES[1]
          ? { ...row, CreatedDate: BEFORE_RUN }
          : row,
    );

    expect(quoteSyncCopiesAmong(read, runOf())).toEqual([]);
  });

  it('leaves a line paired with a line item the run did not create', () => {
    const foreign = id('00k', 9);
    const read = withQuoteLines((row) =>
      row.Id === COPIES[0] ? { ...row, OpportunityLineItemId: foreign } : row,
    );
    read.opportunityLines = [
      ...read.opportunityLines,
      {
        Id: foreign,
        OpportunityId: OPPORTUNITY,
        CreatedById: RUN_USER,
        CreatedDate: LINE_ITEMS_WRITTEN,
      },
    ];

    const copies = quoteSyncCopiesAmong(read, runOf());

    expect(copies.flatMap((object) => object.copies.map((copy) => copy.id))).toEqual([COPIES[1]]);
  });

  it('leaves an unpaired line, whatever its creator and date', () => {
    const read = withQuoteLines((row) =>
      row.Id === COPIES[0] ? { ...row, OpportunityLineItemId: null } : row,
    );

    const copies = quoteSyncCopiesAmong(read, runOf());

    expect(copies.flatMap((object) => object.copies.map((copy) => copy.id))).toEqual([COPIES[1]]);
  });

  it('tells none under a quote no opportunity of the run syncs with', () => {
    expect(quoteSyncCopiesAmong({ ...reading(), syncing: [] }, runOf())).toEqual([]);
    const foreign = id('006', 9);
    expect(
      quoteSyncCopiesAmong(
        { ...reading(), syncing: [{ Id: foreign, SyncedQuoteId: QUOTE }] },
        runOf(),
      ),
    ).toEqual([]);
  });

  it('holds the copies to the user the run kept, where it kept one', () => {
    // A clone that may set audit fields writes the source's creator on its
    // records: the user it kept is the one the platform copied as.
    const read = reading();
    read.opportunityLines = read.opportunityLines.map((row) => ({
      ...row,
      CreatedById: COLLEAGUE,
    }));

    expect(quoteSyncCopiesAmong(read, runOf())).toEqual([]);
    expect(
      quoteSyncCopiesAmong(read, runOf({ user: RUN_USER.slice(0, 15) })).flatMap((object) =>
        object.copies.map((copy) => copy.id),
      ),
    ).toEqual(COPIES);
  });

  it('tells a record by its first fifteen characters, whichever length the org wrote it in', () => {
    const read = withQuoteLines((row) => ({
      ...row,
      OpportunityLineItemId: String(row.OpportunityLineItemId).slice(0, 15),
      CreatedById: RUN_USER.slice(0, 15),
    }));

    expect(
      quoteSyncCopiesAmong(read, runOf()).flatMap((object) => object.copies.map((c) => c.id)),
    ).toEqual(COPIES);
  });

  it('tells the line items the platform copied from the run quote lines, the other way round', () => {
    // Written quote lines first, the platform copies each onto the
    // opportunity as a line item, and pairs the run's quote line with it.
    const copiedItems = [3, 4].map((n) => id('00k', n));
    const keys = new Set(
      [OPPORTUNITY, QUOTE, ...RUN_QUOTE_LINES].map((recordId) => recordId.slice(0, 15)),
    );
    const read: QuoteSyncReading = {
      syncing: [{ Id: OPPORTUNITY, SyncedQuoteId: QUOTE }],
      quoteLines: RUN_QUOTE_LINES.map((Id, n) => ({
        Id,
        QuoteId: QUOTE,
        OpportunityLineItemId: copiedItems[n],
        CreatedById: RUN_USER,
        CreatedDate: QUOTE_LINES_WRITTEN,
        LastModifiedDate: QUOTE_LINES_WRITTEN,
      })),
      opportunityLines: copiedItems.map((Id) => ({
        Id,
        OpportunityId: OPPORTUNITY,
        CreatedById: RUN_USER,
        CreatedDate: QUOTE_LINES_WRITTEN,
        LastModifiedDate: QUOTE_LINES_WRITTEN,
      })),
    };

    expect(quoteSyncCopiesAmong(read, runOf({ has: (key) => keys.has(key) }))).toEqual([
      {
        objectApiName: 'OpportunityLineItem',
        copies: copiedItems.map((copy) => ({
          id: copy,
          modified: Date.parse(QUOTE_LINES_WRITTEN),
        })),
      },
    ]);
  });
});

/** An org answering `SELECT … FROM object WHERE field IN (…) LIMIT n` from rows in memory. */
class LinesOrg {
  readonly queries: string[] = [];
  readonly rows = new Map<string, Array<Record<string, unknown>>>();
  failing?: RegExp;

  constructor(read: QuoteSyncReading) {
    this.rows.set('Opportunity', [...read.syncing]);
    this.rows.set('QuoteLineItem', [...read.quoteLines]);
    this.rows.set('OpportunityLineItem', [...read.opportunityLines]);
  }

  async query(soql: string): Promise<{ totalSize: number; records: unknown[] }> {
    this.queries.push(soql);
    if (this.failing?.test(soql)) throw new Error('INVALID_FIELD: No such column');
    const match = /^SELECT (.+) FROM (\w+) WHERE (\w+) IN \((.*)\) LIMIT (\d+)$/.exec(soql);
    if (!match) throw new Error(`unexpected query: ${soql}`);
    const [, columns, object, field, list, limit] = match;
    const wanted = new Set(list.split(', ').map((quoted) => quoted.slice(1, -1)));
    const records = (this.rows.get(object) ?? [])
      .filter((row) => wanted.has(String(row[field])))
      .slice(0, Number(limit))
      .map((row) => Object.fromEntries(columns.split(', ').map((c) => [c, row[c]])));
    return { totalSize: records.length, records };
  }
}

const RUN_OBJECTS = new Set(['Opportunity', 'Quote', 'OpportunityLineItem', 'QuoteLineItem']);

describe('quoteSyncCopiesAmong, of one part of a run cut and taken up', () => {
  /** The resume: the quote and its lines, the opportunity the cut part's. */
  const resume = (otherParts?: QuoteSyncRun['otherParts']): QuoteSyncRun => {
    const keys = new Set(
      [QUOTE, ...LINE_ITEMS, ...RUN_QUOTE_LINES].map((recordId) => recordId.slice(0, 15)),
    );
    return { ...runOf({ has: (key) => keys.has(key) }), ...(otherParts ? { otherParts } : {}) };
  };
  const cutPart = {
    has: (key: string) => key === OPPORTUNITY.slice(0, 15),
    objects: new Set(['Account', 'Opportunity']),
  };

  it('tells the copies of its lines under its quote, the opportunity that syncs with it another part’s', () => {
    expect(quoteSyncCopiesAmong(reading(), resume(cutPart))).toEqual([
      {
        objectApiName: 'QuoteLineItem',
        copies: COPIES.map((copy) => ({ id: copy, modified: Date.parse(LINE_ITEMS_WRITTEN) })),
      },
    ]);
    // Told against the part's own records alone, none: live, the resume's
    // removal took them uncounted.
    expect(quoteSyncCopiesAmong(reading(), resume())).toEqual([]);
  });

  it('takes no record of another part for a copy', () => {
    const theirs = { has: (key: string) => key === COPIES[0].slice(0, 15) || cutPart.has(key) };

    const copies = quoteSyncCopiesAmong(reading(), resume({ ...cutPart, ...theirs }));

    expect(copies.flatMap((object) => object.copies.map((copy) => copy.id))).toEqual([COPIES[1]]);
  });

  it('reads the lines of a part without an opportunity when another part wrote one', async () => {
    const org = new LinesOrg(reading());
    const objects = new Set(['Quote', 'OpportunityLineItem']);

    expect(await quoteSyncCopiesOf(org, resume(), [QUOTE], objects)).toEqual([]);
    expect(org.queries).toEqual([]);
    const copies = await quoteSyncCopiesOf(org, resume(cutPart), [QUOTE], objects);
    expect(copies.flatMap((object) => object.copies.map((copy) => copy.id))).toEqual(COPIES);
  });
});

describe('quoteSyncCopiesOf', () => {
  it('reads the syncing opportunities by the run quotes, then the lines under them', async () => {
    const org = new LinesOrg(reading());

    const copies = await quoteSyncCopiesOf(org, runOf(), [QUOTE], RUN_OBJECTS);

    expect(copies.flatMap((object) => object.copies.map((copy) => copy.id))).toEqual(COPIES);
    expect(org.queries).toEqual([
      `SELECT Id, SyncedQuoteId FROM Opportunity WHERE SyncedQuoteId IN ('${QUOTE}') LIMIT 2000`,
      'SELECT Id, QuoteId, OpportunityLineItemId, CreatedById, CreatedDate, LastModifiedDate ' +
        `FROM QuoteLineItem WHERE QuoteId IN ('${QUOTE}') LIMIT 2000`,
      'SELECT Id, OpportunityId, CreatedById, CreatedDate, LastModifiedDate ' +
        `FROM OpportunityLineItem WHERE OpportunityId IN ('${OPPORTUNITY}') LIMIT 2000`,
    ]);
  });

  it('reads nothing for a run without a quote, an opportunity, or lines', async () => {
    const org = new LinesOrg(reading());

    expect(await quoteSyncCopiesOf(org, runOf(), [], RUN_OBJECTS)).toEqual([]);
    expect(
      await quoteSyncCopiesOf(org, runOf(), [QUOTE], new Set(['Quote', 'QuoteLineItem'])),
    ).toEqual([]);
    expect(
      await quoteSyncCopiesOf(org, runOf(), [QUOTE], new Set(['Quote', 'Opportunity'])),
    ).toEqual([]);
    expect(org.queries).toEqual([]);
  });

  it('reads no line once no opportunity of the run syncs with its quotes', async () => {
    const org = new LinesOrg({
      ...reading(),
      syncing: [{ Id: id('006', 9), SyncedQuoteId: QUOTE }],
    });

    expect(await quoteSyncCopiesOf(org, runOf(), [QUOTE], RUN_OBJECTS)).toEqual([]);
    expect(org.queries).toHaveLength(1);
  });

  it('tells none when the org refuses a read', async () => {
    const org = new LinesOrg(reading());
    org.failing = /FROM OpportunityLineItem/;

    expect(await quoteSyncCopiesOf(org, runOf(), [QUOTE], RUN_OBJECTS)).toEqual([]);
  });

  it('tells none from a read that fills its limit, which may hold more than it read', async () => {
    const read = reading();
    const many = Array.from({ length: 2_000 }, (_, n) => ({
      Id: id('0QL', 100 + n),
      QuoteId: QUOTE,
      OpportunityLineItemId: null,
      CreatedById: COLLEAGUE,
      CreatedDate: AFTER_RUN,
    }));
    const org = new LinesOrg({ ...read, quoteLines: [...read.quoteLines, ...many] });

    expect(await quoteSyncCopiesOf(org, runOf(), [QUOTE], RUN_OBJECTS)).toEqual([]);
  });
});

describe('quoteSyncCopyObjectsOf', () => {
  it('names the quote lines for a run that wrote a quote, its opportunity and line items, and none of the quote’s lines', () => {
    expect(
      quoteSyncCopyObjectsOf(['Account', 'Opportunity', 'Quote', 'OpportunityLineItem']),
    ).toEqual(['QuoteLineItem']);
  });

  it('names the line items for a run that wrote the quote’s lines and none of the opportunity’s', () => {
    expect(quoteSyncCopyObjectsOf(new Set(['Opportunity', 'Quote', 'QuoteLineItem']))).toEqual([
      'OpportunityLineItem',
    ]);
  });

  it('names the quote lines for a part that wrote a quote and line items, another part its opportunity', () => {
    expect(quoteSyncCopyObjectsOf(['Quote', 'OpportunityLineItem'], ['Opportunity'])).toEqual([
      'QuoteLineItem',
    ]);
    expect(quoteSyncCopyObjectsOf(['Quote', 'OpportunityLineItem'])).toEqual([]);
    // Its quote another part's, no copy of its lines is its removal's.
    expect(quoteSyncCopyObjectsOf(['OpportunityLineItem'], ['Opportunity', 'Quote'])).toEqual([]);
  });

  it('names nothing for a run whose plan holds both lines, neither, or no quote and opportunity', () => {
    expect(
      quoteSyncCopyObjectsOf(['Opportunity', 'Quote', 'OpportunityLineItem', 'QuoteLineItem']),
    ).toEqual([]);
    expect(quoteSyncCopyObjectsOf(['Opportunity', 'Quote'])).toEqual([]);
    expect(quoteSyncCopyObjectsOf(['Opportunity', 'OpportunityLineItem'])).toEqual([]);
    expect(quoteSyncCopyObjectsOf(['Quote', 'QuoteLineItem'])).toEqual([]);
  });
});
