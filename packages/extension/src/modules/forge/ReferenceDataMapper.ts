/**
 * Maps reference-data objects (BusinessHours, OperatingHours,
 * ServiceOffer__c, …) by `Name` instead of cloning them.
 *
 * Reference data is typically deployed via metadata (or seeded once per
 * org) and shares stable names across sandboxes. Cloning these records
 * would either fail with `FIELD_INTEGRITY_EXCEPTION: Name already in use`
 * or duplicate them, so the executor instead resolves source IDs to
 * existing target IDs via a SOQL `WHERE Name IN (...)` lookup and feeds
 * the result into the IdRemapper, where downstream FKs pick it up
 * naturally.
 */

import { assertSoqlIdentifier, sanitizeSoqlValue } from '../../core/common/soqlValidator.js';

/** Mapping between source and target IDs for one reference-data row. */
export interface ReferenceDataMapping {
  sourceId: string;
  targetId: string;
  matchedBy: 'Name' | 'DeveloperName';
  matchValue: string;
}

/** Result for a whole object resolve pass. */
export interface ReferenceDataResolveResult {
  /** Resolved mappings (one per source record matched on target). */
  mappings: ReferenceDataMapping[];
  /** Source records that had no matching target row. */
  unmatched: Array<{ sourceId: string; matchValue: string | null }>;
}

/** Function signature for executing a SOQL query (one-shot). */
export type RefDataQuery = (orgId: string, soql: string) => Promise<Record<string, unknown>[]>;

/**
 * `Name` is the default match field, but a few standard objects expose
 * a more stable `DeveloperName` (RecordType-style). The mapper picks the
 * first available field per object.
 */
const DEFAULT_MATCH_FIELD: Record<string, 'Name' | 'DeveloperName'> = {
  BusinessHours: 'Name',
  OperatingHours: 'Name',
  ServiceTerritory: 'Name',
};

/**
 * Resolve reference-data rows on the target org by name match instead of
 * cloning them. Use the result via `IdRemapper.add(sourceId, targetId)`
 * so downstream lookups remap transparently.
 */
export class ReferenceDataMapper {
  constructor(private readonly query: RefDataQuery) {}

  /**
   * For a single reference-data object, look up source records' match
   * values on the target org and return the resolved mappings + the list
   * of unmatched source rows (caller decides whether to fail or fallback
   * to cloning).
   *
   * @param objectApiName  API name of the reference-data SObject.
   * @param sourceRecords  Records already pulled from the source org —
   *                       must include `Id` plus the chosen match field.
   * @param targetOrgId    Target org id used to issue the lookup query.
   * @param matchField     Override the default match field. When omitted
   *                       the mapper picks `Name` or `DeveloperName`
   *                       based on `DEFAULT_MATCH_FIELD`.
   */
  async resolve(
    objectApiName: string,
    sourceRecords: Record<string, unknown>[],
    targetOrgId: string,
    matchField?: 'Name' | 'DeveloperName',
  ): Promise<ReferenceDataResolveResult> {
    if (sourceRecords.length === 0) {
      return { mappings: [], unmatched: [] };
    }

    const field = matchField ?? DEFAULT_MATCH_FIELD[objectApiName] ?? 'Name';
    const validatedObject = assertSoqlIdentifier(objectApiName);
    const validatedField = assertSoqlIdentifier(field);

    const valueByRecord = new Map<string, string>();
    for (const r of sourceRecords) {
      const id = r['Id'];
      const value = r[field];
      if (typeof id === 'string' && typeof value === 'string' && value) {
        valueByRecord.set(id, value);
      }
    }
    if (valueByRecord.size === 0) {
      return {
        mappings: [],
        unmatched: sourceRecords
          .map((r) => ({
            sourceId: typeof r['Id'] === 'string' ? r['Id'] : '',
            matchValue: typeof r[field] === 'string' ? (r[field] as string) : null,
          }))
          .filter((u) => u.sourceId.length > 0),
      };
    }

    const inList = [...new Set(valueByRecord.values())]
      .map((v) => `'${sanitizeSoqlValue(v)}'`)
      .join(', ');
    const soql = `SELECT Id, ${validatedField} FROM ${validatedObject} WHERE ${validatedField} IN (${inList})`;
    const targetRecords = await this.query(targetOrgId, soql);

    const targetByValue = new Map<string, string>();
    for (const r of targetRecords) {
      const id = r['Id'];
      const value = r[field];
      if (typeof id === 'string' && typeof value === 'string') {
        targetByValue.set(value, id);
      }
    }

    const mappings: ReferenceDataMapping[] = [];
    const unmatched: Array<{ sourceId: string; matchValue: string | null }> = [];
    for (const [sourceId, value] of valueByRecord) {
      const targetId = targetByValue.get(value);
      if (targetId) {
        mappings.push({ sourceId, targetId, matchedBy: field, matchValue: value });
      } else {
        unmatched.push({ sourceId, matchValue: value });
      }
    }
    return { mappings, unmatched };
  }
}
