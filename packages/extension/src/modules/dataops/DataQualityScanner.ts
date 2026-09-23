import { z } from 'zod';
import { isPlatformRequiredField } from '@sandforge/shared';
import type {
  DataQualityCheckError,
  DataQualityDuplicates,
  DataQualityFieldFill,
  DataQualityObjectResult,
  DataQualityScanResult,
  DataQualityScanTarget,
  DataQualityStaleness,
  DataQualityUnmeasuredField,
} from '@sandforge/shared';
import { assertSoqlIdentifier } from '../../core/common/soqlValidator.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';

/**
 * What a scan needs from an org: describes, and queries whose answer is a
 * count or a handful of aggregate rows. No query this module sends returns a
 * record, so how many it sends depends on the fields, never on the records.
 */
export interface QualityScanConnection {
  describe(objectApiName: string): Promise<unknown>;
  query(soql: string): Promise<{ totalSize: number; records: unknown[] }>;
}

/** What a scan is asked to read. */
export interface QualityScanRequest {
  orgId: string;
  objects: DataQualityScanTarget[];
  /** Records not modified for this many days count as stale. */
  staleDays: number;
}

/**
 * `COUNT(field)` expressions per query. Measured on a sandbox: the org refuses
 * the 101st with "maximum number of aliased fields exceeded: 100", so an object
 * with more fields than that is counted in several queries.
 */
export const FILL_COUNTS_PER_QUERY = 100;

/**
 * Repeated values one duplicate search reads. An aggregate query cannot be
 * paged: measured on a sandbox, a GROUP BY past 2,000 rows is refused outright
 * ("Aggregate query does not support queryMore(), use LIMIT to restrict the
 * results to a single batch"), so the search carries this LIMIT and says when
 * it reached it.
 */
export const DUPLICATE_GROUP_LIMIT = 2000;

/** Repeated values handed back per object, the most repeated first. */
export const DUPLICATE_SAMPLE = 20;

/**
 * Fields counted with a query of their own, per object. A multi-select
 * picklist is refused by `COUNT(field)` ("does not support aggregate operator
 * COUNT") but can be filtered, so it takes one `SELECT COUNT()` each; past this
 * many, the rest are named as not counted instead of fanning out further.
 */
export const SINGLE_FIELD_QUERIES = 20;

/** The describe attributes a scan reads, checked before they are trusted. */
const describedFieldSchema = z
  .object({
    name: z.string(),
    label: z.string(),
    type: z.string(),
    createable: z.boolean().optional(),
    updateable: z.boolean().optional(),
    nillable: z.boolean().optional(),
    defaultedOnCreate: z.boolean().optional(),
    aggregatable: z.boolean().optional(),
    groupable: z.boolean().optional(),
    filterable: z.boolean().optional(),
    nameField: z.boolean().optional(),
  })
  .passthrough();

const describedObjectSchema = z
  .object({
    name: z.string(),
    label: z.string(),
    queryable: z.boolean().optional(),
    fields: z.array(describedFieldSchema),
  })
  .passthrough();

type DescribedField = z.infer<typeof describedFieldSchema>;

/** One row of a fill query: `expr0`, `expr1`… in the order the counts were asked. */
const aggregateRowSchema = z.record(z.string(), z.unknown());

/** One row of a duplicate search: the repeated value, and how many records carry it. */
const duplicateRowSchema = z
  .object({
    k: z.union([z.string(), z.number(), z.boolean()]).nullable(),
    n: z.number().int().nonnegative(),
  })
  .passthrough();

/**
 * Whether a person or an integration fills this field in. A field nobody can
 * write — the Id, the audit stamps, a formula, a roll-up — says nothing about
 * how the data is kept, and a checkbox is never empty: unticked is false.
 */
function isFilledIn(field: DescribedField): boolean {
  return (field.createable === true || field.updateable === true) && field.type !== 'boolean';
}

