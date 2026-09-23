import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import en from './i18n/locales/en.json';
import fr from './i18n/locales/fr.json';
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

/**
 * The star beside each module was named by its title alone, "Add to
 * favorites" on every row: a screen reader heard the same button once per
 * module, and never whether that module was a favourite already.
 */
describe('SidePanel favourite stars', () => {
  /** The panel, with the catalogue of a language. */
  const renderIn = async (lng: 'en' | 'fr'): Promise<void> => {
    const i18n = createInstance();
    await i18n.init({
      lng,
      resources: { en: { translation: en }, fr: { translation: fr } },
      interpolation: { escapeValue: false },
    });
    render(
      <I18nextProvider i18n={i18n}>
        <SidePanel />
      </I18nextProvider>,
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useRecentOpsStore.setState({ ops: [] });
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
    useFavoritesStore.setState({ favorites: ['compare'] });
  });

  it('names each star of the modules list after its module, and says whether it is pressed', async () => {
    await renderIn('en');
    const modules = within(screen.getByTestId('sidepanel-modules'));

    expect(modules.getByRole('button', { name: 'Monitor in favorites', pressed: false })).toBe(
      screen.getByTestId('sidepanel-star-monitor'),
    );
    expect(modules.getByRole('button', { name: 'Compare Org in favorites', pressed: true })).toBe(
      screen.getByTestId('sidepanel-star-compare'),
    );
    const stars = modules
      .getAllByRole('button')
      .filter((button) => button.getAttribute('data-testid')?.startsWith('sidepanel-star-'));
    const names = stars.map((star) => star.getAttribute('aria-label'));
    expect(stars.length).toBeGreaterThan(5);
    expect(new Set(names).size).toBe(stars.length);
  });

  it('presses the star once the module is a favourite, and names the one under Favorites too', async () => {
    await renderIn('en');
    fireEvent.click(screen.getByTestId('sidepanel-star-monitor'));

    expect(screen.getByTestId('sidepanel-star-monitor').getAttribute('aria-pressed')).toBe('true');
    const favourites = within(screen.getByTestId('sidepanel-favorites'));
    expect(favourites.getByRole('button', { name: 'Monitor in favorites', pressed: true })).toBe(
      screen.getByTestId('sidepanel-fav-star-monitor'),
    );
  });

  it('names a star in the language of the panel', async () => {
    await renderIn('fr');
    expect(screen.getByTestId('sidepanel-star-monitor').getAttribute('aria-label')).toBe(
      'Moniteur dans les favoris',
    );
  });
});
