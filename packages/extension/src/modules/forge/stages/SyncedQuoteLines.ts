/**
 * The quote lines the platform writes itself while a run writes the products
 * of an opportunity that syncs with one of the run's quotes: each is the line
 * the source holds, taken as the run's own rather than written a second time.
 *
 * While an opportunity syncs with a quote (`Opportunity.SyncedQuoteId`), "the
 * quote and opportunity continue to sync each way" (Salesforce Help, "How
 * Quote Syncing Works"): each product inserted on the opportunity is copied
 * onto the quote as a quote line, paired with it by
 * `QuoteLineItem.OpportunityLineItemId`, and deleting a quote line deletes
 * the product it is paired with. A clone sets the synced quote in its second
 * pass, right after the quote and before the products. Run on a scratch org,
 * an opportunity of two products with its synced quote came out with four
 * quote lines under the quote: two copied by the platform from the run's
 * products, created as the run's user a second before the run wrote the
 * source's two, each product paired with two lines and the quote's totals
 * doubled.
 *
 * Starting the sync once the lines are in is no way out. Syncing a quote
 * makes the opportunity's products the quote's lines — "the existing
 * opportunity line items are replaced by the newly synced quote records",
 * the same article says of a quote synced in another's place — so the
 * products the run wrote would go, with what hangs from them, their
 * schedules, and the fields a product holds that its line does not; and a
 * sync started on a quote with no line yet leaves the opportunity none. So
 * the sync goes on first, the quote written before the products
 * ({@link syncedQuoteWriteEdges}), the platform copies each product the run
 * writes, and each quote line the source holds is the copy paired with its
 * product: read under its quote ({@link quoteLinesUnder}), mapped as the line
 * the run created — what points at it points at the copy, and the removal of
 * the run's records takes it back — and given by an update the fields of the
 * source's line the copy did not take ({@link fieldsTheCopyLacks}): the sync
 * copies a line's standard fields, never its custom ones.
 */

import type { ForgeGraphEdge } from '@sandforge/shared';
import { assertSoqlIdentifier, sanitizeSoqlValue } from '../../../core/common/soqlValidator.js';

/** The quote's lines, which the platform copies from the products of the opportunity it syncs with. */
export const QUOTE_LINE_OBJECT = 'QuoteLineItem';
/** The quote. */
export const QUOTE_OBJECT = 'Quote';
/** The opportunity, whose `SyncedQuoteId` names the quote it syncs with. */
export const OPPORTUNITY_OBJECT = 'Opportunity';
/** The opportunity's products. */
export const OPPORTUNITY_LINE_OBJECT = 'OpportunityLineItem';
/** The opportunity's lookup at the quote it syncs with. */
export const SYNCED_QUOTE_FIELD = 'SyncedQuoteId';
/** A quote line's lookup at its quote. */
export const QUOTE_FIELD = 'QuoteId';
/** A quote line's lookup at the product it is paired with. */
export const PAIRED_PRODUCT_FIELD = 'OpportunityLineItemId';

/** The fields that pair a copy with its line: never part of what it lacks. */
const PAIRING_FIELDS: ReadonlySet<string> = new Set(['Id', QUOTE_FIELD, PAIRED_PRODUCT_FIELD]);

/** A record by its first fifteen characters: the same record, whichever length its id is written in. */
function keyOf(id: string): string {
  return id.slice(0, 15);
}

/** The key of the id a row holds in `field`, or undefined when it holds none. */
function referenceOf(row: Readonly<Record<string, unknown>>, field: string): string | undefined {
  const value = row[field];
  return typeof value === 'string' && value !== '' ? keyOf(value) : undefined;
}

/**
 * The write order of a run that writes an opportunity's products and its
 * quotes, as an edge between them: the quote first, so that the second pass
 * sets the opportunity's synced quote before any product goes in, and the
 * platform copies each product onto the quote as the run writes it.
 *
 * Nothing in the graph orders the two — a product points at its opportunity
 * and its price, a quote at its opportunity — and a product written first
 * goes in before the sync is on: syncing the quote then makes the
 * opportunity's products the quote's lines, of which it has none yet. Kept
 * only where the opportunity can sync with a quote at all: its fields name
 * `SyncedQuoteId`.
 *
 * @param objects - The objects the run writes; the edge joins two of them only.
 * @param fieldsOf - The source fields of the objects the run has described.
 */