/**
 * Whether records may be grouped by this field to look for duplicates: the org
 * groups by it, and it is either filled in or the record's name. `Contact.Name`
 * is both unwritable and the key a person reaches for first — the org composes
 * it from the first and last names. The audit stamps and ids the org keeps
 * itself group too, and grouping records by who last touched them finds no
 * duplicate.
 */
function isDuplicateKey(field: DescribedField): boolean {
  return field.groupable === true && (isFilledIn(field) || field.nameField === true);
}

/**
 * Whether a new record is refused without the field — the product's one
 * notion of a required field, as Seed and the Frozen loader read it: createable,
 * not nillable, no default — or the platform demands it whatever the describe
 * says.
 */
function isRequired(objectApiName: string, field: DescribedField): boolean {
  return (
    (field.createable === true && field.nillable === false && field.defaultedOnCreate !== true) ||
    isPlatformRequiredField(objectApiName, field.name)
  );
}

/** Push an error unless the same check already reported the same words. */
function report(
  errors: DataQualityCheckError[],
  check: DataQualityCheckError['check'],
  err: unknown,
): void {
  const message = extractErrorMessage(err);
  if (!errors.some((e) => e.check === check && e.message === message)) {
    errors.push({ check, message });
  }
}

/** What the fill counts found, and what they could not count. */
interface FillCounts {
  fields: DataQualityFieldFill[];
  unmeasured: DataQualityUnmeasuredField[];
  errors: DataQualityCheckError[];
}

/**
 * How many records fill each field. `COUNT(field)` counts the records where a
 * field is not null, so a hundred fields cost one query that returns one row.
 * Fields the org will not aggregate but will filter take a `SELECT COUNT()` of
 * their own; fields it will do neither for are named, not guessed.
 */
async function countFills(
  conn: QualityScanConnection,
  objectApiName: string,
  fields: readonly DescribedField[],
  totalRecords: number,
): Promise<FillCounts> {
  const counted = new Map<string, number>();
  const unmeasured: DataQualityUnmeasuredField[] = [];
  const errors: DataQualityCheckError[] = [];
  const unmeasure = (field: DescribedField, reason: DataQualityUnmeasuredField['reason']): void => {
    unmeasured.push({ fieldApiName: field.name, label: field.label, reason });
  };

  const aggregated = fields.filter((f) => f.aggregatable === true);
  const filtered = fields.filter((f) => f.aggregatable !== true && f.filterable === true);
  for (const field of fields) {
    if (field.aggregatable !== true && field.filterable !== true) unmeasure(field, 'not-countable');
  }

  if (totalRecords === 0) {
    // Every count is zero; asking the org to confirm it spends queries on nothing.
    for (const field of [...aggregated, ...filtered]) counted.set(field.name, 0);
  } else {
    for (let at = 0; at < aggregated.length; at += FILL_COUNTS_PER_QUERY) {
      const chunk = aggregated.slice(at, at + FILL_COUNTS_PER_QUERY);
      try {
        const counts = chunk.map((f) => `COUNT(${assertSoqlIdentifier(f.name)})`).join(', ');
        const answer = await conn.query(`SELECT ${counts} FROM ${objectApiName}`);
        const row = aggregateRowSchema.parse(answer.records[0] ?? {});
        chunk.forEach((field, index) => {
          const value = row[`expr${index}`];
          if (typeof value !== 'number') {
            throw new Error(`The org answered no count for ${objectApiName}.${field.name}.`);
          }
          counted.set(field.name, value);
        });
      } catch (err: unknown) {
        report(errors, 'fill', err);
        for (const field of chunk) {
          counted.delete(field.name);
          unmeasure(field, 'refused');
        }
      }
    }

    for (const [index, field] of filtered.entries()) {
      if (index >= SINGLE_FIELD_QUERIES) {
        unmeasure(field, 'query-budget');
        continue;
      }
      try {
        const answer = await conn.query(
          `SELECT COUNT() FROM ${objectApiName} WHERE ${assertSoqlIdentifier(field.name)} != null`,
        );
        counted.set(field.name, answer.totalSize);
      } catch (err: unknown) {
        report(errors, 'fill', err);
        unmeasure(field, 'refused');
      }
    }
  }

  const filled: DataQualityFieldFill[] = fields
    .filter((f) => counted.has(f.name))
    .map((f) => ({
      fieldApiName: f.name,
      label: f.label,
      filled: counted.get(f.name) ?? 0,
      required: isRequired(objectApiName, f),
    }))
    .sort((a, b) => a.filled - b.filled || a.fieldApiName.localeCompare(b.fieldApiName));

  return { fields: filled, unmeasured, errors };
}

