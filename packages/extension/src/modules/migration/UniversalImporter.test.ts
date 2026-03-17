import { describe, it, expect, vi } from 'vitest';
import { UniversalImporter, importOptionsSchema } from './UniversalImporter';
import type { FileReader, ImportOptions } from './UniversalImporter';

function createMockFileReader(content: string): FileReader {
  return {
    readFile: vi.fn().mockResolvedValue(content),
  };
}

const CSV_CONTENT = `first_name,last_name,email,phone,company
John,Doe,john@example.com,555-0100,Acme Corp
Jane,Smith,jane@example.com,555-0200,Tech Inc
Bob,Johnson,bob@example.com,555-0300,Sales Co`;

const JSON_CONTENT = JSON.stringify([
  { FirstName: 'John', LastName: 'Doe', Email: 'john@example.com', Phone: '555-0100' },
  { FirstName: 'Jane', LastName: 'Smith', Email: 'jane@example.com', Phone: '555-0200' },
  { FirstName: 'Bob', LastName: 'Johnson', Email: 'bob@example.com', Phone: '555-0300' },
]);

const SINGLE_OBJECT_JSON = JSON.stringify({
  Name: 'Acme Corp',
  Industry: 'Technology',
  AnnualRevenue: 1000000,
});

const TSV_CONTENT = `Name\tIndustry\tEmployees
Acme\tTechnology\t500
Tech Inc\tFinancial Services\t200`;

