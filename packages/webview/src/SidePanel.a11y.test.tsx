import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import en from './i18n/locales/en.json';
import fr from './i18n/locales/fr.json';
import de from './i18n/locales/de.json';
import { SidePanel } from './SidePanel';
import { useRecentOpsStore } from './stores/useRecentOpsStore';
import { useOrgStore } from './stores/useOrgStore';
import { useFavoritesStore } from './stores/useFavoritesStore';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';

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
    useFavoritesStore.setState({ favorites: ['sync'] });
  });

  it('names each star of the modules list after its module, and says whether it is pressed', async () => {
    await renderIn('en');
    const modules = within(screen.getByTestId('sidepanel-modules'));

    expect(modules.getByRole('button', { name: 'Monitor in favorites', pressed: false })).toBe(
      screen.getByTestId('sidepanel-star-monitor'),
    );
    expect(modules.getByRole('button', { name: 'Sync in favorites', pressed: true })).toBe(
      screen.getByTestId('sidepanel-star-sync'),
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

/**
 * The last operation's status was an icon and nothing else: its shape and
 * colour said it, and a screen reader read the operation's label and time
 * with nothing of how it ended.
 */
describe('SidePanel last operation status', () => {
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

  /** A last operation that ended this way a minute ago. */
  const endedAs = (status: 'success' | 'failed' | 'cancelled'): void => {
    useRecentOpsStore.setState({
      ops: [
        {
          id: 'op-1',
          type: 'seed',
          label: 'Seed data generation',
          status,
          timestamp: Date.now() - 60_000,
        },
      ],
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
    useFavoritesStore.setState({ favorites: [] });
  });

  it.each([
    ['success', 'Succeeded'],
    ['failed', 'Failed'],
    ['cancelled', 'Cancelled'],
  ] as const)('names a %s operation by how it ended', async (status, name) => {
    endedAs(status);
    await renderIn('en');

    const lastOp = within(screen.getByTestId('sidepanel-last-op'));
    expect(lastOp.getByRole('img', { name })).toBe(screen.getByTestId(`op-status-${status}`));
  });

  it('names the status in the language of the panel', async () => {
    endedAs('cancelled');
    await renderIn('fr');

    expect(screen.getByTestId('op-status-cancelled').getAttribute('aria-label')).toBe('Annulée');
  });
});

/**
 * The launcher's import button counted the CLI's authorization files, and the
 * import keeps only the orgs whose session still holds: "Import 3 orgs" could
 * bring in two. It names the most it can bring in, in every language.
 */
describe('SidePanel first org import', () => {
  /** The panel, with the catalogue of a language, told how many orgs the CLI holds. */
  const renderWith = async (lng: 'en' | 'fr', count: number): Promise<void> => {
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
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'org:list:response', payload: { orgs: [], selectedOrgId: null } },
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', { data: { type: 'sidebar:cliOrgs', payload: { count } } }),
      );
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useRecentOpsStore.setState({ ops: [] });
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
    useFavoritesStore.setState({ favorites: [] });
  });

  it('names the import by the most orgs it can bring in, not as a count of what it will', async () => {
    await renderWith('en', 3);
    expect(screen.getByTestId('sidepanel-first-org-import').textContent).toBe(
      'Import up to 3 orgs from the Salesforce CLI',
    );
  });

  it('says so in the language of the panel', async () => {
    await renderWith('fr', 1);
    expect(screen.getByTestId('sidepanel-first-org-import').textContent).toBe(
      "Importer jusqu'à 1 org depuis la Salesforce CLI",
    );
  });
});

/**
 * The org switcher: a disclosure over the launcher. It announced a listbox,
 * told the connection and the org picked by colour alone, and dropped the
 * focus with the option picked.
 */
describe('SidePanel org switcher', () => {
  const org = (id: string, alias: string, status: SalesforceOrg['status']): SalesforceOrg => ({
    id,
    alias,
    username: `${id}@example.com`,
    instanceUrl: 'https://example.my.salesforce.com',
    orgId: '00D000000000000',
    orgType: 'Sandbox',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#000000', icon: '', position: 0 },
    metadata: { apiVersion: '59.0', edition: 'Developer', features: [] },
    status,
    lastConnected: '2026-03-07T00:00:00.000Z',
    tags: [],
  });

  const renderEn = async (): Promise<void> => {
    const i18n = createInstance();
    await i18n.init({
      lng: 'en',
      resources: { en: { translation: en } },
      interpolation: { escapeValue: false },
    });
    render(
      <I18nextProvider i18n={i18n}>
        <SidePanel />
        <button data-testid="after-switcher">after</button>
      </I18nextProvider>,
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useRecentOpsStore.setState({ ops: [] });
    useFavoritesStore.setState({ favorites: [] });
    useOrgStore.setState({
      orgs: [org('org-a', 'Alpha', 'connected'), org('org-b', 'Beta', 'expired')],
      selectedOrgId: 'org-a',
    });
  });

  it('says the selected org’s connection in words, and opens a list it controls, not a listbox', async () => {
    await renderEn();
    const trigger = screen.getByTestId('sidepanel-org');
    expect(trigger.hasAttribute('aria-haspopup')).toBe(false);
    expect(trigger.textContent).toContain('Connected');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-controls')).toBe(
      screen.getByTestId('sidepanel-org-dropdown').id,
    );
    const beta = screen.getByTestId('sidepanel-org-option-org-b');
    expect(beta.textContent).toContain('Session expired');
    expect(screen.getByTestId('sidepanel-org-option-org-a').getAttribute('aria-current')).toBe(
      'true',
    );
    expect(beta.hasAttribute('aria-current')).toBe(false);
  });

  it('hands the focus back to the trigger after a pick and after Escape', async () => {
    await renderEn();
    const trigger = screen.getByTestId('sidepanel-org');
    fireEvent.click(trigger);
    const beta = screen.getByTestId('sidepanel-org-option-org-b');
    beta.focus();
    fireEvent.click(beta);
    expect(screen.queryByTestId('sidepanel-org-dropdown')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    screen.getByTestId('sidepanel-org-option-org-a').focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('sidepanel-org-dropdown')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes once the focus leaves it', async () => {
    await renderEn();
    fireEvent.click(screen.getByTestId('sidepanel-org'));
    fireEvent.blur(screen.getByTestId('sidepanel-org-option-org-b'), {
      relatedTarget: screen.getByTestId('after-switcher'),
    });
    expect(screen.queryByTestId('sidepanel-org-dropdown')).toBeNull();
  });
});

/*
 * The first-run title truncated to one line: "Mit Demodaten füllen: dev@…"
 * kept the verb where the alias came last, and a scratch org named by its long
 * username cut it everywhere else. The module names truncated too:
 * "Eingefrorenes Dataset" read "Eingefrorenes Dat…" in a narrow column.
 */
describe('SidePanel fill hero and module names', () => {
  const LONG_ALIAS = 'test-abcdefghijkl@example.com';
  const org: SalesforceOrg = {
    id: 'org-a',
    alias: LONG_ALIAS,
    username: LONG_ALIAS,
    instanceUrl: 'https://test.salesforce.com',
    orgId: '00D000000000001',
    orgType: 'Scratch',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#0000ff', icon: '', position: 0 },
    metadata: { apiVersion: '59.0', edition: 'Developer Edition', features: [] },
    status: 'connected',
    lastConnected: '2026-03-07T00:00:00.000Z',
    tags: [],
  };

  /** The panel in a language, with one org to fill. */
  const renderWithOneOrg = async (lng: 'en' | 'de'): Promise<void> => {
    const i18n = createInstance();
    await i18n.init({
      lng,
      resources: { en: { translation: en }, de: { translation: de } },
      interpolation: { escapeValue: false },
    });
    render(
      <I18nextProvider i18n={i18n}>
        <SidePanel />
      </I18nextProvider>,
    );
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'org:list:response', payload: { orgs: [org], selectedOrgId: null } },
        }),
      );
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    useRecentOpsStore.setState({ ops: [] });
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
    useFavoritesStore.setState({ favorites: ['frozen'] });
  });

  it.each(['en', 'de'] as const)(
    'puts the verb in %s on a line of its own, never cut, the alias under it and the whole sentence in its title',
    async (lng) => {
      await renderWithOneOrg(lng);
      const hero = screen.getByTestId('sidepanel-seed-hero');
      const catalogue = lng === 'en' ? en : de;

      const verb = within(hero).getByText(catalogue.sidePanel.fillOrgAction);
      expect(verb.className).not.toMatch(/\btruncate\b/);
      expect(verb.textContent).not.toContain(LONG_ALIAS);
      expect(screen.getByTestId('sidepanel-seed-hero-alias').textContent).toBe(LONG_ALIAS);
      expect(hero.getAttribute('title')).toBe(
        catalogue.sidePanel.fillOrg.replace('{{alias}}', LONG_ALIAS),
      );
    },
  );

  it('wraps a module’s name on two lines rather than cutting it, in every list', async () => {
    await renderWithOneOrg('de');
    fireEvent.click(screen.getByTestId('sidepanel-advanced-toggle'));
    const names = [
      ...within(screen.getByTestId('sidepanel-favorites')).getAllByText('Eingefrorenes Dataset'),
      ...within(screen.getByTestId('sidepanel-modules')).queryAllByText('Eingefrorenes Dataset'),
      ...within(screen.getByTestId('sidepanel-advanced')).queryAllByText('Eingefrorenes Dataset'),
      within(screen.getByTestId('sidepanel-tools')).getByText('Organisationen'),
    ];
    expect(names.length).toBeGreaterThanOrEqual(3);
    for (const name of names) {
      expect({ name: name.textContent, cut: /\btruncate\b/.test(name.className) }).toEqual({
        name: name.textContent,
        cut: false,
      });
      expect(name.className).toMatch(/\bline-clamp-2\b/);
    }
  });
});
