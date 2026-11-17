/**
 * Drawing the plan of a sample of the whole org against the source: the
 * reads of `sampleReader.ts` put under the reader the closure of
 * `sampleClosure.ts` knows (`SampleReader`), and the steps of a draw in their
 * order — the roots it may take chosen by its window, the filters on its
 * roots and its strata (`sampleDrawOptions.ts`), counted, their read priced
 * against what the source has left today, their ids read and ranked — in
 * their value, of an object stratified (`sampleStrata.ts`) —, the sample
 * closed over them and cut to the budget (`drawTheSample`).
 *
 * Nothing is written here and nothing is kept: the run keeps the plan
 * (`samplePlanStore.ts`) and judges it at its gate.
 *
 * What a record read for a sample is, as the closure sees it
 * (`SampleRow`): its id, the lookups the sample reads of its object, and the
 * few values that decide whether and how it can be written — its record
 * type, whether it is a person account or the contact of one, whether it is
 * the standard price book the run links to the target's, and, of a price in
 * a book of its own, the standard price of its product the platform will not
 * take it without, in its currency and selling model. A price whose product
 * has none in the source cannot be written: the closure leaves it out, and
 * the lines priced from it.
 */

import {
  BYTES_PER_MB,
  PRICEBOOK_ENTRY_BOOK_FIELD,
  PRICEBOOK_ENTRY_CURRENCY_FIELD,
  PRICEBOOK_ENTRY_OBJECT,
  PRICEBOOK_ENTRY_PRODUCT_FIELD,
  PRICEBOOK_ENTRY_SELLING_MODEL_FIELD,
  PRICEBOOK_OBJECT,
  type ForgeSampleDraw,
  type ForgeSampleParents,
  type ForgeSampleWindow,
  type ForgeSamplingProgress,
  type WholeOrgSample,
  type WholeOrgSampleBudget,
  type WholeOrgSampleResult,
  type WholeOrgSampleRoots,
} from '@sandforge/shared';
import { ACCOUNT, CONTACT } from '../../../core/common/platformRecords.js';
import {
  API_BUDGET_EXCEEDED,
  API_BUDGET_NEAR_SHARE,
  ForgeRunGateError,
  countedStorageBytes,
} from '../ForgeRunGate.js';
import type { SourceRow } from '../stages/PagedRows.js';
import {
  type SampleChildren,
  type SampleClosureOptions,
  type SampleReader,
  type SampleRelation,
  type SampleRow,
} from './sampleClosure.js';
import { sampleRootsOf, sampleRootsReportOf, type SampleRoots } from './sampleDrawOptions.js';
import {
  documentedMeasure,
  drawTheSample,
  type SampleBounds,
  type SampleCannotFit,
  type SampleCut,
} from './sampleFit.js';
import {
  fieldsToRead,
  rootFilterOf,
  sampleLinksOf,
  type SampleLinks,
  type SampleObjectInput,
} from './sampleLinks.js';
import {
  RootDraw,
  SMALLEST_RECORD_BYTES,
  idKey,
  rankOf,
  recentRankOf,
  rootsTheBudgetHolds,
} from './sampleRank.js';
import {
  SampleSourceReader,
  rootScanRequestsOf,
  type DatedRootRead,
  type RootCarrier,
  type RootCount,
  type RootRead,
  type SampleSource,
  type StratumValue,
} from './sampleReader.js';
import { StratifiedRoots, strataTakesOf } from './sampleStrata.js';

/**
 * Why a run of a sample of the whole org stops before its first write, as
 * the gate's codes name it: the records its draw reads past what it holds at
 * once (`SAMPLE_TOO_LARGE`); objects copied whole and the floors that alone
 * pass the bounds (`SAMPLE_CANNOT_FIT`); a resume whose plan is no longer as
 * its journal names it (`SAMPLE_PLAN_GONE`); a run that resumes a sample
 * set up as a clone of every record, or the other way (`SAMPLE_PLAN_MISMATCH`).
 */
export type SampleRefusalCode =
  'SAMPLE_TOO_LARGE' | 'SAMPLE_CANNOT_FIT' | 'SAMPLE_PLAN_GONE' | 'SAMPLE_PLAN_MISMATCH';

/** A run of a sample stopped before its first write, nothing written: see {@link SampleRefusalCode}. */
export class SampleRefusedError extends Error {
  constructor(
    readonly code: SampleRefusalCode,
    message: string,
    /** Of `SAMPLE_CANNOT_FIT`, the heaviest of what the objects copied whole and the floors take. */
    readonly heaviest?: SampleCannotFit['heaviest'],
  ) {
    super(message);
    this.name = 'SampleRefusedError';
  }
}

/** A field of the source's describe a sample may read, and what the describe says of how the org takes it. */
export interface SampleDescribedField {
  name: string;
  /**
   * Its type as the describe gives it (`picklist`, `boolean`, `reference`…):
   * what a stratum is held to. Unknown, no stratum is drawn by it.
   */
  type?: string;
  /** Whether the org groups rows by it (`groupable`); unknown when the describe does not say. */
  groupable?: boolean;
  /** Whether the org orders rows by it (`sortable`); unknown when the describe does not say. */
  sortable?: boolean;
  /** Whether the org aggregates it, as `COUNT(Id)` does the id (`aggregatable`); unknown when not said. */
  aggregatable?: boolean;
}

