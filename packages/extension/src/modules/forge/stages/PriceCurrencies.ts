/**
 * The currency each price a clone writes goes in, and the price each line
 * points at, in an org with several currencies.
 *
 * A book prices a product once per currency, and the platform refuses a line
 * — an opportunity's product, a quote's line, an order's product — whose price
 * is in another currency than the record it belongs to:
 * `FIELD_INTEGRITY_EXCEPTION: pricebook entry currency code does not match
 * opportunity currency code`. A price read in a currency the target does not
 * hold active went in the target's corporate currency, or the one the user
 * mapped it to, on the source's own price in that currency when it has one;
 * and the opportunity went, on its own rules, in the default of its record
 * type or in the currency the user mapped its own to. Run between two scratch
 * orgs, a GBP opportunity the user mapped to EUR went in EUR, its prices in
 * USD, and both its lines were refused so.
 *
 * So the prices follow their lines: a price goes in the currency the records
 * its lines belong to are written in — on the source's own price of the same
 * product, book and selling model in that currency when it holds one, and at
 * its own amount converted into it otherwise — and a standard price follows
 * the custom prices of its product it was read for, which the platform
 * refuses without one in their currency. A price no line asks another
 * currency of goes as before: in its own currency when the target holds it
 * active, in the corporate one or the one the user mapped it to otherwise.
 * One price written once can stand in one currency only: when its lines ask
 * two and the source holds it in neither, the lines of one go on a price in
 * another currency, and the target refuses them, said on the object's line.
 */

import {
  PRICEBOOK_ENTRY_BOOK_FIELD,
  PRICEBOOK_ENTRY_CURRENCY_FIELD,
  PRICEBOOK_ENTRY_OBJECT,
  PRICEBOOK_ENTRY_PRODUCT_FIELD,
  PRICEBOOK_ENTRY_SELLING_MODEL_FIELD,
  type ForgeGraphEdge,
} from '@sandforge/shared';
import { CURRENCY_FOLLOWS } from '../../../core/common/recordCurrencies.js';

/** A price book entry as the source read it. */
export type PriceRow = Record<string, unknown>;

/** The field a line names its price in. */
export const LINE_PRICE_FIELD = 'PricebookEntryId';

/** The record a line takes its currency from: its object, and the line's lookup to it. */
export interface LineRecord {
  /** The record's object. */
  readonly record: string;
  /** The line's lookup to it (`CURRENCY_FOLLOWS`). */
  readonly field: string;
}

/**
 * The lines priced from a book, each with the record whose currency it takes:
 * the currency its price has to be in.
 */
export const LINES_PRICED: Readonly<Record<string, LineRecord>> = Object.fromEntries(
  (
    [
      ['OpportunityLineItem', 'Opportunity'],
      ['QuoteLineItem', 'Quote'],
      ['OrderItem', 'Order'],
      ['ContractLineItem', 'ServiceContract'],
    ] as const
  ).map(([line, record]) => [line, { record, field: CURRENCY_FOLLOWS[line] }]),
);

/**
 * The records lines take their currency from, each before the prices, when
 * the prices carry a currency: a price settles the currency it goes in once
 * the records of its lines have gone in theirs (`settlePriceCurrencies`). Left
 * out where the prices already come before such a record, which an order
 * set the other way would make a cycle.
 *
 * @param objects - The objects the run writes.
 * @param lines - Of those, the ones whose records point at a price.
 * @param before - The edges the write already orders by, parent first.
 */
export function recordsBeforeTheirPrices(
  objects: ReadonlySet<string>,
  lines: readonly string[],
  before: readonly ForgeGraphEdge[],
): ForgeGraphEdge[] {
  if (!objects.has(PRICEBOOK_ENTRY_OBJECT)) return [];
  const after = new Map<string, string[]>();
  for (const { sourceObject, targetObject } of before) {
    after.set(sourceObject, [...(after.get(sourceObject) ?? []), targetObject]);
  }
  const pricesComeBefore = (record: string): boolean => {
    const seen = new Set<string>();
    const next = [PRICEBOOK_ENTRY_OBJECT];
    while (next.length > 0) {
      const name = next.pop() as string;
      if (name === record) return true;
      if (seen.has(name)) continue;
      seen.add(name);
      next.push(...(after.get(name) ?? []));
    }
    return false;
  };
  const records = [...new Set(lines.flatMap((line) => LINES_PRICED[line]?.record ?? []))];
  return records
    .filter((record) => objects.has(record) && !pricesComeBefore(record))
    .map((record) => ({
      sourceObject: record,
      targetObject: PRICEBOOK_ENTRY_OBJECT,
      relationshipName: `${record}Before${PRICEBOOK_ENTRY_OBJECT}`,
      type: 'lookup',
      required: true,
    }));
}

