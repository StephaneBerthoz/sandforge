import { describe, it, expect, beforeEach } from 'vitest';
import { RecordTypeAwareSeed } from './RecordTypeAwareSeed';
import type { RecordTypeInfo } from './RecordTypeAwareSeed';
import type { SeedObjectConfig } from '@sandforge/shared';

function createObjectConfig(recordCount: number, recordTypeId?: string): SeedObjectConfig {
  return {
    objectApiName: 'Account',
    recordCount,
    recordTypeId,
    fieldRules: [],
    excludedFields: [],
    insertOrder: 0,
    batchSize: 200,
  };
}

function createRecordTypes(): RecordTypeInfo[] {
  return [
    { id: 'rt-1', name: 'Standard', developerName: 'Standard', isDefault: true },
    { id: 'rt-2', name: 'Enterprise', developerName: 'Enterprise', isDefault: false },
    { id: 'rt-3', name: 'Partner', developerName: 'Partner', isDefault: false },
  ];
}

describe('RecordTypeAwareSeed', () => {
  let generator: RecordTypeAwareSeed;

  beforeEach(() => {
    generator = new RecordTypeAwareSeed();
  });

  describe('generate', () => {
    it('should return empty array for zero record count', () => {
      const result = generator.generate(createObjectConfig(0), createRecordTypes());
      expect(result).toEqual([]);
    });

    it('should return empty records (no RecordTypeId) when no record types provided', () => {
      const result = generator.generate(createObjectConfig(3), []);

      expect(result).toHaveLength(3);
      for (const record of result) {
        expect(record).not.toHaveProperty('RecordTypeId');
      }
    });

    it('should use the specified recordTypeId when present in config', () => {
      const result = generator.generate(createObjectConfig(5, 'rt-2'), createRecordTypes());

      expect(result).toHaveLength(5);
      for (const record of result) {
        expect(record['RecordTypeId']).toBe('rt-2');
      }
    });

    it('should distribute records across all record types', () => {
      const result = generator.generate(createObjectConfig(9), createRecordTypes());

      expect(result).toHaveLength(9);
      const typeCounts = new Map<string, number>();
      for (const record of result) {
        const rtId = record['RecordTypeId'] as string;
        typeCounts.set(rtId, (typeCounts.get(rtId) ?? 0) + 1);
      }

      expect(typeCounts.get('rt-1')).toBe(3);
      expect(typeCounts.get('rt-2')).toBe(3);
      expect(typeCounts.get('rt-3')).toBe(3);
    });

    it('should assign remainder records to the default record type', () => {
      const result = generator.generate(createObjectConfig(10), createRecordTypes());

      const typeCounts = new Map<string, number>();
      for (const record of result) {
        const rtId = record['RecordTypeId'] as string;
        typeCounts.set(rtId, (typeCounts.get(rtId) ?? 0) + 1);
      }

      expect(typeCounts.get('rt-1')).toBe(4);
      expect(typeCounts.get('rt-2')).toBe(3);
      expect(typeCounts.get('rt-3')).toBe(3);
    });

    it('should use first record type when no default is marked', () => {
      const recordTypes: RecordTypeInfo[] = [
        { id: 'rt-a', name: 'TypeA', developerName: 'TypeA', isDefault: false },
        { id: 'rt-b', name: 'TypeB', developerName: 'TypeB', isDefault: false },
      ];

      const result = generator.generate(createObjectConfig(5), recordTypes);

      const typeCounts = new Map<string, number>();
      for (const record of result) {
        const rtId = record['RecordTypeId'] as string;
        typeCounts.set(rtId, (typeCounts.get(rtId) ?? 0) + 1);
      }

      expect(typeCounts.get('rt-a')).toBe(3);
      expect(typeCounts.get('rt-b')).toBe(2);
    });

    it('should handle single record type', () => {
      const recordTypes: RecordTypeInfo[] = [
        { id: 'rt-only', name: 'Only', developerName: 'Only', isDefault: true },
      ];

      const result = generator.generate(createObjectConfig(5), recordTypes);

      expect(result).toHaveLength(5);
      for (const record of result) {
        expect(record['RecordTypeId']).toBe('rt-only');
      }
    });

    it('should handle negative record count', () => {
      const result = generator.generate(createObjectConfig(-1), createRecordTypes());
      expect(result).toEqual([]);
    });

    it('should handle single record with multiple types', () => {
      const result = generator.generate(createObjectConfig(1), createRecordTypes());

      expect(result).toHaveLength(1);
      expect(result[0]['RecordTypeId']).toBe('rt-1');
    });

    it('should create correct total number of records', () => {
      const result = generator.generate(createObjectConfig(100), createRecordTypes());
      expect(result).toHaveLength(100);
    });
  });
});
