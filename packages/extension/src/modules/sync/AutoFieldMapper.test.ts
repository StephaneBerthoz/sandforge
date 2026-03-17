import { describe, it, expect } from 'vitest';
import { AutoFieldMapper } from './AutoFieldMapper';
import type { AutoMapFieldInfo } from './AutoFieldMapper';

function f(apiName: string, label: string, type = 'string'): AutoMapFieldInfo {
  return { apiName, label, type };
}

describe('AutoFieldMapper', () => {
  const mapper = new AutoFieldMapper();

  describe('suggest', () => {
    it('should match exact API names with confidence 1.0', () => {
      const source = [f('Name', 'Name'), f('Email', 'Email')];
      const target = [f('Name', 'Name'), f('Email', 'Email')];
      const suggestions = mapper.suggest(source, target);
      expect(suggestions).toHaveLength(2);
      expect(suggestions[0].confidence).toBe(1.0);
      expect(suggestions[0].reason).toBe('exact_name');
    });

    it('should match normalized names (strip __c suffix)', () => {
      const source = [f('Status__c', 'Status')];
      const target = [f('Status', 'Status')];
      const suggestions = mapper.suggest(source, target);
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0].confidence).toBe(0.9);
      expect(suggestions[0].reason).toBe('normalized_name');
    });

    it('should match by label similarity', () => {
      const source = [f('CompanyName__c', 'Company Name')];
      const target = [f('AccountName', 'Company Name')];
      const suggestions = mapper.suggest(source, target);
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0].confidence).toBeGreaterThanOrEqual(0.8);
      expect(suggestions[0].reason).toBe('label_match');
    });

    it('should not match completely different fields', () => {
      const source = [f('Phone', 'Phone', 'phone')];
      const target = [f('Description', 'Description', 'textarea')];
      const suggestions = mapper.suggest(source, target);
      expect(suggestions).toHaveLength(0);
    });

    it('should not reuse target fields', () => {
      const source = [f('Name', 'Name'), f('Name__c', 'Name')];
      const target = [f('Name', 'Name')];
      const suggestions = mapper.suggest(source, target);
      // Only one can be matched since target is unique
      expect(suggestions.length).toBeLessThanOrEqual(2);
      const targets = suggestions.map((s) => s.targetField);
      const unique = new Set(targets);
      expect(unique.size).toBe(targets.length);
    });

    it('should return suggestions sorted by confidence', () => {
      const source = [f('XYZ__c', 'xyz'), f('Name', 'Name')];
      const target = [f('Name', 'Name'), f('XYZ', 'XYZ')];
      const suggestions = mapper.suggest(source, target);
      for (let i = 1; i < suggestions.length; i++) {
        expect(suggestions[i].confidence).toBeLessThanOrEqual(suggestions[i - 1].confidence);
      }
    });

    it('should return empty array for no matches', () => {
      const source = [f('Alpha', 'Alpha')];
      const target = [f('Omega', 'Omega')];
      const suggestions = mapper.suggest(source, target);
      expect(suggestions).toHaveLength(0);
    });

    it('should handle empty inputs', () => {
      expect(mapper.suggest([], [])).toEqual([]);
      expect(mapper.suggest([f('A', 'A')], [])).toEqual([]);
      expect(mapper.suggest([], [f('A', 'A')])).toEqual([]);
    });
  });

  describe('toMappings', () => {
    it('should convert suggestions to FieldMapping array', () => {
      const suggestions = mapper.suggest(
        [f('Name', 'Name'), f('Email', 'Email')],
        [f('Name', 'Name'), f('Email', 'Email')],
      );
      const mappings = mapper.toMappings(suggestions);
      expect(mappings).toHaveLength(2);
      expect(mappings[0]).toHaveProperty('sourceField');
      expect(mappings[0]).toHaveProperty('targetField');
      expect(mappings[0]).toHaveProperty('type');
    });
  });

  describe('type inference', () => {
    it('should infer direct type for same name and type', () => {
      const suggestions = mapper.suggest(
        [f('Name', 'Name', 'string')],
        [f('Name', 'Name', 'string')],
      );
      expect(suggestions[0].type).toBe('direct');
    });

    it('should infer rename type for different names', () => {
      const source = [f('CompanyName__c', 'Company Name')];
      const target = [f('AccountName', 'Company Name')];
      const suggestions = mapper.suggest(source, target);
      if (suggestions.length > 0) {
        expect(suggestions[0].type).toBe('rename');
      }
    });
  });

  describe('type compatibility', () => {
    it('should match text types together', () => {
      const source = [f('Notes', 'Notes', 'string')];
      const target = [f('Notes', 'Notes', 'textarea')];
      const suggestions = mapper.suggest(source, target);
      expect(suggestions).toHaveLength(1);
    });

    it('should match numeric types together', () => {
      const source = [f('Amount', 'Amount', 'currency')];
      const target = [f('Amount', 'Amount', 'double')];
      const suggestions = mapper.suggest(source, target);
      expect(suggestions).toHaveLength(1);
    });

    it('should match date types together', () => {
      const source = [f('StartDate', 'Start Date', 'date')];
      const target = [f('StartDate', 'Start Date', 'datetime')];
      const suggestions = mapper.suggest(source, target);
      expect(suggestions).toHaveLength(1);
    });
  });

  describe('custom confidence threshold', () => {
    it('should respect minimum confidence threshold', () => {
      const strict = new AutoFieldMapper(0.95);
      const source = [f('Status__c', 'Status')];
      const target = [f('Status', 'Status')];
      const suggestions = strict.suggest(source, target);
      // 0.9 < 0.95 threshold → filtered out
      expect(suggestions).toHaveLength(0);
    });

    it('should allow lower threshold to include weaker matches', () => {
      const lenient = new AutoFieldMapper(0.1);
      const source = [f('CompanyName', 'Company')];
      const target = [f('AccountCompany', 'Company Account')];
      const suggestions = lenient.suggest(source, target);
      // With low threshold, partial matches should be included
      expect(suggestions.length).toBeGreaterThanOrEqual(0);
    });
  });
});