/** What {@link pricesToAsk} and {@link settlePriceCurrencies} read. */
export interface PriceCurrencyInput {
  /** The prices in hand, as read. */
  readonly prices: readonly PriceRow[];
  /** The source's standard price book. */
  readonly standardBookId: string;
  /** Whether a price's selling model is part of what tells it apart. */
  readonly sellingModels: boolean;
  /**
   * The currency a price read in `code` goes in when no line asks another:
   * the one the user mapped it to when the target holds it, `code` itself when
   * the target holds it active, the target's corporate currency otherwise;
   * nothing when none.
   */
  readonly writtenIn: (code: string) => string | undefined;
  /** The currencies the target holds active. */
  readonly active: ReadonlySet<string>;
  /**
   * For a price lines point at, by its id, the currencies the records those
   * lines belong to are written in.
   */
  readonly wanted?: ReadonlyMap<string, ReadonlySet<string>>;
}

/** A price of a product in a book, under a selling model, in a currency. */
export interface PriceWanted {
  readonly book: string;
  readonly product: string;
  /** The selling model, or `''` when the run does not keep them. */
  readonly model: string;
  readonly currency: string;
}

/** How a price read in one currency went in another. */
export type PriceCurrencyHow = 'replaced' | 'converted' | 'none';

/** One price read in `from` whose lines, or whose run, wanted it in `to`. */
export interface PriceCurrencySaid {
  readonly from: string;
  readonly to: string;
  /**
   * `replaced`, by the source's own price in `to`; `converted`, the price
   * itself written in `to` at its amount converted; `none`, neither: the
   * source has no price in `to` and this one goes in another currency.
   */
  readonly how: PriceCurrencyHow;
  /** Whether `to` is the currency of the records its lines belong to, not the one it would go in alone. */
  readonly forLines: boolean;
}

/** What {@link settlePriceCurrencies} decided. */
export interface PriceCurrencyPlan {
  /** The prices to write: those in hand kept, in their order, then those read for them. */
  readonly rows: PriceRow[];
  /** A price left out, by its id, and the price written in its place. */
  readonly standsFor: ReadonlyMap<string, string>;
  /**
   * A price written in another currency than it would go in alone, by its
   * id: the one its lines' records go in, its amount converted into it.
   */
  readonly convertedInto: ReadonlyMap<string, string>;
  /** The price written for a product in a book and a currency, by {@link priceInCurrency}. */
  readonly written: ReadonlyMap<string, string>;
  /** The key of each price considered, those read for the others included, by its id. */
  readonly keys: ReadonlyMap<string, string>;
  /** What became of each price whose currency changed, one entry per currency. */
  readonly said: readonly PriceCurrencySaid[];
}

/** A price's product, book and selling model, as one key. */
export function priceKeyOf(row: PriceRow, sellingModels: boolean): string {
  return [
    row[PRICEBOOK_ENTRY_BOOK_FIELD],
    row[PRICEBOOK_ENTRY_PRODUCT_FIELD],
    sellingModels ? row[PRICEBOOK_ENTRY_SELLING_MODEL_FIELD] : '',
  ]
    .map((value) => String(value ?? ''))
    .join('|');
}

/** A key of {@link priceKeyOf} in a currency. */
export function priceInCurrency(key: string, currency: string): string {
  return `${key}|${currency}`;
}

/** A row's currency, when it carries one. */
function currencyOf(row: PriceRow): string | undefined {
  const code = row[PRICEBOOK_ENTRY_CURRENCY_FIELD];
  return typeof code === 'string' && code !== '' ? code : undefined;
}

/** A price in hand, with what the settling reads of it. */
interface Considered {
  readonly row: PriceRow;
  readonly id: string;
  readonly key: string;
  /** The currency it was read in. */
  readonly read: string;
  /** The currency it goes in when no line asks another. */
  readonly alone: string | undefined;
  /** The currencies it is wanted in, in the order met; empty when it goes as it is. */
  readonly targets: readonly string[];
}

/**
 * The prices in hand that carry a currency, each with the currencies it is
 * wanted in: those its lines' records go in; and, for a price nothing asks
 * another of read in a currency the target does not hold active, the one it
 * goes in alone. A standard price is wanted, besides, in each currency the
 * custom prices of its product read in its currency go in. A price in a
 * currency the target holds that nothing asks another of goes as it is.
 */
