import { describe, it, expect } from 'vitest';
import { CsvFieldMapper } from './CsvFieldMapper.js';
import type { DescribeField } from './SchemaAnalyzer.js';

function makeField(overrides: Partial<DescribeField> & { name: string; label: string; type: string }): DescribeField {
  return {
    nillable: true,
    defaultValue: null,
    unique: false,
    externalId: false,
    length: 255,
    ...overrides,
  };
}

describe('CsvFieldMapper', () => {
  const mapper = new CsvFieldMapper();

  describe('autoMapColumns', () => {
    const fields: DescribeField[] = [
      makeField({ name: 'Name', label: 'Account Name', type: 'string' }),
      makeField({ name: 'Industry', label: 'Industry', type: 'picklist' }),
      makeField({ name: 'AnnualRevenue', label: 'Annual Revenue', type: 'currency' }),
      makeField({ name: 'Custom_Field__c', label: 'Custom Field', type: 'string' }),
    ];

    it('matches CSV header to field name exactly (case-insensitive)', () => {
      const result = mapper.autoMapColumns(['name', 'INDUSTRY'], fields);
      expect(result[0].sfFieldApiName).toBe('Name');
      expect(result[1].sfFieldApiName).toBe('Industry');
    });

    it('matches CSV header to field label (case-insensitive)', () => {
      const result = mapper.autoMapColumns(['Account Name', 'annual revenue'], fields);
      expect(result[0].sfFieldApiName).toBe('Name');
      expect(result[1].sfFieldApiName).toBe('AnnualRevenue');
    });

    it('matches using underscore/space-tolerant normalization', () => {
      const result = mapper.autoMapColumns(['Annual_Revenue', 'custom field'], fields);
      expect(result[0].sfFieldApiName).toBe('AnnualRevenue');
      expect(result[1].sfFieldApiName).toBe('Custom_Field__c');
    });

    it('excludes non-createable system fields', () => {
      const systemFields: DescribeField[] = [
        makeField({ name: 'Id', label: 'Record ID', type: 'id' }),
        makeField({ name: 'CreatedDate', label: 'Created Date', type: 'datetime' }),
        makeField({ name: 'Name', label: 'Name', type: 'string' }),
      ];
      const result = mapper.autoMapColumns(['Id', 'CreatedDate', 'Name'], systemFields);
      expect(result[0].sfFieldApiName).toBe('');
      expect(result[1].sfFieldApiName).toBe('');
      expect(result[2].sfFieldApiName).toBe('Name');
    });

    it('returns unmapped for unrecognized headers', () => {
      const result = mapper.autoMapColumns(['TotallyUnknown'], fields);
      expect(result[0].sfFieldApiName).toBe('');
      expect(result[0].sfFieldType).toBe('');
    });
  });

  describe('convertValue', () => {
    it('returns null for empty string', () => {
      expect(mapper.convertValue('', 'string')).toBeNull();
    });

    it('converts double/currency/percent to number', () => {
      expect(mapper.convertValue('42.5', 'double')).toBe(42.5);
      expect(mapper.convertValue('1000', 'currency')).toBe(1000);
      expect(mapper.convertValue('99.9', 'percent')).toBe(99.9);
    });

    it('returns null for non-numeric values in numeric fields', () => {
      expect(mapper.convertValue('abc', 'double')).toBeNull();
      expect(mapper.convertValue('xyz', 'int')).toBeNull();
    });

    it('converts int type to integer', () => {
      expect(mapper.convertValue('42', 'int')).toBe(42);
      expect(mapper.convertValue('42.9', 'int')).toBe(42);
    });

    it('converts boolean values', () => {
      expect(mapper.convertValue('true', 'boolean')).toBe(true);
      expect(mapper.convertValue('1', 'boolean')).toBe(true);
      expect(mapper.convertValue('false', 'boolean')).toBe(false);
      expect(mapper.convertValue('0', 'boolean')).toBe(false);
    });

    it('validates date format', () => {
      expect(mapper.convertValue('2024-01-15', 'date')).toBe('2024-01-15');
      expect(mapper.convertValue('not-a-date', 'date')).toBeNull();
    });

    it('validates datetime format', () => {
      expect(mapper.convertValue('2024-01-15T10:30:00Z', 'datetime')).toBe('2024-01-15T10:30:00Z');
      expect(mapper.convertValue('not-datetime', 'datetime')).toBeNull();
    });

    it('returns string as-is for other types', () => {
      expect(mapper.convertValue('hello', 'string')).toBe('hello');
      expect(mapper.convertValue('some val', 'textarea')).toBe('some val');
    });
  });
});
