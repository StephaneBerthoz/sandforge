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
      // Two sources compete for the single target: the first to claim it wins
      // and the second is left unmapped, never a duplicate write to `Name`.
      const source = [f('Name', 'Name'), f('Name__c', 'Name')];
      const target = [f('Name', 'Name')];
      const suggestions = mapper.suggest(source, target);
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0].sourceField).toBe('Name');
      expect(suggestions[0].targetField).toBe('Name');
    });

    it('should return suggestions sorted by confidence', () => {
      const source = [f('XYZ__c', 'xyz'), f('Name', 'Name')];
      const target = [f('Name', 'Name'), f('XYZ', 'XYZ')];
      const suggestions = mapper.suggest(source, target);
      // Both match, and the weaker one is listed second — the order the
      // mapping table shows them in.
      expect(suggestions).toHaveLength(2);
      expect(suggestions.map((s) => s.sourceField)).toEqual(['Name', 'XYZ__c']);
      expect(suggestions.map((s) => s.confidence)).toEqual([1.0, 0.9]);
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
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0].type).toBe('rename');
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

    it('should keep a match sitting exactly on the threshold', () => {
      // The gate is `>=`: a 0.9 normalized-name match survives a 0.9 floor.
      // At `>` the same pair would silently drop out of the mapping table.
      const onTheLine = new AutoFieldMapper(0.9);
      const source = [f('Status__c', 'Status')];
      const target = [f('Status', 'Status')];
      const suggestions = onTheLine.suggest(source, target);
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0].confidence).toBe(0.9);
    });
  });
});

describe('a label match never outruns the field-type precheck', () => {
  const mapper = new AutoFieldMapper();

  it('refuses to map a picklist onto a checkbox that shares its label', () => {
    // `Active__c` (picklist, "Active") and `IsActive` (boolean, "Active") score
    // 1.0 on label. The mapper used to emit the pair and the run then refused
    // itself over a mapping nobody typed — on a Quick Sync with no mapping UI.
    const suggestions = mapper.suggest(
      [f('Active__c', 'Active', 'picklist')],
      [f('IsActive', 'Active', 'boolean')],
    );
    expect(suggestions.map((s) => s.reason)).not.toContain('label_match');
  });

  it('still maps a label match when the types fit', () => {
    const suggestions = mapper.suggest(
      [f('Active__c', 'Active', 'picklist')],
      [f('Etat__c', 'Active', 'string')],
    );
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].reason).toBe('label_match');
    expect(suggestions[0].targetField).toBe('Etat__c');
  });
});
