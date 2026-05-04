import { describe, it, expect, beforeEach } from 'vitest';
import { RecordTypeMapper } from './RecordTypeMapper';
import type { RecordTypeInfo, RecordTypeMapping } from './RecordTypeMapper';

function createTypeInfo(overrides?: Partial<RecordTypeInfo>): RecordTypeInfo {
  return {
    id: '012000000000001',
    name: 'Standard',
    developerName: 'Standard',
    ...overrides,
  };
}

describe('RecordTypeMapper', () => {
  let mapper: RecordTypeMapper;

  beforeEach(() => {
    mapper = new RecordTypeMapper();
  });

  describe('buildMapping', () => {
    it('should map record types by developerName', () => {
      const source = [createTypeInfo({ id: 'src-1', developerName: 'Business' })];
      const target = [createTypeInfo({ id: 'tgt-1', developerName: 'Business' })];

      const mappings = mapper.buildMapping(source, target);

      expect(mappings).toHaveLength(1);
      expect(mappings[0]).toEqual({
        sourceId: 'src-1',
        targetId: 'tgt-1',
        developerName: 'Business',
      });
    });

    it('should only include types present in both orgs', () => {
      const source = [
        createTypeInfo({ id: 'src-1', developerName: 'Business' }),
        createTypeInfo({ id: 'src-2', developerName: 'SourceOnly' }),
      ];
      const target = [
        createTypeInfo({ id: 'tgt-1', developerName: 'Business' }),
        createTypeInfo({ id: 'tgt-2', developerName: 'TargetOnly' }),
      ];

      const mappings = mapper.buildMapping(source, target);

      expect(mappings).toHaveLength(1);
      expect(mappings[0].developerName).toBe('Business');
    });

    it('should return empty array when no common types', () => {
      const source = [createTypeInfo({ developerName: 'SourceOnly' })];
      const target = [createTypeInfo({ developerName: 'TargetOnly' })];

      expect(mapper.buildMapping(source, target)).toEqual([]);
    });

    it('should handle empty source list', () => {
      const target = [createTypeInfo()];
      expect(mapper.buildMapping([], target)).toEqual([]);
    });

    it('should handle empty target list', () => {
      const source = [createTypeInfo()];
      expect(mapper.buildMapping(source, [])).toEqual([]);
    });

    it('should handle multiple matching types', () => {
      const source = [
        createTypeInfo({ id: 'src-1', developerName: 'Business' }),
        createTypeInfo({ id: 'src-2', developerName: 'Person' }),
      ];
      const target = [
        createTypeInfo({ id: 'tgt-1', developerName: 'Business' }),
        createTypeInfo({ id: 'tgt-2', developerName: 'Person' }),
      ];

      const mappings = mapper.buildMapping(source, target);

      expect(mappings).toHaveLength(2);
    });
  });

  describe('apply', () => {
    it('should replace RecordTypeId with target ID', () => {
      const records = [{ Name: 'Acme', RecordTypeId: 'src-1' }];
      const mappings: RecordTypeMapping[] = [
        { sourceId: 'src-1', targetId: 'tgt-1', developerName: 'Business' },
      ];

      const result = mapper.apply(records, mappings);

      expect(result[0].RecordTypeId).toBe('tgt-1');
    });

    it('should leave unmapped RecordTypeId unchanged', () => {
      const records = [{ Name: 'Acme', RecordTypeId: 'unknown-id' }];
      const mappings: RecordTypeMapping[] = [
        { sourceId: 'src-1', targetId: 'tgt-1', developerName: 'Business' },
      ];

      const result = mapper.apply(records, mappings);

      expect(result[0].RecordTypeId).toBe('unknown-id');
    });

    it('should leave records without RecordTypeId unchanged', () => {
      const records = [{ Name: 'Acme' }];
      const mappings: RecordTypeMapping[] = [
        { sourceId: 'src-1', targetId: 'tgt-1', developerName: 'Business' },
      ];

      const result = mapper.apply(records, mappings);

      expect(result[0]).toEqual({ Name: 'Acme' });
    });

    it('should not modify original records', () => {
      const records = [{ Name: 'Acme', RecordTypeId: 'src-1' }];
      const mappings: RecordTypeMapping[] = [
        { sourceId: 'src-1', targetId: 'tgt-1', developerName: 'Business' },
      ];

      mapper.apply(records, mappings);

      expect(records[0].RecordTypeId).toBe('src-1');
    });

    it('should handle empty records array', () => {
      expect(mapper.apply([], [])).toEqual([]);
    });

    it('should handle empty mappings', () => {
      const records = [{ Name: 'Acme', RecordTypeId: 'src-1' }];

      const result = mapper.apply(records, []);

      expect(result[0].RecordTypeId).toBe('src-1');
    });

    it('should preserve all other record fields', () => {
      const records = [{ Name: 'Acme', Industry: 'Tech', RecordTypeId: 'src-1' }];
      const mappings: RecordTypeMapping[] = [
        { sourceId: 'src-1', targetId: 'tgt-1', developerName: 'Business' },
      ];

      const result = mapper.apply(records, mappings);

      expect(result[0].Name).toBe('Acme');
      expect(result[0].Industry).toBe('Tech');
    });
  });
});
