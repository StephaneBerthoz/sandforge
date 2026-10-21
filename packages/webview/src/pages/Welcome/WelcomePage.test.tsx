import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { createRef } from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { WelcomePage } from './WelcomePage';
import type { WelcomePageHandle } from './WelcomePage';

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
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
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
  orgs: [] as Array<{ id: string; status: string; orgType: string }>,
  selectedOrgId: null as string | null,
}));
vi.mock('../../stores/useOrgStore', () => ({
  useOrgStore: (selector: (s: typeof mockOrgState) => unknown) => selector(mockOrgState),
}));

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

  it('should suggest Seed and Sync for sandbox org type', () => {
    render(<WelcomePage onComplete={onComplete} orgType="sandbox" />);
    // Navigate to step 4
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    expect(screen.getByText('onboarding.suggestSeedAndSync')).toBeDefined();
    expect(screen.getByText('home.openSeed')).toBeDefined();
    expect(screen.getByText('home.openSync')).toBeDefined();
  });

  it('should suggest Monitor for production org type', () => {
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
      targetOrgId: undefined,
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

  it('should navigate to sync from step 4 for sandbox org type', () => {
    render(<WelcomePage onComplete={onComplete} orgType="sandbox" />);
    // Navigate to step 4
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('home.openSync'));
    expect(onComplete).toHaveBeenCalledOnce();
    expect(mockNavigate).toHaveBeenCalledWith('sync');
  });

  it('should navigate to monitor from step 4 for production org type', () => {
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