describe('UniversalImporter', () => {
  describe('import — CSV', () => {
    it('should import CSV and generate SyncConfig', async () => {
      const reader = createMockFileReader(CSV_CONTENT);
      const importer = new UniversalImporter(reader);

      const result = await importer.import('/data/contacts.csv');

      expect(result.objects).toHaveLength(1);
      expect(result.objects[0].objectApiName).toBe('Contacts');
      expect(result.objects[0].fieldMappings.length).toBeGreaterThan(0);
      expect(result.direction).toBe('source_to_target');
    });

    it('should map CSV columns to SF field names', async () => {
      const reader = createMockFileReader(CSV_CONTENT);
      const importer = new UniversalImporter(reader);

      const result = await importer.import('/data/contacts.csv');

      const mappings = result.objects[0].fieldMappings;
      const emailMapping = mappings.find((m) => m.sourceField === 'email');
      expect(emailMapping?.targetField).toBe('Email');

      const firstNameMapping = mappings.find((m) => m.sourceField === 'first_name');
      expect(firstNameMapping?.targetField).toBe('FirstName');
    });

    it('should use provided objectApiName option', async () => {
      const reader = createMockFileReader(CSV_CONTENT);
      const importer = new UniversalImporter(reader);

      const result = await importer.import('/data/file.csv', {
        objectApiName: 'Contact',
      });

      expect(result.objects[0].objectApiName).toBe('Contact');
    });

    it('should apply field mapping overrides', async () => {
      const reader = createMockFileReader(CSV_CONTENT);
      const importer = new UniversalImporter(reader);

      const result = await importer.import('/data/contacts.csv', {
        fieldMappingOverrides: { company: 'AccountName__c' },
      });

      const companyMapping = result.objects[0].fieldMappings.find(
        (m) => m.sourceField === 'company'
      );
      expect(companyMapping?.targetField).toBe('AccountName__c');
    });

    it('should exclude specified columns', async () => {
      const reader = createMockFileReader(CSV_CONTENT);
      const importer = new UniversalImporter(reader);

      const result = await importer.import('/data/contacts.csv', {
        excludeColumns: ['phone'],
      });

      const phoneMapping = result.objects[0].fieldMappings.find(
        (m) => m.sourceField === 'phone'
      );
      expect(phoneMapping).toBeUndefined();
    });

    it('should set operation from options', async () => {
      const reader = createMockFileReader(CSV_CONTENT);
      const importer = new UniversalImporter(reader);

      const result = await importer.import('/data/contacts.csv', {
        operation: 'insert',
      });

      expect(result.objects[0].operation).toBe('insert');
    });

    it('should set externalIdField from options', async () => {
      const reader = createMockFileReader(CSV_CONTENT);
      const importer = new UniversalImporter(reader);

      const result = await importer.import('/data/contacts.csv', {
        externalIdField: 'Email',
      });

      expect(result.objects[0].externalIdField).toBe('Email');
    });

    it('should support custom CSV delimiter', async () => {
      const reader = createMockFileReader(TSV_CONTENT);
      const importer = new UniversalImporter(reader);

      const result = await importer.import('/data/accounts.tsv', {
        delimiter: '\t',
        objectApiName: 'Account',
      });

      expect(result.objects[0].fieldMappings.length).toBe(3);
    });

    it('should throw on empty CSV', async () => {
      const reader = createMockFileReader('');
      const importer = new UniversalImporter(reader);

      await expect(importer.import('/data/empty.csv')).rejects.toThrow(
        'No records found'
      );
    });

    it('should throw on header-only CSV', async () => {
      const reader = createMockFileReader('Name,Email');
      const importer = new UniversalImporter(reader);

      await expect(importer.import('/data/empty.csv')).rejects.toThrow(
        'No records found'
      );
    });
  });

  describe('import — JSON', () => {
    it('should import JSON array and generate SyncConfig', async () => {
      const reader = createMockFileReader(JSON_CONTENT);
      const importer = new UniversalImporter(reader);

      const result = await importer.import('/data/contacts.json');

      expect(result.objects).toHaveLength(1);
      expect(result.objects[0].fieldMappings.length).toBeGreaterThan(0);
    });

    it('should import single JSON object as one record', async () => {
      const reader = createMockFileReader(SINGLE_OBJECT_JSON);
      const importer = new UniversalImporter(reader);

      const result = await importer.import('/data/account.json', {
        objectApiName: 'Account',
      });

      expect(result.objects).toHaveLength(1);
      expect(result.objects[0].objectApiName).toBe('Account');
    });

    it('should preserve PascalCase JSON keys as direct mappings', async () => {
      const reader = createMockFileReader(JSON_CONTENT);
      const importer = new UniversalImporter(reader);

      const result = await importer.import('/data/contacts.json');

      const firstNameMapping = result.objects[0].fieldMappings.find(
        (m) => m.sourceField === 'FirstName'
      );
      expect(firstNameMapping?.targetField).toBe('FirstName');
      expect(firstNameMapping?.type).toBe('direct');
    });

    it('should throw on invalid JSON', async () => {
      const reader = createMockFileReader('not json at all');
      const importer = new UniversalImporter(reader);

      await expect(importer.import('/data/bad.json')).rejects.toThrow();
    });

    it('should throw on empty JSON array', async () => {
      const reader = createMockFileReader('[]');
      const importer = new UniversalImporter(reader);

      await expect(importer.import('/data/empty.json')).rejects.toThrow(
        'No records found'
      );
    });

    it('should throw on non-object array elements', async () => {
      const reader = createMockFileReader('[1, 2, 3]');
      const importer = new UniversalImporter(reader);

      await expect(importer.import('/data/bad.json')).rejects.toThrow(
        'not an object'
      );
    });
  });

  describe('detectFormat', () => {
    it('should detect JSON from .json extension', () => {
      const reader = createMockFileReader('');
      const importer = new UniversalImporter(reader);

      expect(importer.detectFormat('', '/data/file.json')).toBe('json');
    });

    it('should detect CSV from .csv extension', () => {
      const reader = createMockFileReader('');
      const importer = new UniversalImporter(reader);

      expect(importer.detectFormat('', '/data/file.csv')).toBe('csv');
    });

    it('should detect JSON from content starting with [', () => {
      const reader = createMockFileReader('');
      const importer = new UniversalImporter(reader);

      expect(importer.detectFormat('[{"a": 1}]', '/data/file.txt')).toBe('json');
    });

    it('should detect JSON from content starting with {', () => {
      const reader = createMockFileReader('');
      const importer = new UniversalImporter(reader);

      expect(importer.detectFormat('{"a": 1}', '/data/file.txt')).toBe('json');
    });

    it('should default to CSV for unknown extensions and content', () => {
      const reader = createMockFileReader('');
      const importer = new UniversalImporter(reader);

      expect(importer.detectFormat('Name,Email\nJohn,j@x.com', '/data/file.txt')).toBe('csv');
    });
  });

  describe('detectColumns', () => {
    it('should detect columns from records', () => {
      const reader = createMockFileReader('');
      const importer = new UniversalImporter(reader);

      const records = [
        { Name: 'Acme', Revenue: 1000000, Active: true },
        { Name: 'Tech', Revenue: 500000, Active: false },
      ];

      const columns = importer.detectColumns(records);

      expect(columns).toHaveLength(3);
      const nameCol = columns.find((c) => c.name === 'Name');
      expect(nameCol?.inferredType).toBe('string');

      const revenueCol = columns.find((c) => c.name === 'Revenue');
      expect(revenueCol?.inferredType).toBe('number');

      const activeCol = columns.find((c) => c.name === 'Active');
      expect(activeCol?.inferredType).toBe('boolean');
    });

    it('should detect date type from ISO date strings', () => {
      const reader = createMockFileReader('');
      const importer = new UniversalImporter(reader);

      const records = [
        { CreatedDate: '2026-01-01T00:00:00Z' },
        { CreatedDate: '2026-02-15T12:30:00Z' },
      ];

      const columns = importer.detectColumns(records);
      expect(columns[0].inferredType).toBe('date');
    });

    it('should detect Salesforce ID type', () => {
      const reader = createMockFileReader('');
      const importer = new UniversalImporter(reader);

      const records = [
        { AccountId: '001000000000001AAA' },
        { AccountId: '001000000000002AAA' },
      ];

      const columns = importer.detectColumns(records);
      expect(columns[0].inferredType).toBe('id');
    });

    it('should return empty array for empty records', () => {
      const reader = createMockFileReader('');
      const importer = new UniversalImporter(reader);

      const columns = importer.detectColumns([]);
      expect(columns).toHaveLength(0);
    });

    it('should collect up to 5 sample values', () => {
      const reader = createMockFileReader('');
      const importer = new UniversalImporter(reader);

      const records = Array.from({ length: 10 }, (_, i) => ({ val: i }));
      const columns = importer.detectColumns(records);

      expect(columns[0].sampleValues).toHaveLength(5);
    });
  });

  describe('importOptionsSchema', () => {
    it('should apply defaults for empty input', () => {
      const result = importOptionsSchema.parse({});

      expect(result.operation).toBe('upsert');
      expect(result.batchSize).toBe(200);
      expect(result.delimiter).toBe(',');
      expect(result.excludeColumns).toEqual([]);
    });

    it('should accept valid options', () => {
      const options: Partial<ImportOptions> = {
        objectApiName: 'Account',
        operation: 'insert',
        externalIdField: 'External_Id__c',
        batchSize: 500,
      };

      const result = importOptionsSchema.parse(options);
      expect(result.objectApiName).toBe('Account');
      expect(result.operation).toBe('insert');
      expect(result.batchSize).toBe(500);
    });

    it('should reject invalid operation', () => {
      const result = importOptionsSchema.safeParse({
        operation: 'invalid',
      });
      expect(result.success).toBe(false);
    });

    it('should reject negative batch size', () => {
      const result = importOptionsSchema.safeParse({
        batchSize: -1,
      });
      expect(result.success).toBe(false);
    });
  });
});
