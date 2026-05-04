import type { CompareItem, CompareSeverity, DiffStatus } from '@sandforge/shared';

/** A record fetched from Salesforce for comparison */
export interface SalesforceRecord {
  [field: string]: string;
}

/** Function signature for fetching records from a Salesforce org */
export type FetchRecordsFn = (orgId: string, objectName: string) => Promise<SalesforceRecord[]>;

/**
 * Compares record-level data between two Salesforce orgs.
 * Matches records using a specified field (e.g., ExternalId__c, Name)
 * and produces CompareItems for each difference found.
 */
export class DataCompare {
  private readonly fetchRecords: FetchRecordsFn;

  constructor(fetchRecords: FetchRecordsFn) {
    this.fetchRecords = fetchRecords;
  }

  /**
   * Compare records of a given object between source and target orgs.
   * Records are matched by the specified matchField value.
   */
  async compare(
    sourceOrgId: string,
    targetOrgId: string,
    objectName: string,
    matchField: string,
  ): Promise<CompareItem[]> {
    const [sourceRecords, targetRecords] = await Promise.all([
      this.fetchRecords(sourceOrgId, objectName),
      this.fetchRecords(targetOrgId, objectName),
    ]);

    const sourceMap = indexByField(sourceRecords, matchField);
    const targetMap = indexByField(targetRecords, matchField);
    const allKeys = new Set([...sourceMap.keys(), ...targetMap.keys()]);

    const items: CompareItem[] = [];

    for (const key of allKeys) {
      const sourceRecord = sourceMap.get(key);
      const targetRecord = targetMap.get(key);

      if (sourceRecord && !targetRecord) {
        items.push(createDataItem(objectName, key, 'removed', sourceRecord, undefined));
      } else if (!sourceRecord && targetRecord) {
        items.push(createDataItem(objectName, key, 'added', undefined, targetRecord));
      } else if (sourceRecord && targetRecord) {
        const fieldDiffs = computeFieldDiffs(sourceRecord, targetRecord, matchField);
        const status: DiffStatus = fieldDiffs.length > 0 ? 'modified' : 'unchanged';
        const item = createDataItem(objectName, key, status, sourceRecord, targetRecord);
        if (fieldDiffs.length > 0) {
          item.fieldDiffs = fieldDiffs;
        }
        items.push(item);
      }
    }

    return items;
  }
}

/** Index records by a match field value */
function indexByField(
  records: SalesforceRecord[],
  matchField: string,
): Map<string, SalesforceRecord> {
  const map = new Map<string, SalesforceRecord>();
  for (const record of records) {
    const key = record[matchField];
    if (key !== undefined && key !== '') {
      map.set(key, record);
    }
  }
  return map;
}

/** Compute field-level diffs between two records, excluding the match field */
function computeFieldDiffs(
  source: SalesforceRecord,
  target: SalesforceRecord,
  matchField: string,
): CompareItem['fieldDiffs'] & object {
  const diffs: NonNullable<CompareItem['fieldDiffs']> = [];
  const allFields = new Set([...Object.keys(source), ...Object.keys(target)]);

  for (const field of allFields) {
    if (field === matchField) {
      continue;
    }

    const sourceVal = source[field] ?? '';
    const targetVal = target[field] ?? '';

    if (!(field in source)) {
      diffs.push({ fieldPath: field, sourceValue: '', targetValue: targetVal, status: 'added' });
    } else if (!(field in target)) {
      diffs.push({ fieldPath: field, sourceValue: sourceVal, targetValue: '', status: 'removed' });
    } else if (sourceVal !== targetVal) {
      diffs.push({
        fieldPath: field,
        sourceValue: sourceVal,
        targetValue: targetVal,
        status: 'modified',
      });
    }
  }

  return diffs;
}

/** Determine severity for data comparison diffs */
function determineSeverity(status: DiffStatus): CompareSeverity {
  if (status === 'added' || status === 'unchanged') {
    return 'info';
  }
  return 'warning';
}

/** Create a CompareItem for a data record diff */
function createDataItem(
  objectName: string,
  matchKey: string,
  status: DiffStatus,
  source: SalesforceRecord | undefined,
  target: SalesforceRecord | undefined,
): CompareItem {
  return {
    componentType: 'CustomObject',
    fullName: `${objectName}.${matchKey}`,
    status,
    sourceValue: source ? JSON.stringify(source) : undefined,
    targetValue: target ? JSON.stringify(target) : undefined,
    severity: determineSeverity(status),
    deployable: status !== 'unchanged',
  };
}
