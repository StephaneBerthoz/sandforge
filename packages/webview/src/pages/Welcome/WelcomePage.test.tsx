import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { createRef } from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { WelcomePage } from './WelcomePage';
import type { WelcomePageHandle } from './WelcomePage';
import en from '../../i18n/locales/en.json';
import fr from '../../i18n/locales/fr.json';
import de from '../../i18n/locales/de.json';
import es from '../../i18n/locales/es.json';
import ptBR from '../../i18n/locales/pt-BR.json';
import ja from '../../i18n/locales/ja.json';

const mockChangeLanguage = vi.fn();

/* WelcomePage applies language changes through the lazy bridge loader. */
const mockChangeLanguageLazy = vi.fn();
vi.mock('../../i18n', () => ({
  changeLanguageLazy: (lng: string) => mockChangeLanguageLazy(lng),
  i18nReady: Promise.resolve(),
}));

vi.mock('react-i18next', () => ({
  // The real i18n module calls i18n.use(initReactI18next) at import time.
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    // An alias passed to the sentence shows beside its key, so a test reads
    // which org the sentence names.
    t: (key: string, fallback?: unknown) =>
      typeof fallback === 'string'
        ? fallback
        : typeof fallback === 'object' && fallback !== null && 'alias' in fallback
          ? `${key}(${String(fallback.alias)})`
          : key,
    i18n: { changeLanguage: mockChangeLanguage, language: 'en' },
  }),
}));

/* The wizard mirrors an applied language choice into the extension-side
   settings blob through the enveloped bridge helper. */
const mockSendBridgeMessage = vi.fn();
vi.mock('../../bridge/sendBridgeMessage', () => ({
  sendBridgeMessage: (type: string, payload?: unknown) => mockSendBridgeMessage(type, payload),
}));

const mockNavigate = vi.fn();
const mockSetShowWelcome = vi.fn();
vi.mock('../../stores/useAppStore', () => ({
  useAppStore: (
    selector: (s: {
      navigate: typeof mockNavigate;
      setShowWelcome: typeof mockSetShowWelcome;
    }) => unknown,
  ) => selector({ navigate: mockNavigate, setShowWelcome: mockSetShowWelcome }),
}));

/* The orgs the tour reads: the selected one decides its last suggestion, and
   the org Seed opens on. */
const mockOrgState = vi.hoisted(() => ({
  orgs: [] as Array<{
    id: string;
    status: string;
    orgType: string;
    alias?: string;
    username?: string;
  }>,
  selectedOrgId: null as string | null,
}));
vi.mock('../../stores/useOrgStore', () => ({
  useOrgStore: (selector: (s: typeof mockOrgState) => unknown) => selector(mockOrgState),
}));

/** A connected Developer Edition: an org the tour suggests filling. */
const CONNECTED_DEV = {
  id: 'dev',
  status: 'connected',
  orgType: 'Developer',
  alias: 'dev-org',
  username: 'dev@example.com',
};

/** A connected production org: the tour points it at Monitor. */
const CONNECTED_PROD = {
  id: 'prod',
  status: 'connected',
  orgType: 'Production',
  alias: 'prod-org',
  username: 'prod@example.com',
};

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

vi.mock('../../utils/webviewStorage', () => ({
  getPersistedItem: (key: string): string | null => mockPersistedState.store[key] ?? null,
  setPersistedItem: (key: string, value: string): void => {
    mockPersistedState.store[key] = value;
  },
}));

