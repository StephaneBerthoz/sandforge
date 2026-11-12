/**
 * The removal of a clone of an opportunity whose quote syncs with it, as a
 * scratch org answered it: the clone wrote two line items and two quote
 * lines, and the platform copied each line item onto the synced quote as it
 * went in, a second before the run's own quote lines, as the run's user. The
 * removal deleted the run's two quote lines, the platform deleted the line
 * items they were paired with, and its two copies stayed under the quote:
 * the quote, the opportunity, the account, the products and the price book
 * were kept for records that stay. The org in memory here answers the same.
 */

import { describe, expect, it } from 'vitest';
import type { ForgeRunObjectRecords, ForgeUndoObjectResult } from '@sandforge/shared';

import { writePathOrderDefects, type WritePathStep } from '../checkpoint/beforeRunCheckpoint.js';
import { removeRunRecords, type RemovalOrg, type RunRemovalOptions } from './ForgeRunRemoval.js';
import { removalMark, removalStatus } from './removalOutcome.js';

/** A fake record id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const RUN_STARTED = '2026-09-20T10:00:00.000Z';
/** When the run wrote its line items, and the platform copied them onto the synced quote. */
const LINE_ITEMS_WRITTEN = '2026-09-20T10:02:00.000+0000';
/** A second later, when the run wrote its own quote lines. */
const QUOTE_LINES_WRITTEN = '2026-09-20T10:02:01.000+0000';
const RUN_ENDED = '2026-09-20T10:05:00.000Z';
const AFTER_RUN = '2026-09-20T11:00:00.000+0000';

/** The user the run wrote as, and the removal runs as. */
const USER = id('005', 1);
/** Someone else working in the org. */
const COLLEAGUE = id('005', 2);
/** A user of the platform's own, which may stamp what it writes in answer. */
const PLATFORM_USER = id('005', 3);

const ACCOUNT = id('001', 1);
const OPPORTUNITY = id('006', 1);
const QUOTE = id('0Q0', 1);
const PRICE_BOOK = id('01s', 1);
const PRODUCTS = [1, 2].map((n) => id('01t', n));
const PRICES = [1, 2].map((n) => id('01u', n));
const LINE_ITEMS = [1, 2].map((n) => id('00k', n));
const RUN_QUOTE_LINES = [1, 2].map((n) => id('0QL', n));
const COPIES = [3, 4].map((n) => id('0QL', n));

type Row = Record<string, unknown> & { Id: string };
interface Relationship {
  childSObject: string;
  field: string;
  cascadeDelete: boolean;
  restrictedDelete?: boolean;
}

/** The relationships the removal reads, as the scratch org's describes list them. */
const RELATIONSHIPS: Record<string, Relationship[]> = {
  Account: [{ childSObject: 'Opportunity', field: 'AccountId', cascadeDelete: true }],
  Opportunity: [
    { childSObject: 'OpportunityLineItem', field: 'OpportunityId', cascadeDelete: true },
    { childSObject: 'Quote', field: 'OpportunityId', cascadeDelete: true },
  ],
  Quote: [{ childSObject: 'QuoteLineItem', field: 'QuoteId', cascadeDelete: true }],
  PricebookEntry: [
    {
      childSObject: 'OpportunityLineItem',
      field: 'PricebookEntryId',
      cascadeDelete: false,
      restrictedDelete: true,
    },
    {
      childSObject: 'QuoteLineItem',
      field: 'PricebookEntryId',
      cascadeDelete: false,
      restrictedDelete: true,
    },
  ],
  Product2: [
    { childSObject: 'PricebookEntry', field: 'Product2Id', cascadeDelete: true },
    {
      childSObject: 'QuoteLineItem',
      field: 'Product2Id',
      cascadeDelete: false,
      restrictedDelete: true,
    },
  ],
  Pricebook2: [
    { childSObject: 'PricebookEntry', field: 'Pricebook2Id', cascadeDelete: true },
    {
      childSObject: 'Opportunity',
      field: 'Pricebook2Id',
      cascadeDelete: false,
      restrictedDelete: true,
    },
  ],
};

/**
 * An org in memory that syncs an opportunity's line items with its quote's
 * lines as the scratch org did: a quote line deleted takes the line item it
 * is paired with, which leaves the other lines paired with it unpaired and
 * restamped; a line deleted recalculates its quote; a record a restricted
 * lookup names is refused; a parent takes what cascades from it.
 */