function considered(input: PriceCurrencyInput): Considered[] {
  const wanted = input.wanted ?? new Map<string, ReadonlySet<string>>();
  const rows = input.prices.flatMap((row) => {
    const id = row['Id'];
    const read = currencyOf(row);
    if (typeof id !== 'string' || read === undefined) return [];
    const alone = input.writtenIn(read);
    const own = new Set<string>(wanted.get(id) ?? []);
    if (own.size === 0 && !input.active.has(read) && alone !== undefined) own.add(alone);
    const standard = row[PRICEBOOK_ENTRY_BOOK_FIELD] === input.standardBookId;
    return [{ row, id, read, alone, own, standard }];
  });
  /** Where the custom prices of a product go, by the key of its standard price in their currency. */
  const derived = new Map<string, Set<string>>();
  for (const { row, read, alone, own, standard } of rows) {
    if (standard) continue;
    const goes = own.size > 0 ? own : alone !== undefined ? [alone] : [];
    const at = priceInCurrency(
      priceKeyOf(
        { ...row, [PRICEBOOK_ENTRY_BOOK_FIELD]: input.standardBookId },
        input.sellingModels,
      ),
      read,
    );
    const set = derived.get(at) ?? new Set<string>();
    for (const code of goes) set.add(code);
    derived.set(at, set);
  }
  return rows.map(({ row, id, read, alone, own, standard }) => {
    const key = priceKeyOf(row, input.sellingModels);
    const targets = new Set<string>(wanted.get(id) ?? []);
    if (standard) {
      for (const code of derived.get(priceInCurrency(key, read)) ?? []) targets.add(code);
    }
    if (targets.size === 0) for (const code of own) targets.add(code);
    return { row, id, key, read, alone, targets: [...targets] };
  });
}

/** The prices in hand written in the currency they were read in, by key and currency. */
function writtenAsRead(
  prices: readonly Considered[],
  active: ReadonlySet<string>,
): Map<string, Considered> {
  const held = new Map<string, Considered>();
  for (const price of prices) {
    if (price.alone !== price.read || !active.has(price.read)) continue;
    const at = priceInCurrency(price.key, price.read);
    if (!held.has(at)) held.set(at, price);
  }
  return held;
}

/**
 * The prices the source is to be asked for: of the products and books in
 * hand, in each currency a price is wanted in that no price in hand is
 * written in.
 */
export function pricesToAsk(input: PriceCurrencyInput): PriceWanted[] {
  const prices = considered(input);
  const held = writtenAsRead(prices, input.active);
  const asked = new Map<string, PriceWanted>();
  for (const { row, key, targets } of prices) {
    for (const currency of targets) {
      const at = priceInCurrency(key, currency);
      if (held.has(at) || asked.has(at)) continue;
      asked.set(at, {
        book: String(row[PRICEBOOK_ENTRY_BOOK_FIELD] ?? ''),
        product: String(row[PRICEBOOK_ENTRY_PRODUCT_FIELD] ?? ''),
        model: input.sellingModels ? String(row[PRICEBOOK_ENTRY_SELLING_MODEL_FIELD] ?? '') : '',
        currency,
      });
    }
  }
  return [...asked.values()];
}

/**
 * Which price goes in which currency, from the prices in hand and those the
 * source answered {@link pricesToAsk} with: see the module's comment. A price
 * in hand wanted in a currency is replaced by the price written in it — one
 * in hand read in it, or the source's own — and, where none is, written in it
 * itself at its amount converted, when it is not written as itself for
 * another currency already. A price every currency it is wanted in is
 * written for by another is left out, and stands for the first of them.
 */
