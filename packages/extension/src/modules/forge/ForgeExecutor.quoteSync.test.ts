import { describe, it, expect, vi } from 'vitest';
import type { ForgeGraph, ForgeGraphEdge, ForgeGraphNode } from '@sandforge/shared';
import { ForgeExecutor } from './ForgeExecutor.js';
import type {
  ExecuteOptions,
  ExecutionSummary,
  FieldInfo,
  ForgeExecutorDeps,
  ForgeProgressEvent,
  ForgeWriteBoundary,
  ForgeWriteGateAnswer,
  InsertResult,
  UpdateResult,
} from './ForgeExecutor.js';
import { finishedRunStatus } from './runResult.js';
import { selectRows, type FakeRow } from '../../test/fakeSoql.js';
import { to18 } from '../../core/common/salesforceId.js';
import { writePathOrderDefects, type WritePathStep } from '../checkpoint/beforeRunCheckpoint.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * An opportunity whose quote syncs with it, cloned with its products and the
 * quote's lines. Run on a scratch org, the clone set the opportunity's synced
 * quote in its second pass, right after the quote; the platform copied each
 * product it then wrote onto the quote as a line paired with it; and the run
 * wrote the source's two lines as well: four lines under the quote for two,
 * each product paired with two, the totals doubled. The target here does what
 * that org did.
 */

/** A fake id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const OPPORTUNITY = id('006', 1);
const QUOTE = id('0Q0', 1);
const PRODUCT_A = id('00k', 1);
const PRODUCT_B = id('00k', 2);
const LINE_A = id('0QL', 1);
const LINE_B = id('0QL', 2);
const NOTE = id('a01', 1);

const field = (name: string, overrides: Partial<FieldInfo> = {}): FieldInfo => ({
  name,
  queryable: true,
  createable: name !== 'Id',
  isReference: false,
  ...overrides,
});
const lookup = (name: string, to: string, nillable: boolean): FieldInfo =>
  field(name, { isReference: true, referenceTo: [to], nillable });

/** Both orgs' describes. A line's engraving is a custom field, which the sync never copies. */
const FIELDS: Record<string, FieldInfo[]> = {
  Opportunity: [field('Id'), field('Name'), lookup('SyncedQuoteId', 'Quote', true)],
  Quote: [field('Id'), field('Name'), lookup('OpportunityId', 'Opportunity', false)],
  OpportunityLineItem: [
    field('Id'),
    lookup('OpportunityId', 'Opportunity', false),
    field('Quantity'),
    field('Description'),
  ],
  QuoteLineItem: [
    field('Id'),
    lookup('QuoteId', 'Quote', false),
    lookup('OpportunityLineItemId', 'OpportunityLineItem', true),
    field('Quantity'),
    field('Description'),
    field('Engraving__c'),
  ],
  Line_Note__c: [field('Id'), field('Name'), lookup('Line__c', 'QuoteLineItem', false)],
};

/** A second quote of the opportunity, without lines. */
const DRAFT_QUOTE = id('0Q0', 2);

/**
 * The source: one opportunity of two products, synced with its quote, whose
 * two lines are paired with them — or synced with no quote, or with a second
 * quote of its, without lines.
 */
function sourceTables(syncs: 'its quote' | 'no quote' | 'another quote' = 'its quote') {
  const synced = { 'its quote': QUOTE, 'no quote': null, 'another quote': DRAFT_QUOTE }[syncs];
  const tables: Record<string, FakeRow[]> = {
    Opportunity: [{ Id: OPPORTUNITY, Name: 'Deal', SyncedQuoteId: synced }],
    Quote: [
      { Id: QUOTE, Name: 'Offer', OpportunityId: OPPORTUNITY },
      ...(syncs === 'another quote'
        ? [{ Id: DRAFT_QUOTE, Name: 'Draft', OpportunityId: OPPORTUNITY }]
        : []),
    ],
    OpportunityLineItem: [
      { Id: PRODUCT_A, OpportunityId: OPPORTUNITY, Quantity: '2', Description: 'Desk' },
      { Id: PRODUCT_B, OpportunityId: OPPORTUNITY, Quantity: '5', Description: 'Chair' },
    ],
    QuoteLineItem: [
      {
        Id: LINE_A,
        QuoteId: QUOTE,
        OpportunityLineItemId: PRODUCT_A,
        Quantity: '2',
        Description: 'Desk',
        Engraving__c: 'Oak',
      },
      {
        Id: LINE_B,
        QuoteId: QUOTE,
        OpportunityLineItemId: PRODUCT_B,
        Quantity: '5',
        Description: 'Chair',
        Engraving__c: null,
      },
    ],
    Line_Note__c: [{ Id: NOTE, Name: 'Gift wrap', Line__c: LINE_A }],
  };
  return tables;
}

