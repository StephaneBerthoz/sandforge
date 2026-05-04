import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { WelcomePage } from './WelcomePage';

const mockChangeLanguage = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { changeLanguage: mockChangeLanguage, language: 'en' },
  }),
}));

const mockNavigate = vi.fn();
vi.mock('../../stores/useAppStore', () => ({
  useAppStore: (selector: (s: { navigate: typeof mockNavigate }) => unknown) =>
    selector({ navigate: mockNavigate }),
}));

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string): string | null => store[key] ?? null,
    setItem: (key: string, value: string): void => {
      store[key] = value;
    },
    removeItem: (key: string): void => {
      delete store[key];
    },
    reset: (): void => {
      store = {};
    },
  };
})();
Object.defineProperty(window, 'localStorage', { value: localStorageMock, writable: true });

describe('WelcomePage', () => {
  let onComplete: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onComplete = vi.fn();
    mockNavigate.mockClear();
    mockChangeLanguage.mockClear();
    localStorageMock.reset();
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

  it('should render 5 step indicators', () => {
    render(<WelcomePage onComplete={onComplete} />);
    for (let i = 0; i < 5; i++) {
      expect(screen.getByTestId(`step-indicator-${String(i)}`)).toBeDefined();
    }
  });

  it('should render language selection buttons on Bienvenue step', () => {
    render(<WelcomePage onComplete={onComplete} />);
    expect(screen.getByTestId('lang-en')).toBeDefined();
    expect(screen.getByTestId('lang-fr')).toBeDefined();
  });

  it('should change language when language button is clicked', () => {
    render(<WelcomePage onComplete={onComplete} />);
    fireEvent.click(screen.getByTestId('lang-fr'));
    expect(mockChangeLanguage).toHaveBeenCalledWith('fr');
  });

  it('should navigate from Bienvenue to step 1 when Next is clicked', () => {
    render(<WelcomePage onComplete={onComplete} />);
    fireEvent.click(screen.getByText('common.next'));
    expect(screen.getByTestId('welcome-step-1')).toBeDefined();
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
    expect(screen.getByText('onboarding.openSeed')).toBeDefined();
    expect(screen.getByText('onboarding.openSync')).toBeDefined();
  });

  it('should suggest Monitor for production org type', () => {
    render(<WelcomePage onComplete={onComplete} orgType="production" />);
    // Navigate to step 4
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    expect(screen.getByText('onboarding.suggestMonitor')).toBeDefined();
    expect(screen.getByText('onboarding.openMonitor')).toBeDefined();
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

  it('should persist dont-show-again in localStorage when completing', () => {
    render(<WelcomePage onComplete={onComplete} orgType="production" />);
    // Navigate to step 4
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    // Check dont show again
    fireEvent.click(screen.getByTestId('dont-show-again'));
    // Click finish
    fireEvent.click(screen.getByText('onboarding.openMonitor'));
    expect(localStorageMock.getItem('sandforge-welcome-dont-show')).toBe('true');
  });

  it('should not set localStorage when dont-show-again is unchecked', () => {
    render(<WelcomePage onComplete={onComplete} orgType="production" />);
    // Navigate to step 4
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    // Click finish without checking dont show
    fireEvent.click(screen.getByText('onboarding.openMonitor'));
    expect(localStorageMock.getItem('sandforge-welcome-dont-show')).toBeNull();
  });

  it('should navigate to seed from step 4 for sandbox org type', () => {
    render(<WelcomePage onComplete={onComplete} orgType="sandbox" />);
    // Navigate to step 4
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('onboarding.openSeed'));
    expect(onComplete).toHaveBeenCalledOnce();
    expect(mockNavigate).toHaveBeenCalledWith('seed');
  });

  it('should navigate to sync from step 4 for sandbox org type', () => {
    render(<WelcomePage onComplete={onComplete} orgType="sandbox" />);
    // Navigate to step 4
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('common.next'));
    fireEvent.click(screen.getByText('onboarding.openSync'));
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
    fireEvent.click(screen.getByText('onboarding.openMonitor'));
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
    fireEvent.click(screen.getByText('onboarding.openSettings'));
    expect(onComplete).toHaveBeenCalledOnce();
    expect(mockNavigate).toHaveBeenCalledWith('settings');
  });

  it('should render module cards in step 2', () => {
    render(<WelcomePage onComplete={onComplete} />);
    fireEvent.click(screen.getByText('common.next')); // 0 -> 1
    fireEvent.click(screen.getByText('common.next')); // 1 -> 2
    expect(screen.getByTestId('module-card-monitor')).toBeDefined();
    expect(screen.getByTestId('module-card-seed')).toBeDefined();
    expect(screen.getByTestId('module-card-sync')).toBeDefined();
    expect(screen.getByTestId('module-card-compare')).toBeDefined();
    expect(screen.getByTestId('module-card-dataops')).toBeDefined();
    expect(screen.getByTestId('module-card-automation')).toBeDefined();
  });
});
