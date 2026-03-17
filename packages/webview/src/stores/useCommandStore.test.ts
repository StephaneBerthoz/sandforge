import { describe, it, expect, beforeEach } from 'vitest';
import { useCommandStore } from './useCommandStore';
import type { CommandItem } from './useCommandStore';

/** Helper to create a command item with sensible defaults. */
function makeItem(overrides: Partial<CommandItem> & { id: string }): CommandItem {
  return {
    label: overrides.id,
    group: 'navigate',
    action: () => undefined,
    ...overrides,
  };
}

describe('useCommandStore', () => {
  beforeEach(() => {
    useCommandStore.setState({ open: false, items: [] });
  });

  it('should default to closed with empty items', () => {
    const state = useCommandStore.getState();
    expect(state.open).toBe(false);
    expect(state.items).toEqual([]);
  });

  describe('setOpen', () => {
    it('should set open to true', () => {
      useCommandStore.getState().setOpen(true);
      expect(useCommandStore.getState().open).toBe(true);
    });

    it('should set open to false', () => {
      useCommandStore.setState({ open: true });
      useCommandStore.getState().setOpen(false);
      expect(useCommandStore.getState().open).toBe(false);
    });
  });

  describe('toggle', () => {
    it('should toggle from false to true', () => {
      useCommandStore.getState().toggle();
      expect(useCommandStore.getState().open).toBe(true);
    });

    it('should toggle from true to false', () => {
      useCommandStore.setState({ open: true });
      useCommandStore.getState().toggle();
      expect(useCommandStore.getState().open).toBe(false);
    });
  });

  describe('registerItems', () => {
    it('should add new items', () => {
      const items = [makeItem({ id: 'a' }), makeItem({ id: 'b' })];
      useCommandStore.getState().registerItems(items);
      expect(useCommandStore.getState().items).toHaveLength(2);
    });

    it('should deduplicate items by id', () => {
      const first = [makeItem({ id: 'a', label: 'Alpha' })];
      const second = [makeItem({ id: 'a', label: 'Alpha Updated' })];
      useCommandStore.getState().registerItems(first);
      useCommandStore.getState().registerItems(second);
      const state = useCommandStore.getState();
      expect(state.items).toHaveLength(1);
      expect(state.items[0].label).toBe('Alpha Updated');
    });

    it('should keep existing items when adding new ones', () => {
      useCommandStore.getState().registerItems([makeItem({ id: 'a' })]);
      useCommandStore.getState().registerItems([makeItem({ id: 'b' })]);
      expect(useCommandStore.getState().items).toHaveLength(2);
    });
  });

  describe('removeItems', () => {
    it('should remove items by id', () => {
      useCommandStore
        .getState()
        .registerItems([makeItem({ id: 'a' }), makeItem({ id: 'b' }), makeItem({ id: 'c' })]);
      useCommandStore.getState().removeItems(['a', 'c']);
      const state = useCommandStore.getState();
      expect(state.items).toHaveLength(1);
      expect(state.items[0].id).toBe('b');
    });

    it('should handle removing non-existent ids gracefully', () => {
      useCommandStore.getState().registerItems([makeItem({ id: 'a' })]);
      useCommandStore.getState().removeItems(['nonexistent']);
      expect(useCommandStore.getState().items).toHaveLength(1);
    });
  });
});
