import { describe, it, expect, beforeEach } from 'vitest';
import { SchemaValidator } from './SchemaValidator';
import type { FieldSchema } from './SchemaValidator';

describe('SchemaValidator', () => {
  let validator: SchemaValidator;

  beforeEach(() => {
    validator = new SchemaValidator();
  });

  describe('validate', () => {
    it('should return valid for records matching schema', () => {
      const schema: FieldSchema[] = [
        { apiName: 'Name', type: 'string', required: true, maxLength: 255 },
      ];
      const records = [{ Name: 'Acme' }];

      const result = validator.validate(records, schema);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect missing required fields', () => {
      const schema: FieldSchema[] = [{ apiName: 'Name', type: 'string', required: true }];
      const records = [{ Industry: 'Tech' }];

      const result = validator.validate(records, schema);

      expect(result.valid).toBe(false);
      expect(result.errors[0].fieldName).toBe('Name');
      expect(result.errors[0].message).toContain('Required');
    });

    it('should detect null values for required fields', () => {
      const schema: FieldSchema[] = [{ apiName: 'Name', type: 'string', required: true }];
      const records = [{ Name: null }];

      const result = validator.validate(records, schema);

      expect(result.valid).toBe(false);
    });

    it('should detect empty string for required fields', () => {
      const schema: FieldSchema[] = [{ apiName: 'Name', type: 'string', required: true }];
      const records = [{ Name: '' }];

      const result = validator.validate(records, schema);

      expect(result.valid).toBe(false);
    });

    it('should detect values exceeding max length', () => {
      const schema: FieldSchema[] = [
        { apiName: 'Name', type: 'string', required: false, maxLength: 5 },
      ];
      const records = [{ Name: 'Too Long Name' }];

      const result = validator.validate(records, schema);

      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('max length');
    });

    it('should pass values within max length', () => {
      const schema: FieldSchema[] = [
        { apiName: 'Name', type: 'string', required: false, maxLength: 10 },
      ];
      const records = [{ Name: 'Short' }];

      const result = validator.validate(records, schema);

      expect(result.valid).toBe(true);
    });

    it('should detect invalid picklist values', () => {
      const schema: FieldSchema[] = [
        {
          apiName: 'Industry',
          type: 'picklist',
          required: false,
          picklistValues: ['Tech', 'Finance', 'Healthcare'],
        },
      ];
      const records = [{ Industry: 'InvalidValue' }];

      const result = validator.validate(records, schema);

      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('not a valid picklist');
    });

    it('should pass valid picklist values', () => {
      const schema: FieldSchema[] = [
        {
          apiName: 'Industry',
          type: 'picklist',
          required: false,
          picklistValues: ['Tech', 'Finance'],
        },
      ];
      const records = [{ Industry: 'Tech' }];

      const result = validator.validate(records, schema);

      expect(result.valid).toBe(true);
    });

    it('should detect type mismatch for boolean fields', () => {
      const schema: FieldSchema[] = [{ apiName: 'IsActive', type: 'boolean', required: false }];
      const records = [{ IsActive: 'yes' }];

      const result = validator.validate(records, schema);

      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('Expected boolean');
    });

    it('should detect type mismatch for numeric fields', () => {
      const schema: FieldSchema[] = [{ apiName: 'Revenue', type: 'double', required: false }];
      const records = [{ Revenue: 'not a number' }];

      const result = validator.validate(records, schema);

      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('Expected number');
    });

    it('should include correct recordIndex in errors', () => {
      const schema: FieldSchema[] = [{ apiName: 'Name', type: 'string', required: true }];
      const records = [{ Name: 'Valid' }, { Industry: 'Tech' }];

      const result = validator.validate(records, schema);

      expect(result.errors[0].recordIndex).toBe(1);
    });

    it('should skip validation for optional empty fields', () => {
      const schema: FieldSchema[] = [
        { apiName: 'Phone', type: 'string', required: false, maxLength: 20 },
      ];
      const records = [{ Name: 'Acme' }];

      const result = validator.validate(records, schema);

      expect(result.valid).toBe(true);
    });

    it('should handle empty records array', () => {
      const schema: FieldSchema[] = [{ apiName: 'Name', type: 'string', required: true }];

      const result = validator.validate([], schema);

      expect(result.valid).toBe(true);
    });

    it('should handle empty schema', () => {
      const records = [{ Name: 'Acme' }];

      const result = validator.validate(records, []);

      expect(result.valid).toBe(true);
    });

    it('should collect multiple errors from a single record', () => {
      const schema: FieldSchema[] = [
        { apiName: 'Name', type: 'string', required: true },
        { apiName: 'Email', type: 'string', required: true },
      ];
      const records = [{}];

      const result = validator.validate(records, schema);

      expect(result.errors).toHaveLength(2);
    });
  });
});
