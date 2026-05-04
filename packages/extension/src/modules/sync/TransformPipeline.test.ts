import { describe, it, expect, beforeEach } from 'vitest';
import { TransformPipeline } from './TransformPipeline';
import type { TransformRule, SyncObjectConfig } from '@sandforge/shared';

function createObjectConfig(overrides?: Partial<SyncObjectConfig>): SyncObjectConfig {
  return {
    objectApiName: 'Account',
    operation: 'upsert',
    fieldMappings: [],
    transformRules: [],
    excludedFields: [],
    addOnFields: [],
    batchSize: 200,
    insertOrder: 1,
    ...overrides,
  };
}

describe('TransformPipeline', () => {
  let pipeline: TransformPipeline;

  beforeEach(() => {
    pipeline = new TransformPipeline();
  });

  describe('transform', () => {
    it('should apply uppercase rule', () => {
      const rules: TransformRule[] = [{ type: 'uppercase', config: {} }];
      expect(pipeline.transform('hello', rules)).toBe('HELLO');
    });

    it('should apply lowercase rule', () => {
      const rules: TransformRule[] = [{ type: 'lowercase', config: {} }];
      expect(pipeline.transform('HELLO', rules)).toBe('hello');
    });

    it('should apply trim rule', () => {
      const rules: TransformRule[] = [{ type: 'trim', config: {} }];
      expect(pipeline.transform('  hello  ', rules)).toBe('hello');
    });

    it('should apply truncate rule', () => {
      const rules: TransformRule[] = [{ type: 'truncate', config: { length: 5 } }];
      expect(pipeline.transform('hello world', rules)).toBe('hello');
    });

    it('should apply prefix rule', () => {
      const rules: TransformRule[] = [{ type: 'prefix', config: { prefix: 'SF-' } }];
      expect(pipeline.transform('001', rules)).toBe('SF-001');
    });

    it('should apply suffix rule', () => {
      const rules: TransformRule[] = [{ type: 'suffix', config: { suffix: '-v2' } }];
      expect(pipeline.transform('item', rules)).toBe('item-v2');
    });

    it('should apply replace rule replacing all occurrences', () => {
      const rules: TransformRule[] = [
        { type: 'replace', config: { search: 'foo', replace: 'bar' } },
      ];
      expect(pipeline.transform('foo and foo', rules)).toBe('bar and bar');
    });

    it('should apply regex_replace rule', () => {
      const rules: TransformRule[] = [
        { type: 'regex_replace', config: { regex: '\\d+', replace: 'X' } },
      ];
      expect(pipeline.transform('abc123def456', rules)).toBe('abcXdefX');
    });

    it('should apply map_value rule when value exists in map', () => {
      const rules: TransformRule[] = [
        {
          type: 'map_value',
          config: { valueMap: { US: 'United States', FR: 'France' } },
        },
      ];
      expect(pipeline.transform('US', rules)).toBe('United States');
    });

    it('should return original value for map_value when key not found', () => {
      const rules: TransformRule[] = [
        {
          type: 'map_value',
          config: { valueMap: { US: 'United States' } },
        },
      ];
      expect(pipeline.transform('UK', rules)).toBe('UK');
    });

    it('should apply default_value when value is null', () => {
      const rules: TransformRule[] = [{ type: 'default_value', config: { defaultValue: 'N/A' } }];
      expect(pipeline.transform(null, rules)).toBe('N/A');
    });

    it('should not apply default_value when value is present', () => {
      const rules: TransformRule[] = [{ type: 'default_value', config: { defaultValue: 'N/A' } }];
      expect(pipeline.transform('Hello', rules)).toBe('Hello');
    });

    it('should chain multiple rules in sequence', () => {
      const rules: TransformRule[] = [
        { type: 'trim', config: {} },
        { type: 'uppercase', config: {} },
        { type: 'prefix', config: { prefix: '[' } },
        { type: 'suffix', config: { suffix: ']' } },
      ];
      expect(pipeline.transform('  hello  ', rules)).toBe('[HELLO]');
    });

    it('should handle format_date rule', () => {
      const rules: TransformRule[] = [
        { type: 'format_date', config: { dateFormat: 'YYYY-MM-DD' } },
      ];
      const result = pipeline.transform('2026-03-15T10:30:00Z', rules);
      expect(result).toBe('2026-03-15');
    });

    it('should return original string for invalid date in format_date', () => {
      const rules: TransformRule[] = [
        { type: 'format_date', config: { dateFormat: 'YYYY-MM-DD' } },
      ];
      expect(pipeline.transform('not-a-date', rules)).toBe('not-a-date');
    });
  });

  describe('transformRecord', () => {
    it('should apply object-level transform rules to all fields', () => {
      const config = createObjectConfig({
        transformRules: [{ type: 'trim', config: {} }],
      });
      const record = { Name: '  Acme  ', Industry: '  Tech  ' };

      const result = pipeline.transformRecord(record, config);
      expect(result).toEqual({ Name: 'Acme', Industry: 'Tech' });
    });

    it('should apply per-field transform rules from fieldMappings', () => {
      const config = createObjectConfig({
        fieldMappings: [
          {
            sourceField: 'Name',
            targetField: 'Name',
            type: 'transform',
            transformRules: [{ type: 'uppercase', config: {} }],
          },
        ],
      });
      const record = { Name: 'acme', Industry: 'tech' };

      const result = pipeline.transformRecord(record, config);
      expect(result.Name).toBe('ACME');
      expect(result.Industry).toBe('tech');
    });

    it('should not modify the original record', () => {
      const config = createObjectConfig({
        transformRules: [{ type: 'uppercase', config: {} }],
      });
      const record = { Name: 'acme' };

      pipeline.transformRecord(record, config);
      expect(record.Name).toBe('acme');
    });

    it('should return unchanged record when no rules are defined', () => {
      const config = createObjectConfig();
      const record = { Name: 'Acme', Industry: 'Tech' };

      const result = pipeline.transformRecord(record, config);
      expect(result).toEqual(record);
    });
  });
});
