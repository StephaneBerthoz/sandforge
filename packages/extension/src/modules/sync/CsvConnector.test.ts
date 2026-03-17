import { describe, it, expect, beforeEach } from 'vitest';
import { CsvConnector } from './CsvConnector';

describe('CsvConnector', () => {
  let connector: CsvConnector;

  beforeEach(() => {
    connector = new CsvConnector();
  });

  describe('read', () => {
    it('should parse simple CSV with headers', () => {
      const csv = 'Name,Industry\nAcme,Tech\nGlobex,Finance';
      const records = connector.read(csv);

      expect(records).toHaveLength(2);
      expect(records[0]).toEqual({ Name: 'Acme', Industry: 'Tech' });
      expect(records[1]).toEqual({ Name: 'Globex', Industry: 'Finance' });
    });

    it('should handle quoted fields containing commas', () => {
      const csv = 'Name,Address\nAcme,"123 Main St, Suite 100"';
      const records = connector.read(csv);

      expect(records[0].Address).toBe('123 Main St, Suite 100');
    });

    it('should handle escaped quotes within quoted fields', () => {
      const csv = 'Name,Description\nAcme,"He said ""hello"""';
      const records = connector.read(csv);

      expect(records[0].Description).toBe('He said "hello"');
    });

    it('should parse numeric values as numbers', () => {
      const csv = 'Name,Revenue\nAcme,1000000';
      const records = connector.read(csv);

      expect(records[0].Revenue).toBe(1000000);
    });

    it('should parse boolean values', () => {
      const csv = 'Name,Active\nAcme,true\nGlobex,false';
      const records = connector.read(csv);

      expect(records[0].Active).toBe(true);
      expect(records[1].Active).toBe(false);
    });

    it('should parse null values', () => {
      const csv = 'Name,Value\nAcme,null';
      const records = connector.read(csv);

      expect(records[0].Value).toBeNull();
    });

    it('should return empty array for empty input', () => {
      expect(connector.read('')).toEqual([]);
    });

    it('should return empty array for header-only CSV', () => {
      expect(connector.read('Name,Industry')).toEqual([]);
    });

    it('should handle missing trailing fields', () => {
      const csv = 'Name,Industry,Revenue\nAcme,Tech';
      const records = connector.read(csv);

      expect(records[0].Revenue).toBe('');
    });

    it('should handle Windows-style line endings (CRLF)', () => {
      const csv = 'Name,Industry\r\nAcme,Tech\r\nGlobex,Finance';
      const records = connector.read(csv);

      expect(records).toHaveLength(2);
      expect(records[0].Name).toBe('Acme');
    });

    it('should skip empty rows', () => {
      const csv = 'Name,Industry\nAcme,Tech\n\nGlobex,Finance';
      const records = connector.read(csv);

      expect(records).toHaveLength(2);
    });
  });

  describe('write', () => {
    it('should produce CSV with headers from first record', () => {
      const records = [
        { Name: 'Acme', Industry: 'Tech' },
        { Name: 'Globex', Industry: 'Finance' },
      ];

      const csv = connector.write(records);
      const lines = csv.split('\n');

      expect(lines[0]).toBe('Name,Industry');
      expect(lines[1]).toBe('Acme,Tech');
      expect(lines[2]).toBe('Globex,Finance');
    });

    it('should quote fields containing commas', () => {
      const records = [{ Address: '123 Main St, Suite 100' }];
      const csv = connector.write(records);

      expect(csv).toContain('"123 Main St, Suite 100"');
    });

    it('should escape double quotes within fields', () => {
      const records = [{ Description: 'He said "hello"' }];
      const csv = connector.write(records);

      expect(csv).toContain('"He said ""hello"""');
    });

    it('should handle null and undefined values as empty strings', () => {
      const records = [{ Name: 'Acme', Value: null }];
      const csv = connector.write(records);

      expect(csv).toBe('Name,Value\nAcme,');
    });

    it('should return empty string for empty records array', () => {
      expect(connector.write([])).toBe('');
    });
  });
});
