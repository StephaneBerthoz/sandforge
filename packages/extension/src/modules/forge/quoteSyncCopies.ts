/**
 * The lines the platform copies as a run writes under a quote it synced with
 * its opportunity: part of the run, though its id map never held them.
 *
 * While an opportunity syncs with a quote (`Opportunity.SyncedQuoteId`), the
 * platform copies each line item inserted on the opportunity onto the quote
 * as a quote line, and each quote line onto the opportunity, the two paired
 * by `QuoteLineItem.OpportunityLineItemId`; deleting a quote line deletes the
 * line item it is paired with. A clone sets the opportunity's synced quote
 * right after the quote, before the lines: cloned on a scratch org, an
 * opportunity of two lines with its synced quote came out with four quote
 * lines, two of them copied by the platform from the run's line items a
 * second before the run wrote its own, created as the run's user. The
 * removal deleted the run's two quote lines, the platform deleted their line
 * items, and the two copies stayed under the quote, unpaired and restamped:
 * the quote, the opportunity, the account, the products and the price book
 * were kept for records that stay, and the removal ended partial. Deleting
 * the copies by hand recalculated the quote's totals, and the next removal
 * kept the quote as changed since the run.
 *
 * A copy is told by what ties it to the run, never by its date alone:
 *
 * - a quote line under a quote of the run that an opportunity of the run
 *   syncs with, paired with one of the run's line items, that the run's id
 *   map does not hold;
 * - and the other way, a line item under such an opportunity that one of the
 *   run's quote lines is paired with, for a run that wrote the quote's lines
 *   before the opportunity's;
 * - created as the run's user — the one it kept, or else the one who created
 *   the record of the run it is paired with — while the run wrote, by the
 *   org's clock.
 *
 * A line a colleague added, one added after the run, and one whose pair is
 * not the run's are not copies: they stay, and hold the quote as they did.
 */

import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { idLists, type OrgSession } from '../dataops/RecordRemoval.js';

/** The objects of a quote that syncs with its opportunity, and of their lines. */
export const QUOTE_OBJECT = 'Quote';
const QUOTE_LINE_OBJECT = 'QuoteLineItem';
const OPPORTUNITY_OBJECT = 'Opportunity';
const OPPORTUNITY_LINE_OBJECT = 'OpportunityLineItem';

/**
 * Rows one read of a quote's or an opportunity's lines takes. A read that
 * fills it may hold more than it read, and no copy is told from it.
 */
const LINES_READ_LIMIT = 2_000;

/** A record by its first fifteen characters: the same record, whichever length its id is written in. */
function keyOf(id: string): string {
  return id.slice(0, 15);
}

/** A date the org wrote, in epoch milliseconds; NaN when there is none to read. */
function epochOf(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : Number.NaN;
}

/** The key of a reference a row holds, or undefined when it holds none. */
function referenceOf(row: Readonly<Record<string, unknown>>, field: string): string | undefined {
  const value = row[field];
  return typeof value === 'string' && value !== '' ? keyOf(value) : undefined;
}

/** What the copies of a run are told against. */
export interface QuoteSyncRun {
  /** Whether a record is the run's, by its key. */
  has(key: string): boolean;
  /** The run's first write, by the org's clock. */
  start: number;
  /** The last stamp the run left, by the org's clock. */
  end: number;
  /**
   * The key of the user the run wrote as, where it kept it. Absent, the
   * creator of the run's record a copy is paired with stands for it.
   */
  user?: string;
}

/** A record the platform copied as the run wrote. */
export interface PlatformCopy {
  id: string;
  /** When the org last modified it; NaN when it did not say. */
  modified: number;
}

