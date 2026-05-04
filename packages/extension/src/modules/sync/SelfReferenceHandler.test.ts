import { describe, it, expect, beforeEach } from 'vitest';
import { SelfReferenceHandler } from './SelfReferenceHandler';

describe('SelfReferenceHandler', () => {
  let handler: SelfReferenceHandler;

  beforeEach(() => {
    handler = new SelfReferenceHandler();
  });

  describe('sortForInsert', () => {
    it('should place parent records before children', () => {
      const records = [
        { Id: 'child-1', Name: 'Child', ParentId: 'parent-1' },
        { Id: 'parent-1', Name: 'Parent', ParentId: null },
      ];

      const sorted = handler.sortForInsert(records, 'ParentId');

      const parentIndex = sorted.findIndex((r) => r.Id === 'parent-1');
      const childIndex = sorted.findIndex((r) => r.Id === 'child-1');
      expect(parentIndex).toBeLessThan(childIndex);
    });

    it('should handle multi-level hierarchy', () => {
      const records = [
        { Id: 'grandchild-1', Name: 'GC', ParentId: 'child-1' },
        { Id: 'parent-1', Name: 'Parent', ParentId: null },
        { Id: 'child-1', Name: 'Child', ParentId: 'parent-1' },
      ];

      const sorted = handler.sortForInsert(records, 'ParentId');
      const ids = sorted.map((r) => r.Id);

      expect(ids.indexOf('parent-1')).toBeLessThan(ids.indexOf('child-1'));
      expect(ids.indexOf('child-1')).toBeLessThan(ids.indexOf('grandchild-1'));
    });

    it('should place records with no parent first', () => {
      const records = [
        { Id: 'child-1', Name: 'Child', ParentId: 'root-1' },
        { Id: 'root-1', Name: 'Root', ParentId: null },
        { Id: 'root-2', Name: 'Root 2', ParentId: null },
      ];

      const sorted = handler.sortForInsert(records, 'ParentId');

      expect(sorted[0].ParentId).toBeNull();
    });

    it('should handle records with no self-reference field', () => {
      const records = [
        { Id: 'a1', Name: 'A' },
        { Id: 'a2', Name: 'B' },
      ];

      const sorted = handler.sortForInsert(records, 'ParentId');

      expect(sorted).toHaveLength(2);
    });

    it('should handle empty records array', () => {
      const sorted = handler.sortForInsert([], 'ParentId');

      expect(sorted).toEqual([]);
    });

    it('should handle circular references without infinite loop', () => {
      const records = [
        { Id: 'a', Name: 'A', ParentId: 'b' },
        { Id: 'b', Name: 'B', ParentId: 'a' },
      ];

      const sorted = handler.sortForInsert(records, 'ParentId');

      expect(sorted).toHaveLength(2);
    });

    it('should handle orphan records whose parent is not in the set', () => {
      const records = [{ Id: 'child-1', Name: 'Orphan', ParentId: 'missing-parent' }];

      const sorted = handler.sortForInsert(records, 'ParentId');

      expect(sorted).toHaveLength(1);
      expect(sorted[0].Id).toBe('child-1');
    });

    it('should handle multiple independent trees', () => {
      const records = [
        { Id: 'tree1-child', Name: 'T1C', ParentId: 'tree1-root' },
        { Id: 'tree2-root', Name: 'T2R', ParentId: null },
        { Id: 'tree1-root', Name: 'T1R', ParentId: null },
        { Id: 'tree2-child', Name: 'T2C', ParentId: 'tree2-root' },
      ];

      const sorted = handler.sortForInsert(records, 'ParentId');
      const ids = sorted.map((r) => r.Id);

      expect(ids.indexOf('tree1-root')).toBeLessThan(ids.indexOf('tree1-child'));
      expect(ids.indexOf('tree2-root')).toBeLessThan(ids.indexOf('tree2-child'));
    });

    it('should preserve all record fields', () => {
      const records = [{ Id: 'a1', Name: 'Acme', Industry: 'Tech', ParentId: null }];

      const sorted = handler.sortForInsert(records, 'ParentId');

      expect(sorted[0]).toEqual(records[0]);
    });
  });

  describe('remapIds', () => {
    it('should replace parent IDs using the ID map', () => {
      const records = [{ Id: 'new-child', Name: 'Child', ParentId: 'old-parent' }];
      const idMap = new Map([['old-parent', 'new-parent']]);

      const result = handler.remapIds(records, 'ParentId', idMap);

      expect(result[0].ParentId).toBe('new-parent');
    });

    it('should leave unmapped IDs unchanged', () => {
      const records = [{ Id: 'child', Name: 'Child', ParentId: 'unknown-parent' }];
      const idMap = new Map<string, string>();

      const result = handler.remapIds(records, 'ParentId', idMap);

      expect(result[0].ParentId).toBe('unknown-parent');
    });

    it('should not modify records with null parent', () => {
      const records = [{ Id: 'root', Name: 'Root', ParentId: null }];
      const idMap = new Map<string, string>();

      const result = handler.remapIds(records, 'ParentId', idMap);

      expect(result[0].ParentId).toBeNull();
    });

    it('should not modify original records', () => {
      const records = [{ Id: 'child', Name: 'Child', ParentId: 'old-parent' }];
      const idMap = new Map([['old-parent', 'new-parent']]);

      handler.remapIds(records, 'ParentId', idMap);

      expect(records[0].ParentId).toBe('old-parent');
    });

    it('should handle empty records array', () => {
      const result = handler.remapIds([], 'ParentId', new Map());

      expect(result).toEqual([]);
    });
  });
});
