/**
 * A record's currency, and its amounts, when the target does not hold that
 * currency active.
 *
 * In an org with several currencies every record carries one
 * (`CurrencyIsoCode`), and every currency field of the record is in it. A
 * target that does not hold a row's currency active refuses it ("invalid
 * currency code: GBP"), and each copy got past the refusal its own way: Forge
 * left the code out or put the record type's default in its place, Sync wrote
 * the row again without it, Autopilot lost the row. None touched the amounts.
 * Run between two orgs, an opportunity of 5 000.55 GBP went in as 5 000.55
 * USD, worth some 6 330 USD at the source's own rate.
 *
 * One rule for every copy, read here: a row in a currency the target does not
 * hold active goes in the default the record type it goes in with gives the
 * currency field, when the copy read one the target holds active, and in the
 * target's corporate currency otherwise — written, not left to the platform,
 * which would give it the currency of the user the copy writes as, a currency
 * the conversion could not know. Each currency field of the row is converted
 * into it, rounded to the field's decimals: divided by the source's rate of
 * the row's currency, which gives its worth in the corporate currency as the
 * source values it, and multiplied by the target's rate of the currency it
 * goes in, so that the target values it at the same corporate amount. A rate
 * is `CurrencyType.ConversionRate`, units of the currency per unit of the
 * corporate one. With advanced currency management on, an org converts an
 * opportunity's amounts at the dated rate (`DatedConversionRate`) of its close
 * date instead: an org that has it on is read those too, and an opportunity is
 * converted at the rates of its own close date, each org's, the rates of
 * `CurrencyType` taking over where no dated rate covers the date. A row whose
 * currency the user mapped to another the target holds is converted the same
 * way.
 *
 * A record whose currency is its parent's — an opportunity's product, an
 * order's product, a contract's line, a custom object's detail rows — has no
 * currency of its own to write: the platform gives it its parent's, and
 * refuses the field. When the parent goes in another currency, its amounts
 * are converted as the parent's were, by the same factor
 * (`followParentCurrency`). Left as read, the products of a 5 000 GBP
 * opportunity written in USD kept their GBP prices, and the opportunity,
 * whose amount is the sum of its products', went in at 5 000 USD.
 */

import type { CurrencyChosenBy, CurrencyReplaced } from '@sandforge/shared';
import type { SoqlQuery } from './platformRecords.js';

/** The field a record's currency is held in, in an org with several. */
export const CURRENCY_FIELD = 'CurrencyIsoCode';

/**
 * Every currency an org holds, active or not, with its rate, its decimals and
 * whether it is the corporate one. An org with one currency has no
 * `CurrencyType`, and answers this with an error.
 */
export const CURRENCY_TYPES_SOQL =
  'SELECT IsoCode, ConversionRate, DecimalPlaces, IsActive, IsCorporate FROM CurrencyType';

/**
 * Whether advanced currency management is on: the user the copy reads as may
 * then create dated rates, which nobody may with it off. The rows of
 * `DatedConversionRate` say nothing of it — asked on an org where it had been
 * turned on and off again, they were all still there — nor does any field an
 * ordinary query reads. A user the org does not let manage currencies is told
 * it is off, and the rates of `CurrencyType` are read.
 */
export const DATED_RATES_ON_SOQL =
  'SELECT RunningUserEntityAccess.IsCreatable FROM EntityDefinition ' +
  "WHERE QualifiedApiName = 'DatedConversionRate'";

/** Every dated rate of an org, each currency's periods in order. */
export const DATED_RATES_SOQL =
  'SELECT IsoCode, ConversionRate, StartDate, NextStartDate FROM DatedConversionRate ' +
  'ORDER BY IsoCode, StartDate';

/** A rate an org applies from one date to the day before another. */
export interface DatedRate {
  /** The first day it applies, `YYYY-MM-DD`. */
  readonly start: string;
  /** The day the next rate takes over, `YYYY-MM-DD`. */
  readonly next: string;
  /** Units of the currency per unit of the corporate one, over the period. */
  readonly rate: number;
}

/** What an org holds of currencies. */
export interface OrgCurrencies {
  /** The corporate currency, when the org names one. */
  readonly corporate?: string;
  /** The currencies a record may be written in. */
  readonly active: ReadonlySet<string>;
  /** Units of each currency per unit of the corporate one, the inactive ones too. */
  readonly rates: ReadonlyMap<string, number>;
  /** The decimals each currency is kept with. */
  readonly decimals: ReadonlyMap<string, number>;
  /**
   * Each currency's dated rates, in an org with advanced currency management
   * on: what it converts an opportunity's amounts at, by its close date.
   */
  readonly dated?: ReadonlyMap<string, readonly DatedRate[]>;
}