/**
 * The values of one key that more than one record carries.
 *
 * The key is the one the request names, when it is one of `keyFields`; with
 * none named, `Email`, else the record's name. Records with no value are left
 * out: two records without an email are not duplicates of each other.
 */
async function findDuplicates(
  conn: QualityScanConnection,
  objectApiName: string,
  keyFields: readonly DescribedField[],
  requestedKey: string | undefined,
  totalRecords: number,
): Promise<{ duplicates: DataQualityDuplicates | null; errors: DataQualityCheckError[] }> {
  const errors: DataQualityCheckError[] = [];
  const key = requestedKey
    ? keyFields.find((f) => f.name.toLowerCase() === requestedKey.toLowerCase())
    : (keyFields.find((f) => f.name === 'Email') ?? keyFields.find((f) => f.nameField === true));
  if (!key) {
    if (requestedKey) {
      errors.push({
        check: 'duplicates',
        message: `${objectApiName} has no field ${requestedKey} the org can group records by.`,
      });
    }
    return { duplicates: null, errors };
  }

  const none: DataQualityDuplicates = {
    keyField: key.name,
    keyLabel: key.label,
    groups: [],
    groupCount: 0,
    recordCount: 0,
    truncated: false,
  };
  if (totalRecords === 0) return { duplicates: none, errors };

  try {
    const field = assertSoqlIdentifier(key.name);
    const answer = await conn.query(
      `SELECT ${field} k, COUNT(Id) n FROM ${objectApiName} WHERE ${field} != null ` +
        `GROUP BY ${field} HAVING COUNT(Id) > 1 ORDER BY COUNT(Id) DESC LIMIT ${DUPLICATE_GROUP_LIMIT}`,
    );
    const rows: Array<{ value: string; count: number }> = [];
    for (const record of answer.records) {
      const row = duplicateRowSchema.safeParse(record);
      if (!row.success || row.data.k === null) continue;
      rows.push({ value: String(row.data.k), count: row.data.n });
    }
    return {
      duplicates: {
        ...none,
        groups: rows.slice(0, DUPLICATE_SAMPLE),
        groupCount: rows.length,
        recordCount: rows.reduce((sum, row) => sum + row.count, 0),
        truncated: answer.records.length >= DUPLICATE_GROUP_LIMIT,
      },
      errors,
    };
  } catch (err: unknown) {
    report(errors, 'duplicates', err);
    return { duplicates: null, errors };
  }
}

/**
 * Records nobody has modified for `days`. `LAST_N_DAYS:n` starts at midnight
 * n days ago, in the running user's time zone, so "older than" it is older
 * than the whole of that window.
 */
async function countStale(
  conn: QualityScanConnection,
  objectApiName: string,
  fields: readonly DescribedField[],
  days: number,
  totalRecords: number,
): Promise<{ stale: DataQualityStaleness | null; errors: DataQualityCheckError[] }> {
  const errors: DataQualityCheckError[] = [];
  if (!fields.some((f) => f.name === 'LastModifiedDate' && f.filterable === true)) {
    return { stale: null, errors };
  }
  if (totalRecords === 0) return { stale: { days, records: 0 }, errors };
  try {
    const answer = await conn.query(
      `SELECT COUNT() FROM ${objectApiName} WHERE LastModifiedDate < LAST_N_DAYS:${days}`,
    );
    return { stale: { days, records: answer.totalSize }, errors };
  } catch (err: unknown) {
    report(errors, 'stale', err);
    return { stale: null, errors };
  }
}

