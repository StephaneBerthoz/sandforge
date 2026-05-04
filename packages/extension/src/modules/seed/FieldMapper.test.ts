import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FieldMapper, generateValue } from './FieldMapper';
import type { FieldMapperDependencies } from './FieldMapper';
import type { SeedObjectConfig, FieldRule } from '@sandforge/shared';

function createMockDeps(): FieldMapperDependencies {
  return {
    aiGenerator: {
      generate: vi.fn().mockResolvedValue([]),
    } as unknown as FieldMapperDependencies['aiGenerator'],
    fakerFallback: {
      generate: vi.fn().mockReturnValue([]),
    } as unknown as FieldMapperDependencies['fakerFallback'],
  };
}

function createObjectConfig(fieldRules: FieldRule[], recordCount = 3): SeedObjectConfig {
  return {
    objectApiName: 'Account',
    recordCount,
    fieldRules,
    excludedFields: [],
    insertOrder: 0,
    batchSize: 200,
  };
}

describe('FieldMapper', () => {
  let deps: FieldMapperDependencies;
  let mapper: FieldMapper;

  beforeEach(() => {
    deps = createMockDeps();
    mapper = new FieldMapper(deps);
  });

  describe('mapFields', () => {
    it('should return empty array for zero record count', async () => {
      const config = createObjectConfig(
        [{ fieldApiName: 'Name', ruleType: 'static', config: { staticValue: 'Test' } }],
        0,
      );
      const result = await mapper.mapFields(config, new Map());
      expect(result).toEqual([]);
    });

    it('should return empty array for no field rules', async () => {
      const config = createObjectConfig([], 5);
      const result = await mapper.mapFields(config, new Map());
      expect(result).toEqual([]);
    });

    it('should generate static values for all records', async () => {
      const config = createObjectConfig([
        { fieldApiName: 'Status', ruleType: 'static', config: { staticValue: 'Active' } },
      ]);

      const result = await mapper.mapFields(config, new Map());
      expect(result).toHaveLength(3);
      for (const record of result) {
        expect(record['Status']).toBe('Active');
      }
    });

    it('should generate sequence values', async () => {
      const config = createObjectConfig([
        {
          fieldApiName: 'Code',
          ruleType: 'sequence',
          config: { sequenceStart: 1, sequenceStep: 1, sequencePrefix: 'C-' },
        },
      ]);

      const result = await mapper.mapFields(config, new Map());
      expect(result[0]['Code']).toBe('C-1');
      expect(result[1]['Code']).toBe('C-2');
      expect(result[2]['Code']).toBe('C-3');
    });

    it('should delegate AI rules to aiGenerator', async () => {
      vi.mocked(deps.aiGenerator.generate).mockResolvedValue([
        { Bio: 'AI text 1' },
        { Bio: 'AI text 2' },
      ]);

      const config = createObjectConfig(
        [{ fieldApiName: 'Bio', ruleType: 'ai_generate', config: { aiPrompt: 'Generate bio' } }],
        2,
      );

      const result = await mapper.mapFields(config, new Map());
      expect(deps.aiGenerator.generate).toHaveBeenCalledTimes(1);
      expect(result[0]['Bio']).toBe('AI text 1');
    });

    it('should delegate faker rules to fakerFallback', async () => {
      vi.mocked(deps.fakerFallback.generate).mockReturnValue([
        { Email: 'test@example.com' },
        { Email: 'other@example.com' },
      ]);

      const config = createObjectConfig(
        [{ fieldApiName: 'Email', ruleType: 'faker', config: { fakerMethod: 'email' } }],
        2,
      );

      const result = await mapper.mapFields(config, new Map());
      expect(deps.fakerFallback.generate).toHaveBeenCalledTimes(1);
      expect(result[0]['Email']).toBe('test@example.com');
    });

    it('should resolve reference fields from existing IDs', async () => {
      const existingIds = new Map([['Account', ['001AAA', '001BBB']]]);
      const config = createObjectConfig(
        [
          {
            fieldApiName: 'AccountId',
            ruleType: 'reference',
            config: { referenceObject: 'Account' },
          },
        ],
        2,
      );

      const result = await mapper.mapFields(config, existingIds);
      for (const record of result) {
        expect(['001AAA', '001BBB']).toContain(record['AccountId']);
      }
    });

    it('should return null for reference with no available IDs', async () => {
      const config = createObjectConfig(
        [
          {
            fieldApiName: 'AccountId',
            ruleType: 'reference',
            config: { referenceObject: 'Account' },
          },
        ],
        1,
      );

      const result = await mapper.mapFields(config, new Map());
      expect(result[0]['AccountId']).toBeNull();
    });

    it('should combine multiple rule types in one record', async () => {
      vi.mocked(deps.fakerFallback.generate).mockReturnValue([{ Email: 'a@b.com' }]);

      const config = createObjectConfig(
        [
          { fieldApiName: 'Name', ruleType: 'static', config: { staticValue: 'Test' } },
          { fieldApiName: 'Email', ruleType: 'faker', config: { fakerMethod: 'email' } },
        ],
        1,
      );

      const result = await mapper.mapFields(config, new Map());
      expect(result[0]['Name']).toBe('Test');
      expect(result[0]['Email']).toBe('a@b.com');
    });

    it('should handle picklist_random rule', async () => {
      const config = createObjectConfig(
        [
          {
            fieldApiName: 'Status',
            ruleType: 'picklist_random',
            config: { picklistValues: ['Open', 'Closed', 'Pending'] },
          },
        ],
        5,
      );

      const result = await mapper.mapFields(config, new Map());
      for (const record of result) {
        expect(['Open', 'Closed', 'Pending']).toContain(record['Status']);
      }
    });
  });

  describe('generateValue', () => {
    it('should return static value', () => {
      const rule: FieldRule = {
        fieldApiName: 'X',
        ruleType: 'static',
        config: { staticValue: 42 },
      };
      expect(generateValue(rule, 0, new Map())).toBe(42);
    });

    it('should return null for static with no value', () => {
      const rule: FieldRule = { fieldApiName: 'X', ruleType: 'static', config: {} };
      expect(generateValue(rule, 0, new Map())).toBeNull();
    });

    it('should return formula string for formula rule', () => {
      const rule: FieldRule = {
        fieldApiName: 'X',
        ruleType: 'formula',
        config: { formula: 'A + B' },
      };
      expect(generateValue(rule, 0, new Map())).toBe('A + B');
    });

    it('should return null for from_csv rule', () => {
      const rule: FieldRule = {
        fieldApiName: 'X',
        ruleType: 'from_csv',
        config: { csvColumn: 'col1' },
      };
      expect(generateValue(rule, 0, new Map())).toBeNull();
    });

    it('should return null for unknown rule type', () => {
      const rule = {
        fieldApiName: 'X',
        ruleType: 'unknown_type' as FieldRule['ruleType'],
        config: {},
      };
      expect(generateValue(rule, 0, new Map())).toBeNull();
    });
  });
});