class SyncingOrg implements RemovalOrg {
  readonly rows = new Map<string, Row[]>();
  readonly bin = new Set<string>();
  readonly deletes: Array<{ object: string; ids: string[] }> = [];
  readonly queries: string[] = [];
  /** Who the platform stamps a line it unpairs as: the user whose delete unpaired it. */
  restampedBy = USER;
  /** Told of every call, in order: a read, or a write. */
  onCall?: (kind: 'read' | 'write', what: string) => void;

  now(): string {
    return new Date().toISOString();
  }

  add(object: string, ...rows: Row[]): void {
    this.rows.set(object, [...(this.rows.get(object) ?? []), ...rows]);
  }

  has(object: string, recordId: string): boolean {
    return (this.rows.get(object) ?? []).some((row) => row.Id === recordId);
  }

  row(object: string, recordId: string): Row | undefined {
    return (this.rows.get(object) ?? []).find((row) => row.Id === recordId);
  }

  async serverTime(): Promise<string> {
    return this.now();
  }

  async userId(): Promise<string> {
    return USER;
  }

  async describe(objectApiName: string): Promise<unknown> {
    return {
      name: objectApiName,
      label: objectApiName,
      fields: [],
      childRelationships: RELATIONSHIPS[objectApiName] ?? [],
    };
  }

  async describeGlobal(): Promise<unknown> {
    const names = new Set([
      ...this.rows.keys(),
      ...Object.keys(RELATIONSHIPS),
      ...Object.values(RELATIONSHIPS)
        .flat()
        .map((r) => r.childSObject),
    ]);
    return {
      sobjects: [...names].map((name) => ({
        name,
        label: name,
        queryable: true,
        createable: true,
        layoutable: true,
      })),
    };
  }

  async update(): Promise<unknown> {
    throw new Error('nothing of this org is updated');
  }

  async queryDeleted(soql: string): Promise<{ records: unknown[] }> {
    this.onCall?.('read', soql);
    const match = /^SELECT Id FROM (\w+) WHERE Id IN \((.*)\) AND IsDeleted = true$/.exec(soql);
    if (!match) throw new Error(`unexpected query of the recycle bin: ${soql}`);
    const wanted = match[2].split(', ').map((quoted) => quoted.slice(1, -1));
    return { records: wanted.filter((recordId) => this.bin.has(recordId)).map((Id) => ({ Id })) };
  }

  async query(soql: string): Promise<{ totalSize: number; records: unknown[] }> {
    this.queries.push(soql);
    this.onCall?.('read', soql);
    // No price of this org is a standard one.
    if (/AND Pricebook2\.IsStandard = true$/.test(soql)) return { totalSize: 0, records: [] };
    const match = /^SELECT (.+) FROM (\w+) WHERE (\w+) IN \((.*)\)(?: LIMIT \d+)?$/.exec(soql);
    if (!match) throw new Error(`unexpected query: ${soql}`);
    const [, columns, object, field, list] = match;
    const wanted = new Set(list.split(', ').map((quoted) => quoted.slice(1, -1)));
    const records = (this.rows.get(object) ?? [])
      .filter((row) => wanted.has(String(row[field])))
      .map((row) => Object.fromEntries(columns.split(', ').map((c) => [c, row[c] ?? null])));
    return { totalSize: records.length, records };
  }

  async destroy(objectApiName: string, ids: string[]): Promise<unknown> {
    this.deletes.push({ object: objectApiName, ids: [...ids] });
    this.onCall?.('write', `delete ${objectApiName}`);
    return ids.map((recordId) => {
      const row = this.row(objectApiName, recordId);
      if (!row) {
        return {
          id: recordId,
          success: false,
          errors: [{ statusCode: 'ENTITY_IS_DELETED', message: 'entity is deleted' }],
        };
      }
      const holder = this.restrictedHolder(objectApiName, recordId);
      if (holder) {
        return {
          id: recordId,
          success: false,
          errors: [
            {
              statusCode: 'DELETE_FAILED',
              message: `associated with the following ${holder} records`,
            },
          ],
        };
      }
      this.remove(objectApiName, recordId);
      return { id: recordId, success: true, errors: [] };
    });
  }

  /** The object of a record pointing at `recordId` through a lookup that restricts its delete. */
  private restrictedHolder(object: string, recordId: string): string | undefined {
    return (RELATIONSHIPS[object] ?? [])
      .filter((r) => r.restrictedDelete === true)
      .find((r) => (this.rows.get(r.childSObject) ?? []).some((c) => c[r.field] === recordId))
      ?.childSObject;
  }