/** Read one object. A describe or a count the org refuses fails the object, not the scan. */
async function scanObject(
  conn: QualityScanConnection,
  target: DataQualityScanTarget,
  staleDays: number,
): Promise<DataQualityObjectResult> {
  let described: z.infer<typeof describedObjectSchema>;
  let objectApiName: string;
  let totalRecords: number;
  try {
    described = describedObjectSchema.parse(
      await conn.describe(assertSoqlIdentifier(target.objectApiName)),
    );
    objectApiName = assertSoqlIdentifier(described.name);
    if (described.queryable === false) {
      throw new Error(`${objectApiName} cannot be queried.`);
    }
    totalRecords = (await conn.query(`SELECT COUNT() FROM ${objectApiName}`)).totalSize;
  } catch (err: unknown) {
    return {
      status: 'failed',
      objectApiName: target.objectApiName,
      message: extractErrorMessage(err),
    };
  }

  const keyFields = described.fields
    .filter(isDuplicateKey)
    .sort((a, b) => a.label.localeCompare(b.label));

  // Three independent reads: none waits on another's answer.
  const [fill, duplicates, stale] = await Promise.all([
    countFills(conn, objectApiName, described.fields.filter(isFilledIn), totalRecords),
    findDuplicates(conn, objectApiName, keyFields, target.duplicateKey, totalRecords),
    countStale(conn, objectApiName, described.fields, staleDays, totalRecords),
  ]);

  return {
    status: 'scanned',
    objectApiName: target.objectApiName,
    label: described.label,
    totalRecords,
    fields: fill.fields,
    unmeasured: fill.unmeasured,
    duplicates: duplicates.duplicates,
    stale: stale.stale,
    keyFields: keyFields.map((f) => ({ fieldApiName: f.name, label: f.label })),
    errors: [...fill.errors, ...duplicates.errors, ...stale.errors],
  };
}

/**
 * Measure the records of the objects asked for: how often each field a person
 * fills in is filled, which values of a key repeat, and how many records nobody
 * has modified for `staleDays`.
 *
 * Every figure is a count the org made — `COUNT()`, `COUNT(field)`, a
 * `GROUP BY … HAVING` — and no query returns a record, so the queries a scan
 * sends are bounded by the number of fields, never by the number of records.
 * The org still counts every record, and a count it gives up on, on a very
 * large object, is reported rather than taken for zero. Where a bound applies, the result
 * says so: a duplicate search that reached its LIMIT is `truncated`, and a
 * field that could not be counted is listed with the reason.
 */
export async function scanDataQuality(
  conn: QualityScanConnection,
  request: QualityScanRequest,
  now: () => Date = () => new Date(),
): Promise<DataQualityScanResult> {
  // Written into the query text, so held to what the payload schema allows.
  if (!Number.isInteger(request.staleDays) || request.staleDays < 1) {
    throw new Error(`A staleness threshold is a whole number of days, not ${request.staleDays}.`);
  }
  const scannedAt = now().toISOString();
  const objects: DataQualityObjectResult[] = [];
  for (const target of request.objects) {
    objects.push(await scanObject(conn, target, request.staleDays));
  }
  return {
    orgId: request.orgId,
    staleDays: request.staleDays,
    scannedAt,
    bounds: {
      duplicateGroupLimit: DUPLICATE_GROUP_LIMIT,
      duplicateSample: DUPLICATE_SAMPLE,
      singleFieldQueries: SINGLE_FIELD_QUERIES,
    },
    objects,
  };
}
