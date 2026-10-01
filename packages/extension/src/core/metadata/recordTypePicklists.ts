/**
 * What a record type allows of an object's picklists, as the org's UI API
 * says it — the one source that does.
 *
 * The describe lists the active values of a picklist field once, for every
 * record type of the object. A record type keeps a subset of them, and a
 * restricted picklist refuses at insert a value the record's type does not
 * keep, active as it may be: `INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad
 * value for restricted picklist field`. Only the UI API answers per record
 * type: the values it keeps, its default for the field, and for a dependent
 * picklist the values each value of the controlling field allows.
 *
 * It misses one case, which no read before a write tells: a record type never
 * given values of a field takes none of them, and the UI API answers the
 * field's every value for it all the same. The record type's metadata (Tooling
 * API `RecordType.Metadata.picklistValues`) holds no entry for such a field —
 * and at times none either for a field whose values the record type does take,
 * so it cannot tell the two apart. A real run was refused so on every row of an
 * object; Forge writes a row refused for its value again without the field
 * (`BatchWriter.fieldsToLeaveOut`).
 *
 * One request answers every picklist field of a record type —
 * `ui-api/object-info/{object}/picklist-values/{recordTypeId}` — and one more
 * path segment narrows it to a field. Both answers are external input, read
 * only once checked.
 */

import { z } from 'zod';

/** The part of a jsforce connection a read goes through. */
export interface UiApiConnection {
  /** The REST API version the connection speaks, `66.0`. */
  readonly version: string;
  /** Send a GET to a path of the org's REST API and hand back its JSON. */
  request<T>(url: string): Promise<T>;
}

/** What one record type allows of one picklist field. */
export interface RecordTypePicklist {
  /** The values the record type keeps, in the order the org lists them. */
  readonly values: readonly string[];
  /** The record type's default for the field, or `null` when it sets none. */
  readonly defaultValue: string | null;
  /**
   * For a dependent picklist, the values each value of its controlling field
   * allows, keyed by that value as the UI API writes it — `true` and `false`
   * for a checkbox. Absent when the field depends on none.
   */
  readonly allowedByControllingValue?: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * What a record type allows of each picklist field the answer covers. A field
 * it leaves out — one the running user cannot see, or one the UI API does not
 * serve — is not in it, and nothing is known of it.
 */
export type RecordTypePicklists = ReadonlyMap<string, RecordTypePicklist>;

/** One value of a picklist, as the UI API lists it. */
const picklistValueSchema = z
  .object({
    value: z.string(),
    /** Indices, into `controllerValues`, of the controlling values that allow it. */
    validFor: z.array(z.number().int().nonnegative()).optional(),
  })
  .loose();

/** A picklist field's values for one record type: the UI API's Picklist Values. */
const picklistValuesSchema = z
  .object({
    controllerValues: z.record(z.string(), z.number().int().nonnegative()).optional(),
    defaultValue: picklistValueSchema.nullable().optional(),
    values: z.array(picklistValueSchema),
  })
  .loose();

/** Every picklist field of one record type: the UI API's Picklist Values Collection. */
const picklistValuesCollectionSchema = z
  .object({ picklistFieldValues: z.record(z.string(), z.unknown()) })
  .loose();

/** An API name the path may carry: an object's or a field's. */
const API_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
/** A record type id, in either of its forms. */
const RECORD_TYPE_ID_RE = /^012[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/;

function toRecordTypePicklist(entry: z.infer<typeof picklistValuesSchema>): RecordTypePicklist {
  const values = entry.values.map((v) => v.value);
  const defaultValue = entry.defaultValue?.value ?? null;
  const controllers = Object.entries(entry.controllerValues ?? {});
  if (controllers.length === 0) return { values, defaultValue };
  const allowedByControllingValue = new Map<string, ReadonlySet<string>>();
  for (const [controlling, index] of controllers) {
    allowedByControllingValue.set(
      controlling,
      new Set(entry.values.filter((v) => (v.validFor ?? []).includes(index)).map((v) => v.value)),
    );
  }
  return { values, defaultValue, allowedByControllingValue };
}

/**
 * What a record type allows of each picklist field, from the answer of
 * `picklist-values/{recordTypeId}`. A field whose entry is not the shape the
 * UI API gives is left out rather than guessed at.
 *
 * @throws {z.ZodError} When the answer is not a collection of picklist values.
 */
export function parseRecordTypePicklists(raw: unknown): RecordTypePicklists {
  const collection = picklistValuesCollectionSchema.parse(raw);
  const picklists = new Map<string, RecordTypePicklist>();
  for (const [field, entry] of Object.entries(collection.picklistFieldValues)) {
    const parsed = picklistValuesSchema.safeParse(entry);
    if (parsed.success) picklists.set(field, toRecordTypePicklist(parsed.data));
  }
  return picklists;
}

/**
 * The values a record type keeps of one field, from the answer of
 * `picklist-values/{recordTypeId}/{field}`.
 *
 * @throws {z.ZodError} When the answer is not a field's picklist values.
 */
export function parsePicklistFieldValues(raw: unknown): string[] {
  return picklistValuesSchema.parse(raw).values.map((v) => v.value);
}

/** The UI API path of a record type's picklist values, or of one field's. */
function picklistValuesPath(
  conn: UiApiConnection,
  objectApiName: string,
  recordTypeId: string,
  fieldApiName?: string,
): string {
  // Each segment is checked before it goes into the path: what names an
  // object or a field is an identifier, and a record type is an id.
  for (const name of fieldApiName === undefined ? [objectApiName] : [objectApiName, fieldApiName]) {
    if (!API_NAME_RE.test(name)) throw new Error(`Not an API name: "${name}"`);
  }
  if (!RECORD_TYPE_ID_RE.test(recordTypeId)) {
    throw new Error(`Not a record type id: "${recordTypeId}"`);
  }
  const path = `/services/data/v${conn.version}/ui-api/object-info/${objectApiName}/picklist-values/${recordTypeId}`;
  return fieldApiName === undefined ? path : `${path}/${fieldApiName}`;
}

/**
 * What one record type of an object allows of every picklist field, in one
 * request.
 *
 * @throws When the org refuses the request, or answers with something else.
 */
export async function readRecordTypePicklists(
  conn: UiApiConnection,
  objectApiName: string,
  recordTypeId: string,
): Promise<RecordTypePicklists> {
  return parseRecordTypePicklists(
    await conn.request<unknown>(picklistValuesPath(conn, objectApiName, recordTypeId)),
  );
}

/**
 * The values one record type of an object keeps of one picklist field.
 *
 * @throws When the org refuses the request, or answers with something else.
 */
export async function readPicklistFieldValues(
  conn: UiApiConnection,
  objectApiName: string,
  recordTypeId: string,
  fieldApiName: string,
): Promise<string[]> {
  return parsePicklistFieldValues(
    await conn.request<unknown>(
      picklistValuesPath(conn, objectApiName, recordTypeId, fieldApiName),
    ),
  );
}
