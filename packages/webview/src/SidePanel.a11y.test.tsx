import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SidePanel } from './SidePanel';
import { useRecentOpsStore } from './stores/useRecentOpsStore';
import { useOrgStore } from './stores/useOrgStore';
import { useFavoritesStore } from './stores/useFavoritesStore';

const mockPostMessage = vi.fn();
const mockSyncLanguage = vi.fn();

vi.mock('./i18n', () => ({
  syncLanguageFromSettings: (...args: unknown[]) => mockSyncLanguage(...args),
}));

vi.mock('./hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

/**
 * The side panel stacks three `nav` regions; without distinct accessible
 * names a screen reader announces "navigation" three times with no way to
 * tell them apart. This file guards the names only — behaviour lives in
 * SidePanel.test.tsx.
 */
describe('SidePanel navigation landmarks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRecentOpsStore.setState({ ops: [] });
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
    useFavoritesStore.setState({ favorites: ['forge'] });
  });

  it('should give every nav region a distinct accessible name', () => {
    render(<SidePanel />);
    const names = screen
      .getAllByRole('navigation')
      .map((nav) => nav.getAttribute('aria-label'))
      .filter((n): n is string => n !== null);

    expect(names).toEqual(expect.arrayContaining(['Favorites', 'Modules', 'Tools']));
    expect(new Set(names).size).toBe(names.length);
  });

  it('should name the favorites, modules and tools navs individually', () => {
    render(<SidePanel />);
    expect(screen.getByTestId('sidepanel-favorites').getAttribute('aria-label')).toBe('Favorites');
    expect(screen.getByTestId('sidepanel-modules').getAttribute('aria-label')).toBe('Modules');
    expect(screen.getByTestId('sidepanel-tools').getAttribute('aria-label')).toBe('Tools');
  });
});