export function syncedQuoteWriteEdges(
  objects: ReadonlySet<string>,
  fieldsOf: ReadonlyMap<string, ReadonlyArray<{ readonly name: string }>>,
): ForgeGraphEdge[] {
  if (
    !objects.has(OPPORTUNITY_OBJECT) ||
    !objects.has(QUOTE_OBJECT) ||
    !objects.has(OPPORTUNITY_LINE_OBJECT)
  ) {
    return [];
  }
  const syncs = fieldsOf.get(OPPORTUNITY_OBJECT)?.some((f) => f.name === SYNCED_QUOTE_FIELD);
  if (syncs !== true) return [];
  return [
    {
      sourceObject: QUOTE_OBJECT,
      targetObject: OPPORTUNITY_LINE_OBJECT,
      relationshipName: `${QUOTE_OBJECT}Before${OPPORTUNITY_LINE_OBJECT}`,
      type: 'lookup',
      required: true,
    },
  ];
}

/** A quote line about to be written, as it is paired with its copy. */
export interface QuoteLineToPair {
  /** Its index among the rows the write was handed. */
  readonly index: number;
  /** The id in the target of the quote it goes under. */
  readonly quote: string;
  /** The id in the target of the product it is paired with. */
  readonly product: string;
}

/**
 * The statement that reads, of the lines under `quotes`, those paired with
 * one of `products`, with `fields` besides the ones that pair them.
 */
export function quoteLinesSoql(
  quotes: readonly string[],
  products: readonly string[],
  fields: readonly string[],
): string {
  const columns = [...PAIRING_FIELDS, ...fields.filter((f) => !PAIRING_FIELDS.has(f))]
    .map(assertSoqlIdentifier)
    .join(', ');
  const inList = (ids: readonly string[]): string =>
    ids.map((id) => `'${sanitizeSoqlValue(id)}'`).join(', ');
  return (
    `SELECT ${columns} FROM ${QUOTE_LINE_OBJECT} ` +
    `WHERE ${QUOTE_FIELD} IN (${inList(quotes)}) AND ${PAIRED_PRODUCT_FIELD} IN (${inList(products)})`
  );
}

/** Products a statement of {@link quoteLinesUnder} names, and so quotes at most as many. */
const PRODUCTS_PER_STATEMENT = 200;

/** `items` in lists of `size`. */
function chunks<T>(items: readonly T[], size: number): T[][] {
  const lists: T[][] = [];
  for (let at = 0; at < items.length; at += size) lists.push(items.slice(at, at + size));
  return lists;
}

/**
 * The lines the target holds under the quotes of `lines`, paired with their
 * products, read with `fields`: a statement per list of products, with the
 * quotes those lines go under. What a statement throws, the call throws.
 */
export async function quoteLinesUnder(
  query: (soql: string) => Promise<ReadonlyArray<Record<string, unknown>>>,
  lines: readonly QuoteLineToPair[],
  fields: readonly string[],
): Promise<Array<Record<string, unknown>>> {
  const read: Array<Record<string, unknown>> = [];
  const products = [...new Set(lines.map((line) => line.product))];
  // The quotes of a list of products' lines are no more than the products.
  for (const list of chunks(products, PRODUCTS_PER_STATEMENT)) {
    const wanted = new Set(list.map(keyOf));
    const quotes = [
      ...new Set(lines.filter((line) => wanted.has(keyOf(line.product))).map((line) => line.quote)),
    ];
    read.push(...(await query(quoteLinesSoql(quotes, list, fields))));
  }
  return read;
}

