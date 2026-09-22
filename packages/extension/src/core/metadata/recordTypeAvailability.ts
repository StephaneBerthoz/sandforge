/**
 * Whether the user a write runs as may use the record types it is about to
 * send.
 *
 * A record type can exist in the target org, be active, carry the very API
 * name the source uses — and still be refused, because the running user's
 * profile and permission sets do not grant it. The describe says so, for the
 * user who asks, in `recordTypeInfos[].available`. Nothing read it: a run
 * found out record by record, from an `INVALID_CROSS_REFERENCE_KEY` that names
 * the id and not the reason, after the parents had been written and with the
 * object's children left pointing at nothing.
 *
 * This reads the describe a writer already holds — never one more — and says,
 * before the write, which record type stops which records, and what to do.
 */

import { z } from 'zod';

/** A record type as the describe reports it for the running user. */
export interface RecordTypeAvailability {
  /** The record type's id, as the describe gives it (18 characters). */
  recordTypeId: string;
  /** API name; the label stands in on an API version that leaves it out. */
  developerName: string;
  /** Label. */
  name: string;
  /** Whether the running user may create records of this type. */
  available: boolean;
  /** Whether it is active in the org. An API version that leaves it out is read as active. */
  active: boolean;
  /** The master record type, the one a record carries when its object has no type of its own. */
  master: boolean;
  /** Whether it is the running user's default for the object. */
  defaultRecordTypeMapping: boolean;
}

/** Records of one object held back by one record type. */
export interface UnavailableRecordTypeUse {
  /** Object the records belong to. */
  objectApiName: string;
  /** The record type they carry, in the target org. */
  recordTypeId: string;
  /** Its API name. */
  developerName: string;
  /** Its label. */
  name: string;
  /**
   * The record type is inactive rather than withheld from the user: activating
   * it is the fix, not granting access.
   */
  inactive: boolean;
  /** How many of the records carry it. */
  recordCount: number;
}

/**
 * The code the messages below start with, so that a panel which translates
 * errors by their code can say what it means.
 */
export const RECORD_TYPE_UNAVAILABLE = 'RECORD_TYPE_UNAVAILABLE';

/** One entry of a describe's `recordTypeInfos`: external input, checked before it is read. */
const recordTypeInfoSchema = z
  .object({
    recordTypeId: z.string().regex(/^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/),
    developerName: z.string().min(1).optional(),
    name: z.string().optional(),
    available: z.boolean(),
    active: z.boolean().optional(),
    master: z.boolean().optional(),
    defaultRecordTypeMapping: z.boolean().optional(),
  })
  .passthrough();

/**
 * The record types of a describe, reduced to what the checks read. An entry
 * of the wrong shape is left out rather than guessed at; anything that is not
 * a list reads as no record type at all.
 *
 * @param raw - `recordTypeInfos` of a describe, as the org returned it.
 */
export function parseRecordTypeInfos(raw: unknown): RecordTypeAvailability[] {
  if (!Array.isArray(raw)) return [];
  const infos: RecordTypeAvailability[] = [];
  for (const entry of raw) {
    const parsed = recordTypeInfoSchema.safeParse(entry);
    if (!parsed.success) continue;
    const info = parsed.data;
    const name = info.name ?? info.developerName ?? info.recordTypeId;
    infos.push({
      recordTypeId: info.recordTypeId,
      developerName: info.developerName ?? name,
      name,
      available: info.available,
      active: info.active ?? true,
      master: info.master ?? false,
      defaultRecordTypeMapping: info.defaultRecordTypeMapping ?? false,
    });
  }
  return infos;
}

/**
 * Ids compared on their first fifteen characters: the case-sensitive id both
 * forms share, so a 15-character value in a record matches the 18-character
 * one of the describe.
 */
function idKey(id: string): string {
  return id.slice(0, 15);
}

/**
 * The record types among `records` the running user cannot use, with how
 * many records carry each.
 *
 * Only a record type the describe knows and reports unavailable is counted. A
 * record with no `RecordTypeId` takes the user's default and is fine; a value
 * the target does not know at all is a different fault — a type with no match
 * in the target — which the writers report on their own. The master record
 * type is left to the platform, as the record type mapping leaves it.
 *
 * @param objectApiName - The object the records belong to.
 * @param records - The payloads about to be written, `RecordTypeId` as it will be sent.
 * @param infos - The target's record types for the object, for the running user.
 */