describe('WelcomePage', () => {
  let onComplete: Mock<() => void>;

  beforeEach(() => {
    onComplete = vi.fn<() => void>();
    mockNavigate.mockClear();
    mockSetShowWelcome.mockClear();
    mockChangeLanguage.mockClear();
    mockChangeLanguageLazy.mockClear();
    /* changeLanguageLazy resolves `true` when the language was applied. */
    mockChangeLanguageLazy.mockResolvedValue(true);
    mockSendBridgeMessage.mockClear();
    mockPersistedState.reset();
    mockOrgState.orgs = [];
    mockOrgState.selectedOrgId = null;
  });

  it('should render the welcome page', () => {
    render(<WelcomePage onComplete={onComplete} />);
    expect(screen.getByTestId('welcome-page')).toBeDefined();
  });

  it('should show the Bienvenue step by default (step 0)', () => {
    render(<WelcomePage onComplete={onComplete} />);
    expect(screen.getByTestId('welcome-step-bienvenue')).toBeDefined();
  });

  it('should show the welcome title', () => {
    render(<WelcomePage onComplete={onComplete} />);
    expect(screen.getByText('onboarding.welcomeTitle')).toBeDefined();
  });

  it('should render the progress bar', () => {
    render(<WelcomePage onComplete={onComplete} />);
    expect(screen.getByTestId('progress-bar')).toBeDefined();
  });

  it('gives the step progress bar an accessible name', () => {
    render(<WelcomePage onComplete={onComplete} />);
    // The mocked t() returns the key, so the name is the key itself.
    expect(screen.getByRole('progressbar', { name: 'a11y.stepProgress' })).toBeDefined();
  });

  it('should render 5 step indicators', () => {
    render(<WelcomePage onComplete={onComplete} />);
    for (let i = 0; i < 5; i++) {
      expect(screen.getByTestId(`step-indicator-${String(i)}`)).toBeDefined();
    }
  });

  it('should render all six language selection buttons on Bienvenue step, with native labels', () => {
    render(<WelcomePage onComplete={onComplete} />);
    const expected: Array<[string, string]> = [
      ['lang-en', 'English'],
      ['lang-fr', 'Français'],
      ['lang-de', 'Deutsch'],
      ['lang-es', 'Español'],
      ['lang-ja', '日本語'],
      ['lang-pt-BR', 'Português (Brasil)'],
    ];
    for (const [testid, label] of expected) {
      const button = screen.getByTestId(testid);
      expect(button).toBeDefined();
      // Native labels: readable regardless of the currently active language.
      expect(button.textContent).toBe(label);
    }
  });

  it('should change language when language button is clicked', () => {
    render(<WelcomePage onComplete={onComplete} />);
    fireEvent.click(screen.getByTestId('lang-fr'));
    expect(mockChangeLanguageLazy).toHaveBeenCalledWith('fr');
  });

  it('should change language to a non-European language when its button is clicked', () => {
    render(<WelcomePage onComplete={onComplete} />);
    fireEvent.click(screen.getByTestId('lang-ja'));
    expect(mockChangeLanguageLazy).toHaveBeenCalledWith('ja');
  });

  it('should navigate from Bienvenue to step 1 when Next is clicked', () => {
    render(<WelcomePage onComplete={onComplete} />);
    fireEvent.click(screen.getByText('common.next'));
    expect(screen.getByTestId('welcome-step-1')).toBeDefined();
  });

  it('leaves the tour for the org manager from step 1', () => {
    render(<WelcomePage onComplete={onComplete} />);
    fireEvent.click(screen.getByText('common.next')); // 0 -> 1
    fireEvent.click(screen.getByText('onboarding.connectOrg'));

    expect(mockNavigate).toHaveBeenCalledWith('orgs');
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('should navigate from step 1 to step 2', () => {
    render(<WelcomePage onComplete={onComplete} />);
    fireEvent.click(screen.getByText('common.next')); // 0 -> 1
    fireEvent.click(screen.getByText('common.next')); // 1 -> 2
    expect(screen.getByTestId('welcome-step-2')).toBeDefined();
  });

  it('should navigate from step 2 to step 3', () => {
    render(<WelcomePage onComplete={onComplete} />);
    fireEvent.click(screen.getByText('common.next')); // 0 -> 1
    fireEvent.click(screen.getByText('common.next')); // 1 -> 2
    fireEvent.click(screen.getByText('common.next')); // 2 -> 3
    expect(screen.getByTestId('welcome-step-3')).toBeDefined();
  });

  it('should show the first steps (step 4) after step 3', () => {
    render(<WelcomePage onComplete={onComplete} />);
    fireEvent.click(screen.getByText('common.next')); // 0 -> 1
    fireEvent.click(screen.getByText('common.next')); // 1 -> 2
    fireEvent.click(screen.getByText('common.next')); // 2 -> 3
    fireEvent.click(screen.getByText('common.next')); // 3 -> 4
    expect(screen.getByTestId('welcome-step-4')).toBeDefined();
  });

  it('suggests filling the connected org, named, with Seed or with Forge', () => {
    mockOrgState.orgs = [CONNECTED_DEV];
    mockOrgState.selectedOrgId = CONNECTED_DEV.id;
    render(<WelcomePage onComplete={onComplete} orgType="sandbox" />);
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByText('common.next'));

    // It said "Your sandbox is ready… Seed or Sync" whatever was connected, and
    // the tour's cards led with Forge but its end offered Sync, not Forge.
    expect(screen.getByTestId('welcome-suggestion').textContent).toBe(
      'onboarding.suggestSeedFor(dev-org)',
    );
    expect(screen.getByText('home.openSeed')).toBeDefined();
    expect(screen.getByText('home.openForge')).toBeDefined();
    expect(screen.queryByText('home.openSync')).toBeNull();
  });

  it('asks for an org first when none is connected, and says nothing of an org type', () => {
    render(<WelcomePage onComplete={onComplete} />);
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByText('common.next'));

    // "Based on your org type… Your sandbox is ready" showed with no org at
    // all: the type fell back to a sandbox.
    expect(screen.getByTestId('welcome-suggestion').textContent).toBe('onboarding.connectFirst');
    expect(screen.queryByText('onboarding.step4Desc')).toBeNull();
    expect(screen.queryByTestId('welcome-open-seed-btn')).toBeNull();
    expect(screen.queryByText('home.openMonitor')).toBeNull();

    fireEvent.click(screen.getByTestId('welcome-connect-org-btn'));
    expect(onComplete).toHaveBeenCalledOnce();
    expect(mockNavigate).toHaveBeenCalledWith('orgs');
  });

  it('asks for an org first while the only org registered is not connected', () => {
    mockOrgState.orgs = [{ ...CONNECTED_DEV, status: 'expired' }];
    render(<WelcomePage onComplete={onComplete} />);
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByText('common.next'));

    expect(screen.getByTestId('welcome-suggestion').textContent).toBe('onboarding.connectFirst');
  });

  it('leaves the tour for Forge from its last step', () => {
    mockOrgState.orgs = [CONNECTED_DEV];
    render(<WelcomePage onComplete={onComplete} />);
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByTestId('welcome-start-forge-btn'));

    expect(onComplete).toHaveBeenCalledOnce();
    expect(mockNavigate).toHaveBeenCalledWith('forge');
  });

  it('ends on Done, not Skip, and Done leaves the tour where it is', () => {
    render(<WelcomePage onComplete={onComplete} />);
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByText('common.next'));
    expect(screen.getByTestId('skip-button').textContent).toBe('onboarding.skipOnboarding');
    fireEvent.click(screen.getByText('common.next'));

    expect(screen.queryByTestId('skip-button')).toBeNull();
    fireEvent.click(screen.getByTestId('done-button'));
    expect(screen.getByTestId('done-button').textContent).toBe('onboarding.done');
    expect(onComplete).toHaveBeenCalledOnce();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('opens Settings on its AI tab from the AI step', () => {
    render(<WelcomePage onComplete={onComplete} />);
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByText('common.next'));
    expect(screen.getByTestId('welcome-step-3')).toBeDefined();

    // The step was text alone.
    fireEvent.click(screen.getByTestId('welcome-open-ai-settings-btn'));
    expect(screen.getByText('onboarding.openAiSettings')).toBeDefined();
    expect(onComplete).toHaveBeenCalledOnce();
    expect(mockNavigate).toHaveBeenCalledWith('settings', { settingsTab: 'ai' });
  });

  it('lists Seed first among the three ways, then Forge, then Frozen', () => {
    const { container } = render(<WelcomePage onComplete={onComplete} />);
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));

    const cards = [...container.querySelectorAll('[data-testid^="path-card-"]')].map((card) =>
      card.getAttribute('data-testid'),
    );
    expect(cards).toEqual(['path-card-seed', 'path-card-forge', 'path-card-frozen']);
  });

  it('draws its icons as images, never as emoji, on every step', () => {
    // Emoji drew as empty boxes where no colour-emoji font exists, and a
    // flame, a robot and a rocket said other things than the side panel's.
    mockOrgState.orgs = [CONNECTED_DEV];
    const { container } = render(<WelcomePage onComplete={onComplete} />);
    for (let step = 0; step < 5; step++) {
      const shown = screen.getByTestId(
        step === 0 ? 'welcome-step-bienvenue' : `welcome-step-${step}`,
      );
      expect(shown.textContent ?? '').not.toMatch(/\p{Extended_Pictographic}/u);
      expect(shown.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
      if (step < 4) fireEvent.click(screen.getByText('common.next'));
    }
    expect(container.textContent ?? '').not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('should suggest Monitor for production org type', () => {
    mockOrgState.orgs = [CONNECTED_PROD];
    render(<WelcomePage onComplete={onComplete} orgType="production" />);
    // Navigate to step 4
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    expect(screen.getByText('onboarding.suggestMonitor')).toBeDefined();
    expect(screen.getByText('home.openMonitor')).toBeDefined();
  });

  it('should call onComplete when Skip is clicked', () => {
    render(<WelcomePage onComplete={onComplete} />);
    fireEvent.click(screen.getByTestId('skip-button'));
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('should navigate back from step 1 to Bienvenue', () => {
    render(<WelcomePage onComplete={onComplete} />);
    fireEvent.click(screen.getByText('common.next')); // 0 -> 1
    expect(screen.getByTestId('welcome-step-1')).toBeDefined();
    fireEvent.click(screen.getByText('common.back'));
    expect(screen.getByTestId('welcome-step-bienvenue')).toBeDefined();
  });

  it('offers no "Don\'t show again" box: the tour opens when Help asks for it', () => {
    // A box ticked on an earlier run made Help → Start Guided Tour open nothing.
    mockPersistedState.store['sandforge-welcome-dont-show'] = 'true';
    render(<WelcomePage onComplete={onComplete} orgType="production" />);
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByText('common.next'));

    expect(screen.getByTestId('welcome-step-4')).toBeDefined();
    expect(screen.queryByTestId('dont-show-again')).toBeNull();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('leaves the tour when the overlay skips it through its handle, as Escape does', () => {
    const handle = createRef<WelcomePageHandle>();
    render(<WelcomePage ref={handle} onComplete={onComplete} />);

    act(() => handle.current?.skip());

    expect(onComplete).toHaveBeenCalledOnce();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('suggests Monitor when the selected org is a production org, with no org type passed', () => {
    mockOrgState.orgs = [{ id: 'prod', status: 'connected', orgType: 'Production' }];
    mockOrgState.selectedOrgId = 'prod';
    render(<WelcomePage onComplete={onComplete} />);
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByText('common.next'));

    // Nothing passed the org type: this branch was never shown.
    expect(screen.getByText('onboarding.suggestMonitor')).toBeDefined();
    expect(screen.queryByTestId('welcome-open-seed-btn')).toBeNull();
  });

  it('should navigate to seed from step 4 for sandbox org type', () => {
    mockOrgState.orgs = [CONNECTED_DEV];
    render(<WelcomePage onComplete={onComplete} orgType="sandbox" />);
    // Navigate to step 4
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('home.openSeed'));
    expect(onComplete).toHaveBeenCalledOnce();
    expect(mockNavigate).toHaveBeenCalledWith('seed', {
      seedMode: 'quick-seed',
      targetOrgId: CONNECTED_DEV.id,
    });
  });

  it('opens Seed on its gallery with the org to fill preselected', () => {
    mockOrgState.orgs = [
      { id: 'prod', status: 'connected', orgType: 'Production' },
      { id: 'dev', status: 'connected', orgType: 'Developer' },
    ];
    mockOrgState.selectedOrgId = 'dev';
    render(<WelcomePage onComplete={onComplete} />);
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByTestId('welcome-open-seed-btn'));

    expect(mockNavigate).toHaveBeenCalledWith('seed', {
      seedMode: 'quick-seed',
      targetOrgId: 'dev',
    });
  });

  it('should navigate to monitor from step 4 for production org type', () => {
    mockOrgState.orgs = [CONNECTED_PROD];
    render(<WelcomePage onComplete={onComplete} orgType="production" />);
    // Navigate to step 4
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('home.openMonitor'));
    expect(onComplete).toHaveBeenCalledOnce();
    expect(mockNavigate).toHaveBeenCalledWith('monitor');
  });

  it('should navigate to settings from step 4', () => {
    mockOrgState.orgs = [CONNECTED_PROD];
    render(<WelcomePage onComplete={onComplete} orgType="production" />);
    // Navigate to step 4
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('home.openSettings'));
    expect(onComplete).toHaveBeenCalledOnce();
    expect(mockNavigate).toHaveBeenCalledWith('settings');
  });

  it('should render the primary use case hero on the Bienvenue step', () => {
    render(<WelcomePage onComplete={onComplete} />);
    expect(screen.getByTestId('welcome-hero-usecase')).toBeDefined();
    expect(screen.getByText('onboarding.heroTitle')).toBeDefined();
    expect(screen.getByText('onboarding.heroDesc')).toBeDefined();
  });

  it('should render the three use-case path cards in step 2', () => {
    render(<WelcomePage onComplete={onComplete} />);
    fireEvent.click(screen.getByText('common.next')); // 0 -> 1
    fireEvent.click(screen.getByText('common.next')); // 1 -> 2
    expect(screen.getByTestId('path-card-forge')).toBeDefined();
    expect(screen.getByTestId('path-card-seed')).toBeDefined();
    expect(screen.getByTestId('path-card-frozen')).toBeDefined();
  });

  it('leaves the tour for Forge from its path card', () => {
    render(<WelcomePage onComplete={onComplete} />);
    fireEvent.click(screen.getByText('common.next')); // 0 -> 1
    fireEvent.click(screen.getByText('common.next')); // 1 -> 2
    fireEvent.click(screen.getByTestId('welcome-open-forge-btn'));
    expect(mockNavigate).toHaveBeenCalledWith('forge');
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('opens Seed on its gallery from its path card', () => {
    mockOrgState.orgs = [{ id: 'sbx', status: 'connected', orgType: 'Sandbox' }];
    render(<WelcomePage onComplete={onComplete} />);
    fireEvent.click(screen.getByText('common.next')); // 0 -> 1
    fireEvent.click(screen.getByText('common.next')); // 1 -> 2
    fireEvent.click(screen.getByTestId('welcome-open-seed-btn'));
    expect(mockNavigate).toHaveBeenCalledWith('seed', {
      seedMode: 'quick-seed',
      targetOrgId: 'sbx',
    });
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('should persist the chosen language into the extension settings blob', async () => {
    render(<WelcomePage onComplete={onComplete} />);
    fireEvent.click(screen.getByTestId('lang-fr'));

    // The webview state the i18n module writes dies with the onboarding
    // panel; only this `settings:update` write (globalState) survives it.
    await waitFor(() => {
      expect(mockSendBridgeMessage).toHaveBeenCalledWith('settings:update', {
        key: 'settings',
        value: { language: 'fr' },
      });
    });
  });

  it('should persist a non-European language choice the same way', async () => {
    render(<WelcomePage onComplete={onComplete} />);
    fireEvent.click(screen.getByTestId('lang-ja'));

    await waitFor(() => {
      expect(mockSendBridgeMessage).toHaveBeenCalledWith('settings:update', {
        key: 'settings',
        value: { language: 'ja' },
      });
    });
  });

  it('should NOT persist the language when the locale bundle failed to load', async () => {
    // changeLanguageLazy keeps the current language on bridge failure —
    // persisting the requested one would leave the blob describing a
    // language nobody is looking at.
    mockChangeLanguageLazy.mockResolvedValue(false);
    render(<WelcomePage onComplete={onComplete} />);
    fireEvent.click(screen.getByTestId('lang-de'));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockSendBridgeMessage).not.toHaveBeenCalled();
  });

  it('says so when the language picked could not be loaded', async () => {
    // The click used to end in silence: the bundle failed, the buttons stayed
    // on the current language, and nothing said why.
    mockChangeLanguageLazy.mockResolvedValue(false);
    render(<WelcomePage onComplete={onComplete} />);
    fireEvent.click(screen.getByTestId('lang-de'));

    const banner = await screen.findByTestId('language-error');
    expect(banner.textContent).toContain('settings.languageLoadFailed');
  });

  it('leaves the tour for Frozen from its path card', () => {
    render(<WelcomePage onComplete={onComplete} />);
    fireEvent.click(screen.getByText('common.next')); // 0 -> 1
    fireEvent.click(screen.getByText('common.next')); // 1 -> 2
    fireEvent.click(screen.getByTestId('welcome-open-frozen-btn'));
    expect(mockNavigate).toHaveBeenCalledWith('frozen');
    expect(onComplete).toHaveBeenCalledOnce();
  });
});

describe('WelcomePage step progress bar', () => {
  it('speaks the step progress as a percentage', () => {
    render(<WelcomePage onComplete={vi.fn()} />);
    const bar = screen.getByRole('progressbar', { name: 'a11y.stepProgress' });
    expect(bar.getAttribute('aria-valuetext')).toBe(`${bar.getAttribute('aria-valuenow')}%`);
  });

  it('fills the bar in the accent colour', () => {
    render(<WelcomePage onComplete={vi.fn()} />);
    const bar = screen.getByRole('progressbar', { name: 'a11y.stepProgress' });
    expect((bar.firstChild as HTMLElement).className).toContain('bg-(--sf-accent)');
  });
});

describe('the words of the tour', () => {
  const ALL = { en, fr, de, es, 'pt-BR': ptBR, ja } as const;

  it.each(Object.keys(ALL) as Array<keyof typeof ALL>)(
    '%s leads with Seed and the template it opens on, then offers Forge to an org with real data',
    (locale) => {
      // The hero sold Forge first, which needs a second org holding real data,
      // where every other surface starts a newcomer on Seed in one empty org.
      const catalogue = ALL[locale];
      const { heroTitle, heroDesc } = catalogue.onboarding;
      expect(heroTitle).toContain('Seed');
      expect(heroTitle).toContain(catalogue.seed.templates.crmStarter.name);
      expect(heroTitle).not.toContain('Forge');
      expect(heroDesc).toContain('Forge');
    },
  );

  it('says replay as German says it of a dataset, never wiederholen', () => {
    // "Wiederholen" reads "repeat"; the card's own description says wiedergeben.
    expect(JSON.stringify(de.onboarding.paths)).not.toMatch(/wiederhol/i);
    expect(de.onboarding.step2Desc).not.toMatch(/wiederhol/i);
    expect(de.onboarding.heroDesc).not.toMatch(/wiederhol/i);
    expect(de.onboarding.paths.frozenTitle).toBe('Eingefrorenes Dataset erneut laden');
  });
});