export function settlePriceCurrencies(
  input: PriceCurrencyInput,
  fetched: readonly PriceRow[],
): PriceCurrencyPlan {
  const prices = considered(input);
  const held = writtenAsRead(prices, input.active);
  const keys = new Map(prices.map((price) => [price.id, price.key]));
  const answered = new Map<string, PriceRow>();
  for (const row of fetched) {
    const id = row['Id'];
    const currency = currencyOf(row);
    if (typeof id !== 'string' || currency === undefined) continue;
    if (input.writtenIn(currency) !== currency) continue;
    const key = priceKeyOf(row, input.sellingModels);
    const at = priceInCurrency(key, currency);
    if (held.has(at)) continue;
    const known = answered.get(at);
    // A live price says more of the product than a retired one.
    if (known !== undefined && !(row['IsActive'] === true && known['IsActive'] !== true)) continue;
    answered.set(at, row);
    keys.set(id, key);
  }

  const written = new Map<string, string>();
  const kept = new Set<string>();
  const used = new Set<PriceRow>();
  const convertedInto = new Map<string, string>();
  const converted = new Set<string>();
  const said: PriceCurrencySaid[] = [];
  const say = (price: Considered, to: string, how: PriceCurrencyHow): void => {
    if (to !== price.read) said.push({ from: price.read, to, how, forLines: to !== price.alone });
  };
  const pending: Array<{ price: Considered; to: string }> = [];
  for (const price of prices) {
    for (const to of price.targets) {
      const at = priceInCurrency(price.key, to);
      const own = held.get(at);
      if (own) {
        written.set(at, own.id);
        kept.add(own.id);
        if (own !== price) say(price, to, 'replaced');
        continue;
      }
      const theirs = answered.get(at);
      if (theirs) {
        written.set(at, String(theirs['Id']));
        used.add(theirs);
        say(price, to, 'replaced');
        continue;
      }
      pending.push({ price, to });
    }
  }
  for (const { price, to } of pending) {
    const at = priceInCurrency(price.key, to);
    if (written.has(at)) {
      say(price, to, 'replaced');
    } else if (!kept.has(price.id) && !converted.has(price.id)) {
      converted.add(price.id);
      written.set(at, price.id);
      if (to !== price.alone) convertedInto.set(price.id, to);
      say(price, to, 'converted');
    } else {
      say(price, to, 'none');
    }
  }

  const standsFor = new Map<string, string>();
  const rows: PriceRow[] = [];
  const settled = new Map(prices.map((price) => [price.row, price]));
  for (const row of input.prices) {
    const price = settled.get(row);
    if (!price || price.targets.length === 0 || kept.has(price.id) || converted.has(price.id)) {
      rows.push(row);
      continue;
    }
    const stand = price.targets
      .map((to) => written.get(priceInCurrency(price.key, to)))
      .find((id) => id !== undefined && id !== price.id);
    if (stand === undefined) {
      rows.push(row);
      continue;
    }
    standsFor.set(price.id, stand);
  }
  rows.push(...fetched.filter((row) => used.has(row)));
  // A price that goes as it is stands in the currency it goes in, for a line
  // whose record goes in that one.
  for (const price of prices) {
    if (price.targets.length > 0 || price.alone === undefined) continue;
    const at = priceInCurrency(price.key, price.alone);
    if (!written.has(at)) written.set(at, price.id);
  }
  return { rows, standsFor, convertedInto, written, keys, said };
}

/** Pairs counted, `4 GBP → USD, 1 GBP → EUR`, in the order first met. */
function countedPairs(entries: readonly PriceCurrencySaid[]): string {
  const counts = new Map<string, number>();
  for (const { from, to } of entries) {
    const pair = `${from} → ${to}`;
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return [...counts].map(([pair, count]) => `${count} ${pair}`).join(', ');
}

/**
 * What the prices' line says of {@link PriceCurrencyPlan.said}, one sentence
 * per way the prices went: replaced, converted, or left in another currency
 * than their lines want; first those that went in the currency they would
 * alone, then those that followed their lines.
 */
export function describePriceCurrencies(said: readonly PriceCurrencySaid[]): string[] {
  const of = (forLines: boolean, how: PriceCurrencyHow): PriceCurrencySaid[] =>
    said.filter((entry) => entry.forLines === forLines && entry.how === how);
  const sentences: Array<[PriceCurrencySaid[], string]> = [
    [
      of(false, 'replaced'),
      "price(s) in a currency the target does not hold active replaced by the source's own " +
        'price in the currency written, for the same product and price book',
    ],
    [
      of(false, 'converted'),
      'no price in the currency written in the source for the same product and price book, ' +
        "written in it at the amount converted at the source's rates",
    ],
    [
      of(true, 'replaced'),
      "price(s) replaced by the source's own price in the currency of the record their lines " +
        'belong to, for the same product and price book',
    ],
    [
      of(true, 'converted'),
      'no price in the currency of the record their lines belong to in the source for the same ' +
        'product and price book, written in it at its amount converted',
    ],
    [
      said.filter((entry) => entry.how === 'none'),
      'no price in the currency of the record their lines belong to in the source for the same ' +
        'product and price book, and the price goes in another currency for other lines: the ' +
        'target refuses the lines of a record in it',
    ],
  ];
  return sentences
    .filter(([entries]) => entries.length > 0)
    .map(([entries, words]) => `${countedPairs(entries)}: ${words}`);
}