  private syncing(quote: unknown): boolean {
    return (this.rows.get('Opportunity') ?? []).some((o) => o.SyncedQuoteId === quote);
  }

  private remove(object: string, recordId: string): void {
    const row = this.row(object, recordId);
    if (!row) return;
    this.rows.set(
      object,
      (this.rows.get(object) ?? []).filter((r) => r.Id !== recordId),
    );
    this.bin.add(recordId);
    const now = this.now();
    if (object === 'QuoteLineItem') {
      const quote = this.row('Quote', String(row.QuoteId));
      if (quote) Object.assign(quote, { LastModifiedDate: now, LastModifiedById: USER });
      const paired = row.OpportunityLineItemId;
      if (this.syncing(row.QuoteId) && typeof paired === 'string') {
        this.remove('OpportunityLineItem', paired);
        for (const line of this.rows.get('QuoteLineItem') ?? []) {
          if (line.OpportunityLineItemId !== paired) continue;
          Object.assign(line, {
            OpportunityLineItemId: null,
            LastModifiedDate: now,
            LastModifiedById: this.restampedBy,
          });
        }
      }
    }
    if (object === 'OpportunityLineItem') {
      const opportunity = this.row('Opportunity', String(row.OpportunityId));
      if (opportunity)
        Object.assign(opportunity, { LastModifiedDate: now, LastModifiedById: USER });
    }
    for (const relationship of RELATIONSHIPS[object] ?? []) {
      if (!relationship.cascadeDelete) continue;
      for (const child of [...(this.rows.get(relationship.childSObject) ?? [])]) {
        if (child[relationship.field] === recordId)
          this.remove(relationship.childSObject, child.Id);
      }
    }
  }
}

/** A record the run created: written during it, as its user, not touched since. */
function runRow(recordId: string, fields: Record<string, unknown> = {}): Row {
  return {
    Id: recordId,
    CreatedDate: LINE_ITEMS_WRITTEN,
    LastModifiedDate: LINE_ITEMS_WRITTEN,
    CreatedById: USER,
    LastModifiedById: USER,
    ...fields,
  };
}

/** The org once the clone is through: what it wrote, and the platform's two copies. */
function clonedOpportunity(): SyncingOrg {
  const org = new SyncingOrg();
  org.add('Account', runRow(ACCOUNT));
  org.add('Pricebook2', runRow(PRICE_BOOK));
  org.add('Product2', ...PRODUCTS.map((product) => runRow(product)));
  org.add(
    'PricebookEntry',
    ...PRICES.map((price, n) =>
      runRow(price, { Product2Id: PRODUCTS[n], Pricebook2Id: PRICE_BOOK }),
    ),
  );
  org.add(
    'Opportunity',
    runRow(OPPORTUNITY, { AccountId: ACCOUNT, Pricebook2Id: PRICE_BOOK, SyncedQuoteId: QUOTE }),
  );
  org.add('Quote', runRow(QUOTE, { OpportunityId: OPPORTUNITY }));
  org.add(
    'OpportunityLineItem',
    ...LINE_ITEMS.map((item, n) =>
      runRow(item, { OpportunityId: OPPORTUNITY, PricebookEntryId: PRICES[n] }),
    ),
  );
  const line = (n: number): Record<string, unknown> => ({
    QuoteId: QUOTE,
    OpportunityLineItemId: LINE_ITEMS[n],
    PricebookEntryId: PRICES[n],
    Product2Id: PRODUCTS[n],
  });
  // The platform's copies, as the line items went in: no id of the run's.
  org.add('QuoteLineItem', ...COPIES.map((copy, n) => runRow(copy, line(n))));
  org.add(
    'QuoteLineItem',
    ...RUN_QUOTE_LINES.map((own, n) =>
      runRow(own, {
        ...line(n),
        CreatedDate: QUOTE_LINES_WRITTEN,
        LastModifiedDate: QUOTE_LINES_WRITTEN,
      }),
    ),
  );
  return org;
}

