import type { SeedObjectConfig } from '@sandforge/shared';

/** Information about a Salesforce record type */
export interface RecordTypeInfo {
  id: string;
  name: string;
  developerName: string;
  isDefault: boolean;
}

/**
 * Generates records with appropriate RecordTypeId distribution.
 * Distributes records across available record types proportionally
 * or uses a single record type when specified in the config.
 */
export class RecordTypeAwareSeed {
  /**
   * Generate records for the given object config, distributing them
   * across the provided record types.
   *
   * If the config specifies a recordTypeId, all records use that type.
   * Otherwise, records are distributed evenly across all record types
   * with any remainder allocated to the default or first record type.
   */
  generate(
    objectConfig: SeedObjectConfig,
    recordTypes: RecordTypeInfo[]
  ): Record<string, unknown>[] {
    const { recordCount } = objectConfig;

    if (recordCount <= 0) {
      return [];
    }

    if (recordTypes.length === 0) {
      return createRecordsWithoutRecordType(recordCount);
    }

    if (objectConfig.recordTypeId) {
      return createRecordsWithSingleType(recordCount, objectConfig.recordTypeId);
    }

    return distributeAcrossRecordTypes(recordCount, recordTypes);
  }
}

/** Create records with no RecordTypeId set */
function createRecordsWithoutRecordType(count: number): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    records.push({});
  }
  return records;
}

/** Create records all using a single record type */
function createRecordsWithSingleType(
  count: number,
  recordTypeId: string
): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    records.push({ RecordTypeId: recordTypeId });
  }
  return records;
}

/**
 * Distribute records evenly across record types.
 * Remainder records go to the default record type (or the first one).
 */
function distributeAcrossRecordTypes(
  count: number,
  recordTypes: RecordTypeInfo[]
): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const perType = Math.floor(count / recordTypes.length);
  const remainder = count % recordTypes.length;

  const defaultType = recordTypes.find((rt) => rt.isDefault) ?? recordTypes[0];

  for (const rt of recordTypes) {
    const typeCount = rt.id === defaultType.id ? perType + remainder : perType;
    for (let i = 0; i < typeCount; i++) {
      records.push({ RecordTypeId: rt.id });
    }
  }

  return records;
}