/** What both orgs of a copy hold of currencies. */
export interface RunCurrencies {
  readonly source: OrgCurrencies;
  readonly target: OrgCurrencies;
}

/** A positive, finite number, as a rate or a count of decimals is read. */
function numberOf(value: unknown): number | undefined {
  const read = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof read === 'number' && Number.isFinite(read) ? read : undefined;
}

/** A flag as jsforce gives it: a boolean, or the SOAP-normalized text. */
function flagOf(value: unknown): boolean {
  return value === true || value === 'true';
}

/**
 * {@link OrgCurrencies} from the rows of {@link CURRENCY_TYPES_SOQL}, or
 * nothing when there are none.
 */
export function orgCurrenciesOf(
  rows: ReadonlyArray<Record<string, unknown>>,
): OrgCurrencies | undefined {
  const active = new Set<string>();
  const rates = new Map<string, number>();
  const decimals = new Map<string, number>();
  let corporate: string | undefined;
  for (const row of rows) {
    const code = row['IsoCode'];
    if (typeof code !== 'string' || code === '') continue;
    const rate = numberOf(row['ConversionRate']);
    if (rate !== undefined && rate > 0) rates.set(code, rate);
    const places = numberOf(row['DecimalPlaces']);
    if (places !== undefined && places >= 0) decimals.set(code, places);
    // A row without the flag is one read by a query that did not ask for it.
    if (row['IsActive'] === undefined || flagOf(row['IsActive'])) active.add(code);
    if (flagOf(row['IsCorporate'])) corporate = code;
  }
  if (active.size === 0 && rates.size === 0) return undefined;
  return { ...(corporate !== undefined ? { corporate } : {}), active, rates, decimals };
}

/** A date as a row holds one, `YYYY-MM-DD`, or nothing. */
function dayOf(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)
    ? value.slice(0, 10)
    : undefined;
}

/**
 * Each currency's dated rates from the rows of {@link DATED_RATES_SOQL}, in
 * the order they start. A row without its dates or its rate is left out.
 */
export function datedRatesOf(
  rows: ReadonlyArray<Record<string, unknown>>,
): Map<string, DatedRate[]> {
  const dated = new Map<string, DatedRate[]>();
  for (const row of rows) {
    const code = row['IsoCode'];
    const start = dayOf(row['StartDate']);
    const next = dayOf(row['NextStartDate']);
    const rate = numberOf(row['ConversionRate']);
    if (typeof code !== 'string' || code === '' || !start || !next) continue;
    if (rate === undefined || rate <= 0) continue;
    const periods = dated.get(code) ?? [];
    periods.push({ start, next, rate });
    dated.set(code, periods);
  }
  for (const periods of dated.values()) periods.sort((a, b) => a.start.localeCompare(b.start));
  return dated;
}

/**
 * An org's dated rates, when it has advanced currency management on
 * ({@link DATED_RATES_ON_SOQL}); nothing when it is off, or either read
 * fails: the rates of `CurrencyType` are then the ones applied.
 */
async function readDatedRates(
  query: SoqlQuery,
): Promise<ReadonlyMap<string, readonly DatedRate[]> | undefined> {
  try {
    const [entity] = await query(DATED_RATES_ON_SOQL);
    const access = entity?.['RunningUserEntityAccess'];
    const on =
      typeof access === 'object' &&
      access !== null &&
      flagOf((access as Record<string, unknown>)['IsCreatable']);
    if (!on) return undefined;
    const dated = datedRatesOf(await query(DATED_RATES_SOQL));
    return dated.size > 0 ? dated : undefined;
  } catch {
    return undefined;
  }
}

/**
 * An org's currencies, or nothing when it holds one: it answers the query
 * with an error, which is no reason to stop a copy. With advanced currency
 * management on, its dated rates come with them.
 */
export async function readOrgCurrencies(query: SoqlQuery): Promise<OrgCurrencies | undefined> {
  let read: OrgCurrencies | undefined;
  try {
    read = orgCurrenciesOf(await query(CURRENCY_TYPES_SOQL));
  } catch {
    return undefined;
  }
  if (!read) return undefined;
  const dated = await readDatedRates(query);
  return dated ? { ...read, dated } : read;
}

