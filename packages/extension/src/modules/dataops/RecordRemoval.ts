import { z } from 'zod';
import type { Connection } from 'jsforce';
import type { RelatedRecordCount, RemovalOutcome } from '@sandforge/shared';
import { duplicateRuleHeaders } from '@sandforge/shared';

import { assertSoqlIdentifier, sanitizeSoqlValue } from '../../core/common/soqlValidator.js';
import { extractErrorMessage } from '../../core/common/extractErrorMessage.js';
import { checkApiLimits } from '../../core/common/sforceLimitParser.js';
import type { DescribedObject } from './DataQualityScanner.js';

/**
 * What the compliance and cleanup work needs from an org: describes, queries
 * that come back in one page, and the two writes an erasure makes — an update
 * that overwrites fields, a delete that sends records to the recycle bin.
 */
export interface OrgSession {
  describe(objectApiName: string): Promise<unknown>;
  describeGlobal(): Promise<unknown>;
  query(soql: string): Promise<{ totalSize: number; records: unknown[] }>;
  update(objectApiName: string, records: Array<Record<string, unknown>>): Promise<unknown>;
  destroy(objectApiName: string, ids: string[]): Promise<unknown>;
}

/**
 * The session over a jsforce connection. Each query answers in one page: every
 * query the compliance and cleanup work sends carries a LIMIT within it.
 *
 * @param conn - The org's connection.
 * @param context - Names the work in the API-usage warnings.
 */
export function orgSession(conn: Connection, context: string): OrgSession {
  return {
    describe: (objectApiName) => conn.describe(objectApiName),
    describeGlobal: () => conn.describeGlobal(),
    query: async (soql) => {
      const answer = await conn.query<Record<string, unknown>>(soql);
      checkApiLimits(conn.limitInfo, context);
      return { totalSize: answer.totalSize, records: answer.records };
    },
    // A duplicate rule can block an edit as it blocks a create: an erasure, or
    // an order a removal drafts and gives its status back, would be refused.
    update: (objectApiName, records) =>
      conn
        .sobject(objectApiName)
        .update(records as Array<Record<string, unknown> & { Id: string }>, {
          headers: duplicateRuleHeaders(true),
        }),
    destroy: (objectApiName, ids) => conn.sobject(objectApiName).destroy(ids),
  };
}

/**
 * Records one write carries, and Ids one `IN` list names: the most the org
 * takes in one collection call, and a list short enough for a query sent in a
 * URL.
 */
export const RECORDS_PER_CALL = 200;

/**
 * Relationships whose records are counted before a delete. Past it, the
 * related objects left are named as not counted rather than queried: an
 * account has some fifty cascading relationships, most of them the org's own
 * bookkeeping, and the ones people work with come well under this.
 */
export const RELATED_COUNT_LIMIT = 30;

/** Columns past which a read by Id names fewer records per query. */
const WIDE_OBJECT_COLUMNS = 100;

/** Queries sent at once while counting related records. */
const RELATED_COUNT_CONCURRENCY = 4;

/** How many rejected rows are echoed back: an org repeats a handful of reasons. */
const ERROR_SAMPLE_LIMIT = 10;

