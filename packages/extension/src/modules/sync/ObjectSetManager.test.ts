import { describe, it, expect, beforeEach } from 'vitest';
import { ObjectSetManager } from './ObjectSetManager';

describe('ObjectSetManager', () => {
  let manager: ObjectSetManager;

  beforeEach(() => {
    manager = new ObjectSetManager();
  });

  describe('create', () => {
    it('should create an object set with unique ID', () => {
      const set = manager.create('Core Objects', ['Account', 'Contact']);

      expect(set.id).toBe('objset-1');
      expect(set.name).toBe('Core Objects');
      expect(set.objects).toEqual(['Account', 'Contact']);
    });

    it('should assign incremental IDs', () => {
      const first = manager.create('Set A', ['Account']);
      const second = manager.create('Set B', ['Contact']);

      expect(first.id).toBe('objset-1');
      expect(second.id).toBe('objset-2');
    });

    it('should set createdAt timestamp', () => {
      const set = manager.create('Test', ['Account']);

      expect(set.createdAt).toBeDefined();
      expect(new Date(set.createdAt).getTime()).not.toBeNaN();
    });

    it('should create a copy of the objects array', () => {
      const objects = ['Account', 'Contact'];
      const set = manager.create('Test', objects);

      objects.push('Lead');

      expect(set.objects).toEqual(['Account', 'Contact']);
    });

    it('should handle empty objects array', () => {
      const set = manager.create('Empty', []);

      expect(set.objects).toEqual([]);
    });
  });

  describe('get', () => {
    it('should retrieve an existing object set by ID', () => {
      const created = manager.create('Test', ['Account']);
      const retrieved = manager.get(created.id);

      expect(retrieved).toEqual(created);
    });

    it('should return undefined for non-existent ID', () => {
      expect(manager.get('non-existent')).toBeUndefined();
    });

    it('should return the correct set among multiple', () => {
      manager.create('Set A', ['Account']);
      const setB = manager.create('Set B', ['Contact']);
      manager.create('Set C', ['Lead']);

      expect(manager.get(setB.id)?.name).toBe('Set B');
    });
  });

  describe('list', () => {
    it('should return empty array when no sets exist', () => {
      expect(manager.list()).toEqual([]);
    });

    it('should return all created sets', () => {
      manager.create('Set A', ['Account']);
      manager.create('Set B', ['Contact']);

      expect(manager.list()).toHaveLength(2);
    });

    it('should return a copy of the sets array', () => {
      manager.create('Test', ['Account']);
      const first = manager.list();
      const second = manager.list();

      expect(first).not.toBe(second);
    });
  });

  describe('delete', () => {
    it('should remove an object set and return true', () => {
      const set = manager.create('Test', ['Account']);
      const deleted = manager.delete(set.id);

      expect(deleted).toBe(true);
      expect(manager.get(set.id)).toBeUndefined();
    });

    it('should return false for non-existent ID', () => {
      expect(manager.delete('non-existent')).toBe(false);
    });

    it('should only remove the specified set', () => {
      manager.create('Set A', ['Account']);
      const setB = manager.create('Set B', ['Contact']);

      manager.delete(setB.id);

      expect(manager.list()).toHaveLength(1);
      expect(manager.list()[0].name).toBe('Set A');
    });
  });
});