/**
 * Both orgs' currencies, read once each, or nothing when either holds one
 * currency: a source with one gives its rows no currency to replace, and a
 * target with one takes none from a row.
 */
export async function readRunCurrencies(
  source: SoqlQuery,
  target: SoqlQuery,
): Promise<RunCurrencies | undefined> {
  const [inSource, inTarget] = await Promise.all([
    readOrgCurrencies(source),
    readOrgCurrencies(target),
  ]);
  return inSource && inTarget ? { source: inSource, target: inTarget } : undefined;
}

/**
 * The objects whose amounts an org with advanced currency management on
 * converts at the dated rates, by the field holding the date it takes them
 * on: an opportunity, at its close date. Its products, schedules and splits
 * take its currency and its rates with it (`CURRENCY_FOLLOWS`); every other
 * object is converted at the rates of `CurrencyType`, as the Salesforce Help
 * says of the feature.
 */
export const DATED_RATE_FIELDS: Readonly<Record<string, string>> = { Opportunity: 'CloseDate' };

/** The date a row's amounts are converted on, and the field it was read from. */
export interface RatesOn {
  /** The field holding the date, as the object names it. */
  readonly field: string;
  /** The day, `YYYY-MM-DD`. */
  readonly on: string;
}

/**
 * The date the platform converts a row of `objectApiName` on with dated rates
 * ({@link DATED_RATE_FIELDS}), as the row was read; nothing for an object it
 * converts at the rates of `CurrencyType`, or a row without the date.
 */
export function datedRateOf(
  objectApiName: string,
  row: Readonly<Record<string, unknown>> | undefined,
): RatesOn | undefined {
  const field = DATED_RATE_FIELDS[objectApiName];
  const on = field !== undefined ? dayOf(row?.[field]) : undefined;
  return field !== undefined && on !== undefined ? { field, on } : undefined;
}

/**
 * An org's rate of `code`: the dated rate covering `on` when the org holds
 * one, its rate of `CurrencyType` otherwise.
 */
function rateOf(
  org: OrgCurrencies,
  code: string,
  on: string | undefined,
): { rate: number; dated: boolean } | undefined {
  if (on !== undefined) {
    const period = org.dated?.get(code)?.find((p) => p.start <= on && on < p.next);
    if (period) return { rate: period.rate, dated: true };
  }
  const rate = org.rates.get(code);
  return rate === undefined ? undefined : { rate, dated: false };
}

/**
 * What an amount in `from` is multiplied by to be in `to`, and whether a
 * dated rate went into it, or nothing when no rate gives it. See
 * {@link conversionFactor}.
 */
function conversionOf(
  from: string,
  to: string,
  currencies: RunCurrencies,
  on: string | undefined,
): { factor: number; dated: boolean } | undefined {
  const { source, target } = currencies;
  const fromRate = rateOf(source, from, on);
  const toRate = rateOf(target, to, on);
  if (fromRate === undefined || toRate === undefined) return undefined;
  let corporate = 1;
  let dated = fromRate.dated || toRate.dated;
  if (source.corporate !== target.corporate) {
    const inSource =
      target.corporate !== undefined ? rateOf(source, target.corporate, on) : undefined;
    const inTarget =
      source.corporate !== undefined ? rateOf(target, source.corporate, on) : undefined;
    if (inSource !== undefined) corporate = inSource.rate;
    else if (inTarget !== undefined) corporate = 1 / inTarget.rate;
    else return undefined;
    dated ||= (inSource ?? inTarget)?.dated === true;
  }
  return { factor: (corporate * toRate.rate) / fromRate.rate, dated };
}

/**
 * What an amount in `from` is multiplied by to be in `to`, or nothing when no
 * rate gives it: see the module's comment. Two orgs whose corporate
 * currencies differ go from one to the other at the rate either holds of the
 * other's. Given the day a row's amounts are converted on, each org's dated
 * rate covering it is taken where the org holds one.
 */
export function conversionFactor(
  from: string,
  to: string,
  currencies: RunCurrencies,
  on?: string,
): number | undefined {
  return conversionOf(from, to, currencies, on)?.factor;
}

/**
 * `value` rounded to `scale` decimals, half away from zero as the platform
 * rounds an amount: `6329.810126…` to `6329.81`. The product carries the
 * error of binary fractions — 1.005 × 100 is 100.49999… — which a nudge of
 * the order of that error puts back.
 */
