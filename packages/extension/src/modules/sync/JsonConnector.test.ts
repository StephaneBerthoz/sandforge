import { describe, it, expect, beforeEach } from 'vitest';
import { JsonConnector } from './JsonConnector';

describe('JsonConnector', () => {
  let connector: JsonConnector;

  beforeEach(() => {
    connector = new JsonConnector();
  });

  describe('read', () => {
    it('should parse a JSON array of objects', () => {
      const json = '[{"Name": "Acme"}, {"Name": "Globex"}]';
      const records = connector.read(json);

      expect(records).toHaveLength(2);
      expect(records[0].Name).toBe('Acme');
      expect(records[1].Name).toBe('Globex');
    });

    it('should parse a single JSON object as a one-element array', () => {
      const json = '{"Name": "Acme", "Industry": "Tech"}';
      const records = connector.read(json);

      expect(records).toHaveLength(1);
      expect(records[0]).toEqual({ Name: 'Acme', Industry: 'Tech' });
    });

    it('should return empty array for empty string', () => {
      expect(connector.read('')).toEqual([]);
    });

    it('should return empty array for whitespace-only string', () => {
      expect(connector.read('   ')).toEqual([]);
    });

    it('should throw for invalid JSON', () => {
      expect(() => connector.read('not json')).toThrow();
    });

    it('should throw for array containing non-objects', () => {
      expect(() => connector.read('[1, 2, 3]')).toThrow('not an object');
    });

    it('should throw for primitive JSON values', () => {
      expect(() => connector.read('"hello"')).toThrow('must be an array');
    });

    it('should handle nested objects in records', () => {
      const json = '[{"Name": "Acme", "Address": {"Street": "123 Main"}}]';
      const records = connector.read(json);

      expect(records[0].Address).toEqual({ Street: '123 Main' });
    });

    it('should preserve null values in records', () => {
      const json = '[{"Name": "Acme", "Value": null}]';
      const records = connector.read(json);

      expect(records[0].Value).toBeNull();
    });

    it('should handle empty array', () => {
      expect(connector.read('[]')).toEqual([]);
    });

    it('should preserve numeric and boolean values', () => {
      const json = '[{"Revenue": 1000, "Active": true}]';
      const records = connector.read(json);

      expect(records[0].Revenue).toBe(1000);
      expect(records[0].Active).toBe(true);
    });

    it('should throw for array with mixed types', () => {
      expect(() => connector.read('[{"Name": "ok"}, "bad"]')).toThrow('not an object');
    });
  });

  describe('write', () => {
    it('should serialize records to formatted JSON', () => {
      const records = [{ Name: 'Acme', Industry: 'Tech' }];
      const json = connector.write(records);
      const parsed = JSON.parse(json);

      expect(parsed).toEqual(records);
    });

    it('should use 2-space indentation', () => {
      const records = [{ Name: 'Acme' }];
      const json = connector.write(records);

      expect(json).toContain('  "Name"');
    });

    it('should handle empty array', () => {
      expect(connector.write([])).toBe('[]');
    });

    it('should handle null values in records', () => {
      const records = [{ Name: 'Acme', Value: null }];
      const json = connector.write(records);
      const parsed = JSON.parse(json);

      expect(parsed[0].Value).toBeNull();
    });

    it('should produce valid JSON that can be round-tripped', () => {
      const original = [
        { Name: 'Acme', Revenue: 1000, Active: true },
        { Name: 'Globex', Revenue: 2000, Active: false },
      ];
      const json = connector.write(original);
      const roundTripped = connector.read(json);

      expect(roundTripped).toEqual(original);
    });
  });
});