/** The fields of a product the sync copies onto its line. */
const SYNCED_FIELDS = ['Quantity', 'Description'] as const;

function node(objectApiName: string, level: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 2,
    fieldCount: 4,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 3,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'rest',
  };
}

const edge = (parent: string, child: string, relationshipName: string): ForgeGraphEdge => ({
  sourceObject: parent,
  targetObject: child,
  relationshipName,
  type: 'lookup',
});

/**
 * The opportunity, its quote, its products and the quote's lines, in the
 * order `nodes` gives: discovery's order, which no write order relies on.
 */
function graphOf(nodes: string[]): ForgeGraph {
  return {
    nodes: nodes.map((name, level) => node(name, level)),
    edges: [
      edge('Opportunity', 'Quote', 'Quotes'),
      edge('Quote', 'Opportunity', 'SyncedQuoteId'),
      edge('Opportunity', 'OpportunityLineItem', 'OpportunityLineItems'),
      edge('Quote', 'QuoteLineItem', 'QuoteLineItems'),
      edge('OpportunityLineItem', 'QuoteLineItem', 'OpportunityLineItemId'),
      edge('QuoteLineItem', 'Line_Note__c', 'Line__c'),
    ],
    totalRecords: 0,
    estimatedSizeMB: 0,
    estimatedDurationSeconds: 0,
  };
}

const GRAPH = graphOf([
  'Opportunity',
  'Quote',
  'OpportunityLineItem',
  'QuoteLineItem',
  'Line_Note__c',
]);

const ROOTED: ExecuteOptions = { rootRecordId: OPPORTUNITY, rootObjectApiName: 'Opportunity' };

/** Key prefixes the target gives each object's new records. */
const PREFIX: Record<string, string> = {
  Opportunity: '006',
  Quote: '0Q0',
  OpportunityLineItem: '00k',
  QuoteLineItem: '0QL',
  Line_Note__c: 'a01',
};

/**
 * A source holding {@link sourceTables}, and a target that syncs a quote with
 * the opportunity whose `SyncedQuoteId` names it, as the scratch org did: a
 * product inserted on such an opportunity is copied onto the quote as a line
 * paired with it, its standard fields with it, as the run's user; a line
 * inserted with its product named is paired with it, and copied nowhere; and
 * syncing a quote makes the opportunity's products the quote's lines ("the
 * existing opportunity line items are replaced", Salesforce Help, "How Quote
 * Syncing Works"). Every read, write and update the target is asked is
 * logged in `calls`.
 */
