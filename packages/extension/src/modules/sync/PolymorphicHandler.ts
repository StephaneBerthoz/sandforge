/** Known polymorphic lookup fields in Salesforce */
const POLYMORPHIC_FIELDS: ReadonlySet<string> = new Set([
  'WhoId',
  'WhatId',
  'OwnerId',
  'RelatedToId',
  'ParentId',
  'TaskWhoIds',
  'EventWhoIds',
]);

/** Prefix-to-object mapping for Salesforce ID prefixes */
const ID_PREFIX_MAP: Readonly<Record<string, string>> = {
  '001': 'Account',
  '003': 'Contact',
  '00Q': 'Lead',
  '006': 'Opportunity',
  '500': 'Case',
  '00T': 'Task',
  '00U': 'Event',
  '005': 'User',
  '01I': 'Campaign',
};

/**
 * Handles polymorphic lookup fields (WhoId, WhatId, OwnerId, etc.)
 * in Salesforce records. Resolves polymorphic references to their
 * correct target object type based on ID prefix conventions.
 */
export class PolymorphicHandler {
  /**
   * Resolve polymorphic field values in a set of records.
   * Adds a `{fieldName}Type` field indicating the resolved object type.
   * Filters records to only include those matching the specified objectType.
   */
  resolve(
    fieldName: string,
    objectType: string,
    records: Record<string, unknown>[],
  ): Record<string, unknown>[] {
    const typeFieldName = `${fieldName}Type`;

    return records
      .map((record) => {
        const value = record[fieldName];
        if (typeof value !== 'string' || value.length < 3) {
          return null;
        }

        const prefix = value.substring(0, 3);
        const resolvedType = ID_PREFIX_MAP[prefix] ?? 'Unknown';

        if (resolvedType !== objectType) {
          return null;
        }

        return {
          ...record,
          [typeFieldName]: resolvedType,
        };
      })
      .filter((r): r is Record<string, unknown> => r !== null);
  }

  /**
   * Check whether a field name is a known polymorphic lookup field.
   */
  isPolymorphic(fieldName: string): boolean {
    return POLYMORPHIC_FIELDS.has(fieldName);
  }
}
