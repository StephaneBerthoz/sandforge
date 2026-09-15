import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '../../logger.js';
import { RecordTypeMapper, warnUnmappedRecordType } from './RecordTypeMapper';
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

    it('matches within the same object when both sides say which object a type belongs to', () => {
      // DeveloperName is unique per object, not per org: Account and
      // Opportunity can each have a "Business" record type.
      const source = [
        createTypeInfo({ id: 'src-acc', developerName: 'Business', sobjectType: 'Account' }),
        createTypeInfo({ id: 'src-opp', developerName: 'Business', sobjectType: 'Opportunity' }),
      ];
      const target = [
        createTypeInfo({ id: 'tgt-opp', developerName: 'Business', sobjectType: 'Opportunity' }),
        createTypeInfo({ id: 'tgt-acc', developerName: 'Business', sobjectType: 'Account' }),
      ];

      const mappings = mapper.buildMapping(source, target);

      expect(mappings).toEqual([
        { sourceId: 'src-acc', targetId: 'tgt-acc', developerName: 'Business' },
        { sourceId: 'src-opp', targetId: 'tgt-opp', developerName: 'Business' },
      ]);
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

    it('reports an unmapped id once, however many records carry it', () => {
      const records = [
        { Name: 'A', RecordTypeId: 'unknown-id' },
        { Name: 'B', RecordTypeId: 'src-1' },
        { Name: 'C', RecordTypeId: 'unknown-id' },
        { Name: 'D', RecordTypeId: 'other-unknown' },
        { Name: 'E' },
      ];
      const mappings: RecordTypeMapping[] = [
        { sourceId: 'src-1', targetId: 'tgt-1', developerName: 'Business' },
      ];
      const unmapped: string[] = [];

      const result = mapper.apply(records, mappings, (id) => unmapped.push(id));

      expect(unmapped).toEqual(['unknown-id', 'other-unknown']);
      expect(result.map((r) => r.RecordTypeId)).toEqual([
        'unknown-id',
        'tgt-1',
        'unknown-id',
        'other-unknown',
        undefined,
      ]);
    });

    it('keeps the master record type Id, which is the same in every org, without reporting it', () => {
      const records = [
        { Name: 'A', RecordTypeId: '012000000000000AAA' },
        { Name: 'B', RecordTypeId: '012000000000000' },
      ];
      const unmapped: string[] = [];

      const result = mapper.apply(
        records,
        [{ sourceId: 'src-1', targetId: 'tgt-1', developerName: 'Business' }],
        (id) => unmapped.push(id),
      );

      expect(unmapped).toEqual([]);
      expect(result.map((r) => r.RecordTypeId)).toEqual(['012000000000000AAA', '012000000000000']);
    });
  });

  describe('warnUnmappedRecordType', () => {
    it('names the object and the source Id, and the match on object and API name', () => {
      vi.mocked(logger.warn).mockClear();

      warnUnmappedRecordType('Case', '012SRC000000001AAA');

      expect(logger.warn).toHaveBeenCalledTimes(1);
      const line = vi.mocked(logger.warn).mock.calls[0][0] as string;
      expect(line).toContain('Case');
      expect(line).toContain('012SRC000000001AAA');
      expect(line).toContain('no active Case record type with the same API name');
    });
  });
});