/** A Salesforce record Id: 15 or 18 letters and digits. */
const RECORD_ID = /^[A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?$/;

/** Whether a string can be a record Id, and so be written into a query. */
export function isRecordId(value: unknown): value is string {
  return typeof value === 'string' && RECORD_ID.test(value);
}

/** `ids` in lists of at most `size`, quoted for an `IN (…)`. */
export function idLists(ids: readonly string[], size: number = RECORDS_PER_CALL): string[] {
  const lists: string[] = [];
  for (let at = 0; at < ids.length; at += size) {
    lists.push(
      ids
        .slice(at, at + size)
        .map((id) => `'${sanitizeSoqlValue(id)}'`)
        .join(', '),
    );
  }
  return lists;
}

/** One row of a write's answer. */
const saveResultSchema = z
  .object({
    success: z.boolean(),
    id: z.string().nullish(),
    errors: z
      .array(z.union([z.object({ message: z.string() }).passthrough(), z.string()]))
      .optional(),
  })
  .passthrough();

/** One object of `describeGlobal`, as far as it is read here. */
const globalObjectSchema = z
  .object({
    name: z.string(),
    label: z.string(),
    queryable: z.boolean().optional(),
    createable: z.boolean().optional(),
    layoutable: z.boolean().optional(),
  })
  .passthrough();

const describeGlobalSchema = z.object({ sobjects: z.array(globalObjectSchema) }).passthrough();

/**
 * The org's objects a person works with, by name, with their labels:
 * queryable, createable, and given a page layout. That leaves out what the org
 * keeps for itself behind a record — its history, its sharing rows, its feed.
 */
export async function workedObjects(
  conn: Pick<OrgSession, 'describeGlobal'>,
): Promise<Map<string, string>> {
  const global = describeGlobalSchema.parse(await conn.describeGlobal());
  return new Map(
    global.sobjects
      .filter((o) => o.queryable === true && o.createable === true && o.layoutable === true)
      .map((o) => [o.name, o.label]),
  );
}

/** What the org deletes along with some records, as far as it was counted. */
export interface RelatedRecords {
  related: RelatedRecordCount[];
  /** Labels of the related objects left uncounted: past the limit, or refused. */
  uncounted: string[];
}

/** Run `tasks` with at most `limit` in flight; the results come back in the tasks' order. */
async function inPool<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = new Array<T>(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/**
 * The records of other objects the org deletes along with `ids`: for every
 * relationship the describe marks `cascadeDelete` to an object people work
 * with, how many of its records point at one of `ids`. An account takes its
 * contacts and opportunities with it, a contact its tasks and campaign
 * memberships — none of which the delete itself names.
 *
 * @param conn - The org.
 * @param object - The describe of the object whose records are deleted.
 * @param ids - The records to delete.
 * @param worked - {@link workedObjects} of the org.
 */
export async function countRelated(
  conn: Pick<OrgSession, 'query'>,
  object: DescribedObject,
  ids: readonly string[],
  worked: ReadonlyMap<string, string>,
): Promise<RelatedRecords> {
  if (ids.length === 0) return { related: [], uncounted: [] };
  const relationships = (object.childRelationships ?? []).filter(
    (r) => r.cascadeDelete === true && worked.has(r.childSObject),
  );
  const counted = relationships.slice(0, RELATED_COUNT_LIMIT);
  const uncounted = new Set(
    relationships
      .slice(RELATED_COUNT_LIMIT)
      .map((r) => worked.get(r.childSObject) ?? r.childSObject),
  );
  const lists = idLists(ids);

  const answers = await inPool(
    counted.map((relationship) => async () => {
      try {
        const child = assertSoqlIdentifier(relationship.childSObject);
        const field = assertSoqlIdentifier(relationship.field);
        let records = 0;
        for (const list of lists) {
          records += (await conn.query(`SELECT COUNT() FROM ${child} WHERE ${field} IN (${list})`))
            .totalSize;
        }
        return { relationship, records };
      } catch {
        return { relationship, records: null };
      }
    }),
    RELATED_COUNT_CONCURRENCY,
  );

  const byObject = new Map<string, number>();
  for (const { relationship, records } of answers) {
    const label = worked.get(relationship.childSObject) ?? relationship.childSObject;
    if (records === null) {
      uncounted.add(label);
      continue;
    }
    byObject.set(
      relationship.childSObject,
      (byObject.get(relationship.childSObject) ?? 0) + records,
    );
  }
  const related = [...byObject]
    .filter(([, records]) => records > 0)
    .map(([objectApiName, records]) => ({
      objectApiName,
      label: worked.get(objectApiName) ?? objectApiName,
      records,
    }))
    .sort((a, b) => b.records - a.records || a.label.localeCompare(b.label));
  return { related, uncounted: [...uncounted].sort() };
}

/**
 * Read `fields` of the records `ids` names, in lists the org takes. Records
 * deleted since they were found simply do not come back.
 */
export async function readRecordsById(
  conn: Pick<OrgSession, 'query'>,
  objectApiName: string,
  fields: readonly string[],
  ids: readonly string[],
): Promise<Array<Record<string, unknown>>> {
  const object = assertSoqlIdentifier(objectApiName);
  const names = [...new Set(['Id', ...fields])].map(assertSoqlIdentifier);
  const columns = names.join(', ');
  // A query travels in a URL: a wide object names fewer records per query, so
  // the columns and the Ids together stay short of what the org accepts.
  const perQuery = names.length > WIDE_OBJECT_COLUMNS ? RECORDS_PER_CALL / 4 : RECORDS_PER_CALL;
  const records: Array<Record<string, unknown>> = [];
  for (const list of idLists(ids, perQuery)) {
    const answer = await conn.query(`SELECT ${columns} FROM ${object} WHERE Id IN (${list})`);
    for (const record of answer.records) {
      if (typeof record !== 'object' || record === null) continue;
      const values: Record<string, unknown> = { ...(record as Record<string, unknown>) };
      delete values.attributes;
      records.push(values);
    }
  }
  return records;
}

/** What one write did to one object. */
export interface WriteCounts {
  done: number;
  failed: number;
  errors: Array<{ objectApiName: string; message: string }>;
}

/** Count the rows of a write's answer, keeping a sample of what the org refused. */
function countAnswer(answer: unknown, objectApiName: string, counts: WriteCounts): void {
  const rows = Array.isArray(answer) ? answer : [answer];
  for (const row of rows) {
    const parsed = saveResultSchema.safeParse(row);
    if (parsed.success && parsed.data.success) {
      counts.done++;
      continue;
    }
    counts.failed++;
    if (counts.errors.length < ERROR_SAMPLE_LIMIT) {
      const first = parsed.success ? parsed.data.errors?.[0] : undefined;
      const message =
        typeof first === 'string' ? first : (first?.message ?? 'The org gave no reason.');
      counts.errors.push({ objectApiName, message });
    }
  }
}

/**
 * Write `records` over the org's, {@link RECORDS_PER_CALL} at a time. A call
 * the org refuses whole counts every record of it as refused, and the rest
 * still go.
 */
export async function updateRecords(
  conn: Pick<OrgSession, 'update'>,
  objectApiName: string,
  records: ReadonlyArray<Record<string, unknown>>,
): Promise<WriteCounts> {
  const counts: WriteCounts = { done: 0, failed: 0, errors: [] };
  for (let at = 0; at < records.length; at += RECORDS_PER_CALL) {
    const batch = records.slice(at, at + RECORDS_PER_CALL);
    try {
      countAnswer(await conn.update(objectApiName, [...batch]), objectApiName, counts);
    } catch (err: unknown) {
      counts.failed += batch.length;
      if (counts.errors.length < ERROR_SAMPLE_LIMIT) {
        counts.errors.push({ objectApiName, message: extractErrorMessage(err) });
      }
    }
  }
  return counts;
}

/**
 * Delete `ids`, {@link RECORDS_PER_CALL} at a time. The org sends them to its
 * recycle bin, and deletes along with them what cascades from them.
 */
export async function deleteRecords(
  conn: Pick<OrgSession, 'destroy'>,
  objectApiName: string,
  ids: readonly string[],
): Promise<WriteCounts> {
  const counts: WriteCounts = { done: 0, failed: 0, errors: [] };
  for (let at = 0; at < ids.length; at += RECORDS_PER_CALL) {
    const batch = ids.slice(at, at + RECORDS_PER_CALL);
    try {
      countAnswer(await conn.destroy(objectApiName, [...batch]), objectApiName, counts);
    } catch (err: unknown) {
      counts.failed += batch.length;
      if (counts.errors.length < ERROR_SAMPLE_LIMIT) {
        counts.errors.push({ objectApiName, message: extractErrorMessage(err) });
      }
    }
  }
  return counts;
}

/**
 * The words Seed, Sync, Restore and Anonymize already use for a write that
 * did not fully land.
 */
export function writeStatus(done: number, failed: number): RemovalOutcome['status'] {
  if (failed === 0) return 'success';
  if (done === 0) return 'failure';
  return 'partial';
}

/** The outcome of writes to several objects, summed. */
export function removalOutcome(
  perObject: ReadonlyArray<{ objectApiName: string; counts: WriteCounts }>,
): RemovalOutcome {
  const done = perObject.reduce((sum, o) => sum + o.counts.done, 0);
  const failed = perObject.reduce((sum, o) => sum + o.counts.failed, 0);
  return {
    status: writeStatus(done, failed),
    done,
    failed,
    objects: perObject.map((o) => ({
      objectApiName: o.objectApiName,
      done: o.counts.done,
      failed: o.counts.failed,
    })),
    errors: perObject.flatMap((o) => o.counts.errors).slice(0, ERROR_SAMPLE_LIMIT),
  };
}
