import type { SfFieldType } from '@sandforge/shared';

/** Describes a field for type compatibility checks */
export interface FieldDescriptor {
  /** Salesforce API name of the field */
  apiName: string;
  /** Salesforce field data type */
  type: string;
  /** Maximum string length (optional, for string-like types) */
  maxLength?: number;
}

/** Describes a target field with additional constraints for record validation */
export interface TargetFieldDescriptor extends FieldDescriptor {
  /** Whether the field is required */
  required?: boolean;
  /** Allowed picklist values */
  picklistValues?: string[];
}

/** Result of checking compatibility between a source and target field */
export interface FieldCompatibility {
  /** Source field API name */
  sourceField: string;
  /** Source field type */
  sourceType: string;
  /** Target field API name */
  targetField: string;
  /** Target field type */
  targetType: string;
  /** Whether the types are compatible */
  compatible: boolean;
  /** Explanation if incompatible, or warning message */
  reason?: string;
}

/** Result of validating field mappings */
export interface FieldValidationResult {
  /** Whether all mappings are valid (no errors) */
  valid: boolean;
  /** Incompatible type mappings (blocking errors) */
  errors: FieldCompatibility[];
  /** Lossy or ambiguous type mappings (non-blocking) */
  warnings: FieldCompatibility[];
}

/** Result of validating record values against target fields */
export interface RecordValidationResult {
  /** Whether all records passed validation */
  valid: boolean;
  /** List of validation errors */
  errors: RecordValidationError[];
}

/** A single record-level validation error */
export interface RecordValidationError {
  /** Zero-based index of the record in the input array */
  recordIndex: number;
  /** Field that failed validation */
  field: string;
  /** Human-readable error message */
  message: string;
}

/**
 * Type compatibility matrix.
 * Maps a source field type to the set of compatible target field types.
 * If a type is not listed, it is only compatible with itself and 'string'.
 */
const COMPATIBLE_TYPES: Record<string, Set<string>> = {
  string: new Set([
    'string',
    'textarea',
    'richtext',
    'phone',
    'email',
    'url',
    'picklist',
    'multipicklist',
    'encryptedstring',
  ]),
  int: new Set(['int', 'double', 'currency', 'percent', 'string']),
  double: new Set(['double', 'currency', 'percent', 'string']),
  currency: new Set(['currency', 'double', 'string']),
  percent: new Set(['percent', 'double', 'string']),
  boolean: new Set(['boolean', 'string']),
  date: new Set(['date', 'datetime', 'string']),
  datetime: new Set(['datetime', 'date', 'string']),
  id: new Set(['id', 'reference', 'string']),
  reference: new Set(['reference', 'id', 'string']),
  picklist: new Set(['picklist', 'string', 'multipicklist']),
  multipicklist: new Set(['multipicklist', 'string']),
  phone: new Set(['phone', 'string']),
  email: new Set(['email', 'string']),
  url: new Set(['url', 'string']),
  textarea: new Set(['textarea', 'richtext', 'string']),
  richtext: new Set(['richtext', 'textarea', 'string']),
  time: new Set(['time', 'string']),
  base64: new Set(['base64', 'string']),
  address: new Set(['address']),
  location: new Set(['location']),
};

/**
 * Types where source-to-target conversion may lose data.
 * These produce warnings rather than errors.
 */
const LOSSY_CONVERSIONS: Array<{ source: string; target: string; reason: string }> = [
  { source: 'double', target: 'int', reason: 'Decimal portion will be truncated' },
  { source: 'datetime', target: 'date', reason: 'Time portion will be lost' },
  { source: 'richtext', target: 'textarea', reason: 'HTML formatting will be lost' },
  { source: 'multipicklist', target: 'picklist', reason: 'Multiple selections may be lost' },
];

/**
 * Validates field type compatibility between source and target schemas,
 * and validates record values against target field constraints.
 */
