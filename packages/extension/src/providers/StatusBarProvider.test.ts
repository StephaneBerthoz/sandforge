import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StatusBarProvider } from './StatusBarProvider';
import type { StatusBarItemConfig, StatusBarItemFactory } from './StatusBarProvider';

interface MockStatusBarItem {
  text: string;
  tooltip: string | undefined;
  command: string | undefined;
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

function createMockStatusBarItem(): MockStatusBarItem {
  return {
    text: '',
    tooltip: undefined,
    command: undefined,
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  };
}

describe('StatusBarProvider', () => {
  let provider: StatusBarProvider;
  let factory: ReturnType<typeof vi.fn>;
  let lastCreatedItem: MockStatusBarItem;

  beforeEach(() => {
    factory = vi.fn().mockImplementation(() => {
      lastCreatedItem = createMockStatusBarItem();
      return lastCreatedItem;
    });
    provider = new StatusBarProvider(factory as StatusBarItemFactory);
  });

  describe('setItem', () => {
    it('should create a new status bar item and show it', () => {
      const config: StatusBarItemConfig = {
        id: 'test-item',
        text: '$(cloud) SandForge',
      };

      provider.setItem(config);

      expect(factory).toHaveBeenCalledOnce();
      expect(lastCreatedItem.text).toBe('$(cloud) SandForge');
      expect(lastCreatedItem.show).toHaveBeenCalledOnce();
    });

    it('should pass left alignment (1) by default', () => {
      provider.setItem({ id: 'item', text: 'text' });

      expect(factory).toHaveBeenCalledWith(1, 100);
    });

    it('should pass right alignment (2) when configured', () => {
      provider.setItem({ id: 'item', text: 'text', alignment: 'right' });

      expect(factory).toHaveBeenCalledWith(2, 100);
    });

    it('should use the provided priority', () => {
      provider.setItem({ id: 'item', text: 'text', priority: 50 });

      expect(factory).toHaveBeenCalledWith(1, 50);
    });

    it('should set tooltip when provided', () => {
      provider.setItem({ id: 'item', text: 'text', tooltip: 'Hover text' });

      expect(lastCreatedItem.tooltip).toBe('Hover text');
    });

    it('should set command when provided', () => {
      provider.setItem({ id: 'item', text: 'text', command: 'sandforge.open' });

      expect(lastCreatedItem.command).toBe('sandforge.open');
    });

    it('should update an existing item without creating a new one', () => {
      provider.setItem({ id: 'item', text: 'Original' });
      const firstItem = lastCreatedItem;

      provider.setItem({ id: 'item', text: 'Updated' });

      expect(factory).toHaveBeenCalledOnce();
      expect(firstItem.text).toBe('Updated');
      expect(firstItem.show).toHaveBeenCalledTimes(2);
    });

    it('should not overwrite tooltip when not provided in update', () => {
      provider.setItem({ id: 'item', text: 'text', tooltip: 'Original tooltip' });

      provider.setItem({ id: 'item', text: 'updated text' });

      expect(lastCreatedItem.tooltip).toBe('Original tooltip');
    });
  });

  describe('removeItem', () => {
    it('should dispose the item and remove it from tracking', () => {
      provider.setItem({ id: 'item', text: 'text' });
      const item = lastCreatedItem;

      provider.removeItem('item');

      expect(item.dispose).toHaveBeenCalledOnce();
      expect(provider.getItemIds()).toEqual([]);
    });

    it('should do nothing for a non-existent id', () => {
      expect(() => provider.removeItem('nonexistent')).not.toThrow();
    });
  });

  describe('updateText', () => {
    it('should update the text of an existing item', () => {
      provider.setItem({ id: 'item', text: 'Original' });
      const item = lastCreatedItem;

      provider.updateText('item', 'New text');

      expect(item.text).toBe('New text');
    });

    it('should do nothing for a non-existent id', () => {
      expect(() => provider.updateText('nonexistent', 'text')).not.toThrow();
    });
  });

  describe('getItemIds', () => {
    it('should return empty array when no items exist', () => {
      expect(provider.getItemIds()).toEqual([]);
    });

    it('should return ids of all active items', () => {
      provider.setItem({ id: 'item-a', text: 'A' });
      provider.setItem({ id: 'item-b', text: 'B' });
      provider.setItem({ id: 'item-c', text: 'C' });

      const ids = provider.getItemIds();
      expect(ids).toHaveLength(3);
      expect(ids).toContain('item-a');
      expect(ids).toContain('item-b');
      expect(ids).toContain('item-c');
    });
  });

  describe('dispose', () => {
    it('should dispose all items and clear the registry', () => {
      provider.setItem({ id: 'item-a', text: 'A' });
      const itemA = lastCreatedItem;
      provider.setItem({ id: 'item-b', text: 'B' });
      const itemB = lastCreatedItem;

      provider.dispose();

      expect(itemA.dispose).toHaveBeenCalledOnce();
      expect(itemB.dispose).toHaveBeenCalledOnce();
      expect(provider.getItemIds()).toEqual([]);
    });

    it('should handle dispose when no items exist', () => {
      expect(() => provider.dispose()).not.toThrow();
    });
  });
});
