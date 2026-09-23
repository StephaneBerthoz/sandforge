import type {
  CleanupObjectResult,
  CleanupOrphans,
  CleanupRecommendation,
  CleanupScanResult,
  DataQualityScanTarget,
} from '@sandforge/shared';
import { ORPHAN_FILL_THRESHOLD } from '@sandforge/shared';

import { assertSoqlIdentifier, sanitizeSoqlValue } from '../../core/common/soqlValidator.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import {
  countFills,
  countStale,
  describedObjectSchema,
  DUPLICATE_GROUP_LIMIT,
  DUPLICATE_SAMPLE,
  findDuplicates,
  isDuplicateKey,
  isFilledIn,
  repeatedValues,
  SINGLE_FIELD_QUERIES,
} from './DataQualityScanner.js';
import type { DescribedField, DescribedObject } from './DataQualityScanner.js';
import type { OrgSession } from './RecordRemoval.js';
import { isRecordId } from './RecordRemoval.js';

/** What a cleanup scan is asked to read. */
export interface CleanupScanRequest {
  orgId: string;
  objects: DataQualityScanTarget[];
  /** Records not modified for this many days count as stale. */
  staleDays: number;
}

/**
 * Objects a lookup to which is no parent: the owner, the queue, the record
 * type, the org's own settings. A record whose record type is empty uses the
 * default one; nobody is left without a parent by it.
 */
const NOT_A_PARENT = new Set([
  'User',
  'Group',
  'RecordType',
  'BusinessHours',
  'Profile',
  'UserRole',
]);

/**
 * Whether a lookup can leave a record an orphan: a person fills it, it points
 * at one object that is a parent, and the org lets it be empty. A lookup the
 * org requires — a master-detail — is never empty, and one that may point at
 * several objects says nothing of which one a record should have.
 */
export function isOrphanLookup(field: DescribedField): boolean {
  return (
    field.type === 'reference' &&
    isFilledIn(field) &&
    field.nillable === true &&
    field.filterable === true &&
    field.referenceTo?.length === 1 &&
    !NOT_A_PARENT.has(field.referenceTo[0])
  );
}

/**
 * Whether the business relies on a lookup: at least {@link ORPHAN_FILL_THRESHOLD}
 * of the object's records fill it. Nine records in ten carry it on purpose;
 * the tenth, which leaves it empty, is the orphan a cleanup lists.
 */
export function isReliedOn(filled: number, total: number): boolean {
  return total > 0 && filled / total >= ORPHAN_FILL_THRESHOLD;
}

