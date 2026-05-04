import { describe, it, expect } from 'vitest';
import { ReferenceLinker } from './ReferenceLinker';
import type { SeedObjectConfig } from '@sandforge/shared';

function createObject(
  name: string,
  references: Array<{ field: string; target: string }> = [],
): SeedObjectConfig {
  return {
    objectApiName: name,
    recordCount: 10,
    fieldRules: references.map((ref) => ({
      fieldApiName: ref.field,
      ruleType: 'reference' as const,
      config: { referenceObject: ref.target },
    })),
    excludedFields: [],
    insertOrder: 0,
    batchSize: 200,
  };
}

describe('ReferenceLinker', () => {
  let linker: ReferenceLinker;

  beforeEach(() => {
    linker = new ReferenceLinker();
  });

  describe('link', () => {
    it('should assign IDs from availableIds to each record', () => {
      const records = [{ Name: 'A' }, { Name: 'B' }];
      const result = linker.link(records, 'AccountId', 'Account', ['001A', '001B']);

      for (const record of result) {
        expect(['001A', '001B']).toContain(record['AccountId']);
      }
    });

    it('should not modify records when availableIds is empty', () => {
      const records = [{ Name: 'A' }];
      const result = linker.link(records, 'AccountId', 'Account', []);

      expect(result[0]['AccountId']).toBeUndefined();
      expect(result[0]['Name']).toBe('A');
    });

    it('should preserve existing record fields', () => {
      const records = [{ Name: 'Test', Email: 'test@example.com' }];
      const result = linker.link(records, 'AccountId', 'Account', ['001A']);

      expect(result[0]['Name']).toBe('Test');
      expect(result[0]['Email']).toBe('test@example.com');
      expect(result[0]['AccountId']).toBe('001A');
    });

    it('should handle single available ID', () => {
      const records = [{ Name: 'A' }, { Name: 'B' }, { Name: 'C' }];
      const result = linker.link(records, 'ParentId', 'Parent', ['001X']);

      for (const record of result) {
        expect(record['ParentId']).toBe('001X');
      }
    });

    it('should not mutate the original records', () => {
      const original = [{ Name: 'Original' }];
      linker.link(original, 'AccountId', 'Account', ['001A']);

      expect(original[0]).not.toHaveProperty('AccountId');
    });

    it('should handle empty records array', () => {
      const result = linker.link([], 'AccountId', 'Account', ['001A']);
      expect(result).toEqual([]);
    });
  });

  describe('resolveInsertOrder', () => {
    it('should place parent objects before children', () => {
      const objects = [
        createObject('Contact', [{ field: 'AccountId', target: 'Account' }]),
        createObject('Account'),
      ];

      const sorted = linker.resolveInsertOrder(objects);
      const names = sorted.map((o) => o.objectApiName);

      expect(names.indexOf('Account')).toBeLessThan(names.indexOf('Contact'));
    });

    it('should handle objects with no dependencies', () => {
      const objects = [createObject('Account'), createObject('Lead')];

      const sorted = linker.resolveInsertOrder(objects);
      expect(sorted).toHaveLength(2);
    });

    it('should handle deep dependency chains', () => {
      const objects = [
        createObject('Task', [{ field: 'ContactId', target: 'Contact' }]),
        createObject('Contact', [{ field: 'AccountId', target: 'Account' }]),
        createObject('Account'),
      ];

      const sorted = linker.resolveInsertOrder(objects);
      const names = sorted.map((o) => o.objectApiName);

      expect(names.indexOf('Account')).toBeLessThan(names.indexOf('Contact'));
      expect(names.indexOf('Contact')).toBeLessThan(names.indexOf('Task'));
    });

    it('should detect circular dependencies', () => {
      const objects = [
        createObject('A', [{ field: 'BId', target: 'B' }]),
        createObject('B', [{ field: 'AId', target: 'A' }]),
      ];

      expect(() => linker.resolveInsertOrder(objects)).toThrow('Circular dependency');
    });

    it('should handle self-referencing objects without crashing', () => {
      const objects = [createObject('Account', [{ field: 'ParentId', target: 'Account' }])];

      expect(() => linker.resolveInsertOrder(objects)).toThrow('Circular dependency');
    });

    it('should return empty array for empty input', () => {
      expect(linker.resolveInsertOrder([])).toEqual([]);
    });

    it('should handle multiple dependencies from one object', () => {
      const objects = [
        createObject('OpportunityContactRole', [
          { field: 'OpportunityId', target: 'Opportunity' },
          { field: 'ContactId', target: 'Contact' },
        ]),
        createObject('Opportunity'),
        createObject('Contact'),
      ];

      const sorted = linker.resolveInsertOrder(objects);
      const ocrIndex = sorted.findIndex((o) => o.objectApiName === 'OpportunityContactRole');
      const oppIndex = sorted.findIndex((o) => o.objectApiName === 'Opportunity');
      const conIndex = sorted.findIndex((o) => o.objectApiName === 'Contact');

      expect(oppIndex).toBeLessThan(ocrIndex);
      expect(conIndex).toBeLessThan(ocrIndex);
    });

    it('should handle references to objects not in the list', () => {
      const objects = [createObject('Contact', [{ field: 'AccountId', target: 'Account' }])];

      const sorted = linker.resolveInsertOrder(objects);
      expect(sorted).toHaveLength(1);
    });
  });
});
