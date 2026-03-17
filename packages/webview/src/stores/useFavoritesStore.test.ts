import { describe, it, expect, beforeEach } from 'vitest';
import { useFavoritesStore } from './useFavoritesStore';

describe('useFavoritesStore', () => {
  beforeEach(() => {
    useFavoritesStore.setState({ favorites: [] });
    sessionStorage.clear();
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

  it('persists to sessionStorage on toggle', () => {
    useFavoritesStore.getState().toggle('monitor');
    const stored = sessionStorage.getItem('sf-favorites');
    expect(stored).toBe(JSON.stringify(['monitor']));
  });
});
