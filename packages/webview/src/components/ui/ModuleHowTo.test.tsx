import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { ModuleHowTo, HowToSteps } from './ModuleHowTo';
import { MODULE_HOW_TO, howToHiddenKey } from './moduleHowTo';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
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

describe('HowToSteps', () => {
  it('says the steps in order, then the tip', () => {
    render(<HowToSteps module="seed" />);
    const items = within(screen.getByRole('list')).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([...MODULE_HOW_TO.seed.steps]);
    expect(screen.getByText(MODULE_HOW_TO.seed.tip)).toBeInTheDocument();
    expect(screen.getByText('howTo.tipLabel')).toBeInTheDocument();
  });
});

describe('ModuleHowTo', () => {
  beforeEach(() => {
    mockPersistedState.reset();
  });

  it('opens on a first visit, its button naming the panel it opens', () => {
    render(<ModuleHowTo module="forge" />);
    const toggle = screen.getByTestId('how-to-forge-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panel = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    expect(panel).not.toBeNull();
    expect(panel).toBeVisible();
    expect(screen.getByRole('region', { name: 'howTo.title' })).toBeInTheDocument();
  });

  it('hides when asked and stays hidden for that module alone', () => {
    const { unmount } = render(<ModuleHowTo module="forge" />);
    fireEvent.click(screen.getByTestId('how-to-forge-toggle'));
    expect(screen.getByTestId('how-to-forge-toggle')).toHaveAttribute('aria-expanded', 'false');
    expect(mockPersistedState.store[howToHiddenKey('forge')]).toBe('true');
    unmount();

    render(<ModuleHowTo module="forge" />);
    const toggle = screen.getByTestId('how-to-forge-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // Hidden, the panel is still there for aria-controls to name.
    const panel = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    expect(panel).not.toBeNull();
    expect(panel).not.toBeVisible();

    render(<ModuleHowTo module="seed" />);
    expect(screen.getByTestId('how-to-seed-toggle')).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens again when shown, and is remembered open', () => {
    mockPersistedState.store[howToHiddenKey('sync')] = 'true';
    render(<ModuleHowTo module="sync" />);
    fireEvent.click(screen.getByTestId('how-to-sync-toggle'));
    expect(screen.getByTestId('how-to-sync-toggle')).toHaveAttribute('aria-expanded', 'true');
    expect(mockPersistedState.store[howToHiddenKey('sync')]).toBe('false');
  });
});
