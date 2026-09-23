import { z } from 'zod';
import { logger } from '../../logger.js';

/**
 * Active record types of an org, with the object each belongs to: what
 * {@link RecordTypeMapper.buildMapping} matches, read the same way by every
 * module that translates `RecordTypeId` between two orgs.
 */
export const RECORD_TYPES_SOQL =
  'SELECT Id, Name, DeveloperName, SobjectType FROM RecordType WHERE IsActive = true';

/** Shape of the rows {@link RECORD_TYPES_SOQL} returns, checked before mapping. */
const recordTypeRowsSchema = z.array(
  z.object({
    Id: z.string().min(1),
    Name: z.string(),
    DeveloperName: z.string().min(1),
    SobjectType: z.string().min(1),
  }),
);

/**
 * The record types in the rows of {@link RECORD_TYPES_SOQL}.
 *
 * @throws {z.ZodError} When a row is not the shape the query returns.
 */
export function parseRecordTypeRows(rows: unknown): RecordTypeInfo[] {
  return recordTypeRowsSchema.parse(rows).map((r) => ({
    id: r.Id,
    name: r.Name,
    developerName: r.DeveloperName,
    sobjectType: r.SobjectType,
  }));
}

/**
 * The master record type: an object with no record type of its own stores
 * this Id, 15 or 18 characters, and it is the same in every org. It never
 * appears in the RecordType table, so it is never in a mapping either.
 */
const MASTER_RECORD_TYPE_ID_RE = /^012000000000000(AAA)?$/;

/**
 * Log a RecordTypeId that has no counterpart on the target org. The record
 * keeps the source Id, so its insert is refused with an error that names the
 * field but not why the value was wrong; this line in the output is the link.
 */
export function warnUnmappedRecordType(
  objectApiName: string,
  recordTypeId: string,
  module = 'forge',
): void {
  logger.warn(
    `[${module}] ${objectApiName}: RecordTypeId ${recordTypeId} has no active ${objectApiName} ` +
      `record type with the same API name on the target org. Records keep the source Id and ` +
      `the target org will likely refuse them — create or activate that record type on the target.`,
  );
}

/** Record type information from a Salesforce org */
export interface RecordTypeInfo {
  id: string;
  name: string;
  developerName: string;
  /**
   * Object the record type belongs to (`RecordType.SobjectType`). A
   * DeveloperName is unique per object, not per org, so when both sides carry
   * it the match is made within the object.
   */
  sobjectType?: string;
}

/** Mapping between source and target record type IDs */
export interface RecordTypeMapping {
  sourceId: string;
  targetId: string;
  developerName: string;
}

/**
 * Maps record types between source and target Salesforce orgs.
 * Record type IDs differ between orgs, so this service builds a mapping
 * based on developerName (which is consistent) and applies it to records.
 */
export class RecordTypeMapper {
  /**
   * Build a mapping between source and target record types.
   * Matches by developerName, which is consistent across orgs.
   * Only includes types that exist in both source and target.
   */
  buildMapping(sourceTypes: RecordTypeInfo[], targetTypes: RecordTypeInfo[]): RecordTypeMapping[] {
    // Keyed by object as well when it is known: Account.Business and
    // Opportunity.Business share a DeveloperName, and keying on the name alone
    // handed Account records the Opportunity record type.
    const matchKey = (t: RecordTypeInfo): string => `${t.sobjectType ?? ''}::${t.developerName}`;
    const targetByDevName = new Map<string, RecordTypeInfo>();
    for (const t of targetTypes) {
      targetByDevName.set(matchKey(t), t);
    }

    const mappings: RecordTypeMapping[] = [];

    for (const source of sourceTypes) {
      const target = targetByDevName.get(matchKey(source));
      if (target) {
        mappings.push({
          sourceId: source.id,
          targetId: target.id,
          developerName: source.developerName,
        });
      }
    }

    return mappings;
  }

  /**
   * Apply record type mappings to a set of records.
   * Replaces RecordTypeId values with the corresponding target org ID.
   * Records with unmapped RecordTypeId values are left unchanged.
   *
   * @param onUnmapped - Called once per distinct RecordTypeId that has no
   *   mapping. Such a record still carries the source org's Id, which the
   *   target org rejects; without this the insert failed later with nothing
   *   pointing back at the record type.
   */
  apply(
    records: Record<string, unknown>[],
    mappings: RecordTypeMapping[],
    onUnmapped?: (sourceRecordTypeId: string) => void,
  ): Record<string, unknown>[] {
    const mappingBySourceId = new Map<string, string>();
    for (const m of mappings) {
      mappingBySourceId.set(m.sourceId, m.targetId);
    }
    const reported = new Set<string>();

    return records.map((record) => {
      const recordTypeId = record.RecordTypeId;
      if (typeof recordTypeId !== 'string' || MASTER_RECORD_TYPE_ID_RE.test(recordTypeId)) {
        return { ...record };
      }

      const targetId = mappingBySourceId.get(recordTypeId);
      if (!targetId) {
        if (onUnmapped && !reported.has(recordTypeId)) {
          reported.add(recordTypeId);
          onUnmapped(recordTypeId);
        }
        return { ...record };
      }

      return {
        ...record,
        RecordTypeId: targetId,
      };
    });
  }
}