export function roundToScale(value: number, scale: number): number {
  const places = Math.max(0, Math.min(Math.trunc(scale), 15));
  const factor = 10 ** places;
  const scaled = Math.abs(value) * factor;
  const rounded = Math.round(scaled + scaled * Number.EPSILON) / factor;
  return value < 0 ? -rounded : rounded;
}

/** One field of a describe, as {@link currencyFieldsOf} reads it. */
export interface DescribedCurrencyField {
  readonly name: string;
  readonly type?: string;
  readonly scale?: number;
}

/**
 * The currency fields of a target's describe, each with the decimals it keeps
 * when the describe says, by name.
 */
export function currencyFieldsOf(
  fields: ReadonlyArray<DescribedCurrencyField>,
): Map<string, number | undefined> {
  return new Map(
    fields
      .filter((field) => field.type === 'currency')
      .map((field) => [
        field.name,
        typeof field.scale === 'number' && field.scale >= 0 ? field.scale : undefined,
      ]),
  );
}

/** A row written in another currency than it was read in. */
export interface CurrencyChange {
  /** The currency the row was read in. */
  readonly from: string;
  /** The currency it is written in. */
  readonly to: string;
  readonly chosenBy: CurrencyChosenBy;
  /** The currency fields whose amounts were converted. */
  readonly fields: readonly string[];
  /** Set when no rate converts `from` into `to`: the amounts go as read. */
  readonly notConverted?: true;
  /** Set when `to` is not the target's corporate currency: the amounts went into it at the target's rate. */
  readonly atTargetRate?: true;
  /**
   * The field whose date chose the rates, when a dated rate went into the
   * conversion (`DATED_RATE_FIELDS`): `CloseDate`. Absent, the rates of
   * `CurrencyType` converted the amounts.
   */
  readonly datedBy?: string;
  /**
   * What the amounts were multiplied by: what the rows whose currency is this
   * row's take with it (`followParentCurrency`). Absent when not converted.
   */
  readonly factor?: number;
}

/** What {@link replaceRowCurrency} reads beside the row. */
export interface RowCurrencyInput {
  /** The currency the row was read in, as the source holds it. */
  readonly read: unknown;
  /** The currency fields the row may carry, under the names it is written with, and their decimals. */
  readonly currencyFields: ReadonlyMap<string, number | undefined>;
  /** The default the record type the row goes in with gives the currency field, when it was read. */
  readonly recordTypeDefault?: string | null;
  /**
   * The day the platform converts the row's amounts on with dated rates, as
   * the row was read (`datedRateOf`): the rates of that day are taken where
   * an org holds dated rates. Absent, the rates of `CurrencyType`.
   */
  readonly ratesOn?: RatesOn;
}

/**
 * The currency a row read in `code`, which the target does not hold active,
 * goes in, and how it was chosen: the record type's default when the target
 * holds it active, the target's corporate currency otherwise; nothing when
 * the target names none it holds active.
 */
export function replacementCurrency(
  recordTypeDefault: string | null | undefined,
  target: OrgCurrencies,
): { to: string; chosenBy: CurrencyChosenBy } | undefined {
  if (typeof recordTypeDefault === 'string' && target.active.has(recordTypeDefault)) {
    return { to: recordTypeDefault, chosenBy: 'record-type-default' };
  }
  if (target.corporate !== undefined && target.active.has(target.corporate)) {
    return { to: target.corporate, chosenBy: 'corporate' };
  }
  return undefined;
}

/** An amount, as a row holds one: a number, or its text. */
function amountOf(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const read = Number(value);
  return Number.isFinite(read) ? read : undefined;
}

/**
 * The currency a row goes in with, and its amounts converted into it, when
 * that is not the currency it was read in: see the module's comment. Changes
 * `payload` in place. Nothing when the row carries no currency to write — the
 * field is not written, or the user left it out — or the one it was read in,
 * or when the target names no currency to put in the place of one it does not
 * hold active.
 */