/** The run's records, children before their parents, as the clone kept them. */
const PLAN: ForgeRunObjectRecords[] = [
  { objectApiName: 'QuoteLineItem', ids: RUN_QUOTE_LINES },
  { objectApiName: 'OpportunityLineItem', ids: LINE_ITEMS },
  { objectApiName: 'PricebookEntry', ids: PRICES },
  { objectApiName: 'Quote', ids: [QUOTE] },
  { objectApiName: 'Opportunity', ids: [OPPORTUNITY] },
  { objectApiName: 'Product2', ids: PRODUCTS },
  { objectApiName: 'Pricebook2', ids: [PRICE_BOOK] },
  { objectApiName: 'Account', ids: [ACCOUNT] },
];

const PLANNED = PLAN.reduce((sum, object) => sum + object.ids.length, 0);

function options(overrides: Partial<RunRemovalOptions> = {}): RunRemovalOptions {
  return {
    runStartedAt: new Date(RUN_STARTED),
    runEndedAt: new Date(RUN_ENDED),
    includeChanged: false,
    ...overrides,
  };
}

const objectOf = (
  objects: readonly ForgeUndoObjectResult[],
  name: string,
): ForgeUndoObjectResult | undefined => objects.find((object) => object.objectApiName === name);

describe('removeRunRecords — the lines the platform copied onto a quote the run synced', () => {
  it('takes them with the run own lines and ends a success on the first removal', async () => {
    const org = clonedOpportunity();

    const outcome = await removeRunRecords(org, PLAN, options());

    expect(removalStatus(outcome.objects, outcome.cancelled)).toBe('success');
    expect(objectOf(outcome.objects, 'QuoteLineItem')).toMatchObject({
      planned: 4,
      platformCopies: 2,
      deleted: 4,
      keptDependents: 0,
    });
    // Each line item went with the first quote line paired with it.
    expect(objectOf(outcome.objects, 'OpportunityLineItem')).toMatchObject({
      planned: 2,
      alreadyGone: 2,
    });
    // Recalculated as its lines went, the quote is no change since the run.
    expect(objectOf(outcome.objects, 'Quote')).toMatchObject({ deleted: 1, keptChanged: 0 });
    for (const name of ['PricebookEntry', 'Opportunity', 'Product2', 'Pricebook2', 'Account']) {
      expect(objectOf(outcome.objects, name)?.keptDependents).toBe(0);
    }
    expect([...org.rows.values()].flat()).toEqual([]);
  });

  it('takes them whoever the platform stamps them as once it unpairs them', async () => {
    // Read as changed since the run, unpaired copies held the quote, and
    // the prices and products behind it by the lookups they restrict.
    const org = clonedOpportunity();
    org.restampedBy = PLATFORM_USER;

    const outcome = await removeRunRecords(org, PLAN, options());

    expect(removalStatus(outcome.objects, outcome.cancelled)).toBe('success');
    expect(objectOf(outcome.objects, 'QuoteLineItem')).toMatchObject({
      platformCopies: 2,
      deleted: 4,
    });
    expect(objectOf(outcome.objects, 'Quote')).toMatchObject({ deleted: 1, heldBy: [] });
  });

  it('says them apart in the run own plan, the records handed over alone said gone or left', async () => {
    const org = clonedOpportunity();

    const outcome = await removeRunRecords(org, PLAN, options());

    expect(outcome.gone.filter((recordId) => COPIES.includes(recordId))).toEqual([]);
    expect(outcome.gone).toHaveLength(PLANNED);
    const left: string[] = [];
    for await (const { ids } of outcome.left()) left.push(...ids);
    expect(left).toEqual([]);
    // The run's line counts what the removal took, the copies with the rest.
    const mark = removalMark({ ...outcome, status: 'success', finishedAt: RUN_ENDED }, PLANNED);
    expect(mark).toMatchObject({ alreadyGone: 2, kept: 0, refused: 0 });
    expect((mark?.deleted ?? 0) + (mark?.alreadyGone ?? 0)).toBe(PLANNED + COPIES.length);
  });

  it('counts them gone when a sweep granted with the removal took them first', async () => {
    const org = clonedOpportunity();

    const outcome = await removeRunRecords(
      org,
      PLAN,
      options({
        sweep: async () => {
          await org.destroy('QuoteLineItem', COPIES);
          return true;
        },
      }),
    );

    expect(removalStatus(outcome.objects, outcome.cancelled)).toBe('success');
    expect(objectOf(outcome.objects, 'QuoteLineItem')).toMatchObject({
      planned: 4,
      platformCopies: 2,
      deleted: 2,
      alreadyGone: 2,
    });
  });

  it('names them in a preview, which deletes nothing', async () => {
    const org = clonedOpportunity();

    const outcome = await removeRunRecords(org, PLAN, options({ previewOnly: true }));

    expect(outcome.preview?.objects.find((o) => o.objectApiName === 'QuoteLineItem')).toEqual(
      expect.objectContaining({ planned: 4, platformCopies: 2, toDelete: 4 }),
    );
    expect(org.deletes).toEqual([]);
    const left: string[] = [];
    for await (const { ids } of outcome.left()) left.push(...ids);
    expect(left).toHaveLength(PLANNED);
  });

  it('leaves a quote no opportunity of the run syncs with to the lines outside the run', async () => {
    // Not synced, two more lines under the quote are someone's, not copies.
    const org = clonedOpportunity();
    const opportunity = org.row('Opportunity', OPPORTUNITY);
    if (opportunity) opportunity.SyncedQuoteId = null;
    for (const copy of COPIES) {
      Object.assign(org.row('QuoteLineItem', copy) ?? {}, { LastModifiedDate: AFTER_RUN });
    }

    const outcome = await removeRunRecords(org, PLAN, options());

    expect(removalStatus(outcome.objects, outcome.cancelled)).toBe('partial');
    expect(objectOf(outcome.objects, 'QuoteLineItem')).toMatchObject({ planned: 2, deleted: 2 });
    expect(objectOf(outcome.objects, 'QuoteLineItem')?.platformCopies).toBeUndefined();
    expect(objectOf(outcome.objects, 'Quote')).toMatchObject({
      keptDependents: 1,
      heldBy: ['QuoteLineItem'],
    });
    expect(org.has('QuoteLineItem', COPIES[0])).toBe(true);
  });

  it('keeps the quote for a line a colleague added to it, the platform pairing a line item of theirs', async () => {
    const org = clonedOpportunity();
    const theirItem = id('00k', 3);
    const theirLine = id('0QL', 5);
    const theirs = {
      CreatedById: COLLEAGUE,
      LastModifiedById: COLLEAGUE,
      CreatedDate: AFTER_RUN,
      LastModifiedDate: AFTER_RUN,
    };
    org.add(
      'OpportunityLineItem',
      runRow(theirItem, { ...theirs, OpportunityId: OPPORTUNITY, PricebookEntryId: PRICES[0] }),
    );
    org.add(
      'QuoteLineItem',
      runRow(theirLine, {
        ...theirs,
        QuoteId: QUOTE,
        OpportunityLineItemId: theirItem,
        PricebookEntryId: PRICES[0],
        Product2Id: PRODUCTS[0],
      }),
    );

    const outcome = await removeRunRecords(org, PLAN, options());

    expect(removalStatus(outcome.objects, outcome.cancelled)).toBe('partial');
    expect(objectOf(outcome.objects, 'QuoteLineItem')).toMatchObject({
      planned: 4,
      platformCopies: 2,
      deleted: 4,
    });
    expect(objectOf(outcome.objects, 'Quote')?.heldBy).toEqual(['QuoteLineItem']);
    expect(org.has('QuoteLineItem', theirLine)).toBe(true);
    expect(org.has('OpportunityLineItem', theirItem)).toBe(true);
  });

  it('keeps the quote for a line the run user added once the run was over', async () => {
    const org = clonedOpportunity();
    const late = id('0QL', 6);
    org.add(
      'QuoteLineItem',
      runRow(late, {
        CreatedDate: AFTER_RUN,
        LastModifiedDate: AFTER_RUN,
        QuoteId: QUOTE,
        OpportunityLineItemId: LINE_ITEMS[0],
        PricebookEntryId: PRICES[0],
        Product2Id: PRODUCTS[0],
      }),
    );

    const outcome = await removeRunRecords(org, PLAN, options());

    expect(removalStatus(outcome.objects, outcome.cancelled)).toBe('partial');
    expect(objectOf(outcome.objects, 'QuoteLineItem')).toMatchObject({ platformCopies: 2 });
    expect(objectOf(outcome.objects, 'Quote')?.heldBy).toEqual(['QuoteLineItem']);
    expect(org.has('QuoteLineItem', late)).toBe(true);
  });

  it('keeps a copy changed since the run, and the quote with it, unless changed records go too', async () => {
    const org = clonedOpportunity();
    Object.assign(org.row('QuoteLineItem', COPIES[0]) ?? {}, {
      LastModifiedDate: AFTER_RUN,
      LastModifiedById: COLLEAGUE,
    });

    const kept = await removeRunRecords(org, PLAN, options());

    expect(objectOf(kept.objects, 'QuoteLineItem')).toMatchObject({
      platformCopies: 2,
      deleted: 3,
      keptChanged: 1,
    });
    expect(objectOf(kept.objects, 'Quote')?.heldBy).toEqual(['QuoteLineItem']);

    const included = await removeRunRecords(
      clonedOpportunityChanged(),
      PLAN,
      options({ includeChanged: true }),
    );
    expect(removalStatus(included.objects, included.cancelled)).toBe('success');
  });

  it('needs no changed records on a second removal once the first was stopped past the quote lines', async () => {
    // Deleting the copies by hand recalculated the quote, and the next
    // removal kept it as changed since the run: taken by the removal, they
    // stamp it as the removal's doing, which the next one reads back.
    const org = clonedOpportunity();
    const stop = new AbortController();

    const first = await removeRunRecords(
      org,
      PLAN,
      options({
        signal: stop.signal,
        onProgress: (_settled, _total, objectApiName) => {
          if (objectApiName === 'OpportunityLineItem') stop.abort();
        },
      }),
    );

    expect(first.cancelled).toBe(true);
    expect(objectOf(first.objects, 'QuoteLineItem')).toMatchObject({ deleted: 4 });
    expect(first.stamps[QUOTE]).toBeDefined();
    const left: ForgeRunObjectRecords[] = [];
    for await (const page of first.left()) left.push(page);

    const second = await removeRunRecords(
      org,
      left,
      options({
        removalStamps: first.stamps,
        ...(first.span ? { removalSpans: [first.span] } : {}),
      }),
    );

    expect(removalStatus(second.objects, second.cancelled)).toBe('success');
    expect(objectOf(second.objects, 'Quote')).toMatchObject({ deleted: 1, keptChanged: 0 });
    expect([...org.rows.values()].flat()).toEqual([]);
  });

  it('reads the copies before its first write, and deletes them before the prices they point at', async () => {
    const org = clonedOpportunity();
    const steps: WritePathStep[] = [];
    const calls: string[] = [];
    org.onCall = (kind, what) => {
      steps.push(kind === 'read' ? 'reads' : 'write');
      calls.push(what);
    };
    let afterRan = false;

    const outcome = await removeRunRecords(
      org,
      PLAN,
      options({
        sweep: async () => {
          steps.push('write');
          calls.push('sweep');
          return false;
        },
        afterRemoval: async () => {
          steps.push('write');
          calls.push('after');
          afterRan = true;
          return false;
        },
      }),
    );
    steps.push('result');

    expect(writePathOrderDefects(steps)).toEqual([]);
    const copiesRead = calls.findIndex((call) => call.includes('FROM QuoteLineItem WHERE QuoteId'));
    const firstWrite = calls.indexOf('sweep');
    expect(copiesRead).toBeGreaterThanOrEqual(0);
    expect(copiesRead).toBeLessThan(firstWrite);
    // Every delete of the run's records after the sweep, and the last part after them all.
    const deletes = calls.flatMap((call, at) => (call.startsWith('delete ') ? [at] : []));
    expect(Math.min(...deletes)).toBeGreaterThan(firstWrite);
    expect(calls.indexOf('after')).toBeGreaterThan(Math.max(...deletes));
    expect(calls.filter((call) => call === 'after')).toHaveLength(1);
    expect(afterRan).toBe(true);
    // The quote lines, the copies among them, before the prices they restrict.
    const objects = org.deletes.map((d) => d.object);
    expect(objects.indexOf('QuoteLineItem')).toBeLessThan(objects.indexOf('PricebookEntry'));
    expect(org.deletes.find((d) => d.ids.includes(COPIES[0]))?.object).toBe('QuoteLineItem');
    expect(removalStatus(outcome.objects, outcome.cancelled)).toBe('success');
  });
});

/** {@link clonedOpportunity} with one copy changed since the run by a colleague. */
function clonedOpportunityChanged(): SyncingOrg {
  const org = clonedOpportunity();
  Object.assign(org.row('QuoteLineItem', COPIES[0]) ?? {}, {
    LastModifiedDate: AFTER_RUN,
    LastModifiedById: COLLEAGUE,
  });
  return org;
}