function orgs(
  options: {
    syncs?: Parameters<typeof sourceTables>[0];
    quoteLinesRefused?: Error;
    updateRefused?: string;
    /** What the target holds before the run. */
    held?: Record<string, FakeRow[]>;
    /** Whether it refuses an opportunity, a quote or a product it holds one of by name, naming it. */
    refusesWhatItHolds?: boolean;
    /** The source's quote lines, in place of its two. */
    lines?: FakeRow[];
  } = {},
) {
  const source = sourceTables(options.syncs);
  if (options.lines) source.QuoteLineItem = options.lines;
  const target: Record<string, FakeRow[]> = Object.fromEntries(
    Object.entries(options.held ?? {}).map(([object, rows]) => [
      object,
      rows.map((r) => ({ ...r })),
    ]),
  );
  const calls: string[] = [];
  let next = 900;
  const created = (objectApiName: string, row: FakeRow): string => {
    const newId = id(PREFIX[objectApiName] ?? '000', ++next);
    (target[objectApiName] ??= []).push({ ...row, Id: newId });
    return newId;
  };
  const syncedQuoteOf = (opportunity: unknown): string | undefined => {
    const row = target.Opportunity?.find((o) => o.Id === opportunity);
    const quote = row?.SyncedQuoteId;
    return typeof quote === 'string' && quote !== '' ? quote : undefined;
  };
  const deps = {
    describeFields: vi.fn(async (_org: string, object: string) => FIELDS[object] ?? [field('Id')]),
    queryRecords: vi.fn(async (org: string, soql: string) => {
      const object = /FROM (\w+)/.exec(soql)?.[1] ?? '';
      if (org === 'src') {
        calls.push(`read ${object}`);
        return selectRows(source, soql);
      }
      if (object === 'QuoteLineItem' && soql.includes('OpportunityLineItemId IN')) {
        calls.push('read the copies');
        if (options.quoteLinesRefused) throw options.quoteLinesRefused;
      }
      try {
        return selectRows(target, soql);
      } catch {
        return [];
      }
    }),
    insertRecords: vi.fn(async (_org: string, object: string, rows: Record<string, unknown>[]) => {
      calls.push(`insert ${object}`);
      return rows.map((row): InsertResult => {
        const named = row.Name ?? row.Description;
        const held =
          options.refusesWhatItHolds && object !== 'QuoteLineItem'
            ? target[object]?.find(
                (r) => named !== undefined && (r.Name ?? r.Description) === named,
              )
            : undefined;
        if (held) {
          return {
            id: '',
            success: false,
            errors: [
              `DUPLICATE_VALUE: duplicate value found: Name duplicates value on record with id: ${held.Id}`,
            ],
          };
        }
        const newId = created(object, row as FakeRow);
        const quote =
          object === 'OpportunityLineItem' ? syncedQuoteOf(row.OpportunityId) : undefined;
        if (quote) {
          const copy: FakeRow = { QuoteId: quote, OpportunityLineItemId: newId };
          for (const name of SYNCED_FIELDS) copy[name] = (row[name] as string | undefined) ?? null;
          created('QuoteLineItem', copy);
        }
        return { id: newId, success: true, errors: [] };
      });
    }),
    updateRecords: vi.fn(async (_org: string, object: string, rows: Record<string, unknown>[]) => {
      calls.push(`update ${object}`);
      return rows.map((row): UpdateResult => {
        if (object === 'QuoteLineItem' && options.updateRefused) {
          return { id: String(row.Id), success: false, errors: [options.updateRefused] };
        }
        const held = target[object]?.find((r) => r.Id === row.Id);
        const before = held?.SyncedQuoteId;
        if (held) Object.assign(held, row);
        const quote = object === 'Opportunity' ? row.SyncedQuoteId : undefined;
        if (typeof quote === 'string' && quote !== '' && quote !== before) {
          target.OpportunityLineItem = (target.OpportunityLineItem ?? []).filter(
            (product) => product.OpportunityId !== row.Id,
          );
          for (const line of target.QuoteLineItem ?? []) {
            if (line.QuoteId !== quote) continue;
            const product: FakeRow = { OpportunityId: String(row.Id) };
            for (const name of SYNCED_FIELDS) product[name] = line[name] ?? null;
            line.OpportunityLineItemId = created('OpportunityLineItem', product);
          }
        }
        return { id: String(row.Id), success: true, errors: [] };
      });
    }),
  } satisfies ForgeExecutorDeps;
  return { deps, target, calls };
}

/** The lines under the target's quote, each with the product it is paired with and its engraving. */
function linesOfTheQuote(target: Record<string, FakeRow[]>) {
  return (target.QuoteLineItem ?? []).map((line) => ({
    product: (target.OpportunityLineItem ?? []).find((p) => p.Id === line.OpportunityLineItemId)
      ?.Description,
    engraving: line.Engraving__c ?? null,
  }));
}

/** The line that ends an object's write. */
function lineOf(events: ForgeProgressEvent[], objectApiName: string): string | undefined {
  return events.filter((e) => e.objectName === objectApiName && e.status === 'done').at(-1)
    ?.message;
}

async function run(
  deps: ForgeExecutorDeps,
  options: ExecuteOptions = ROOTED,
  graph: ForgeGraph = GRAPH,
): Promise<{ summary: ExecutionSummary; events: ForgeProgressEvent[] }> {
  const events: ForgeProgressEvent[] = [];
  const summary = await new ForgeExecutor(deps).execute(
    graph,
    'src',
    'tgt',
    (e) => events.push(e),
    options,
  );
  return { summary, events };
}