export class FieldTypeValidator {
  /**
   * Validate type compatibility for a set of field mappings.
   * Each mapping maps a source field name to a target field name.
   */
  validateMapping(
    sourceFields: FieldDescriptor[],
    targetFields: FieldDescriptor[],
    fieldMapping: Record<string, string>,
  ): FieldValidationResult {
    const errors: FieldCompatibility[] = [];
    const warnings: FieldCompatibility[] = [];

    const sourceByName = new Map(sourceFields.map((f) => [f.apiName, f]));
    const targetByName = new Map(targetFields.map((f) => [f.apiName, f]));

    for (const [sourceFieldName, targetFieldName] of Object.entries(fieldMapping)) {
      const sourceField = sourceByName.get(sourceFieldName);
      const targetField = targetByName.get(targetFieldName);

      if (!sourceField || !targetField) {
        continue;
      }

      const compatibility = this.checkTypeCompatibility(
        sourceFieldName,
        sourceField.type,
        targetFieldName,
        targetField.type,
      );

      if (!compatibility.compatible) {
        errors.push(compatibility);
      } else if (compatibility.reason) {
        warnings.push(compatibility);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Validate record values against target field definitions.
   * Checks types, lengths, required fields, and picklist values.
   */
  validateRecords(
    records: Record<string, unknown>[],
    targetFields: TargetFieldDescriptor[],
  ): RecordValidationResult {
    const errors: RecordValidationError[] = [];

    for (let i = 0; i < records.length; i++) {
      const record = records[i];

      for (const field of targetFields) {
        const value = record[field.apiName];

        if (field.required && isEmptyValue(value)) {
          errors.push({
            recordIndex: i,
            field: field.apiName,
            message: `Required field '${field.apiName}' is missing or empty`,
          });
          continue;
        }

        if (isEmptyValue(value)) {
          continue;
        }

        const typeError = this.validateValueType(value, field);
        if (typeError) {
          errors.push({ recordIndex: i, field: field.apiName, message: typeError });
          continue;
        }

        if (field.maxLength !== undefined && typeof value === 'string') {
          if (value.length > field.maxLength) {
            errors.push({
              recordIndex: i,
              field: field.apiName,
              message: `Value exceeds max length of ${field.maxLength} (got ${value.length})`,
            });
          }
        }

        if (field.picklistValues && field.picklistValues.length > 0) {
          const strValue = String(value);
          if (!field.picklistValues.includes(strValue)) {
            errors.push({
              recordIndex: i,
              field: field.apiName,
              message: `Value '${strValue}' is not a valid picklist value. Allowed: ${field.picklistValues.join(', ')}`,
            });
          }
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Check if two field types are compatible.
   * Returns a FieldCompatibility with compatible=true/false and an optional reason.
   */
  private checkTypeCompatibility(
    sourceField: string,
    sourceType: string,
    targetField: string,
    targetType: string,
  ): FieldCompatibility {
    const normalizedSource = sourceType.toLowerCase() as SfFieldType;
    const normalizedTarget = targetType.toLowerCase() as SfFieldType;

    if (normalizedSource === normalizedTarget) {
      return {
        sourceField,
        sourceType,
        targetField,
        targetType,
        compatible: true,
      };
    }

    const allowed = COMPATIBLE_TYPES[normalizedSource];
    const compatible = allowed ? allowed.has(normalizedTarget) : normalizedTarget === 'string';

    const lossy = LOSSY_CONVERSIONS.find(
      (l) => l.source === normalizedSource && l.target === normalizedTarget,
    );

    return {
      sourceField,
      sourceType,
      targetField,
      targetType,
      compatible,
      reason: compatible
        ? lossy?.reason
        : `Type '${sourceType}' is not compatible with '${targetType}'`,
    };
  }

  /**
   * Validate that a value matches the expected field type.
   * Returns an error message if invalid, or undefined if valid.
   */
  private validateValueType(value: unknown, field: TargetFieldDescriptor): string | undefined {
    const type = field.type.toLowerCase();

    switch (type) {
      case 'boolean':
        if (typeof value !== 'boolean') {
          return `Expected boolean but got ${typeof value}`;
        }
        break;
      case 'int':
        if (typeof value !== 'number' || !Number.isInteger(value)) {
          return `Expected integer but got ${typeof value === 'number' ? 'float' : typeof value}`;
        }
        break;
      case 'double':
      case 'currency':
      case 'percent':
        if (typeof value !== 'number') {
          return `Expected number but got ${typeof value}`;
        }
        break;
      case 'date':
      case 'datetime':
        if (typeof value !== 'string' || !isValidDateString(value)) {
          return `Expected valid ${type} string`;
        }
        break;
    }

    return undefined;
  }
}

/** Check if a value is null, undefined, or empty string */
function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

/** Basic date string validation (ISO 8601 format) */
function isValidDateString(value: string): boolean {
  const parsed = Date.parse(value);
  return !isNaN(parsed);
}
