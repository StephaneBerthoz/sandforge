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
 * corporate one. The rates of `CurrencyType` are the ones read; with advanced
 * currency management, the dated rates (`DatedConversionRate`) the platform
 * applies to opportunities by their close date are not. A row whose currency
 * the user mapped to another the target holds is converted the same way.
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

/**
 * An org's currencies, or nothing when it holds one: it answers the query
 * with an error, which is no reason to stop a copy.
 */
export async function readOrgCurrencies(query: SoqlQuery): Promise<OrgCurrencies | undefined> {
  try {
    return orgCurrenciesOf(await query(CURRENCY_TYPES_SOQL));
  } catch {
    return undefined;
  }
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
 * What an amount in `from` is multiplied by to be in `to`, or nothing when no
 * rate gives it: see the module's comment. Two orgs whose corporate
 * currencies differ go from one to the other at the rate either holds of the
 * other's.
 */
export function conversionFactor(
  from: string,
  to: string,
  currencies: RunCurrencies,
): number | undefined {
  const { source, target } = currencies;
  const fromRate = source.rates.get(from);
  const toRate = target.rates.get(to);
  if (fromRate === undefined || toRate === undefined) return undefined;
  let corporate = 1;
  if (source.corporate !== target.corporate) {
    const inSource =
      target.corporate !== undefined ? source.rates.get(target.corporate) : undefined;
    const inTarget =
      source.corporate !== undefined ? target.rates.get(source.corporate) : undefined;
    if (inSource !== undefined) corporate = inSource;
    else if (inTarget !== undefined) corporate = 1 / inTarget;
    else return undefined;
  }
  return (corporate * toRate) / fromRate;
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
}

/** What {@link replaceRowCurrency} reads beside the row. */
export interface RowCurrencyInput {
  /** The currency the row was read in, as the source holds it. */
  readonly read: unknown;
  /** The currency fields the row may carry, under the names it is written with, and their decimals. */
  readonly currencyFields: ReadonlyMap<string, number | undefined>;
  /** The default the record type the row goes in with gives the currency field, when it was read. */
  readonly recordTypeDefault?: string | null;
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
    const byRecordType = input.recordTypeDefault;
    if (typeof byRecordType === 'string' && target.active.has(byRecordType)) {
      to = byRecordType;
      chosenBy = 'record-type-default';
    } else if (target.corporate !== undefined && target.active.has(target.corporate)) {
      to = target.corporate;
      chosenBy = 'corporate';
    } else {
      return undefined;
    }
    payload[CURRENCY_FIELD] = to;
  }
  const factor = conversionFactor(read, to, currencies);
  const fields: string[] = [];
  if (factor !== undefined) {
    for (const [field, scale] of input.currencyFields) {
      const amount = amountOf(payload[field]);
      if (amount === undefined) continue;
      payload[field] = roundToScale(amount * factor, scale ?? target.decimals.get(to) ?? 2);
      fields.push(field);
    }
  }
  return {
    from: read,
    to,
    chosenBy,
    fields,
    ...(factor === undefined ? { notConverted: true as const } : {}),
    ...(factor !== undefined && to !== target.corporate ? { atTargetRate: true as const } : {}),
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
  return `amounts converted ${rates} (${entry.fields.join(', ')})`;
}

/**
 * One entry, as a line or a summary says it: `1 row(s) in GBP written in USD,
 * the target's corporate currency, GBP not being active there: amounts
 * converted at the source's rates (Amount)`.
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
