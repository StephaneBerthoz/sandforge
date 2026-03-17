import { describe, it, expect, beforeEach } from 'vitest';
import { IdRemapper } from './IdRemapper.js';

describe('IdRemapper', () => {
  let remapper: IdRemapper;

  beforeEach(() => {
    remapper = new IdRemapper();
  });

  describe('add / get', () => {
    it('should store and retrieve a mapping', () => {
      remapper.add('001OLD', '001NEW');
      expect(remapper.get('001OLD')).toBe('001NEW');
    });

    it('should return undefined for unmapped IDs', () => {
      expect(remapper.get('001UNKNOWN')).toBeUndefined();
    });

    it('should overwrite an existing mapping', () => {
      remapper.add('001OLD', '001NEW1');
      remapper.add('001OLD', '001NEW2');
      expect(remapper.get('001OLD')).toBe('001NEW2');
    });
  });

  describe('remapRecord', () => {
    it('should remap lookup fields that exist in the map', () => {
      remapper.add('001PARENT', '001NEWPARENT');
      const record = { Name: 'Test', AccountId: '001PARENT', OwnerId: '005OWNER' };
      const result = remapper.remapRecord(record, ['AccountId', 'OwnerId']);
      expect(result.AccountId).toBe('001NEWPARENT');
      expect(result.OwnerId).toBe('005OWNER'); // not mapped, stays unchanged
    });

    it('should leave non-lookup fields unchanged', () => {
      remapper.add('001PARENT', '001NEWPARENT');
      const record = { Name: 'Test', AccountId: '001PARENT', Amount: 100 };
      const result = remapper.remapRecord(record, ['AccountId']);
      expect(result.Name).toBe('Test');
      expect(result.Amount).toBe(100);
    });

    it('should not modify the original record', () => {
      remapper.add('001PARENT', '001NEWPARENT');
      const original = { AccountId: '001PARENT' };
      remapper.remapRecord(original, ['AccountId']);
      expect(original.AccountId).toBe('001PARENT');
    });

    it('should handle null and non-string lookup values', () => {
      const record = { ParentId: null, RefId: 42 };
      const result = remapper.remapRecord(record, ['ParentId', 'RefId']);
      expect(result.ParentId).toBeNull();
      expect(result.RefId).toBe(42);
    });

    it('should handle empty lookup fields array', () => {
      remapper.add('001X', '001Y');
      const record = { AccountId: '001X', Name: 'Test' };
      const result = remapper.remapRecord(record, []);
      expect(result.AccountId).toBe('001X');
    });
  });

  describe('count', () => {
    it('should return 0 for empty remapper', () => {
      expect(remapper.count).toBe(0);
    });

    it('should return correct count after adding mappings', () => {
      remapper.add('001A', '001B');
      remapper.add('002A', '002B');
      expect(remapper.count).toBe(2);
    });

    it('should not double-count overwritten keys', () => {
      remapper.add('001A', '001B');
      remapper.add('001A', '001C');
      expect(remapper.count).toBe(1);
    });
  });

  describe('clear', () => {
    it('should remove all mappings', () => {
      remapper.add('001A', '001B');
      remapper.add('002A', '002B');
      remapper.clear();
      expect(remapper.count).toBe(0);
      expect(remapper.get('001A')).toBeUndefined();
    });
  });

  describe('serialization', () => {
    it('should serialize to JSON', () => {
      const r = new IdRemapper();
      r.add('OLD1', 'NEW1');
      r.add('OLD2', 'NEW2');
      const json = r.toJSON();
      expect(json).toEqual({ OLD1: 'NEW1', OLD2: 'NEW2' });
    });

    it('should deserialize from JSON', () => {
      const r = IdRemapper.fromJSON({ OLD1: 'NEW1', OLD2: 'NEW2' });
      expect(r.get('OLD1')).toBe('NEW1');
      expect(r.get('OLD2')).toBe('NEW2');
      expect(r.count).toBe(2);
    });

    it('should round-trip correctly', () => {
      const original = new IdRemapper();
      original.add('A', 'B');
      original.add('C', 'D');
      const restored = IdRemapper.fromJSON(original.toJSON());
      expect(restored.get('A')).toBe('B');
      expect(restored.get('C')).toBe('D');
      expect(restored.count).toBe(2);
    });
  });
});
