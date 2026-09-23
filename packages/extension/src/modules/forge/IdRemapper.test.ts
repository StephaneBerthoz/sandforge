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

  describe('records the target already held', () => {
    it('remaps children onto an existing record like onto a created one', () => {
      remapper.addExisting('001OLD', '001EXISTING');

      expect(remapper.get('001OLD')).toBe('001EXISTING');
      expect(remapper.remapRecord({ AccountId: '001OLD' }, ['AccountId']).AccountId).toBe(
        '001EXISTING',
      );
    });

    it('tells an existing record apart from one the run created', () => {
      remapper.add('001A', '001CREATED');
      remapper.addExisting('001B', '001EXISTING');

      expect(remapper.isExisting('001A')).toBe(false);
      expect(remapper.isExisting('001B')).toBe(true);
      expect(remapper.existingSourceIds()).toEqual(['001B']);
      expect(remapper.count).toBe(2);
    });

    it('stops calling a record existing once the run created it after all', () => {
      remapper.addExisting('001B', '001EXISTING');
      remapper.add('001B', '001CREATED');

      expect(remapper.isExisting('001B')).toBe(false);
      expect(remapper.existingSourceIds()).toEqual([]);
    });

    it('forgets existing records on clear', () => {
      remapper.addExisting('001B', '001EXISTING');
      remapper.clear();

      expect(remapper.existingSourceIds()).toEqual([]);
    });
  });

  describe('records an upsert matched by their external id', () => {
    it('remaps children onto the record the upsert wrote over', () => {
      remapper.addUpdated('001A', '001MATCHED', 'Account');

      expect(remapper.get('001A')).toBe('001MATCHED');
      expect(remapper.remapRecord({ AccountId: '001A' }, ['AccountId']).AccountId).toBe(
        '001MATCHED',
      );
    });

    it('counts them as updated, apart from the rows the run created and the ones it linked', () => {
      remapper.add('001A', '001CREATED', 'Account');
      remapper.addUpdated('001B', '001MATCHED', 'Account');
      remapper.addExisting('001C', '001EXISTING', 'Account');
      remapper.add('003A', '003CREATED', 'Contact');

      expect(remapper.countsByObject()).toEqual([
        { objectApiName: 'Account', created: 1, linked: 1, updated: 1 },
        { objectApiName: 'Contact', created: 1, linked: 0 },
      ]);
    });

    it('never lists them among the rows the run created', () => {
      remapper.add('001A', '001CREATED', 'Account');
      remapper.addUpdated('001B', '001MATCHED', 'Account');
      remapper.addUpdated('003A', '003MATCHED', 'Contact');

      expect(remapper.createdByObject()).toEqual([
        { objectApiName: 'Account', sourceIds: ['001A'] },
      ]);
    });

    it('names them, in the order they were registered', () => {
      remapper.add('001A', '001CREATED', 'Account');
      remapper.addUpdated('003B', '003MATCHED', 'Contact');
      remapper.addUpdated('001C', '001MATCHED', 'Account');

      expect(remapper.updatedSourceIds()).toEqual(['003B', '001C']);
    });

    it('counts a matched row the run created after all as created', () => {
      remapper.addUpdated('001A', '001MATCHED', 'Account');
      remapper.add('001A', '001CREATED', 'Account');

      expect(remapper.createdByObject()).toEqual([
        { objectApiName: 'Account', sourceIds: ['001A'] },
      ]);
    });
  });

  describe('counted by object', () => {
    it('counts, per object, the rows the run created and the ones it linked', () => {
      remapper.add('001A', '001CREATED1', 'Account');
      remapper.add('001B', '001CREATED2', 'Account');
      remapper.addExisting('001C', '001EXISTING', 'Account');
      remapper.add('003A', '003CREATED', 'Contact');

      expect(remapper.countsByObject()).toEqual([
        { objectApiName: 'Account', created: 2, linked: 1 },
        { objectApiName: 'Contact', created: 1, linked: 0 },
      ]);
    });

    it('leaves out a mapping registered without its object: nothing was written there', () => {
      // Reference data matched by name, the standard price book: mapped so
      // their children point at the right row, never cloned.
      remapper.add('01sSTANDARD', '01sTARGET');
      remapper.add('001A', '001CREATED', 'Account');

      expect(remapper.countsByObject()).toEqual([
        { objectApiName: 'Account', created: 1, linked: 0 },
      ]);
      expect(remapper.count).toBe(2);
    });

    it('counts a row once, as what it finally became', () => {
      remapper.addExisting('001A', '001EXISTING', 'Account');
      remapper.add('001A', '001CREATED', 'Account');

      expect(remapper.countsByObject()).toEqual([
        { objectApiName: 'Account', created: 1, linked: 0 },
      ]);
    });

    it('forgets the objects on clear', () => {
      remapper.add('001A', '001CREATED', 'Account');
      remapper.clear();

      expect(remapper.countsByObject()).toEqual([]);
    });
  });

  describe('created by object', () => {
    it('lists, per object, the rows the run created, in the order it wrote them', () => {
      remapper.add('001A', '001CREATED1', 'Account');
      remapper.add('003A', '003CREATED1', 'Contact');
      remapper.add('001B', '001CREATED2', 'Account');
      remapper.add('003B', '003CREATED2', 'Contact');

      expect(remapper.createdByObject()).toEqual([
        { objectApiName: 'Account', sourceIds: ['001A', '001B'] },
        { objectApiName: 'Contact', sourceIds: ['003A', '003B'] },
      ]);
    });

    it('leaves out the rows it linked and the mappings it only found', () => {
      remapper.add('01sSTANDARD', '01sTARGET');
      remapper.addExisting('001A', '001EXISTING', 'Account');
      remapper.add('001B', '001CREATED', 'Account');
      remapper.addExisting('003A', '003EXISTING', 'Contact');

      expect(remapper.createdByObject()).toEqual([
        { objectApiName: 'Account', sourceIds: ['001B'] },
      ]);
    });

    it('counts a linked row the run wrote after all as created', () => {
      remapper.addExisting('001A', '001EXISTING', 'Account');
      remapper.add('001A', '001CREATED', 'Account');

      expect(remapper.createdByObject()).toEqual([
        { objectApiName: 'Account', sourceIds: ['001A'] },
      ]);
    });
  });

  describe('isCreated', () => {
    it('says created only of a record this run wrote', () => {
      remapper.add('001A', '001CREATED', 'Account');
      remapper.addExisting('001B', '001EXISTING', 'Account');
      remapper.addUpdated('001C', '001MATCHED', 'Account');

      expect(remapper.isCreated('001A')).toBe(true);
      expect(remapper.isCreated('001B')).toBe(false);
      expect(remapper.isCreated('001C')).toBe(false);
      expect(remapper.isCreated('001UNMAPPED')).toBe(false);
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
