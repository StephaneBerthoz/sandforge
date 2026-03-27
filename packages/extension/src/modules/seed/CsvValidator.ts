import type { CsvColumnMapping, CsvValidationError, CsvValidationResult } from '@sandforge/shared';
import type { DescribeField } from './SchemaAnalyzer.js';

/** Maximum number of errors to collect before stopping validation. */
const MAX_ERRORS = 100;

/** Salesforce field types that represent numeric values. */
const NUMERIC_TYPES = new Set(['double', 'currency', 'percent', 'int', 'integer']);

/**
 * Validates CSV records against Salesforce field metadata.
 *
 * Checks for type mismatches, missing required fields, length violations,
 * invalid picklist values, and duplicate external IDs. Error collection
 * is capped at {@link MAX_ERRORS} to avoid memory issues on large files.
 */
export class CsvValidator {
  /**
   * Validate an array of CSV records against Salesforce field describe metadata.
   *
   * Validation rules applied per record per mapped column:
   * 1. **Type mismatch** -- numeric field with non-parseable value.
   * 2. **Missing required** -- non-nillable field with no default and empty value.
   * 3. **Length exceeded** -- value longer than field's `length` attribute.
   * 4. **Invalid picklist** -- value not in the field's picklist values (case-sensitive).
   *
   * Additionally, if `externalIdField` is provided, checks for duplicate values across all rows.
   *
   * @param records - Array of CSV rows as key-value objects (string values).
   * @param columnMappings - Mappings from CSV headers to Salesforce fields.
   * @param describeFields - Salesforce field metadata from describe call.
   * @param externalIdField - Optional external ID field to check for duplicates.
   * @returns Validation result with all errors found (capped at 100).
   */
  validate(
    records: Record<string, string>[],
    columnMappings: CsvColumnMapping[],
    describeFields: DescribeField[],
    externalIdField?: string,
  ): CsvValidationResult {
    const errors: CsvValidationError[] = [];
    const fieldMap = new Map(describeFields.map((f) => [f.name, f]));

    // Per-row, per-column validation
    for (let rowIndex = 0; rowIndex < records.length && errors.length < MAX_ERRORS; rowIndex++) {
      const record = records[rowIndex];

      for (const mapping of columnMappings) {
        if (errors.length >= MAX_ERRORS) break;
        if (!mapping.sfFieldApiName) continue;

        const field = fieldMap.get(mapping.sfFieldApiName);
        if (!field) continue;

        const value = record[mapping.csvHeader] ?? '';

        // Missing required
        if (value === '' && !field.nillable && field.defaultValue === null) {
          errors.push({
            row: rowIndex + 1,
            column: mapping.csvHeader,
            field: mapping.sfFieldApiName,
            errorType: 'missing_required',
            message: `Required field "${mapping.sfFieldApiName}" is empty`,
            value,
          });
          continue;
        }

        if (value === '') continue;

        // Type mismatch for numeric fields
        if (NUMERIC_TYPES.has(field.type.toLowerCase())) {
          const parsed = parseFloat(value);
          if (isNaN(parsed)) {
            errors.push({
              row: rowIndex + 1,
              column: mapping.csvHeader,
              field: mapping.sfFieldApiName,
              errorType: 'type_mismatch',
              message: `Expected numeric value for field "${mapping.sfFieldApiName}", got "${value}"`,
              value,
            });
          }
        }

        // Length exceeded
        if (field.length && field.length > 0 && value.length > field.length) {
          errors.push({
            row: rowIndex + 1,
            column: mapping.csvHeader,
            field: mapping.sfFieldApiName,
            errorType: 'length_exceeded',
            message: `Value exceeds max length ${field.length} for field "${mapping.sfFieldApiName}" (got ${value.length})`,
            value,
          });
        }

        // Invalid picklist
        if (
          field.type.toLowerCase() === 'picklist' &&
          field.picklistValues &&
          field.picklistValues.length > 0
        ) {
          const validValues = field.picklistValues.map((pv) => pv.value);
          if (!validValues.includes(value)) {
            errors.push({
              row: rowIndex + 1,
              column: mapping.csvHeader,
              field: mapping.sfFieldApiName,
              errorType: 'invalid_picklist',
              message: `Invalid picklist value "${value}" for field "${mapping.sfFieldApiName}"`,
              value,
            });
          }
        }
      }
    }

    // Duplicate external ID check
    if (externalIdField && errors.length < MAX_ERRORS) {
      const extMapping = columnMappings.find((m) => m.sfFieldApiName === externalIdField);
      if (extMapping) {
        const seen = new Map<string, number>();
        for (let rowIndex = 0; rowIndex < records.length && errors.length < MAX_ERRORS; rowIndex++) {
          const value = records[rowIndex][extMapping.csvHeader] ?? '';
          if (value === '') continue;

          const prevRow = seen.get(value);
          if (prevRow !== undefined) {
            errors.push({
              row: rowIndex + 1,
              column: extMapping.csvHeader,
              field: externalIdField,
              errorType: 'duplicate_external_id',
              message: `Duplicate external ID "${value}" (also in row ${prevRow})`,
              value,
            });
          } else {
            seen.set(value, rowIndex + 1);
          }
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warningCount: 0,
    };
  }
}