describe('ForgeExecutor, the lines of a quote that syncs with its opportunity', () => {
  it('leaves the quote with the source’s two lines, not four: each the platform’s copy of its product, taken', async () => {
    const { deps, target } = orgs();

    const { summary, events } = await run(deps);

    expect(target.QuoteLineItem).toHaveLength(2);
    expect(linesOfTheQuote(target)).toEqual([
      { product: 'Desk', engraving: 'Oak' },
      { product: 'Chair', engraving: null },
    ]);
    expect(deps.insertRecords.mock.calls.map(([, object]) => object)).not.toContain(
      'QuoteLineItem',
    );
    expect(lineOf(events, 'QuoteLineItem')).toBe(
      "Completed QuoteLineItem: 2 succeeded (2 of them the platform's copies of their " +
        'opportunity products, made as the quote syncs with its opportunity: taken rather ' +
        'than written twice, 1 given the fields the copy lacked), 0 failed',
    );
    expect(summary.errors).toEqual([]);
    expect(finishedRunStatus(summary)).toBe('success');
  });

  it('maps each source line onto its copy, as a line the run created: what points at it points at the copy, and a removal takes it back', async () => {
    const { deps, target } = orgs();

    const { summary } = await run(deps);

    const copies = (target.QuoteLineItem ?? []).map((line) => line.Id);
    expect([summary.remapTable[LINE_A], summary.remapTable[LINE_B]]).toEqual(copies);
    expect(summary.createdByObject).toContainEqual({
      objectApiName: 'QuoteLineItem',
      sourceIds: [LINE_A, LINE_B],
    });
    expect(summary.existingSourceIds).not.toContain(LINE_A);
    expect(target.Line_Note__c).toEqual([
      expect.objectContaining({ Name: 'Gift wrap', Line__c: summary.remapTable[LINE_A] }),
    ]);
    expect(summary.successCount).toBe(7);
  });

  it('gives a copy only the fields it lacks, by one update, and none to a copy that lacks nothing', async () => {
    const { deps } = orgs();

    await run(deps);

    const updates = deps.updateRecords.mock.calls.filter(
      ([, object]) => object === 'QuoteLineItem',
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.[2]).toEqual([{ Id: expect.any(String), Engraving__c: 'Oak' }]);
  });

  it('turns the sync on before the products go in, whatever order discovery met them in, and keeps them', async () => {
    // The products met before the quote: written first, they went in before
    // the opportunity synced with it, and syncing it then left the
    // opportunity the lines of a quote that had none.
    const { deps, calls, target } = orgs();
    const graph = graphOf([
      'Opportunity',
      'OpportunityLineItem',
      'Quote',
      'QuoteLineItem',
      'Line_Note__c',
    ]);

    await run(deps, ROOTED, graph);

    expect((target.OpportunityLineItem ?? []).map((product) => product.Description)).toEqual([
      'Desk',
      'Chair',
    ]);
    expect(linesOfTheQuote(target)).toEqual([
      { product: 'Desk', engraving: 'Oak' },
      { product: 'Chair', engraving: null },
    ]);
    const writes = calls.filter((call) => call.startsWith('insert') || call.startsWith('update'));
    expect(writes.slice(0, 4)).toEqual([
      'insert Opportunity',
      'insert Quote',
      'update Opportunity',
      'insert OpportunityLineItem',
    ]);
  });

  it('says on a dry run that the two lines would be the platform’s copies, reading nothing of the target for them and writing nothing', async () => {
    const { deps, calls } = orgs();

    const { summary, events } = await run(deps, { ...ROOTED, dryRun: true });

    expect(calls.filter((call) => !call.startsWith('read ') || call === 'read the copies')).toEqual(
      [],
    );
    expect(lineOf(events, 'QuoteLineItem')).toBe(
      "Simulated QuoteLineItem: 2 would be inserted (2 of them would be the platform's copies " +
        'of their opportunity products, made as the quote syncs with its opportunity: taken ' +
        'rather than written twice), 0 failed',
    );
    expect(summary.wouldInsertCount).toBe(7);
  });

  it('says on a dry run what the real run then does: as many records, as many lines taken from the copies', async () => {
    const dry = await run(orgs().deps, { ...ROOTED, dryRun: true });
    const real = await run(orgs().deps);

    expect(dry.summary.wouldInsertCount).toBe(real.summary.successCount);
    const takenOf = (events: ForgeProgressEvent[]): string | undefined =>
      /\((\d+) of them/.exec(lineOf(events, 'QuoteLineItem') ?? '')?.[1];
    expect(takenOf(dry.events)).toBe('2');
    expect(takenOf(real.events)).toBe('2');
  });

  it('takes no copy of a quote the opportunity does not sync with, and writes its lines as read, as its dry run says', async () => {
    const { deps, target } = orgs({ syncs: 'no quote' });

    const dry = await run(orgs({ syncs: 'no quote' }).deps, { ...ROOTED, dryRun: true });
    const { events } = await run(deps);

    expect(target.QuoteLineItem).toHaveLength(2);
    expect(deps.insertRecords.mock.calls.map(([, object]) => object)).toContain('QuoteLineItem');
    expect(lineOf(events, 'QuoteLineItem')).toBe('Completed QuoteLineItem: 2 succeeded, 0 failed');
    expect(lineOf(dry.events, 'QuoteLineItem')).toBe(
      'Simulated QuoteLineItem: 2 would be inserted, 0 failed',
    );
  });

  it('takes the copies the run it retries left, once it writes the lines that run never reached', async () => {
    // The first run stopped after the products: the platform had copied
    // them onto the quote, and the retry wrote the source's lines beside them.
    const earlier = {
      opportunity: id('006', 801),
      quote: id('0Q0', 801),
      productA: id('00k', 801),
      productB: id('00k', 802),
      copyA: id('0QL', 801),
      copyB: id('0QL', 802),
    };
    const { deps, target } = orgs({
      held: {
        Opportunity: [{ Id: earlier.opportunity, Name: 'Deal', SyncedQuoteId: earlier.quote }],
        Quote: [{ Id: earlier.quote, Name: 'Offer', OpportunityId: earlier.opportunity }],
        OpportunityLineItem: [
          { Id: earlier.productA, OpportunityId: earlier.opportunity, Description: 'Desk' },
          { Id: earlier.productB, OpportunityId: earlier.opportunity, Description: 'Chair' },
        ],
        QuoteLineItem: [
          { Id: earlier.copyA, QuoteId: earlier.quote, OpportunityLineItemId: earlier.productA },
          { Id: earlier.copyB, QuoteId: earlier.quote, OpportunityLineItemId: earlier.productB },
        ],
      },
    });

    const { summary } = await run(deps, {
      ...ROOTED,
      writtenBefore: {
        [OPPORTUNITY]: earlier.opportunity,
        [QUOTE]: earlier.quote,
        [PRODUCT_A]: earlier.productA,
        [PRODUCT_B]: earlier.productB,
      },
    });

    expect(target.QuoteLineItem).toHaveLength(2);
    expect([summary.remapTable[LINE_A], summary.remapTable[LINE_B]]).toEqual([
      earlier.copyA,
      earlier.copyB,
    ]);
    expect(target.QuoteLineItem?.[0]).toMatchObject({ Id: earlier.copyA, Engraving__c: 'Oak' });
  });

  it('never takes for a line the record of another line the run it retries wrote itself', async () => {
    // Two lines of one product, as an org that syncs no longer pairs them:
    // the first written by the run retried, beside the platform's copy of
    // the product. The second is the copy, never the first one's record.
    const LINE_C = id('0QL', 3);
    const earlier = {
      opportunity: id('006', 801),
      quote: id('0Q0', 801),
      productA: id('00k', 801),
      productB: id('00k', 802),
      lineA: id('0QL', 801),
      copyA: id('0QL', 802),
    };
    const { deps } = orgs({
      lines: [
        { Id: LINE_A, QuoteId: QUOTE, OpportunityLineItemId: PRODUCT_A, Description: 'Desk' },
        { Id: LINE_C, QuoteId: QUOTE, OpportunityLineItemId: PRODUCT_A, Description: 'Desk' },
      ],
      held: {
        Opportunity: [{ Id: earlier.opportunity, Name: 'Deal', SyncedQuoteId: earlier.quote }],
        Quote: [{ Id: earlier.quote, Name: 'Offer', OpportunityId: earlier.opportunity }],
        OpportunityLineItem: [
          { Id: earlier.productA, OpportunityId: earlier.opportunity, Description: 'Desk' },
          { Id: earlier.productB, OpportunityId: earlier.opportunity, Description: 'Chair' },
        ],
        QuoteLineItem: [
          { Id: earlier.lineA, QuoteId: earlier.quote, OpportunityLineItemId: earlier.productA },
          { Id: earlier.copyA, QuoteId: earlier.quote, OpportunityLineItemId: earlier.productA },
        ],
      },
    });

    const { summary } = await run(deps, {
      ...ROOTED,
      writtenBefore: {
        [OPPORTUNITY]: earlier.opportunity,
        [QUOTE]: earlier.quote,
        [PRODUCT_A]: earlier.productA,
        [PRODUCT_B]: earlier.productB,
        [LINE_A]: earlier.lineA,
      },
    });

    expect(summary.remapTable[LINE_A]).toBe(earlier.lineA);
    expect(summary.remapTable[LINE_C]).toBe(earlier.copyA);
  });

  it('never takes as the run’s a line under a quote and a product the target already held', async () => {
    // Linked to the target's own quote and products, the source's lines
    // found the target's own lines paired with them: taken as created, a
    // removal of the run would delete them.
    const held = (prefix: string, n: number): string =>
      to18(`${prefix}${String(n).padStart(12, '0')}`);
    const heldLines = [held('0QL', 701), held('0QL', 702)];
    const { deps, target } = orgs({
      refusesWhatItHolds: true,
      held: {
        Opportunity: [{ Id: held('006', 701), Name: 'Deal', SyncedQuoteId: held('0Q0', 701) }],
        Quote: [{ Id: held('0Q0', 701), Name: 'Offer', OpportunityId: held('006', 701) }],
        OpportunityLineItem: [
          { Id: held('00k', 701), OpportunityId: held('006', 701), Description: 'Desk' },
          { Id: held('00k', 702), OpportunityId: held('006', 701), Description: 'Chair' },
        ],
        QuoteLineItem: [
          { Id: heldLines[0], QuoteId: held('0Q0', 701), OpportunityLineItemId: held('00k', 701) },
          { Id: heldLines[1], QuoteId: held('0Q0', 701), OpportunityLineItemId: held('00k', 702) },
        ],
      },
    });

    const { summary } = await run(deps);

    expect(summary.remapTable[QUOTE]).toBe(held('0Q0', 701));
    expect(summary.remapTable[PRODUCT_A]).toBe(held('00k', 701));
    expect(heldLines).not.toContain(summary.remapTable[LINE_A]);
    expect(heldLines).not.toContain(summary.remapTable[LINE_B]);
    expect(
      target.QuoteLineItem?.filter((line) => heldLines.includes(String(line.Id))).map(
        (line) => line.Engraving__c,
      ),
    ).toEqual([undefined, undefined]);
  });

  it('takes no copy of the lines of a quote the opportunity does not sync with when it syncs with another, as its dry run says', async () => {
    // The platform copies the products onto the synced quote, which is not
    // the one these lines go under.
    const { deps, target } = orgs({ syncs: 'another quote' });

    const dry = await run(orgs({ syncs: 'another quote' }).deps, { ...ROOTED, dryRun: true });
    const { events, summary } = await run(deps);

    const synced = summary.remapTable[DRAFT_QUOTE];
    expect(target.QuoteLineItem?.filter((line) => line.QuoteId === synced)).toHaveLength(2);
    expect(target.QuoteLineItem?.filter((line) => line.QuoteId !== synced)).toHaveLength(2);
    expect(lineOf(events, 'QuoteLineItem')).toBe('Completed QuoteLineItem: 2 succeeded, 0 failed');
    expect(lineOf(dry.events, 'QuoteLineItem')).toBe(
      'Simulated QuoteLineItem: 2 would be inserted, 0 failed',
    );
  });

  it('takes one copy for two lines of one product and writes the other, as its dry run says', async () => {
    // The platform copies a product once: the second line has no copy.
    const lines: FakeRow[] = [
      { Id: LINE_A, QuoteId: QUOTE, OpportunityLineItemId: PRODUCT_A, Description: 'Desk' },
      { Id: LINE_B, QuoteId: QUOTE, OpportunityLineItemId: PRODUCT_A, Description: 'Desk' },
    ];
    const { deps, target } = orgs({ lines });

    const dry = await run(orgs({ lines }).deps, { ...ROOTED, dryRun: true });
    const { events } = await run(deps);

    // The copies of both products, and the second line of the first.
    expect(target.QuoteLineItem).toHaveLength(3);
    expect(lineOf(events, 'QuoteLineItem')).toMatch(
      /^Completed QuoteLineItem: 2 succeeded \(1 of them the platform's copy of its opportunity product/,
    );
    expect(lineOf(dry.events, 'QuoteLineItem')).toMatch(
      /^Simulated QuoteLineItem: 2 would be inserted \(1 of them would be the platform's copy/,
    );
  });

  it('writes the lines as read when the copies cannot be read, and says why the quote may hold a line twice', async () => {
    const { deps, target } = orgs({ quoteLinesRefused: new Error('INSUFFICIENT_ACCESS: no') });

    const { summary } = await run(deps);

    expect(target.QuoteLineItem).toHaveLength(4);
    expect(summary.errors).toEqual([
      {
        objectApiName: 'QuoteLineItem',
        stage: 'scope',
        failedCount: 0,
        attemptedCount: 0,
        samples: [
          {
            recordSummary: '(quote lines the platform copied from their opportunity products)',
            messages: [
              'Not looked up, so written as read: a quote that syncs with its opportunity may ' +
                'hold a line twice. INSUFFICIENT_ACCESS: no',
            ],
          },
        ],
      },
    ]);
  });

  it('takes a copy the target refuses the update of, as the platform wrote it, and says what it lacks', async () => {
    const { deps, target, calls } = orgs({
      updateRefused: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Engraving needs a size',
    });

    const { summary, events } = await run(deps);

    expect(target.QuoteLineItem).toHaveLength(2);
    expect(calls).not.toContain('insert QuoteLineItem');
    expect(lineOf(events, 'QuoteLineItem')).toContain('2 succeeded (2 of them');
    expect(lineOf(events, 'QuoteLineItem')).not.toContain('given the fields');
    expect(summary.errors).toEqual([
      expect.objectContaining({
        objectApiName: 'QuoteLineItem',
        failedCount: 0,
        attemptedCount: 1,
        samples: [
          {
            recordSummary: '(quote lines the platform copied from their opportunity products)',
            messages: [
              expect.stringContaining(
                "Taken, and left as the platform copied them, without the fields of the source's " +
                  'lines: ',
              ),
            ],
          },
        ],
      }),
    ]);
    expect(summary.errors[0]?.samples[0]?.messages[0]).toContain('Engraving needs a size');
    expect(finishedRunStatus(summary)).toBe('success');
  });

  it('keeps the write path in its order: the gate, the lease, the writes, the copies read and given their fields under the lease, the lease given back, the result', async () => {
    const { deps, calls } = orgs();
    const giveBack = vi.fn(async () => {
      calls.push('lease given back');
    });
    const beforeWrite = vi.fn(async (boundary: ForgeWriteBoundary) => {
      calls.push('gate');
      calls.push('lease taken');
      const answer: ForgeWriteGateAnswer = { lease: { assigned: 0, giveBack } };
      return boundary.dryRun ? undefined : answer;
    });

    await run(deps, { ...ROOTED, beforeWrite });
    calls.push('result');

    const steps = calls.flatMap((call): WritePathStep[] => {
      if (call.startsWith('read ')) return ['reads'];
      if (call === 'gate') return ['question'];
      if (call === 'lease taken') return ['leaseAcquire'];
      if (call.startsWith('insert') || call.startsWith('update') || call === 'read the copies') {
        return ['write'];
      }
      if (call === 'lease given back') return ['leaseRelease'];
      return call === 'result' ? ['result'] : [];
    });
    expect(writePathOrderDefects(steps)).toEqual([]);
    // Counted: one gate and one lease, given back once; four objects
    // inserted and no quote line; the synced quote set, then one read of
    // the copies and one update of the one that lacked a field.
    expect(steps.filter((step) => step === 'question')).toHaveLength(1);
    expect(steps.filter((step) => step === 'leaseAcquire')).toHaveLength(1);
    expect(giveBack).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call.startsWith('insert'))).toEqual([
      'insert Opportunity',
      'insert Quote',
      'insert OpportunityLineItem',
      'insert Line_Note__c',
    ]);
    const write = calls.slice(calls.indexOf('lease taken'), calls.indexOf('lease given back'));
    expect(write.filter((call) => call === 'read the copies')).toHaveLength(1);
    expect(write.filter((call) => call === 'update QuoteLineItem')).toHaveLength(1);
    expect(write.indexOf('read the copies')).toBeGreaterThan(
      write.indexOf('insert OpportunityLineItem'),
    );
    expect(write.indexOf('update QuoteLineItem')).toBeLessThan(
      write.indexOf('insert Line_Note__c'),
    );
  });
});
