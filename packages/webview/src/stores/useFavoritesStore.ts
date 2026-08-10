import { create } from 'zustand';

import { getPersistedItem, setPersistedItem } from '../utils/webviewStorage';

/** State and actions for module favorites/bookmarks */
export interface FavoritesState {
  favorites: string[];
  toggle: (moduleId: string) => void;
  isFavorite: (moduleId: string) => boolean;
  clear: () => void;
}

const STORAGE_KEY = 'sf-favorites';

/** Load favorites from the persisted VS Code webview state */
function loadFavorites(): string[] {
  try {
    const stored = getPersistedItem(STORAGE_KEY);
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) {
        return parsed as string[];
      }
    }
  } catch {
    // Ignore parse errors
  }
  return [];
}

/** Persist favorites to the VS Code webview state */
function saveFavorites(favorites: string[]): void {
  try {
    setPersistedItem(STORAGE_KEY, JSON.stringify(favorites));
  } catch {
    // Ignore storage errors
  }
}

/** Zustand store for managing module favorites */
export const useFavoritesStore = create<FavoritesState>((set, get) => ({
  favorites: loadFavorites(),

  toggle(moduleId: string): void {
    set((state) => {
      const next = state.favorites.includes(moduleId)
        ? state.favorites.filter((id) => id !== moduleId)
        : [...state.favorites, moduleId];
      saveFavorites(next);
      return { favorites: next };
    });
  },

  isFavorite(moduleId: string): boolean {
    return get().favorites.includes(moduleId);
  },

  clear(): void {
    saveFavorites([]);
    set({ favorites: [] });
  },
}));