export function findUnavailableRecordTypes(
  objectApiName: string,
  records: ReadonlyArray<Record<string, unknown>>,
  infos: readonly RecordTypeAvailability[],
): UnavailableRecordTypeUse[] {
  if (infos.length === 0) return [];
  const counts = new Map<string, number>();
  for (const record of records) {
    const value = record['RecordTypeId'];
    if (typeof value !== 'string' || value.length < 15) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return unavailableRecordTypeUses(objectApiName, counts, infos);
}

/**
 * {@link findUnavailableRecordTypes} for a writer that knows how many records
 * carry each record type without holding the records — from a `GROUP BY
 * RecordTypeId` count, for one that reads an object a page at a time.
 *
 * @param countsById - Records per `RecordTypeId`, ids in either form.
 */
export function unavailableRecordTypeUses(
  objectApiName: string,
  countsById: ReadonlyMap<string, number>,
  infos: readonly RecordTypeAvailability[],
): UnavailableRecordTypeUse[] {
  if (infos.length === 0) return [];
  const byId = new Map(infos.map((info) => [idKey(info.recordTypeId), info]));
  const uses = new Map<string, UnavailableRecordTypeUse>();
  for (const [value, count] of countsById) {
    if (value.length < 15 || count <= 0) continue;
    const info = byId.get(idKey(value));
    if (!info || info.available || info.master) continue;
    const use = uses.get(info.recordTypeId);
    if (use) {
      use.recordCount += count;
    } else {
      uses.set(info.recordTypeId, {
        objectApiName,
        recordTypeId: info.recordTypeId,
        developerName: info.developerName,
        name: info.name,
        inactive: !info.active,
        recordCount: count,
      });
    }
  }
  return [...uses.values()].sort((a, b) => a.developerName.localeCompare(b.developerName));
}

/**
 * The query that counts an object's records per record type, for a writer
 * that reads the object a page at a time and has to know every record type
 * before the first page is written.
 *
 * @param objectApiName - An object name already checked as a SOQL identifier.
 */
export function recordTypeCountSoql(objectApiName: string): string {
  return `SELECT RecordTypeId, COUNT(Id) n FROM ${objectApiName} GROUP BY RecordTypeId`;
}

/** One row of {@link recordTypeCountSoql}: external input, checked before it is read. */
const recordTypeCountRowSchema = z
  .object({ RecordTypeId: z.string().nullable(), n: z.number().int().nonnegative() })
  .passthrough();

/**
 * Records per `RecordTypeId` from the rows of {@link recordTypeCountSoql}.
 * Records with no record type, and rows of the wrong shape, are left out.
 */
export function parseRecordTypeCounts(rows: unknown): Map<string, number> {
  const counts = new Map<string, number>();
  if (!Array.isArray(rows)) return counts;
  for (const row of rows) {
    const parsed = recordTypeCountRowSchema.safeParse(row);
    if (!parsed.success || !parsed.data.RecordTypeId) continue;
    counts.set(parsed.data.RecordTypeId, parsed.data.n);
  }
  return counts;
}

/** Whether `record` carries one of the record types in `uses`. */
export function carriesRecordType(
  record: Record<string, unknown>,
  uses: readonly UnavailableRecordTypeUse[],
): boolean {
  const value = record['RecordTypeId'];
  return typeof value === 'string' && uses.some((use) => idKey(use.recordTypeId) === idKey(value));
}

/** `12 Account records`, `1 Case record`. */
function countOf(use: UnavailableRecordTypeUse): string {
  return `${use.recordCount} ${use.objectApiName} record${use.recordCount === 1 ? '' : 's'}`;
}

/** `Partner_Account (Partner Account)`, or the API name alone when the label says the same. */
function titleOf(use: UnavailableRecordTypeUse): string {
  return use.name && use.name !== use.developerName
    ? `${use.developerName} (${use.name})`
    : use.developerName;
}

/**
 * Why an object is held back and what to do about it, for a module that has
 * no fallback for a record type and does not write the object at all.
 */
export function recordTypeBlockedReason(use: UnavailableRecordTypeUse): string {
  const uses = use.recordCount === 1 ? 'uses' : 'use';
  if (use.inactive) {
    return (
      `${countOf(use)} ${uses} record type ${titleOf(use)}, which is inactive in the target ` +
      `org. Activate record type ${use.developerName} on ${use.objectApiName} in the target ` +
      `org, or map it to an active one the running user has.`
    );
  }
  return (
    `${countOf(use)} ${uses} record type ${titleOf(use)}, which the running user cannot use ` +
    `in the target org. Give the running user access to record type ${use.developerName} on ` +
    `${use.objectApiName}, or map it to one they have.`
  );
}

/** {@link recordTypeBlockedReason}, led by its code for a panel that translates errors by code. */
export function recordTypeBlockedMessage(use: UnavailableRecordTypeUse): string {
  return `${RECORD_TYPE_UNAVAILABLE}: ${recordTypeBlockedReason(use)}`;
}

/** The running user's default record type for the object, when the describe names one they may use. */
export function defaultRecordTypeOf(
  infos: readonly RecordTypeAvailability[],
): RecordTypeAvailability | undefined {
  return infos.find((info) => info.defaultRecordTypeMapping && info.available);
}

/**
 * What became of records a module wrote without their record type: the
 * platform gives a new record the running user's default, and leaves an
 * existing one's as it is.
 *
 * @param use - The record type the records carried.
 * @param fallback - The default the describe names for the running user, when it names one.
 */
export function recordTypeFallbackNote(
  use: UnavailableRecordTypeUse,
  fallback: RecordTypeAvailability | undefined,
): string {
  const given = fallback
    ? `the running user's default record type (${fallback.developerName})`
    : `the running user's default record type`;
  const reason = use.inactive
    ? 'which is inactive in the target org'
    : 'which the running user cannot use in the target org';
  const keep = use.inactive
    ? `Activate record type ${use.developerName} on ${use.objectApiName} in the target org to keep it.`
    : `Give the running user access to record type ${use.developerName} on ${use.objectApiName} to keep it.`;
  return (
    `${countOf(use)} written without record type ${titleOf(use)}, ${reason}: a new record ` +
    `took ${given}, an existing one kept its own. ${keep}`
  );
}