/** The options a sample is drawn with, each as applied: the defaults filled in. */
export interface SampleDrawOptions {
  seed: number;
  draw: ForgeSampleDraw;
  parents: ForgeSampleParents;
  children: number | 'all';
  floor: number;
  /** Objects asked whole (`--fit-whole`). */
  whole?: readonly string[];
  /** The dates the roots are drawn in (`--fit-window`): see `sampleDrawOptions.ts`. */
  window?: ForgeSampleWindow;
  /** Per object, the condition its roots are drawn among (`--fit-where`). */
  rootWhere?: Record<string, string>;
  /** The fields the roots are stratified by (`--fit-strata`). */
  strata?: string[];
}

/**
 * What a sample may take, read of the target once before anything is drawn
 * (`ForgeStreamOptions.sample.budget`): the budget the report says, which of
 * the target's storage or the MB asked gives its bytes, and the target's room
 * before the bounds asked, which the objects copied whole and the roots set
 * aside are chosen against.
 */
export interface SampleBudgetTerms {
  /** The budget as the report says it; its `bytes` and `maxTotal` are the bounds of the cut. */
  budget: WholeOrgSampleBudget;
  /** What gives `budget.bytes`: what the target has left, or the MB asked. */
  bytesLimit: 'storage' | 'within';
  /** The bytes of the target's room, the bounds asked left out (`SampleLinksInput.roomBytes`). */
  roomBytes: number;
  /**
   * The bytes the target's storage leaves the sample, the MB asked aside: a
   * need past them is held by the storage (`bytesLimitOf`). Absent when the
   * target would not say.
   */
  storageBytes?: number;
  /** What the target's automation that still runs creates under each record of an object the run inserts, in bytes. */
  automationBytes?: (objectApiName: string) => number;
  /** The bounds on requests at the records the run writes per object: see `SampleBounds.requests`. */
  requests?: SampleBounds['requests'];
}

/** What drawing a sample is given: see {@link drawSampleOfTheOrg}. */
export interface SampleDrawingInput {
  /** The source, as the run reads it (`deps.queryPages`, `deps.countRecords`). */
  source: SampleSource;
  /** The objects of the run the sample is drawn of, with their lookups. */
  objects: readonly SampleObjectInput[];
  /** The objects in the order the run writes them. */
  order: readonly string[];
  /** The objects the user left out by name, with their key prefix when known. */
  excluded?: ReadonlyMap<string, string | null>;
  /** The objects the run matches by name in the target and never writes. */
  referenceData?: ReadonlySet<string>;
  /** The queryable fields of an object's describe in the source; undefined for one the run has no describe of. */
  fieldsOf: (objectApiName: string) => readonly SampleDescribedField[] | undefined;
  /** An object's filter (`ForgeConfig.objectSoqlFilters`). */
  filterOf?: (objectApiName: string) => string | undefined;
  options: SampleDrawOptions;
  budget: SampleBudgetTerms;
  /** The most records an object is read whole in (`maxRecordsPerObject`). */
  maxRecordsPerObject?: number;
  /** Why a record of a record type is held back: see `SampleClosureOptions.recordTypeVerdict`. */
  recordTypeVerdict?: SampleClosureOptions['recordTypeVerdict'];
  /**
   * The currency a price read in `code` goes in, when the target does not
   * hold `code` active: the one the user mapped it to, or the target's
   * corporate currency, as the run settles its prices. Undefined for one the
   * target holds, which goes as it is read. Absent, every price goes so.
   */
  priceCurrencyWrittenIn?: (code: string) => string | undefined;
  /**
   * Per object of a size of its own — an email, the size of its text — what
   * each record of it is weighed at as the sample is drawn, on average: the
   * plan is weighed exactly at the run's gate. An object not in it is weighed
   * by the documented sizes.
   */
  averageBytes?: ReadonlyMap<string, number>;
  /**
   * The requests the source has left today: reading the roots' ids past a
   * tenth of them is refused before one is read. Undefined when the source
   * would not say: nothing is refused for it.
   */
  sourceRequestsLeft?: number;
  /** The most records the closure holds (`SAMPLE_MAX_ROWS` when absent): a test seam. */
  maxRows?: number;
  /**
   * When the sample is drawn, in milliseconds: what a window of the last
   * days counts back from. Now when absent.
   */
  now?: number;
  /**
   * How the values of a field an object's roots are stratified by are
   * named in the report: a record type by its DeveloperName, as the
   * source's describe lists its record types — no request of its own.
   * Undefined, or a value it does not name, is said as it is read: a
   * picklist's value, a lookup's id.
   */
  labelsOf?: (
    objectApiName: string,
    field: string,
  ) => Promise<((value: StratumValue) => string | undefined) | undefined>;
  signal?: AbortSignal;
  onProgress?: (progress: ForgeSamplingProgress) => void;
}

/** A sample drawn: the objects and lookups it was drawn by, its cut, and what it read. */
export interface SampleDrawing {
  links: SampleLinks;
  cut: SampleCut | SampleCannotFit;
  /** The requests drawing it sent the source. */
  planRequests: number;
  /**
   * The objects whose newest — roots of a draw by recency, or children kept
   * under the cap — were taken in the order of their ids: see
   * `WholeOrgSample.newestByIds`.
   */
  newestByIds: string[];
  /**
   * The objects whose oldest roots, of a draw of the oldest, were taken in
   * the order of their ids: see `WholeOrgSample.oldestByIds`.
   */
  oldestByIds: string[];
  /**
   * How the roots were chosen, when the options chose them — a window,
   * filters on the roots, strata —: see `WholeOrgSample.roots`. Absent of a
   * draw among every root.
   */
  roots?: WholeOrgSampleRoots;
  /**
   * Per object whose roots a window or a filter restricts, those in the draw
   * and those of the source (`WholeOrgSampleObject.rootsInTheDraw`,
   * `rootsInTheSource`), each when it is known: the second not of an object
   * not counted, and neither where a count selected rows only their read
   * tells roots of (`RootCount.exact`) and no read went through them.
   */
  rootsCounted: ReadonlyMap<string, { inTheDraw?: number; inTheSource?: number }>;
  /** The objects the window, the filters on the roots or the strata left no root to draw. */
  noRootInTheDraw: ReadonlySet<string>;
  /**
   * Of a draw by strata, the roots their floors keep at the least share
   * (`--fit-floor` of each value), and the values: what a sample that cannot
   * fit may be held by.
   */
  strataFloors?: { roots: number; values: number };
}

