import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SeedTemplateManager } from './SeedTemplateManager';
import type { GenerateIdFn, NowFn } from './SeedTemplateManager';
import type { SeedTemplateStore } from './SeedTemplateStore';
import type { SeedTemplate } from '@sandforge/shared';

function createTemplateInput(): Omit<SeedTemplate, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: 'Test Template',
    description: 'A test seed template',
    version: 1,
    strategy: 'faker',
    objects: [],
    tags: ['test'],
  };
}

describe('SeedTemplateManager', () => {
  let manager: SeedTemplateManager;
  let generateId: GenerateIdFn;
  let now: NowFn;
  let idCounter: number;

  beforeEach(() => {
    idCounter = 0;
    generateId = vi.fn<GenerateIdFn>(() => {
      idCounter++;
      return `id-${idCounter}`;
    });
    now = vi.fn<NowFn>().mockReturnValue('2026-01-15T10:00:00Z');
    manager = new SeedTemplateManager(generateId, now);
  });

  describe('create', () => {
    it('should create a template with auto-generated ID', () => {
      const template = manager.create(createTemplateInput());
      expect(template.id).toBe('id-1');
    });

    it('should set createdAt and updatedAt timestamps', () => {
      const template = manager.create(createTemplateInput());
      expect(template.createdAt).toBe('2026-01-15T10:00:00Z');
      expect(template.updatedAt).toBe('2026-01-15T10:00:00Z');
    });

    it('should preserve all input fields', () => {
      const input = createTemplateInput();
      const template = manager.create(input);
      expect(template.name).toBe('Test Template');
      expect(template.strategy).toBe('faker');
      expect(template.tags).toEqual(['test']);
    });

    it('should store the template for later retrieval', () => {
      const template = manager.create(createTemplateInput());
      const retrieved = manager.get(template.id);
      expect(retrieved).toEqual(template);
    });
  });

  describe('get', () => {
    it('should return undefined for non-existent ID', () => {
      expect(manager.get('non-existent')).toBeUndefined();
    });

    it('should return the correct template', () => {
      const t1 = manager.create({ ...createTemplateInput(), name: 'First' });
      manager.create({ ...createTemplateInput(), name: 'Second' });

      const retrieved = manager.get(t1.id);
      expect(retrieved?.name).toBe('First');
    });
  });

  describe('list', () => {
    it('should return empty array when no templates exist', () => {
      expect(manager.list()).toEqual([]);
    });

    it('should return all templates', () => {
      manager.create(createTemplateInput());
      manager.create(createTemplateInput());

      expect(manager.list()).toHaveLength(2);
    });

    it('should sort templates by updatedAt descending', () => {
      vi.mocked(now)
        .mockReturnValueOnce('2026-01-01T00:00:00Z')
        .mockReturnValueOnce('2026-01-03T00:00:00Z')
        .mockReturnValueOnce('2026-01-02T00:00:00Z');

      manager.create({ ...createTemplateInput(), name: 'Old' });
      manager.create({ ...createTemplateInput(), name: 'Newest' });
      manager.create({ ...createTemplateInput(), name: 'Middle' });

      const list = manager.list();
      expect(list[0].name).toBe('Newest');
      expect(list[1].name).toBe('Middle');
      expect(list[2].name).toBe('Old');
    });
  });

  describe('update', () => {
    it('should update the template fields', () => {
      const original = manager.create(createTemplateInput());
      const updated = manager.update(original.id, { name: 'Updated Name' });

      expect(updated.name).toBe('Updated Name');
    });

    it('should refresh the updatedAt timestamp', () => {
      const original = manager.create(createTemplateInput());

      vi.mocked(now).mockReturnValue('2026-02-01T00:00:00Z');
      const updated = manager.update(original.id, { name: 'New' });

      expect(updated.updatedAt).toBe('2026-02-01T00:00:00Z');
      expect(updated.createdAt).toBe(original.createdAt);
    });

    it('should not allow overwriting the ID', () => {
      const original = manager.create(createTemplateInput());
      const updated = manager.update(original.id, { id: 'hacked-id' } as Partial<SeedTemplate>);

      expect(updated.id).toBe(original.id);
    });

    it('should not allow overwriting createdAt', () => {
      const original = manager.create(createTemplateInput());
      const updated = manager.update(original.id, { createdAt: '1999-01-01T00:00:00Z' });

      expect(updated.createdAt).toBe(original.createdAt);
    });

    it('should throw for non-existent template', () => {
      expect(() => manager.update('fake-id', { name: 'X' })).toThrow('Template not found');
    });
  });

  describe('delete', () => {
    it('should return true when deleting an existing template', () => {
      const template = manager.create(createTemplateInput());
      expect(manager.delete(template.id)).toBe(true);
    });

    it('should return false when deleting a non-existent template', () => {
      expect(manager.delete('fake-id')).toBe(false);
    });

    it('should remove the template from the store', () => {
      const template = manager.create(createTemplateInput());
      manager.delete(template.id);
      expect(manager.get(template.id)).toBeUndefined();
    });
  });

  describe('duplicate', () => {
    it('should create a copy with a new ID', () => {
      const original = manager.create(createTemplateInput());
      const duplicate = manager.duplicate(original.id, 'Copy of Template');

      expect(duplicate.id).not.toBe(original.id);
      expect(duplicate.name).toBe('Copy of Template');
    });

    it('should reset version to 1', () => {
      const original = manager.create({ ...createTemplateInput(), version: 5 });
      const duplicate = manager.duplicate(original.id, 'Copy');

      expect(duplicate.version).toBe(1);
    });

    it('should set fresh timestamps', () => {
      manager.create(createTemplateInput());

      vi.mocked(now).mockReturnValue('2026-06-01T00:00:00Z');
      const duplicate = manager.duplicate('id-1', 'Copy');

      expect(duplicate.createdAt).toBe('2026-06-01T00:00:00Z');
      expect(duplicate.updatedAt).toBe('2026-06-01T00:00:00Z');
    });

    it('should throw for non-existent source template', () => {
      expect(() => manager.duplicate('fake-id', 'Copy')).toThrow('Template not found');
    });

    it('should preserve the original template unchanged', () => {
      const original = manager.create(createTemplateInput());
      manager.duplicate(original.id, 'Copy');

      const unchanged = manager.get(original.id);
      expect(unchanged?.name).toBe('Test Template');
    });
  });

  describe('with SeedTemplateStore (persistence)', () => {
    let mockStore: { save: ReturnType<typeof vi.fn>; load: ReturnType<typeof vi.fn>; list: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
    let persistedManager: SeedTemplateManager;

    beforeEach(() => {
      mockStore = {
        save: vi.fn(),
        load: vi.fn(),
        list: vi.fn().mockReturnValue([]),
        delete: vi.fn().mockReturnValue(true),
      };
      persistedManager = new SeedTemplateManager(generateId, now, mockStore as unknown as SeedTemplateStore);
    });

    it('should persist on create', () => {
      const template = persistedManager.create(createTemplateInput());
      expect(mockStore.save).toHaveBeenCalledWith(template);
    });

    it('should persist on update', () => {
      persistedManager.create(createTemplateInput());
      const updated = persistedManager.update('id-1', { name: 'Updated' });
      expect(mockStore.save).toHaveBeenCalledWith(updated);
    });

    it('should persist on duplicate', () => {
      persistedManager.create(createTemplateInput());
      const dup = persistedManager.duplicate('id-1', 'Copy');
      expect(mockStore.save).toHaveBeenCalledWith(dup);
    });

    it('should call store.delete on delete', () => {
      persistedManager.create(createTemplateInput());
      persistedManager.delete('id-1');
      expect(mockStore.delete).toHaveBeenCalledWith('id-1');
    });

    it('should fall back to store.load for cache miss', () => {
      const persisted: SeedTemplate = {
        id: 'ext-1',
        name: 'External',
        description: 'From store',
        version: 1,
        strategy: 'faker',
        objects: [],
        tags: [],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      };
      mockStore.load.mockReturnValue(persisted);

      const result = persistedManager.get('ext-1');
      expect(result).toEqual(persisted);
      expect(mockStore.load).toHaveBeenCalledWith('ext-1');
    });

    it('should return undefined when store also has no match', () => {
      mockStore.load.mockReturnValue(undefined);
      expect(persistedManager.get('ghost')).toBeUndefined();
    });
  });
});