export function replaceRowCurrency(
  payload: Record<string, unknown>,
  input: RowCurrencyInput,
  currencies: RunCurrencies,
): CurrencyChange | undefined {
  const read = typeof input.read === 'string' && input.read !== '' ? input.read : undefined;
  const written = payload[CURRENCY_FIELD];
  if (read === undefined || typeof written !== 'string' || written === '') return undefined;
  const { target } = currencies;
  let to: string;
  let chosenBy: CurrencyChosenBy;
  if (target.active.has(written)) {
    if (written === read) return undefined;
    to = written;
    chosenBy = 'decision';
  } else {
    const replacement = replacementCurrency(input.recordTypeDefault, target);
    if (!replacement) return undefined;
    ({ to, chosenBy } = replacement);
    payload[CURRENCY_FIELD] = to;
  }
  const conversion = conversionOf(read, to, currencies, input.ratesOn?.on);
  const fields = convertAmounts(
    payload,
    input.currencyFields,
    conversion?.factor,
    target.decimals.get(to),
  );
  return {
    from: read,
    to,
    chosenBy,
    fields,
    ...(conversion === undefined ? { notConverted: true as const } : { factor: conversion.factor }),
    ...(conversion !== undefined && to !== target.corporate ? { atTargetRate: true as const } : {}),
    ...(conversion?.dated && input.ratesOn ? { datedBy: input.ratesOn.field } : {}),
  };
}

/**
 * Multiply each amount `payload` holds in `currencyFields` by `factor`,
 * rounded to the field's decimals or, when the describe does not say them,
 * to those of the currency written (`decimals`), two at worst; and answer
 * the fields converted. Nothing
 * is converted without a factor.
 */
function convertAmounts(
  payload: Record<string, unknown>,
  currencyFields: ReadonlyMap<string, number | undefined>,
  factor: number | undefined,
  decimals: number | undefined,
): string[] {
  const fields: string[] = [];
  if (factor === undefined) return fields;
  for (const [field, scale] of currencyFields) {
    const amount = amountOf(payload[field]);
    if (amount === undefined) continue;
    payload[field] = roundToScale(amount * factor, scale ?? decimals ?? 2);
    fields.push(field);
  }
  return fields;
}

/**
 * The objects whose currency is their parent's, by the lookup to that parent:
 * the platform gives a row its parent's currency and refuses one of its own
 * (`CurrencyIsoCode` is not createable). Read from the describes of an org
 * with several currencies — opportunity products, order products and
 * contract lines — and from the Salesforce documentation for the objects
 * that org did not have. A custom object's detail rows take their master's
 * the same way: no table names their lookup, and the one whose record went
 * in another currency is taken (`parentCurrencyChange`).
 */
export const CURRENCY_FOLLOWS: Readonly<Record<string, string>> = {
  OpportunityLineItem: 'OpportunityId',
  OpportunityLineItemSchedule: 'OpportunityLineItemId',
  OpportunitySplit: 'OpportunityId',
  Quote: 'OpportunityId',
  QuoteLineItem: 'QuoteId',
  OrderItem: 'OrderId',
  ContractLineItem: 'ServiceContractId',
};

/**
 * The currency change of the parent whose currency a row of `objectApiName`
 * takes — the record its lookup in {@link CURRENCY_FOLLOWS} names, or, for an
 * object the table does not name, the first of `lookups` whose record went
 * in another currency — when that parent was read in the row's own currency;
 * nothing when the row's parent kept its currency, or was never written by
 * the copy.
 *
 * @param row - The row as it was read, its lookups naming source records.
 * @param lookups - The row's lookup fields, for an object the table does not name.
 * @param changeOf - The change a record the copy wrote went through, by its source id.
 */
export function parentCurrencyChange(
  objectApiName: string,
  row: Readonly<Record<string, unknown>>,
  lookups: readonly string[],
  changeOf: (sourceId: string) => CurrencyChange | undefined,
): CurrencyChange | undefined {
  const read = row[CURRENCY_FIELD];
  if (typeof read !== 'string' || read === '') return undefined;
  const known = CURRENCY_FOLLOWS[objectApiName];
  for (const field of known !== undefined ? [known] : lookups) {
    const id = row[field];
    if (typeof id !== 'string' || id === '') continue;
    const change = changeOf(id);
    if (change && change.from === read) return change;
  }
  return undefined;
}

/** What {@link followParentCurrency} reads beside the row. */
export interface FollowedCurrencyInput {
  /** The currency the row was read in: its parent's, as the source holds it. */
  readonly read: unknown;
  /** The change the row's parent went through (`parentCurrencyChange`). */
  readonly parent: CurrencyChange | undefined;
  /** The currency fields the row may carry, under the names it is written with, and their decimals. */
  readonly currencyFields: ReadonlyMap<string, number | undefined>;
}

/**
 * The amounts of a row whose currency is its parent's, converted as the
 * parent's were when it went in another currency: by the same factor, dated
 * rates included, so the row and its parent keep the same worth in the
 * target as in the source. The row writes no currency of its own: the
 * platform gives it the parent's. Changes `payload` in place. Nothing when
 * the parent kept its currency, or was read in another than the row.
 *
 * @param currencies - Both orgs' currencies, for the decimals of the
 *   currency written when a field's describe does not say its own.
 */