/**
 * Of the lines `copies` the target holds, the one each of `lines` is: under
 * its quote and paired with its product, by the line's index. A copy is one
 * line's only, the first that names it; one of `taken` — a line the run wrote
 * itself, or a copy an earlier write took — is none's. A line no copy is
 * paired with is not listed: it goes in as written.
 *
 * @param taken - Records by the first fifteen characters of their id.
 */
export function copiesOfTheLines(
  lines: readonly QuoteLineToPair[],
  copies: ReadonlyArray<Readonly<Record<string, unknown>>>,
  taken: ReadonlySet<string>,
): Map<number, Readonly<Record<string, unknown>>> {
  /** The copies not yet given to a line, by their quote and product. */
  const free = new Map<string, Array<Readonly<Record<string, unknown>>>>();
  for (const copy of copies) {
    const id = referenceOf(copy, 'Id');
    const quote = referenceOf(copy, QUOTE_FIELD);
    const product = referenceOf(copy, PAIRED_PRODUCT_FIELD);
    if (!id || !quote || !product || taken.has(id)) continue;
    const key = `${quote}:${product}`;
    free.set(key, [...(free.get(key) ?? []), copy]);
  }
  const paired = new Map<number, Readonly<Record<string, unknown>>>();
  for (const line of lines) {
    const copy = free.get(`${keyOf(line.quote)}:${keyOf(line.product)}`)?.shift();
    if (copy) paired.set(line.index, copy);
  }
  return paired;
}

/** A date and time as the API writes one: what two spellings of the same instant are compared by. */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * Whether a value a write sends and one a read of the target answers are the
 * same: both empty — absent, null or no text —, the same number however each
 * is written, the same instant, or the same text. Anything else differs, and
 * is sent: one sent that the copy held is written again, one held back that
 * it lacked would be lost.
 */
export function sameValue(sent: unknown, held: unknown): boolean {
  const empty = (value: unknown): boolean => value === undefined || value === null || value === '';
  if (empty(sent) || empty(held)) return empty(sent) && empty(held);
  if (sent === held) return true;
  if (typeof sent === 'number' || typeof held === 'number') {
    const a = Number(sent);
    const b = Number(held);
    return Number.isFinite(a) && Number.isFinite(b) && a === b;
  }
  if (typeof sent === 'string' && typeof held === 'string') {
    if (DATE_TIME.test(sent) && DATE_TIME.test(held)) {
      const a = Date.parse(sent);
      const b = Date.parse(held);
      return Number.isFinite(a) && a === b;
    }
    return false;
  }
  return String(sent) === String(held);
}

/**
 * The fields of a line as written that its copy holds otherwise, with the
 * line's values: what an update gives the copy. The sync copies the
 * product's standard fields and none of the line's custom ones, so the line's
 * custom fields are what the copy lacks, and any standard one the source's
 * line holds otherwise than its product. Only the fields an update can set
 * count (`updatable`); neither those that pair the copy with its line nor
 * those owed to the second pass (`owed`), which fills them in on the copy as
 * on any record the run created.
 */
export function fieldsTheCopyLacks(
  payload: Readonly<Record<string, unknown>>,
  copy: Readonly<Record<string, unknown>>,
  updatable: (field: string) => boolean,
  owed: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  const lacks: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(payload)) {
    if (PAIRING_FIELDS.has(field) || owed.has(field) || !updatable(field)) continue;
    if (!sameValue(value, copy[field])) lacks[field] = value ?? null;
  }
  return lacks;
}

/**
 * What the line that ends a node of quote lines says of those it took from
 * the platform's copies: how many, and how many of them an update gave the
 * fields the copy lacked. A simulation says what a real run would find.
 */
export function syncCopiesNote(taken: number, given: number, simulated: boolean): string {
  const one = taken === 1;
  const copies =
    `the platform's ${one ? 'copy' : 'copies'} of ${one ? 'its' : 'their'} ` +
    `opportunity product${one ? '' : 's'}`;
  const fields = given > 0 ? `, ${given} given the fields the copy lacked` : '';
  return (
    `${taken} of them ${simulated ? 'would be ' : ''}${copies}, made as the quote syncs ` +
    `with its opportunity: taken rather than written twice${fields}`
  );
}
