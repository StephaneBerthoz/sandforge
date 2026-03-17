import { describe, it, expect, beforeEach } from 'vitest';
import { FieldMappingService } from './FieldMapping';
import type { FieldMapping, AddOnField } from '@sandforge/shared';

describe('FieldMappingService', () => {
  let service: FieldMappingService;

  beforeEach(() => {
    service = new FieldMappingService();
  });

  describe('apply', () => {
    it('should apply a direct mapping copying value as-is', () => {
      const record = { Name: 'Acme', Industry: 'Tech' };
      const mappings: FieldMapping[] = [
        { sourceField: 'Name', targetField: 'Name', type: 'direct' },
      ];

      const result = service.apply(record, mappings);
      expect(result).toEqual({ Name: 'Acme' });
    });

    it('should apply a rename mapping to a different target field', () => {
      const record = { OldName: 'Acme' };
      const mappings: FieldMapping[] = [
        { sourceField: 'OldName', targetField: 'NewName', type: 'rename' },
      ];

      const result = service.apply(record, mappings);
      expect(result).toEqual({ NewName: 'Acme' });
    });

    it('should apply transform mapping with uppercase rule', () => {
      const record = { Name: 'acme' };
      const mappings: FieldMapping[] = [
        {
          sourceField: 'Name',
          targetField: 'Name',
          type: 'transform',
          transformRules: [{ type: 'uppercase', config: {} }],
        },
      ];

      const result = service.apply(record, mappings);
      expect(result).toEqual({ Name: 'ACME' });
    });

    it('should apply transform mapping with multiple chained rules', () => {
      const record = { Name: '  acme  ' };
      const mappings: FieldMapping[] = [
        {
          sourceField: 'Name',
          targetField: 'Name',
          type: 'transform',
          transformRules: [
            { type: 'trim', config: {} },
            { type: 'uppercase', config: {} },
          ],
        },
      ];

      const result = service.apply(record, mappings);
      expect(result).toEqual({ Name: 'ACME' });
    });

    it('should handle exclude mapping by omitting the field', () => {
      const record = { Name: 'Acme', Secret: 'hidden' };
      const mappings: FieldMapping[] = [
        { sourceField: 'Name', targetField: 'Name', type: 'direct' },
        { sourceField: 'Secret', targetField: 'Secret', type: 'exclude' },
      ];

      const result = service.apply(record, mappings);
      expect(result).toEqual({ Name: 'Acme' });
      expect(result).not.toHaveProperty('Secret');
    });

    it('should handle formula mapping with field references', () => {
      const record = { FirstName: 'John', LastName: 'Doe' };
      const mappings: FieldMapping[] = [
        {
          sourceField: '{FirstName} {LastName}',
          targetField: 'FullName',
          type: 'formula',
        },
      ];

      const result = service.apply(record, mappings);
      expect(result).toEqual({ FullName: 'John Doe' });
    });

    it('should handle formula mapping with simple field name', () => {
      const record = { Name: 'Acme' };
      const mappings: FieldMapping[] = [
        { sourceField: 'Name', targetField: 'CompanyName', type: 'formula' },
      ];

      const result = service.apply(record, mappings);
      expect(result).toEqual({ CompanyName: 'Acme' });
    });

    it('should apply truncate transform rule', () => {
      const record = { Name: 'A very long company name' };
      const mappings: FieldMapping[] = [
        {
          sourceField: 'Name',
          targetField: 'Name',
          type: 'transform',
          transformRules: [{ type: 'truncate', config: { length: 10 } }],
        },
      ];

      const result = service.apply(record, mappings);
      expect(result).toEqual({ Name: 'A very lon' });
    });

    it('should apply prefix transform rule', () => {
      const record = { Code: '001' };
      const mappings: FieldMapping[] = [
        {
          sourceField: 'Code',
          targetField: 'Code',
          type: 'transform',
          transformRules: [{ type: 'prefix', config: { prefix: 'SF-' } }],
        },
      ];

      const result = service.apply(record, mappings);
      expect(result).toEqual({ Code: 'SF-001' });
    });

    it('should apply suffix transform rule', () => {
      const record = { Name: 'Test' };
      const mappings: FieldMapping[] = [
        {
          sourceField: 'Name',
          targetField: 'Name',
          type: 'transform',
          transformRules: [{ type: 'suffix', config: { suffix: '_v2' } }],
        },
      ];

      const result = service.apply(record, mappings);
      expect(result).toEqual({ Name: 'Test_v2' });
    });

    it('should handle multiple mappings for different fields', () => {
      const record = { Name: 'Acme', Industry: 'Tech', Revenue: 1000 };
      const mappings: FieldMapping[] = [
        { sourceField: 'Name', targetField: 'Account_Name', type: 'rename' },
        { sourceField: 'Industry', targetField: 'Industry', type: 'direct' },
        { sourceField: 'Revenue', targetField: 'Revenue', type: 'direct' },
      ];

      const result = service.apply(record, mappings);
      expect(result).toEqual({
        Account_Name: 'Acme',
        Industry: 'Tech',
        Revenue: 1000,
      });
    });

    it('should return empty object for empty mappings', () => {
      const record = { Name: 'Acme' };
      const result = service.apply(record, []);
      expect(result).toEqual({});
    });
  });

  describe('applyAddOns', () => {
    it('should add a new field that does not exist', () => {
      const record = { Name: 'Acme' };
      const addOns: AddOnField[] = [
        { fieldApiName: 'Source__c', value: 'Migration', overwriteExisting: false },
      ];

      const result = service.applyAddOns(record, addOns);
      expect(result).toEqual({ Name: 'Acme', Source__c: 'Migration' });
    });

    it('should not overwrite existing field when overwriteExisting is false', () => {
      const record = { Name: 'Acme', Source__c: 'Manual' };
      const addOns: AddOnField[] = [
        { fieldApiName: 'Source__c', value: 'Migration', overwriteExisting: false },
      ];

      const result = service.applyAddOns(record, addOns);
      expect(result.Source__c).toBe('Manual');
    });

    it('should overwrite existing field when overwriteExisting is true', () => {
      const record = { Name: 'Acme', Source__c: 'Manual' };
      const addOns: AddOnField[] = [
        { fieldApiName: 'Source__c', value: 'Migration', overwriteExisting: true },
      ];

      const result = service.applyAddOns(record, addOns);
      expect(result.Source__c).toBe('Migration');
    });

    it('should handle boolean add-on values', () => {
      const record = { Name: 'Acme' };
      const addOns: AddOnField[] = [
        { fieldApiName: 'IsActive__c', value: true, overwriteExisting: false },
      ];

      const result = service.applyAddOns(record, addOns);
      expect(result.IsActive__c).toBe(true);
    });

    it('should handle numeric add-on values', () => {
      const record = { Name: 'Acme' };
      const addOns: AddOnField[] = [
        { fieldApiName: 'Priority__c', value: 5, overwriteExisting: false },
      ];

      const result = service.applyAddOns(record, addOns);
      expect(result.Priority__c).toBe(5);
    });
  });
});