export function followParentCurrency(
  payload: Record<string, unknown>,
  input: FollowedCurrencyInput,
  currencies?: RunCurrencies,
): CurrencyChange | undefined {
  const { parent } = input;
  if (!parent || input.read !== parent.from) return undefined;
  const fields = convertAmounts(
    payload,
    input.currencyFields,
    parent.factor,
    currencies?.target.decimals.get(parent.to),
  );
  return {
    from: parent.from,
    to: parent.to,
    chosenBy: 'parent',
    fields,
    ...(parent.factor === undefined ? { notConverted: true as const } : { factor: parent.factor }),
    ...(parent.atTargetRate ? { atTargetRate: true as const } : {}),
    ...(parent.datedBy !== undefined ? { datedBy: parent.datedBy } : {}),
  };
}

/**
 * The rows written in another currency, by object, the currency read, the one
 * written and how it was chosen, rows counted, in the order first met.
 */
export class CurrencyReplacementTally {
  private readonly entries = new Map<string, { entry: CurrencyReplaced; fields: Set<string> }>();

  /** How many entries the tally holds. */
  get size(): number {
    return this.entries.size;
  }

  /** Count one row of `objectApiName`, when its currency changed. */
  add(objectApiName: string, change: CurrencyChange | undefined): void {
    if (!change) return;
    const key = [
      objectApiName,
      change.from,
      change.to,
      change.chosenBy,
      change.notConverted ? 'kept' : '',
      change.datedBy ?? '',
    ].join('\u0000');
    const known = this.entries.get(key);
    if (known) {
      known.entry.rows++;
      for (const field of change.fields) known.fields.add(field);
      return;
    }
    this.entries.set(key, {
      entry: {
        objectApiName,
        from: change.from,
        to: change.to,
        chosenBy: change.chosenBy,
        rows: 1,
        fields: [],
        ...(change.notConverted ? { notConverted: true as const } : {}),
        ...(change.atTargetRate ? { atTargetRate: true as const } : {}),
        ...(change.datedBy !== undefined ? { datedBy: change.datedBy } : {}),
      },
      fields: new Set(change.fields),
    });
  }

  /** The entries, each with its fields sorted. */
  list(): CurrencyReplaced[] {
    return [...this.entries.values()].map(({ entry, fields }) => ({
      ...entry,
      fields: [...fields].sort(),
    }));
  }
}

/** Why the rows went in the currency they went in, as a line says it. */
function chosenWords(entry: CurrencyReplaced): string {
  switch (entry.chosenBy) {
    case 'decision':
      return 'as decided';
    case 'record-type-default':
      return `the default of their record type, ${entry.from} not being active in the target`;
    case 'corporate':
      return `the target's corporate currency, ${entry.from} not being active there`;
    case 'parent':
      return 'the currency of the record they belong to';
  }
}

/** What became of the amounts, as a line says it. */
function amountWords(entry: CurrencyReplaced): string {
  if (entry.notConverted) {
    return `amounts written as read: no rate converts ${entry.from} into ${entry.to}`;
  }
  if (entry.fields.length === 0) return 'no amount to convert';
  const rates = entry.atTargetRate
    ? `at the source's rate for ${entry.from} and the target's for ${entry.to}`
    : "at the source's rates";
  const dated = entry.datedBy !== undefined ? `, dated by ${entry.datedBy}` : '';
  return `amounts converted ${rates}${dated} (${entry.fields.join(', ')})`;
}

/**
 * One entry, as a line or a summary says it: `1 row(s) in GBP written in USD,
 * the target's corporate currency, GBP not being active there: amounts
 * converted at the source's rates (Amount)` — `at the source's rates, dated
 * by CloseDate` when dated rates converted them.
 */
export function describeCurrencyReplaced(entry: CurrencyReplaced): string {
  return (
    `${entry.rows} row(s) in ${entry.from} written in ${entry.to}, ${chosenWords(entry)}: ` +
    amountWords(entry)
  );
}

/**
 * What an object's line says of the rows its write sent in another currency
 * — `, written in another currency: 1 row(s) in GBP …` — or nothing.
 */
export function currencyReplacementsNote(entries: readonly CurrencyReplaced[]): string {
  if (entries.length === 0) return '';
  return `, written in another currency: ${entries.map(describeCurrencyReplaced).join('; ')}`;
}
