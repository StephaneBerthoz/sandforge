import { describe, it, expect } from 'vitest';
import { CsvValidator } from './CsvValidator.js';
import type { CsvColumnMapping } from '@sandforge/shared';
import type { DescribeField } from './SchemaAnalyzer.js';

function makeField(overrides: Partial<DescribeField> & { name: string; type: string }): DescribeField {
  return {
    label: overrides.name,
    nillable: true,
    defaultValue: null,
    unique: false,
    externalId: false,
    length: 255,
    ...overrides,
  };
}

function makeMapping(csvHeader: string, sfFieldApiName: string, sfFieldType: string, sfFieldLength: number | null = null): CsvColumnMapping {
  return { csvHeader, sfFieldApiName, sfFieldType, sfFieldLength };
}

describe('CsvValidator', () => {
  const validator = new CsvValidator();

  it('returns valid result for correct data', () => {
    const fields = [makeField({ name: 'Name', type: 'string' })];
    const mappings = [makeMapping('Name', 'Name', 'string')];
    const records = [{ Name: 'Acme Corp' }, { Name: 'Globex' }];

    const result = validator.validate(records, mappings, fields);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('detects type mismatch for numeric fields', () => {
    const fields = [makeField({ name: 'Revenue', type: 'currency' })];
    const mappings = [makeMapping('Revenue', 'Revenue', 'currency')];
    const records = [{ Revenue: 'not-a-number' }];

    const result = validator.validate(records, mappings, fields);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].errorType).toBe('type_mismatch');
    expect(result.errors[0].row).toBe(1);
  });

  it('detects missing required fields', () => {
    const fields = [makeField({ name: 'Name', type: 'string', nillable: false, defaultValue: null })];
    const mappings = [makeMapping('Name', 'Name', 'string')];
    const records = [{ Name: '' }];

    const result = validator.validate(records, mappings, fields);
    expect(result.valid).toBe(false);
    expect(result.errors[0].errorType).toBe('missing_required');
  });

  it('detects length exceeded', () => {
    const fields = [makeField({ name: 'Code', type: 'string', length: 5 })];
    const mappings = [makeMapping('Code', 'Code', 'string')];
    const records = [{ Code: 'TOOLONG' }];

    const result = validator.validate(records, mappings, fields);
    expect(result.valid).toBe(false);
    expect(result.errors[0].errorType).toBe('length_exceeded');
  });

  it('detects invalid picklist values', () => {
    const fields = [makeField({
      name: 'Status',
      type: 'picklist',
      picklistValues: [{ value: 'Open', active: true }, { value: 'Closed', active: true }],
    })];
    const mappings = [makeMapping('Status', 'Status', 'picklist')];
    const records = [{ Status: 'Invalid' }];

    const result = validator.validate(records, mappings, fields);
    expect(result.valid).toBe(false);
    expect(result.errors[0].errorType).toBe('invalid_picklist');
  });

  it('detects duplicate external IDs', () => {
    const fields = [makeField({ name: 'ExtId__c', type: 'string', externalId: true })];
    const mappings = [makeMapping('ExtId', 'ExtId__c', 'string')];
    const records = [{ ExtId: 'ABC' }, { ExtId: 'DEF' }, { ExtId: 'ABC' }];

    const result = validator.validate(records, mappings, fields, 'ExtId__c');
    expect(result.valid).toBe(false);
    const dupError = result.errors.find((e) => e.errorType === 'duplicate_external_id');
    expect(dupError).toBeDefined();
    expect(dupError?.row).toBe(3);
  });

  it('caps error collection at 100', () => {
    const fields = [makeField({ name: 'Revenue', type: 'currency' })];
    const mappings = [makeMapping('Revenue', 'Revenue', 'currency')];
    const records = Array.from({ length: 200 }, () => ({ Revenue: 'bad' }));

    const result = validator.validate(records, mappings, fields);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(100);
  });

  it('skips unmapped columns', () => {
    const fields = [makeField({ name: 'Name', type: 'string' })];
    const mappings = [makeMapping('UnmappedCol', '', '')];
    const records = [{ UnmappedCol: 'value' }];

    const result = validator.validate(records, mappings, fields);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
