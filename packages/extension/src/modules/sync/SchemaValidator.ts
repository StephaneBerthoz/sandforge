/** Schema definition for a single field */
export interface FieldSchema {
  apiName: string;
  type: string;
  required: boolean;
  maxLength?: number;
  picklistValues?: string[];
}

/** Validation error for a specific record field */
export interface SchemaError {
  recordIndex: number;
  fieldName: string;
  message: string;
}

/** Result of schema validation */
export interface SchemaValidationResult {
  valid: boolean;
  errors: SchemaError[];
}

/**
 * Validates source data records against a target Salesforce schema.
 * Checks for required fields, max length constraints, picklist values,
 * and basic type compatibility.
 */
export class SchemaValidator {
  /**
   * Validate an array of records against a field schema definition.
   * Returns a result indicating whether all records are valid,
   * and a list of specific errors for invalid records.
   */
  validate(records: Record<string, unknown>[], schema: FieldSchema[]): SchemaValidationResult {
    const errors: SchemaError[] = [];

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      const recordErrors = validateRecord(record, schema, i);
      errors.push(...recordErrors);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

/**
 * Validate a single record against the schema.
 */
function validateRecord(
  record: Record<string, unknown>,
  schema: FieldSchema[],
  recordIndex: number,
): SchemaError[] {
  const errors: SchemaError[] = [];

  for (const field of schema) {
    const value = record[field.apiName];

    if (field.required && isEmptyValue(value)) {
      errors.push({
        recordIndex,
        fieldName: field.apiName,
        message: `Required field '${field.apiName}' is missing or empty`,
      });
      continue;
    }

    if (isEmptyValue(value)) {
      continue;
    }

    const lengthError = validateLength(value, field, recordIndex);
    if (lengthError) {
      errors.push(lengthError);
    }

    const picklistError = validatePicklist(value, field, recordIndex);
    if (picklistError) {
      errors.push(picklistError);
    }

    const typeError = validateType(value, field, recordIndex);
    if (typeError) {
      errors.push(typeError);
    }
  }

  return errors;
}

/**
 * Check if a value is considered empty (null, undefined, or empty string).
 */
function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

/**
 * Validate that a string value does not exceed the field's max length.
 */
function validateLength(
  value: unknown,
  field: FieldSchema,
  recordIndex: number,
): SchemaError | null {
  if (field.maxLength === undefined) {
    return null;
  }

  const strValue = String(value);
  if (strValue.length > field.maxLength) {
    return {
      recordIndex,
      fieldName: field.apiName,
      message: `Value exceeds max length of ${field.maxLength} (got ${strValue.length})`,
    };
  }

  return null;
}

/**
 * Validate that a value is within the allowed picklist values.
 */
function validatePicklist(
  value: unknown,
  field: FieldSchema,
  recordIndex: number,
): SchemaError | null {
  if (!field.picklistValues || field.picklistValues.length === 0) {
    return null;
  }

  const strValue = String(value);
  if (!field.picklistValues.includes(strValue)) {
    return {
      recordIndex,
      fieldName: field.apiName,
      message: `Value '${strValue}' is not a valid picklist value. Allowed: ${field.picklistValues.join(', ')}`,
    };
  }

  return null;
}

/**
 * Validate basic type compatibility between the value and the schema type.
 */
function validateType(value: unknown, field: FieldSchema, recordIndex: number): SchemaError | null {
  switch (field.type) {
    case 'boolean':
      if (typeof value !== 'boolean') {
        return {
          recordIndex,
          fieldName: field.apiName,
          message: `Expected boolean but got ${typeof value}`,
        };
      }
      break;

    case 'int':
    case 'double':
    case 'currency':
    case 'percent':
      if (typeof value !== 'number') {
        return {
          recordIndex,
          fieldName: field.apiName,
          message: `Expected number but got ${typeof value}`,
        };
      }
      break;
  }

  return null;
}