/** What the org holds of a run's synced quotes, as {@link quoteSyncCopiesOf} reads it. */
export interface QuoteSyncReading {
  /** The opportunities that sync with a quote of the run: `Id` and `SyncedQuoteId`. */
  syncing: ReadonlyArray<Readonly<Record<string, unknown>>>;
  /**
   * The quote lines under those quotes: `Id`, `QuoteId`, `OpportunityLineItemId`,
   * `CreatedById`, `CreatedDate` and `LastModifiedDate`.
   */
  quoteLines: ReadonlyArray<Readonly<Record<string, unknown>>>;
  /**
   * The line items under those opportunities: `Id`, `OpportunityId`,
   * `CreatedById`, `CreatedDate` and `LastModifiedDate`.
   */
  opportunityLines: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

/** The copies of a run, per object: quote lines first, then line items. Empty when there is none. */
export type PlatformCopies = Array<{ objectApiName: string; copies: PlatformCopy[] }>;

/**
 * Of what the org holds under a run's synced quotes, the records the platform
 * copied as the run wrote: see the module's comment. Reads nothing.
 */
export function quoteSyncCopiesAmong(reading: QuoteSyncReading, run: QuoteSyncRun): PlatformCopies {
  // A quote counts only where an opportunity of the run syncs with it.
  const syncedQuotes = new Set<string>();
  const syncingOpportunities = new Set<string>();
  for (const row of reading.syncing) {
    const opportunity = referenceOf(row, 'Id');
    const quote = referenceOf(row, 'SyncedQuoteId');
    if (!opportunity || !quote || !run.has(opportunity) || !run.has(quote)) continue;
    syncedQuotes.add(quote);
    syncingOpportunities.add(opportunity);
  }
  if (syncedQuotes.size === 0) return [];
  const quoteLines = reading.quoteLines.filter((row) => {
    const quote = referenceOf(row, 'QuoteId');
    return quote !== undefined && syncedQuotes.has(quote) && referenceOf(row, 'Id') !== undefined;
  });
  const opportunityLines = reading.opportunityLines.filter((row) => {
    const opportunity = referenceOf(row, 'OpportunityId');
    return (
      opportunity !== undefined &&
      syncingOpportunities.has(opportunity) &&
      referenceOf(row, 'Id') !== undefined
    );
  });
  const creatorOf = (row: Readonly<Record<string, unknown>>): string | undefined =>
    referenceOf(row, 'CreatedById');
  /**
   * Whether `row`, outside the run, is the platform's copy of the run's
   * record `pair`: created as the run's user — or, where the run did not keep
   * its user, as the one who created `pair` — while the run wrote.
   */
  const copied = (
    row: Readonly<Record<string, unknown>>,
    pair: Readonly<Record<string, unknown>> | undefined,
  ): boolean => {
    const key = referenceOf(row, 'Id');
    if (!key || run.has(key) || !pair) return false;
    const user = run.user ?? creatorOf(pair);
    const created = epochOf(row.CreatedDate);
    return (
      user !== undefined && creatorOf(row) === user && created >= run.start && created <= run.end
    );
  };
  const copyOf = (row: Readonly<Record<string, unknown>>): PlatformCopy => ({
    id: String(row.Id),
    modified: epochOf(row.LastModifiedDate),
  });

  // The run's line items, and the line items each of the run's quote lines is paired with.
  const runLineItems = new Map(
    opportunityLines.flatMap((row) => {
      const key = referenceOf(row, 'Id');
      return key && run.has(key) ? [[key, row] as const] : [];
    }),
  );
  const pairedWithRunLines = new Map<string, Readonly<Record<string, unknown>>>();
  for (const row of quoteLines) {
    const key = referenceOf(row, 'Id');
    const pair = referenceOf(row, 'OpportunityLineItemId');
    if (key && pair && run.has(key) && !pairedWithRunLines.has(pair)) {
      pairedWithRunLines.set(pair, row);
    }
  }

  const copiedLines = quoteLines
    .filter((row) => {
      const pair = referenceOf(row, 'OpportunityLineItemId');
      return copied(row, pair ? runLineItems.get(pair) : undefined);
    })
    .map(copyOf);
  const copiedItems = opportunityLines
    .filter((row) => {
      const key = referenceOf(row, 'Id');
      return copied(row, key ? pairedWithRunLines.get(key) : undefined);
    })
    .map(copyOf);
  return [
    ...(copiedLines.length > 0 ? [{ objectApiName: QUOTE_LINE_OBJECT, copies: copiedLines }] : []),
    ...(copiedItems.length > 0
      ? [{ objectApiName: OPPORTUNITY_LINE_OBJECT, copies: copiedItems }]
      : []),
  ];
}

/**
 * The objects outside `objects` the platform's copies of a run's lines can be
 * on, which its removal takes at their object's turn as it reads them
 * ({@link quoteSyncCopiesOf}): the quote lines of a run that wrote a quote, an
 * opportunity and its line items but none of the quote's lines — a clone that
 * left them out of its plan, or past its depth —, and the line items of one
 * that wrote the quote's lines but none of the opportunity's. Nothing for a
 * run that wrote both, or neither, or no quote and opportunity: no copy of it
 * is ever on an object it did not write.
 *
 * Told before anything is read, so that what the target runs as those records
 * go is read with the rest: the removal of such a clone deleted the copies
 * without a word of the flow on their object, nothing asked and nothing muted.
 * A run whose opportunity syncs with no quote of its own has no copy, and its
 * removal reads that object's automation all the same: it cannot tell which
 * until it reads the org.
 */
export function quoteSyncCopyObjectsOf(objects: Iterable<string>): string[] {
  const of = new Set(objects);
  if (!of.has(QUOTE_OBJECT) || !of.has(OPPORTUNITY_OBJECT)) return [];
  const quoteLines = of.has(QUOTE_LINE_OBJECT);
  const opportunityLines = of.has(OPPORTUNITY_LINE_OBJECT);
  if (quoteLines === opportunityLines) return [];
  return [quoteLines ? OPPORTUNITY_LINE_OBJECT : QUOTE_LINE_OBJECT];
}

/**
 * The rows of `object` whose `field` names one of `ids`, a list at a time.
 * A read that fills its limit throws: what it left unread could hold a copy
 * as well as a colleague's line.
 */
async function rowsNaming(
  org: Pick<OrgSession, 'query'>,
  object: string,
  columns: readonly string[],
  field: string,
  ids: readonly string[],
): Promise<Array<Record<string, unknown>>> {
  const select = columns.map(assertSoqlIdentifier).join(', ');
  const rows: Array<Record<string, unknown>> = [];
  for (const list of idLists(ids)) {
    const answer = await org.query(
      `SELECT ${select} FROM ${assertSoqlIdentifier(object)} ` +
        `WHERE ${assertSoqlIdentifier(field)} IN (${list}) LIMIT ${LINES_READ_LIMIT}`,
    );
    if (answer.records.length >= LINES_READ_LIMIT) {
      throw new Error(`More ${object} records than one read takes.`);
    }
    for (const record of answer.records) {
      if (typeof record === 'object' && record !== null) {
        rows.push(record as Record<string, unknown>);
      }
    }
  }
  return rows;
}

/**
 * The records the platform copied as a run wrote under the quotes it synced,
 * read before the run's removal writes anything: once the run's quote lines
 * are deleted, the platform deletes the line items they were paired with,
 * and its copies lose the pairing that tells them.
 *
 * Nothing is read for a run that created no quote, no opportunity, or
 * neither quote lines nor line items: no copy of it can be told. A read the
 * org refuses, or one that fills its limit, tells none: the lines stay, and
 * hold the quote as any record that stays.
 *
 * @param quotes - The ids of the run's quotes.
 * @param objects - The objects the run created records of.
 */
export async function quoteSyncCopiesOf(
  org: Pick<OrgSession, 'query'>,
  run: QuoteSyncRun,
  quotes: readonly string[],
  objects: ReadonlySet<string>,
): Promise<PlatformCopies> {
  const lines = objects.has(QUOTE_LINE_OBJECT) || objects.has(OPPORTUNITY_LINE_OBJECT);
  if (quotes.length === 0 || !objects.has(OPPORTUNITY_OBJECT) || !lines) return [];
  try {
    const syncing = await rowsNaming(
      org,
      OPPORTUNITY_OBJECT,
      ['Id', 'SyncedQuoteId'],
      'SyncedQuoteId',
      quotes,
    );
    const synced = syncing.filter((row) => {
      const opportunity = referenceOf(row, 'Id');
      return opportunity !== undefined && run.has(opportunity);
    });
    if (synced.length === 0) return [];
    const quoteLines = await rowsNaming(
      org,
      QUOTE_LINE_OBJECT,
      ['Id', 'QuoteId', 'OpportunityLineItemId', 'CreatedById', 'CreatedDate', 'LastModifiedDate'],
      'QuoteId',
      [...new Set(synced.map((row) => String(row.SyncedQuoteId)))],
    );
    const opportunityLines = await rowsNaming(
      org,
      OPPORTUNITY_LINE_OBJECT,
      ['Id', 'OpportunityId', 'CreatedById', 'CreatedDate', 'LastModifiedDate'],
      'OpportunityId',
      synced.map((row) => String(row.Id)),
    );
    return quoteSyncCopiesAmong({ syncing: synced, quoteLines, opportunityLines }, run);
  } catch {
    return [];
  }
}
