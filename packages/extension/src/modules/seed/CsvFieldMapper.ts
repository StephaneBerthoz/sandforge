import type { CsvColumnMapping } from '@sandforge/shared';
import type { DescribeField } from './SchemaAnalyzer.js';

/** Set of field names that are never createable and should be excluded from mapping. */
const NON_CREATEABLE_FIELDS = new Set([
  'id',
  'createddate',
  'createdbyid',
  'lastmodifieddate',
  'lastmodifiedbyid',
  'systemmodstamp',
  'isdeleted',
]);

/**
 * Maps CSV column headers to Salesforce fields using describe metadata.
 *
 * Supports exact, case-insensitive, and underscore/space-tolerant matching.
 * Non-createable system fields are always excluded from mapping results.
 */
export class CsvFieldMapper {
  /**
   * Normalize a string for fuzzy matching: lowercase, strip underscores, spaces, and `__c` suffix.
   */
  private normalize(value: string): string {
    return value.toLowerCase().replace(/__c$/i, '').replace(/[_ ]/g, '');
  }

  /**
   * Auto-map CSV column headers to Salesforce fields.
   *
   * Matching strategy (per CSV header):
   * 1. Exact match on field `name` (case-insensitive).
   * 2. Exact match on field `label` (case-insensitive).
   * 3. Normalized match (strip underscores/spaces/__c, lowercase) on `name` or `label`.
   *
   * Non-createable system fields (Id, CreatedDate, etc.) are always excluded.
   *
   * @param csvHeaders - Array of column header strings from the CSV file.
   * @param describeFields - Salesforce field describe metadata for the target object.
   * @returns Array of column mappings; unmapped columns have `sfFieldApiName: ''`.
   */
  autoMapColumns(csvHeaders: string[], describeFields: DescribeField[]): CsvColumnMapping[] {
    const createableFields = describeFields.filter(
      (f) => !NON_CREATEABLE_FIELDS.has(f.name.toLowerCase()),
    );

    return csvHeaders.map((header) => {
      const headerLower = header.toLowerCase();
      const headerNormalized = this.normalize(header);

      // 1. Exact name match (case-insensitive)
      let matched = createableFields.find((f) => f.name.toLowerCase() === headerLower);

      // 2. Exact label match (case-insensitive)
      if (!matched) {
        matched = createableFields.find((f) => f.label.toLowerCase() === headerLower);
      }

      // 3. Normalized match on name or label
      if (!matched) {
        matched = createableFields.find(
          (f) =>
            this.normalize(f.name) === headerNormalized ||
            this.normalize(f.label) === headerNormalized,
        );
      }

      if (matched) {
        return {
          csvHeader: header,
          sfFieldApiName: matched.name,
          sfFieldType: matched.type,
          sfFieldLength: matched.length ?? null,
        };
      }

      return {
        csvHeader: header,
        sfFieldApiName: '',
        sfFieldType: '',
        sfFieldLength: null,
      };
    });
  }

  /**
   * Convert a CSV string value to the appropriate JavaScript type based on the Salesforce field type.
   *
   * - Numeric types (`double`, `currency`, `percent`, `int`) -> parsed number or `null` if NaN.
   * - `boolean` -> `true`/`false` based on value.
   * - `date` -> validated ISO date string or `null`.
   * - `datetime` -> validated ISO datetime string or `null`.
   * - Empty string -> `null`.
   * - All others -> string as-is.
   *
   * @param value - The raw string value from the CSV.
   * @param sfFieldType - The Salesforce field type string.
   * @returns The converted value.
   */
  convertValue(value: string, sfFieldType: string): unknown {
    if (value === '') return null;

    const typeLower = sfFieldType.toLowerCase();

    switch (typeLower) {
      case 'int':
      case 'integer': {
        const parsed = parseInt(value, 10);
        return isNaN(parsed) ? null : parsed;
      }
      case 'double':
      case 'currency':
      case 'percent': {
        const parsed = parseFloat(value);
        return isNaN(parsed) ? null : parsed;
      }
      case 'boolean':
        return value.toLowerCase() === 'true' || value === '1';
      case 'date': {
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        return dateRegex.test(value) ? value : null;
      }
      case 'datetime': {
        const dtRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
        return dtRegex.test(value) ? value : null;
      }
      default:
        return value;
    }
  }
}
