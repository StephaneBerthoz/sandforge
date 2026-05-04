import { describe, it, expect } from 'vitest';
import { FieldTypeValidator } from './FieldTypeValidator';
import type { FieldDescriptor, TargetFieldDescriptor } from './FieldTypeValidator';

describe('FieldTypeValidator', () => {
  const validator = new FieldTypeValidator();

  describe('validateMapping - compatible types', () => {
    it('should pass identical types', () => {
      const source: FieldDescriptor[] = [{ apiName: 'Name', type: 'string' }];
      const target: FieldDescriptor[] = [{ apiName: 'Name', type: 'string' }];

      const result = validator.validateMapping(source, target, { Name: 'Name' });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should pass int to double conversion', () => {
      const source: FieldDescriptor[] = [{ apiName: 'Count', type: 'int' }];
      const target: FieldDescriptor[] = [{ apiName: 'Amount', type: 'double' }];

      const result = validator.validateMapping(source, target, { Count: 'Amount' });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should pass date to datetime conversion', () => {
      const source: FieldDescriptor[] = [{ apiName: 'StartDate', type: 'date' }];
      const target: FieldDescriptor[] = [{ apiName: 'Created', type: 'datetime' }];

      const result = validator.validateMapping(source, target, { StartDate: 'Created' });

      expect(result.valid).toBe(true);
    });

    it('should pass id to reference conversion', () => {
      const source: FieldDescriptor[] = [{ apiName: 'AccountId', type: 'id' }];
      const target: FieldDescriptor[] = [{ apiName: 'Ref', type: 'reference' }];

      const result = validator.validateMapping(source, target, { AccountId: 'Ref' });

      expect(result.valid).toBe(true);
    });

    it('should pass any type to string', () => {
      const source: FieldDescriptor[] = [{ apiName: 'Val', type: 'boolean' }];
      const target: FieldDescriptor[] = [{ apiName: 'Str', type: 'string' }];

      const result = validator.validateMapping(source, target, { Val: 'Str' });

      expect(result.valid).toBe(true);
    });
  });

  describe('validateMapping - incompatible types', () => {
    it('should fail boolean to int conversion', () => {
      const source: FieldDescriptor[] = [{ apiName: 'Active', type: 'boolean' }];
      const target: FieldDescriptor[] = [{ apiName: 'Count', type: 'int' }];

      const result = validator.validateMapping(source, target, { Active: 'Count' });

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].reason).toContain('not compatible');
    });

    it('should fail reference to date conversion', () => {
      const source: FieldDescriptor[] = [{ apiName: 'Ref', type: 'reference' }];
      const target: FieldDescriptor[] = [{ apiName: 'Date', type: 'date' }];

      const result = validator.validateMapping(source, target, { Ref: 'Date' });

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
    });

    it('should fail address to string conversion', () => {
      const source: FieldDescriptor[] = [{ apiName: 'Addr', type: 'address' }];
      const target: FieldDescriptor[] = [{ apiName: 'Text', type: 'string' }];

      const result = validator.validateMapping(source, target, { Addr: 'Text' });

      expect(result.valid).toBe(false);
    });
  });

  describe('validateMapping - lossy conversions (warnings)', () => {
    it('should warn on datetime to date conversion', () => {
      const source: FieldDescriptor[] = [{ apiName: 'Created', type: 'datetime' }];
      const target: FieldDescriptor[] = [{ apiName: 'Day', type: 'date' }];

      const result = validator.validateMapping(source, target, { Created: 'Day' });

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].reason).toContain('Time portion will be lost');
    });

    it('should warn on richtext to textarea conversion', () => {
      const source: FieldDescriptor[] = [{ apiName: 'Body', type: 'richtext' }];
      const target: FieldDescriptor[] = [{ apiName: 'Plain', type: 'textarea' }];

      const result = validator.validateMapping(source, target, { Body: 'Plain' });

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0].reason).toContain('HTML formatting');
    });
  });

  describe('validateMapping - edge cases', () => {
    it('should return valid for empty mapping', () => {
      const result = validator.validateMapping([], [], {});

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('should skip fields not found in source or target', () => {
      const source: FieldDescriptor[] = [{ apiName: 'Name', type: 'string' }];
      const target: FieldDescriptor[] = [{ apiName: 'Name', type: 'string' }];

      const result = validator.validateMapping(source, target, {
        Name: 'Name',
        Missing: 'Missing',
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('validateRecords', () => {
    it('should pass records with correct types', () => {
      const fields: TargetFieldDescriptor[] = [
        { apiName: 'Name', type: 'string', maxLength: 255 },
        { apiName: 'Active', type: 'boolean' },
        { apiName: 'Count', type: 'int' },
      ];

      const records = [
        { Name: 'Test', Active: true, Count: 5 },
        { Name: 'Other', Active: false, Count: 10 },
      ];

      const result = validator.validateRecords(records, fields);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should catch wrong type values', () => {
      const fields: TargetFieldDescriptor[] = [{ apiName: 'Active', type: 'boolean' }];

      const records = [{ Active: 'yes' }];

      const result = validator.validateRecords(records, fields);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('Expected boolean');
    });

    it('should catch string exceeding maxLength', () => {
      const fields: TargetFieldDescriptor[] = [{ apiName: 'Code', type: 'string', maxLength: 5 }];

      const records = [{ Code: 'TOOLONG' }];

      const result = validator.validateRecords(records, fields);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('max length of 5');
    });

    it('should catch missing required fields', () => {
      const fields: TargetFieldDescriptor[] = [{ apiName: 'Name', type: 'string', required: true }];

      const records = [{ Other: 'value' }];

      const result = validator.validateRecords(records, fields);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('Required field');
    });

    it('should catch invalid picklist values', () => {
      const fields: TargetFieldDescriptor[] = [
        {
          apiName: 'Status',
          type: 'picklist',
          picklistValues: ['Active', 'Inactive', 'Pending'],
        },
      ];

      const records = [{ Status: 'Deleted' }];

      const result = validator.validateRecords(records, fields);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('not a valid picklist value');
    });

    it('should skip validation for null/undefined/empty values on optional fields', () => {
      const fields: TargetFieldDescriptor[] = [{ apiName: 'Name', type: 'string', maxLength: 255 }];

      const records = [{ Name: null }, { Name: undefined }, { Name: '' }];

      const result = validator.validateRecords(records, fields);

      expect(result.valid).toBe(true);
    });

    it('should validate integer fields reject floats', () => {
      const fields: TargetFieldDescriptor[] = [{ apiName: 'Count', type: 'int' }];

      const records = [{ Count: 3.14 }];

      const result = validator.validateRecords(records, fields);

      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('Expected integer');
    });

    it('should validate date fields accept valid ISO strings', () => {
      const fields: TargetFieldDescriptor[] = [{ apiName: 'StartDate', type: 'date' }];

      const records = [{ StartDate: '2026-01-15' }];

      const result = validator.validateRecords(records, fields);

      expect(result.valid).toBe(true);
    });

    it('should validate date fields reject invalid strings', () => {
      const fields: TargetFieldDescriptor[] = [{ apiName: 'StartDate', type: 'date' }];

      const records = [{ StartDate: 'not-a-date' }];

      const result = validator.validateRecords(records, fields);

      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('Expected valid date');
    });
  });
});
