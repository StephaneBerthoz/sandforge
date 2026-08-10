import { describe, it, expect, vi, beforeEach } from 'vitest';

/* In-memory mock of the webview state persistence layer. */
const mockPersistedState = vi.hoisted(() => {
  const store: Record<string, string> = {};
  return {
    store,
    reset(): void {
      for (const key of Object.keys(store)) {
        delete store[key];
      }
    },
  };
});

vi.mock('../utils/webviewStorage', () => ({
  getPersistedItem: (key: string): string | null => mockPersistedState.store[key] ?? null,
  setPersistedItem: (key: string, value: string): void => {
    mockPersistedState.store[key] = value;
  },
  removePersistedItem: (key: string): void => {
    delete mockPersistedState.store[key];
  },
}));

import { useFavoritesStore } from './useFavoritesStore';

describe('useFavoritesStore', () => {
  beforeEach(() => {
    useFavoritesStore.setState({ favorites: [] });
    mockPersistedState.reset();
  });

  it('starts with empty favorites', () => {
    expect(useFavoritesStore.getState().favorites).toEqual([]);
  });

  it('toggles a module as favorite', () => {
    useFavoritesStore.getState().toggle('monitor');
    expect(useFavoritesStore.getState().favorites).toEqual(['monitor']);
  });

  it('toggles off a favorite', () => {
    useFavoritesStore.getState().toggle('monitor');
    useFavoritesStore.getState().toggle('monitor');
    expect(useFavoritesStore.getState().favorites).toEqual([]);
  });

  it('supports multiple favorites', () => {
    useFavoritesStore.getState().toggle('monitor');
    useFavoritesStore.getState().toggle('seed');
    expect(useFavoritesStore.getState().favorites).toEqual(['monitor', 'seed']);
  });

  it('checks if module is favorite', () => {
    useFavoritesStore.getState().toggle('sync');
    expect(useFavoritesStore.getState().isFavorite('sync')).toBe(true);
    expect(useFavoritesStore.getState().isFavorite('monitor')).toBe(false);
  });

  it('clears all favorites', () => {
    useFavoritesStore.getState().toggle('monitor');
    useFavoritesStore.getState().toggle('seed');
    useFavoritesStore.getState().clear();
    expect(useFavoritesStore.getState().favorites).toEqual([]);
  });

  it('persists to the webview state on toggle', () => {
    useFavoritesStore.getState().toggle('monitor');
    expect(mockPersistedState.store['sf-favorites']).toBe(JSON.stringify(['monitor']));
  });
});