/** The columns a price is read with beside its lookups: what decides the standard price it needs. */
const PRICE_COLUMNS = [
  PRICEBOOK_ENTRY_BOOK_FIELD,
  PRICEBOOK_ENTRY_PRODUCT_FIELD,
  PRICEBOOK_ENTRY_CURRENCY_FIELD,
  PRICEBOOK_ENTRY_SELLING_MODEL_FIELD,
  'IsActive',
];

/** Whether an org's flag reads as set: jsforce gives a boolean, or the string of one. */
function isSet(value: unknown): boolean {
  return value === true || value === 'true';
}

/** A value read as an id or nothing. */
function idOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** When a record read with its creation date was made, in milliseconds; undefined when it was not read so. */
function createdOf(row: SourceRow): number | undefined {
  const at = row['CreatedDate'];
  const ms = typeof at === 'string' ? Date.parse(at) : Number.NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

/** What tells the price a price goes as in another currency: its book, product and selling model. */
function bookKeyOf(row: SourceRow): string {
  const part = (field: string): string => {
    const value = row[field];
    return typeof value === 'string' ? idKey(value) : '';
  };
  return [
    part(PRICEBOOK_ENTRY_BOOK_FIELD),
    part(PRICEBOOK_ENTRY_PRODUCT_FIELD),
    part(PRICEBOOK_ENTRY_SELLING_MODEL_FIELD),
  ].join('\n');
}

/** What tells the standard price a price needs: its product, currency and selling model. */
function standardKeyOf(row: SourceRow): string {
  const part = (field: string): string => {
    const value = row[field];
    return typeof value === 'string' ? value : '';
  };
  return [
    idKey(part(PRICEBOOK_ENTRY_PRODUCT_FIELD)),
    part(PRICEBOOK_ENTRY_CURRENCY_FIELD),
    idKey(part(PRICEBOOK_ENTRY_SELLING_MODEL_FIELD)),
  ].join('\n');
}

/**
 * The reads of `sampleReader.ts` as the closure of a sample asks them
 * (`SampleReader`): each record read with the lookups the sample reads of
 * its object and what decides how it is written, mapped to a `SampleRow`.
 */
export class SourceSampleReader implements SampleReader {
  /**
   * The objects whose children the cap left some of, kept by their ids: the
   * org orders none of their creation dates. The plan says them
   * (`WholeOrgSample.newestByIds`).
   */
  readonly cappedByIds = new Set<string>();

  constructor(
    private readonly reader: SampleSourceReader,
    private readonly links: SampleLinks,
    private readonly sourceRows: ReadonlyMap<string, number>,
    /** See `SampleDrawingInput.priceCurrencyWrittenIn`. */
    private readonly priceCurrencyWrittenIn?: (code: string) => string | undefined,
  ) {}

  /** The columns read of `objectApiName` besides its id: those the reader's describe does not list are left out there. */
  private columnsOf(objectApiName: string): string[] {
    const columns = [...fieldsToRead(this.links, objectApiName), 'RecordTypeId'];
    if (objectApiName === ACCOUNT || objectApiName === CONTACT) columns.push('IsPersonAccount');
    if (objectApiName === PRICEBOOK_ENTRY_OBJECT) columns.push(...PRICE_COLUMNS);
    if (objectApiName === PRICEBOOK_OBJECT) columns.push('IsStandard');
    return columns;
  }

  private rowOf(objectApiName: string, row: SourceRow, outsideFilter = false): SampleRow {
    const refs: Record<string, string | null> = {};
    for (const field of fieldsToRead(this.links, objectApiName)) refs[field] = idOrNull(row[field]);
    const recordTypeId = row['RecordTypeId'];
    const created = createdOf(row);
    return {
      id: String(row['Id']),
      refs,
      ...(typeof recordTypeId === 'string' || recordTypeId === null
        ? { recordTypeId: idOrNull(recordTypeId) }
        : {}),
      ...((objectApiName === ACCOUNT || objectApiName === CONTACT) && isSet(row['IsPersonAccount'])
        ? { personAccount: true }
        : {}),
      ...(objectApiName === PRICEBOOK_OBJECT && isSet(row['IsStandard']) ? { matched: true } : {}),
      ...(outsideFilter ? { outsideFilter: true } : {}),
      ...(created !== undefined ? { created } : {}),
    };
  }

  /**
   * The rows of `objectApiName` as the closure takes them; of prices, each
   * in a book of its own given the standard price it cannot be written
   * without, read once for the products of the batch.
   */
  private async sampleRowsOf(
    objectApiName: string,
    rows: readonly SourceRow[],
    outside: readonly SourceRow[] = [],
  ): Promise<SampleRow[]> {
    const mapped = [
      ...rows.map((row) => this.rowOf(objectApiName, row)),
      ...outside.map((row) => this.rowOf(objectApiName, row, true)),
    ];
    if (objectApiName !== PRICEBOOK_ENTRY_OBJECT || rows.length === 0) return mapped;
    const products = [
      ...new Set(
        rows.flatMap((row) => {
          const product = idOrNull(row[PRICEBOOK_ENTRY_PRODUCT_FIELD]);
          return product ? [product] : [];
        }),
      ),
    ];
    const standard = await this.reader.readStandardPrices(products, PRICE_COLUMNS.slice(1));
    const standardIds = new Set(standard.map((row) => idKey(String(row['Id']))));
    const byKey = new Map<string, string>();
    for (const row of standard) byKey.set(standardKeyOf(row), String(row['Id']));
    const asWritten = await this.pricesWrittenFor(rows);
    return mapped.map((sampleRow, index) => {
      const row = rows[index];
      if (row === undefined) return sampleRow;
      const also: Array<{ objectApiName: string; id: string | null }> = [];
      // A price of its own book: the platform takes it only beside the
      // standard price of its product, currency and selling model.
      if (!standardIds.has(idKey(sampleRow.id))) {
        also.push({
          objectApiName: PRICEBOOK_ENTRY_OBJECT,
          id: byKey.get(standardKeyOf(row)) ?? null,
        });
      }
      // In a currency the target does not hold, it goes as the source's own
      // price of its book and product in the currency it is written in: the
      // run writes that one in its place, which the plan holds with it.
      const instead = asWritten.get(sampleRow.id);
      if (instead !== undefined) also.push({ objectApiName: PRICEBOOK_ENTRY_OBJECT, id: instead });
      return also.length > 0 ? { ...sampleRow, also } : sampleRow;
    });
  }

  /**
   * Of the prices `rows` in a currency the target does not hold, by their
   * id, the source's own price of the same book and product in the currency
   * each goes in (`priceCurrencyWrittenIn`), where it holds one: the run
   * writes it in their place (`settlePriceCurrencies`). Read once a currency
   * for the products and books of the batch.
   */
  private async pricesWrittenFor(rows: readonly SourceRow[]): Promise<Map<string, string>> {
    const instead = new Map<string, string>();
    const writtenIn = this.priceCurrencyWrittenIn;
    if (!writtenIn) return instead;
    const byCurrency = new Map<string, SourceRow[]>();
    for (const row of rows) {
      const read = row[PRICEBOOK_ENTRY_CURRENCY_FIELD];
      if (typeof read !== 'string') continue;
      const written = writtenIn(read);
      if (written === undefined || written === read) continue;
      byCurrency.set(written, [...(byCurrency.get(written) ?? []), row]);
    }
    for (const [currency, priced] of byCurrency) {
      const ids = (field: string): string[] =>
        priced.flatMap((row) => {
          const value = idOrNull(row[field]);
          return value ? [value] : [];
        });
      const found = await this.reader.readPricesIn(
        currency,
        ids(PRICEBOOK_ENTRY_PRODUCT_FIELD),
        ids(PRICEBOOK_ENTRY_BOOK_FIELD),
        PRICE_COLUMNS,
      );
      const byBook = new Map(found.map((row) => [bookKeyOf(row), String(row['Id'])]));
      for (const row of priced) {
        const id = byBook.get(bookKeyOf(row));
        if (id !== undefined) instead.set(String(row['Id']), id);
      }
    }
    return instead;
  }

  async rows(objectApiName: string, ids: readonly string[]): Promise<readonly SampleRow[]> {
    const [answer] = await this.reader.readParents([
      { objectApiName, ids, columns: this.columnsOf(objectApiName) },
    ]);
    if (!answer) return [];
    return this.sampleRowsOf(objectApiName, answer.rows, answer.outsideFilter);
  }

  async children(
    relation: SampleRelation,
    parentIds: readonly string[],
    cap: number | 'all',
  ): Promise<SampleChildren> {
    const [answer] = await this.reader.readChildren([
      {
        objectApiName: relation.objectApiName,
        field: relation.field,
        parentIds,
        columns: this.columnsOf(relation.objectApiName),
        cap,
        // Not counted by discovery: counted by parent first, as a large one is.
        sourceRows: this.sourceRows.get(relation.objectApiName) ?? Number.MAX_SAFE_INTEGER,
      },
    ]);
    if (!answer) return { rows: [] };
    if (answer.newestBy === 'id' && answer.cut.some((cut) => cut.rows > 0)) {
      this.cappedByIds.add(relation.objectApiName);
    }
    return {
      rows: await this.sampleRowsOf(relation.objectApiName, answer.rows),
      counts: answer.counts,
    };
  }

  async whole(objectApiName: string): Promise<readonly SampleRow[]> {
    const rows: SourceRow[] = [];
    await this.reader.readWhole(
      [{ objectApiName, columns: this.columnsOf(objectApiName) }],
      (_object, page) => {
        for (const row of page) rows.push(row);
      },
    );
    return this.sampleRowsOf(objectApiName, rows);
  }
}

/**
 * How the roots of `objectApiName` are told: each lookup that carries the
 * draw, the one-object ones held to `= null`, the others told by the key
 * prefixes of the drawn objects they may name.
 */
function carriersOf(links: SampleLinks, objectApiName: string): RootCarrier[] {
  const { empty, told } = rootFilterOf(links, objectApiName);
  const own = links.linksOf.get(objectApiName) ?? [];
  return [
    ...empty.map((field) => ({ field })),
    ...told.map((field) => ({
      field,
      drawnPrefixes: new Set(
        own.flatMap((link) =>
          link.field === field && link.carries && typeof link.prefix === 'string'
            ? [link.prefix]
            : [],
        ),
      ),
    })),
  ];
}

/**
 * A window as a refusal says it: the roots made, or last modified, from and
 * to its instants, or within its last days.
 */
function windowWordsOf(window: ForgeSampleWindow): string {
  const made = window.field === 'LastModifiedDate' ? 'last modified' : 'made';
  if (window.lastDays !== undefined) {
    return (
      `roots ${made} in the last ${window.lastDays} days` +
      (window.from !== undefined ? `, from ${window.from}` : '')
    );
  }
  const from = window.from !== undefined ? ` from ${window.from}` : '';
  const to = window.to !== undefined ? ` to before ${window.to}` : '';
  return `roots ${made}${from}${to}`;
}

/**
 * The refusal of a draw whose window and filters on the roots leave no
 * object a root (`SAMPLE_DRAW_EMPTY`): what chose the roots, the objects the
 * window could not date, the roots the source holds outside them, and the
 * ways to widen them. Nothing is read past the counts.
 */
function drawEmptyOf(
  roots: SampleRoots,
  counts: readonly RootCount[],
  requests: number,
): ForgeRunGateError {
  const chosen = [
    ...(roots.window ? [windowWordsOf(roots.window)] : []),
    ...roots.where.map(({ objectApiName, where }) => `${objectApiName} where ${where}`),
  ];
  // A count a lookup of several objects tests on the rows read selects rows
  // that may not be roots: said as the most it may hold. Said as roots, an
  // empty window told of 2 552 task roots outside it, where the source held
  // none.
  const outside = counts
    .filter((count) => (count.inTheSource?.rows ?? 0) > 0)
    .map(
      (count) =>
        `${count.objectApiName} ${count.inTheSource?.exact === false ? 'at most ' : ''}` +
        `${count.inTheSource?.rows ?? 0}`,
    );
  const ways = [
    ...(roots.window ? ['widen the window (--fit-window)'] : []),
    ...(roots.where.length > 0 ? ['loosen the filters on the roots (--fit-where)'] : []),
    'draw without them',
  ].join(', or ');
  return new ForgeRunGateError(
    'SAMPLE_DRAW_EMPTY',
    `No object has a root in the draw: ${chosen.join('; ')}.` +
      (roots.notWindowed.length > 0
        ? ` The window does not date ${roots.notWindowed.join(', ')}, which have no root in it.`
        : '') +
      (outside.length > 0 ? ` The source holds roots outside them: ${outside.join(', ')}.` : '') +
      ` Nothing was written, and the counts sent ${requests} request(s) of the source. ` +
      `${ways.charAt(0).toUpperCase()}${ways.slice(1)}.`,
    undefined,
    undefined,
    undefined,
    { sample: { requests } },
  );
}

/**
 * The ways out of a draw whose read of the roots would cost past a tenth of
 * the source's day: of a draw spread over the org, the newest or the oldest,
 * which read only the roots they keep; of any, fewer roots — a window or
 * filters on them, or narrower ones —, fewer strata, a filter on the large
 * objects, or another day.
 */
function drawingWaysOf(draw: ForgeSampleDraw, roots: SampleRoots): string {
  const fewer = roots.restricted
    ? 'narrow the window or the filters on the roots (--fit-window, --fit-where)'
    : 'draw among fewer roots (--fit-window, --fit-where)';
  if (draw === 'uniform') {
    return (
      'Draw the most recent records (--fit-draw recent) or the oldest (--fit-draw oldest), ' +
      `${fewer}, or narrow the large objects (--filter).`
    );
  }
  return (
    `${fewer.charAt(0).toUpperCase()}${fewer.slice(1)}` +
    (roots.stratified ? ', stratify fewer objects (--fit-strata)' : '') +
    ', narrow the large objects (--filter), or draw it once the source has more to spare.'
  );
}

/**
 * Draw a sample of the whole org: see the module's comment. Refuses, before
 * a request, options of the draw the run cannot take (`SAMPLE_DRAW_INVALID`,
 * every problem at once); once the roots are counted, a draw whose window
 * and filters on the roots leave none (`SAMPLE_DRAW_EMPTY`), and, before an
 * id is read, a read of the roots past a tenth of what the source has left
 * today (`API_BUDGET_EXCEEDED`, of the source). A sample the bounds cannot
 * hold comes back as `cannotFit`, and one past the records it may hold
 * throws `SampleTooLarge`.
 *
 * The roots of an object stratified are read value by value, as far as each
 * can enter the sample, and ranked in their value (`sampleStrata.ts`); its
 * floor is each value's.
 */
export async function drawSampleOfTheOrg(input: SampleDrawingInput): Promise<SampleDrawing> {
  const { options, budget } = input;
  const average = (objectApiName: string): number | undefined =>
    input.averageBytes?.get(objectApiName);
  const wholeBytesOf = (objectApiName: string, rows: number): number => {
    const each = average(objectApiName);
    return each !== undefined ? rows * each : countedStorageBytes(objectApiName, { rows });
  };
  const sourceRows = new Map(
    input.objects.flatMap((object) =>
      object.rows === undefined ? [] : [[object.objectApiName, object.rows] as const],
    ),
  );
  const links = sampleLinksOf({
    objects: input.objects,
    order: input.order,
    ...(input.excluded ? { excluded: input.excluded } : {}),
    ...(input.referenceData ? { referenceData: input.referenceData } : {}),
    ...(options.whole ? { whole: options.whole } : {}),
    roomBytes: budget.roomBytes,
    ...(input.maxRecordsPerObject !== undefined
      ? { maxRecordsPerObject: input.maxRecordsPerObject }
      : {}),
    wholeBytes: (objectApiName, rows) => wholeBytesOf(objectApiName, rows),
  });
  // Which roots the draw takes, held to the run and its describes before a
  // request is sent: every option it cannot take refused at once.
  const roots = sampleRootsOf({
    options: {
      ...(options.window ? { window: options.window } : {}),
      ...(options.rootWhere ? { rootWhere: options.rootWhere } : {}),
      ...(options.strata ? { strata: options.strata } : {}),
    },
    now: input.now ?? Date.now(),
    links,
    ...(input.excluded ? { excluded: input.excluded.keys() } : {}),
    fieldsOf: (objectApiName) => input.fieldsOf(objectApiName),
    ...(input.filterOf ? { filterOf: input.filterOf } : {}),
  });
  const described = (objectApiName: string, name: string): SampleDescribedField | undefined =>
    input.fieldsOf(objectApiName)?.find((field) => field.name.toLowerCase() === name.toLowerCase());
  const reader = new SampleSourceReader(input.source, {
    fieldsOf: (objectApiName) => input.fieldsOf(objectApiName)?.map((field) => field.name),
    ...(input.filterOf ? { filterOf: input.filterOf } : {}),
    // As the describe says it: the id aggregated by `COUNT(Id)`, the lookup
    // grouped by. Unsaid, the count is asked, and a refusal read as no.
    countsBy: (objectApiName, field) => {
      const id = described(objectApiName, 'Id')?.aggregatable;
      const by = described(objectApiName, field)?.groupable;
      if (id === false || by === false) return false;
      return id === true && by === true ? true : undefined;
    },
    sorts: (objectApiName, field) => described(objectApiName, field)?.sortable,
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });

  const rooted = [...links.classes]
    .filter(([, kind]) => kind.kind === 'drawn' && kind.rooted)
    .map(([objectApiName]) => objectApiName)
    .sort();
  // An object the window cannot date has no root in the draw: never read.
  const reads: RootRead[] = rooted
    .filter((objectApiName) => roots.objects.get(objectApiName)?.notWindowed !== true)
    .map((objectApiName) => {
      const chosen = roots.objects.get(objectApiName);
      return {
        objectApiName,
        carriers: carriersOf(links, objectApiName),
        ...(chosen?.window ? { window: chosen.window } : {}),
        ...(chosen?.where !== undefined ? { where: chosen.where } : {}),
        ...(chosen?.stratifiedBy !== undefined ? { stratifiedBy: chosen.stratifiedBy } : {}),
      };
    });
  const counts = await reader.countRoots(reads);
  const most = rootsTheBudgetHolds(budget.budget.bytes, budget.budget.maxTotal);
  // Of an object stratified, each value read as far as a root of it can
  // enter the sample, and no further.
  const stratified = new Map<string, StratifiedRoots>();
  counts.forEach((count, index) => {
    const field = reads[index].stratifiedBy;
    if (field === undefined || !count.strata) return;
    const takes = strataTakesOf(
      count.strata.map((stratum) => stratum.rows),
      most,
      options.floor,
    );
    stratified.set(
      count.objectApiName,
      new StratifiedRoots({
        objectApiName: count.objectApiName,
        field,
        strata: count.strata.map((stratum, at) => ({
          value: stratum.value,
          roots: stratum.rows,
          take: takes[at],
        })),
        draw: options.draw,
        seed: options.seed,
        floor: options.floor,
      }),
    );
  });
  const takeOf = (count: RootCount): DatedRootRead['take'] =>
    stratified.get(count.objectApiName)?.reads() ?? Math.min(count.rows, most);
  const scan = counts.reduce(
    (sum, count) => sum + rootScanRequestsOf(count, options.draw, takeOf(count)),
    0,
  );
  const left = input.sourceRequestsLeft;
  if (left !== undefined && reader.requests + scan > Math.floor(API_BUDGET_NEAR_SHARE * left)) {
    const estimate = reader.requests + scan;
    // Marked as the drawing's, with its share and how it drew: the page said
    // it as a run past all the source has left, and offered the newest
    // records to a draw that took them already.
    throw new ForgeRunGateError(
      API_BUDGET_EXCEEDED,
      `Drawing the sample reads about ${estimate} requests of the source, more than a tenth ` +
        `of the ${left} it has left today. Nothing was written, and no id was read past the ` +
        `counts. ${drawingWaysOf(options.draw, roots)}`,
      undefined,
      undefined,
      undefined,
      {
        api: {
          kind: 'requests',
          org: 'source',
          estimate,
          remaining: left,
          drawing: {
            share: API_BUDGET_NEAR_SHARE,
            draw: options.draw,
            ...(roots.restricted ? { restricted: true } : {}),
          },
        },
      },
    );
  }

  const draw = new RootDraw(most, options.floor);
  let rootsByIds: string[] = [];
  /** Per object, the roots a scan spread over the org handed on: every root of it in the draw. */
  const scanned = new Map<string, number>();
  /** Per object read by date, the roots its read handed on, in the order read. */
  const positions = new Map<string, number>();
  if (options.draw === 'uniform') {
    await reader.drawUniform(reads, (objectApiName, ids, value) => {
      scanned.set(objectApiName, (scanned.get(objectApiName) ?? 0) + ids.length);
      const strata = stratified.get(objectApiName);
      if (strata) {
        for (const id of ids) strata.scanned(id, value ?? null);
        return;
      }
      for (const id of ids) draw.offer(objectApiName, id, rankOf(options.seed, id));
    });
  } else {
    const rowsOf = new Map(counts.map((count) => [count.objectApiName, count.rows]));
    const drawn = await reader.drawByDate(
      counts.map((count, index) => ({ ...reads[index], take: takeOf(count) })),
      options.draw,
      (objectApiName, ids, value) => {
        const strata = stratified.get(objectApiName);
        if (strata) {
          strata.read(value ?? null, ids);
          return;
        }
        let position = positions.get(objectApiName) ?? 0;
        for (const id of ids) {
          draw.offer(objectApiName, id, recentRankOf(position, rowsOf.get(objectApiName) ?? 0));
          position++;
        }
        positions.set(objectApiName, position);
      },
    );
    rootsByIds = drawn.filter((read) => read.by === 'id').map((read) => read.objectApiName);
    // An object read up to its take, short of the roots counted, has roots
    // never read past it: the share stays below them.
    for (const count of counts) {
      if (stratified.has(count.objectApiName)) continue;
      const take = Math.min(count.rows, most);
      if (take < count.rows && (positions.get(count.objectApiName) ?? 0) >= take) {
        draw.leftUnread(recentRankOf(take, count.rows));
      }
    }
  }
  // Each root of a value ranked in it, its floor the value's; a value read
  // short of its roots holds the share below its first left unread.
  for (const strata of stratified.values()) {
    for (const root of strata.ranked()) {
      draw.offer(strata.objectApiName, root.id, root.rank, root.stratum);
    }
    draw.leftUnread(strata.firstUnread);
  }
  const offered = draw.drawn();
  // No root in the window and the conditions: nothing is read past the
  // counts, an object counted to hold none never read, and nothing drawn —
  // where a sample of the objects copied whole alone would have been said.
  // A count a lookup of several objects tests on the rows read ends here too.
  if (roots.restricted && offered.length === 0) {
    throw drawEmptyOf(roots, counts, reader.requests);
  }
  const { maxTotal } = budget.budget;
  const heldBy =
    maxTotal !== undefined && maxTotal < Math.floor(budget.budget.bytes / SMALLEST_RECORD_BYTES)
      ? 'maxTotal'
      : budget.bytesLimit;
  const closing = new SourceSampleReader(reader, links, sourceRows, input.priceCurrencyWrittenIn);
  const cut = await drawTheSample({
    links,
    reader: closing,
    draw: {
      roots: offered,
      beyond: draw.beyond,
      heldBy,
      floor: options.floor,
      ...(roots.restricted ? { restricted: true } : {}),
    },
    sourceRows,
    options: {
      parents: options.parents,
      children: options.children,
      ...(input.recordTypeVerdict ? { recordTypeVerdict: input.recordTypeVerdict } : {}),
      ...(input.maxRows !== undefined ? { maxRows: input.maxRows } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    },
    measure: {
      bytes: (objectApiName, row) =>
        row.bytes ?? average(objectApiName) ?? documentedMeasure.bytes(objectApiName, row),
      wholeBytes: wholeBytesOf,
      ...(budget.automationBytes ? { roomBytes: budget.automationBytes } : {}),
    },
    bounds: {
      bytes: budget.budget.bytes,
      bytesLimit: budget.bytesLimit,
      ...(budget.storageBytes !== undefined ? { storageBytes: budget.storageBytes } : {}),
      ...(maxTotal !== undefined ? { maxTotal } : {}),
      ...(budget.requests ? { requests: budget.requests } : {}),
    },
    roomBytes: budget.roomBytes,
    onStep: (step, rows) => input.onProgress?.({ step, rows, requests: reader.requests }),
  });

  // The roots read by their ids: the newest, or the oldest; and the children
  // the cap kept by theirs, always the newest.
  const newestByIds = [
    ...new Set([...(options.draw === 'recent' ? rootsByIds : []), ...closing.cappedByIds]),
  ].sort();
  const oldestByIds = options.draw === 'oldest' ? [...rootsByIds].sort() : [];

  // Of each object whose roots the window or a filter chose, those in the
  // draw — every one a scan handed on, or as the count said — and those of
  // the source; none, of an object the window could not date. A count that
  // selected rows only their read tells roots of (`RootCount.exact`) is no
  // count of roots: those in the draw are the ones a read through every row
  // of it handed on — a scan, or a read by date that ended short of its take
  // —, and those of the source, which nothing read through, are not said.
  const rootsCounted = new Map<string, { inTheDraw?: number; inTheSource?: number }>();
  const noRootInTheDraw = new Set<string>();
  for (const objectApiName of rooted) {
    const chosen = roots.objects.get(objectApiName);
    if (
      !chosen ||
      (chosen.window === undefined && chosen.where === undefined && !chosen.notWindowed)
    ) {
      continue;
    }
    const count = counts.find((entry) => entry.objectApiName === objectApiName);
    const readThrough = (counted: RootCount): number | undefined => {
      const given = positions.get(objectApiName) ?? 0;
      return !stratified.has(objectApiName) && given < Math.min(counted.rows, most)
        ? given
        : undefined;
    };
    const inTheDraw =
      chosen.notWindowed || !count
        ? 0
        : options.draw === 'uniform'
          ? (scanned.get(objectApiName) ?? 0)
          : count.exact && count.timedOut !== true
            ? count.rows
            : readThrough(count);
    const inTheSource = count?.inTheSource?.exact === true ? count.inTheSource.rows : undefined;
    rootsCounted.set(objectApiName, {
      ...(inTheDraw !== undefined ? { inTheDraw } : {}),
      ...(inTheSource !== undefined ? { inTheSource } : {}),
    });
    if (
      inTheDraw === 0 &&
      (chosen.notWindowed || (inTheSource ?? count?.inTheSource?.rows ?? 0) > 0)
    ) {
      noRootInTheDraw.add(objectApiName);
    }
  }

  // How the roots were chosen, the values of each stratum with the roots it
  // holds and those the sample keeps as roots.
  let report: WholeOrgSampleRoots | undefined;
  if (roots.restricted || roots.stratified) {
    const strata: NonNullable<WholeOrgSampleRoots['strata']> = [];
    for (const strataOf of stratified.values()) {
      const kept = cut.kind === 'sample' ? cut.rootIds.get(strataOf.objectApiName) : undefined;
      const labelOf = await input.labelsOf?.(strataOf.objectApiName, strataOf.field);
      strata.push(strataOf.report((id) => kept?.has(idKey(id)) === true, labelOf));
    }
    report = { ...sampleRootsReportOf(roots), ...(strata.length > 0 ? { strata } : {}) };
  }

  // The floors of the strata, what a sample that cannot fit may be held by.
  let strataFloors: SampleDrawing['strataFloors'];
  if (options.floor > 0 && stratified.size > 0) {
    let values = 0;
    let floorRoots = 0;
    for (const strataOf of stratified.values()) {
      for (const value of strataOf.reads()) {
        values++;
        floorRoots += Math.min(value.roots, options.floor);
      }
    }
    if (values > 0) strataFloors = { roots: floorRoots, values };
  }

  return {
    links,
    cut,
    planRequests: reader.requests,
    newestByIds,
    oldestByIds,
    ...(report ? { roots: report } : {}),
    rootsCounted,
    noRootInTheDraw,
    ...(strataFloors ? { strataFloors } : {}),
  };
}

/**
 * How a sample chose its roots, as a run's result, its history and its
 * audit keep it (`WholeOrgSampleResult.roots`): the window, the objects whose
 * roots were filtered, and the fields they were stratified by
 * (`Object.Field`) — never a filter's text nor a stratum's value, which stay
 * with the run's config and its plan. Nothing of a draw among every root.
 */
export function sampleRootsResultOf(
  roots: WholeOrgSampleRoots | undefined,
): WholeOrgSampleResult['roots'] | undefined {
  if (!roots) return undefined;
  const whereObjects = (roots.where ?? []).map((entry) => entry.objectApiName);
  const strataFields = (roots.strata ?? []).map((entry) => `${entry.objectApiName}.${entry.field}`);
  const summary = {
    ...(roots.window ? { window: { ...roots.window } } : {}),
    ...(whereObjects.length > 0 ? { whereObjects } : {}),
    ...(strataFields.length > 0 ? { strataFields } : {}),
  };
  return Object.keys(summary).length > 0 ? summary : undefined;
}

/** What a sample drew, as its plan keeps it and its dry run says it: the report but for its place on disk. */
export function sampleReportOf(
  drawing: SampleDrawing & { cut: SampleCut },
  options: SampleDrawOptions,
  budget: WholeOrgSampleBudget,
): Omit<WholeOrgSample, 'plan'> {
  const { cut, links } = drawing;
  return {
    seed: options.seed,
    draw: options.draw,
    floor: options.floor,
    parents: options.parents,
    children: options.children,
    share: cut.share,
    // What the target's automation creates under the records kept, said
    // apart: run for real, a sample said "about 3.6 MB" and its gate "1.95
    // MB", the 1.65 MB of tasks a flow opens under its contacts said nowhere.
    budget: {
      ...budget,
      ...(cut.automationBytes > 0 ? { automationMB: cut.automationBytes / BYTES_PER_MB } : {}),
      limitedBy: cut.limitedBy,
    },
    rows: cut.rows,
    storageBytes: cut.storageBytes,
    // Of an object whose roots the draw chose, those in it beside those of
    // the source: the share is of the first.
    objects: cut.objects.map((object) => {
      const counted = drawing.rootsCounted.get(object.objectApiName);
      if (!counted) return object;
      return {
        ...object,
        ...(counted.inTheSource !== undefined ? { rootsInTheSource: counted.inTheSource } : {}),
        ...(counted.inTheDraw !== undefined ? { rootsInTheDraw: counted.inTheDraw } : {}),
      };
    }),
    whole: links.whole,
    heavyRoots: cut.heavyRoots,
    dropped: cut.dropped,
    leftEmpty: cut.leftEmpty,
    noRecordDrawn: cut.noRecordDrawn.map((entry) =>
      drawing.noRootInTheDraw.has(entry.objectApiName)
        ? { ...entry, noRootInTheDraw: true as const }
        : entry,
    ),
    ...(drawing.roots ? { roots: drawing.roots } : {}),
    ...(cut.partialMasters.length > 0 ? { partialMasters: cut.partialMasters } : {}),
    planRequests: { source: drawing.planRequests },
    ...(drawing.newestByIds.length > 0 ? { newestByIds: [...drawing.newestByIds] } : {}),
    ...(drawing.oldestByIds.length > 0 ? { oldestByIds: [...drawing.oldestByIds] } : {}),
  };
}