/** Read one object. A describe or a count the org refuses fails the object, not the scan. */
async function scanObject(
  conn: Pick<OrgSession, 'describe' | 'query'>,
  target: DataQualityScanTarget,
  staleDays: number,
): Promise<CleanupObjectResult> {
  let described: DescribedObject;
  let objectApiName: string;
  let totalRecords: number;
  try {
    described = describedObjectSchema.parse(
      await conn.describe(assertSoqlIdentifier(target.objectApiName)),
    );
    objectApiName = assertSoqlIdentifier(described.name);
    if (described.queryable === false) throw new Error(`${objectApiName} cannot be queried.`);
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
  const lookups = described.fields.filter(isOrphanLookup);

  // Three independent reads, each the one the Quality tab counts with.
  const [fills, duplicates, stale] = await Promise.all([
    countFills(conn, objectApiName, lookups, totalRecords),
    findDuplicates(conn, objectApiName, keyFields, target.duplicateKey, totalRecords),
    countStale(conn, objectApiName, described.fields, staleDays, totalRecords),
  ]);

  const orphans: CleanupOrphans[] = fills.fields
    .filter((f) => isReliedOn(f.filled, totalRecords) && f.filled < totalRecords)
    .map((f) => {
      const lookup = lookups.find((l) => l.name === f.fieldApiName);
      return {
        fieldApiName: f.fieldApiName,
        label: f.label,
        referenceTo: lookup?.referenceTo?.[0] ?? '',
        filled: f.filled,
        empty: totalRecords - f.filled,
      };
    })
    .sort((a, b) => b.empty - a.empty || a.label.localeCompare(b.label));

  return {
    status: 'scanned',
    objectApiName: target.objectApiName,
    label: described.label,
    totalRecords,
    stale: stale.stale,
    orphans,
    duplicates: duplicates.duplicates,
    keyFields: keyFields.map((f) => ({ fieldApiName: f.name, label: f.label })),
    errors: [...fills.errors, ...duplicates.errors, ...stale.errors],
  };
}

/**
 * Count what a cleanup would look at in the objects asked for: the records
 * nobody has modified for `staleDays`, the orphans of each lookup the business
 * relies on, and the values of a key more than one record carries.
 *
 * Every figure is a count the org made, with the Quality tab's own queries —
 * `COUNT(field)` for the lookups, its duplicate search, its staleness count —
 * so a scan reads no record, and what it costs depends on the fields, not on
 * the records.
 *
 * @param conn - The org.
 * @param request - The org, the objects and the staleness threshold.
 * @param now - When the scan ran (injected by tests).
 */
export async function scanCleanup(
  conn: Pick<OrgSession, 'describe' | 'query'>,
  request: CleanupScanRequest,
  now: () => Date = () => new Date(),
): Promise<CleanupScanResult> {
  if (!Number.isInteger(request.staleDays) || request.staleDays < 1) {
    throw new Error(`A staleness threshold is a whole number of days, not ${request.staleDays}.`);
  }
  const scannedAt = now().toISOString();
  const objects: CleanupObjectResult[] = [];
  for (const target of request.objects) {
    objects.push(await scanObject(conn, target, request.staleDays));
  }
  return {
    orgId: request.orgId,
    staleDays: request.staleDays,
    scannedAt,
    orphanThreshold: ORPHAN_FILL_THRESHOLD,
    bounds: {
      duplicateGroupLimit: DUPLICATE_GROUP_LIMIT,
      duplicateSample: DUPLICATE_SAMPLE,
      singleFieldQueries: SINGLE_FIELD_QUERIES,
    },
    objects,
  };
}

/** The records a recommendation names, as far as one run acts on them. */
export interface ResolvedRecommendation {
  object: DescribedObject;
  /** Records the recommendation names, all told. */
  total: number;
  /** The ones this run acts on: at most the run's limit. */
  ids: string[];
  /** More records are recommended than this run acts on. */
  truncated: boolean;
}

/** The Ids of an answer's records, those that are Ids. */
function idsOf(records: readonly unknown[]): string[] {
  return records.flatMap((record) => {
    const id =
      typeof record === 'object' && record !== null ? (record as { Id?: unknown }).Id : undefined;
    return isRecordId(id) ? [id] : [];
  });
}

/**
 * A value of a key, written as SOQL writes it for the field's type; undefined
 * for a type whose literals this does not write — a date and time, a time —
 * which the caller refuses rather than guesses at.
 */
export function soqlLiteral(type: string, value: string | number | boolean): string | undefined {
  switch (type) {
    case 'int':
    case 'long':
    case 'double':
    case 'currency':
    case 'percent':
      return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
    case 'boolean':
      return typeof value === 'boolean' ? String(value) : undefined;
    case 'date':
      return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;
    case 'datetime':
    case 'time':
      return undefined;
    default:
      return typeof value === 'string' ? `'${sanitizeSoqlValue(value)}'` : undefined;
  }
}

/** How the org groups a key's values: text whatever its case. */
function groupKey(type: string, value: unknown): string {
  const text = String(value ?? '');
  return typeof value === 'string' && type !== 'date' ? text.toLowerCase() : text;
}

/** Values of a key one read of their records names. */
const VALUES_PER_QUERY = 100;

/** Rows one read of duplicate copies returns at most: one page. */
const COPIES_PER_QUERY = 2000;

/**
 * The copies of every repeated value of a key, less one per value: the record
 * modified last, which holds the freshest data, is kept. Read value list by
 * value list, until `limit` copies are found.
 */
async function duplicateCopies(
  conn: Pick<OrgSession, 'query'>,
  object: DescribedObject,
  key: DescribedField,
  limit: number,
): Promise<{ total: number; ids: string[] }> {
  const objectApiName = assertSoqlIdentifier(object.name);
  const field = assertSoqlIdentifier(key.name);
  const repeated = await repeatedValues(conn, objectApiName, key.name);
  const total = repeated.rows.reduce((sum, row) => sum + row.count - 1, 0);
  const literals = repeated.rows.map((row) => soqlLiteral(key.type, row.value));
  if (literals.some((l) => l === undefined)) {
    throw new Error(
      `Copies of ${object.label} records cannot be picked out by ${key.label}: its values are ` +
        'dates and times, which this cleanup does not compare.',
    );
  }
  const hasModified = object.fields.some((f) => f.name === 'LastModifiedDate');
  const ids: string[] = [];
  for (let at = 0; at < literals.length && ids.length < limit; at += VALUES_PER_QUERY) {
    const list = literals.slice(at, at + VALUES_PER_QUERY).join(', ');
    const answer = await conn.query(
      `SELECT Id, ${field}${hasModified ? ', LastModifiedDate' : ''} FROM ${objectApiName} ` +
        `WHERE ${field} IN (${list}) ORDER BY Id LIMIT ${COPIES_PER_QUERY}`,
    );
    const groups = new Map<string, Array<{ id: string; modified: string }>>();
    for (const raw of answer.records) {
      if (typeof raw !== 'object' || raw === null) continue;
      const record = raw as Record<string, unknown>;
      if (!isRecordId(record.Id)) continue;
      const bucket = groupKey(key.type, record[key.name]);
      const members = groups.get(bucket) ?? [];
      members.push({
        id: record.Id,
        modified: typeof record.LastModifiedDate === 'string' ? record.LastModifiedDate : '',
      });
      groups.set(bucket, members);
    }
    for (const members of groups.values()) {
      // The latest modification first; between two modified at once, the
      // newer record.
      members.sort((a, b) => b.modified.localeCompare(a.modified) || b.id.localeCompare(a.id));
      for (const copy of members.slice(1)) {
        if (ids.length >= limit) break;
        ids.push(copy.id);
      }
    }
  }
  return { total, ids };
}

/**
 * The records a cleanup recommendation names, oldest or first by Id, at most
 * `limit` of them — checked against the rule that made it, so a request can
 * only ever name what a scan would recommend.
 *
 * - `stale`: not modified in `days` days, the oldest first.
 * - `orphans`: the lookup is one the business relies on (see
 *   {@link isReliedOn}), counted again now, and these records leave it empty.
 * - `duplicates`: every record but the one modified last, for each value of
 *   the key more than one record carries.
 *
 * @throws When the recommendation does not apply to the object as it is now.
 */
export async function resolveRecommendation(
  conn: Pick<OrgSession, 'describe' | 'query'>,
  objectApiName: string,
  recommendation: CleanupRecommendation,
  limit: number,
): Promise<ResolvedRecommendation> {
  const object = describedObjectSchema.parse(
    await conn.describe(assertSoqlIdentifier(objectApiName)),
  );
  const name = assertSoqlIdentifier(object.name);
  const fieldOf = (fieldApiName: string): DescribedField | undefined =>
    object.fields.find((f) => f.name.toLowerCase() === fieldApiName.toLowerCase());

  if (recommendation.kind === 'stale') {
    if (!Number.isInteger(recommendation.days) || recommendation.days < 1) {
      throw new Error(
        `A staleness threshold is a whole number of days, not ${recommendation.days}.`,
      );
    }
    if (!fieldOf('LastModifiedDate')) {
      throw new Error(`${object.label} records carry no date of last modification.`);
    }
    const where = `LastModifiedDate < LAST_N_DAYS:${recommendation.days}`;
    const total = (await conn.query(`SELECT COUNT() FROM ${name} WHERE ${where}`)).totalSize;
    const answer = await conn.query(
      `SELECT Id FROM ${name} WHERE ${where} ORDER BY LastModifiedDate, Id LIMIT ${limit}`,
    );
    const ids = idsOf(answer.records);
    return { object, total, ids, truncated: total > ids.length };
  }

  if (recommendation.kind === 'orphans') {
    const lookup = fieldOf(recommendation.fieldApiName);
    if (!lookup || !isOrphanLookup(lookup)) {
      throw new Error(
        `${recommendation.fieldApiName} is not a lookup of ${object.label} that can leave a record without its parent.`,
      );
    }
    const field = assertSoqlIdentifier(lookup.name);
    const all = (await conn.query(`SELECT COUNT() FROM ${name}`)).totalSize;
    const total = (await conn.query(`SELECT COUNT() FROM ${name} WHERE ${field} = null`)).totalSize;
    if (!isReliedOn(all - total, all)) {
      throw new Error(
        `${lookup.label} is filled on fewer than ${Math.round(ORPHAN_FILL_THRESHOLD * 100)}% of ` +
          `${object.label} records: the business does not rely on it, and a record without it is no orphan.`,
      );
    }
    const answer = await conn.query(
      `SELECT Id FROM ${name} WHERE ${field} = null ORDER BY Id LIMIT ${limit}`,
    );
    const ids = idsOf(answer.records);
    return { object, total, ids, truncated: total > ids.length };
  }

  const key = fieldOf(recommendation.keyField);
  if (!key || !isDuplicateKey(key)) {
    throw new Error(
      `${recommendation.keyField} is not a field ${object.label} records can be grouped by.`,
    );
  }
  const copies = await duplicateCopies(conn, object, key, limit);
  return {
    object,
    total: copies.total,
    ids: copies.ids,
    truncated: copies.total > copies.ids.length,
  };
}
