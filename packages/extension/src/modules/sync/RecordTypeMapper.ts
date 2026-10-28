import * as z from 'zod';
import { logger } from '../../logger.js';
import {
  partsOfRecordTypeName,
  recordTypeMatchKey,
  recordTypeNameOf,
} from '../../core/metadata/recordTypeNames.js';

/**
 * Active record types of an org, with the object and the namespace each
 * belongs to: what {@link RecordTypeMapper.buildMapping} matches, read the
 * same way by every module that translates `RecordTypeId` between two orgs.
 */
export const RECORD_TYPES_SOQL =
  'SELECT Id, Name, DeveloperName, NamespacePrefix, SobjectType FROM RecordType WHERE IsActive = true';

/** Shape of the rows {@link RECORD_TYPES_SOQL} returns, checked before mapping. */
const recordTypeRowsSchema = z.array(
  z.object({
    Id: z.string().min(1),
    Name: z.string(),
    DeveloperName: z.string().min(1),
    NamespacePrefix: z.string().nullable().optional(),
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
    namespacePrefix: r.NamespacePrefix ? r.NamespacePrefix : null,
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
  /** The DeveloperName, without the namespace. */
  developerName: string;
  /**
   * The namespace of the package that installed it; `null` for the org's
   * own. A row read without it is matched as the org's own.
   */
  namespacePrefix?: string | null;
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
  /**
   * The name both sides share, as SandForge shows and takes it: `ns__Retail`
   * for package `ns`'s record type, `Retail` for the org's own.
   */
  developerName: string;
}

/**
 * A source record type left unmatched although the target has one of the
 * same object and DeveloperName — under another namespace, which no match
 * crosses: a package's and the org's own, or two packages'.
 */
export interface NamespaceMismatch {
  objectApiName: string;
  /** The source's, by its name (`ns__Retail`, `Retail`). */
  source: string;
  /** The target's that carry its DeveloperName, by their names. */
  target: string[];
}

/**
 * The source record types {@link RecordTypeMapper.buildMapping} leaves
 * unmatched for want of the same namespace in the target, where the target
 * has the DeveloperName under another. Matched by DeveloperName alone, such a
 * record type was written as the other one: a package's records went in with
 * the org's own record type, or the reverse, and nothing said so.
 */
export function namespaceMismatches(
  sourceTypes: readonly RecordTypeInfo[],
  targetTypes: readonly RecordTypeInfo[],
): NamespaceMismatch[] {
  const targetKeys = new Set(targetTypes.map(recordTypeMatchKey));
  const mismatches: NamespaceMismatch[] = [];
  for (const source of sourceTypes) {
    if (targetKeys.has(recordTypeMatchKey(source))) continue;
    const namesakes = targetTypes.filter(
      (t) =>
        t.developerName === source.developerName &&
        (t.sobjectType ?? '') === (source.sobjectType ?? ''),
    );
    if (namesakes.length === 0) continue;
    mismatches.push({
      objectApiName: source.sobjectType ?? '',
      source: recordTypeNameOf(source),
      target: namesakes.map(recordTypeNameOf),
    });
  }
  return mismatches;
}

/** What to say of a {@link NamespaceMismatch}: one line, with the change to make. */
export function namespaceMismatchWarning(mismatch: NamespaceMismatch): string {
  const namespacePrefix = partsOfRecordTypeName(mismatch.source).namespacePrefix;
  const whose = namespacePrefix ? `of package ${namespacePrefix}` : "the source org's own";
  return (
    `${mismatch.objectApiName}: record type ${mismatch.source}, ${whose}, is not mapped to ` +
    `${mismatch.target.join(' or ')} in the target org: a record type is matched to one of ` +
    `the same namespace only. Its records keep the source Id unless the target gets ` +
    `${mismatch.source}, or a decision maps it.`
  );
}

/**
 * Maps record types between source and target Salesforce orgs.
 * Record type IDs differ between orgs, so this service builds a mapping
 * based on object, namespace and DeveloperName (which are consistent) and
 * applies it to records.
 */
export class RecordTypeMapper {
  /**
   * Build a mapping between source and target record types, matched by
   * object, namespace and DeveloperName. Only includes types that exist in
   * both source and target.
   */
  buildMapping(sourceTypes: RecordTypeInfo[], targetTypes: RecordTypeInfo[]): RecordTypeMapping[] {
    // Keyed by object as well when it is known: Account.Business and
    // Opportunity.Business share a DeveloperName, and keying on the name alone
    // handed Account records the Opportunity record type. And by namespace: a
    // package's Account record type can carry the DeveloperName of the org's
    // own, and keyed without it the one read last took the other's place.
    const targetByKey = new Map<string, RecordTypeInfo>();
    for (const t of targetTypes) {
      targetByKey.set(recordTypeMatchKey(t), t);
    }

    const mappings: RecordTypeMapping[] = [];

    for (const source of sourceTypes) {
      const target = targetByKey.get(recordTypeMatchKey(source));
      if (target) {
        mappings.push({
          sourceId: source.id,
          targetId: target.id,
          developerName: recordTypeNameOf(source),
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
