import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import en from '../../i18n/locales/en.json';
import { CDCSubscriptionPanel } from './CDCSubscriptionPanel';
import { useCDCLiveStore } from '../../stores/useCDCLiveStore';

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => ({
    postMessage: vi.fn(),
    getState: () => undefined,
    setState: () => undefined,
  }),
  getVscodeApi: () => ({
    postMessage: vi.fn(),
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

/* `t` echoes its key, so any label still hardcoded in the component shows up
   as English prose instead of a key. */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

const STRATEGIES = ['source_wins', 'target_wins', 'newest_wins', 'manual', 'merge'] as const;

describe('CDCSubscriptionPanel — translated conflict strategies', () => {
  beforeEach(() => {
    useCDCLiveStore.setState({ watchedObjects: ['Account'], autoSyncObjects: {} });
  });

  it('resolves every conflict strategy option through i18n', () => {
    render(<CDCSubscriptionPanel availableObjects={['Account']} />);
    fireEvent.click(screen.getByTestId('cdc-autosync-toggle-Account'));

    const options = screen.getByTestId('cdc-conflict-select-Account').querySelectorAll('option');
    expect(options.length).toBe(STRATEGIES.length);
    for (const [i, strategy] of STRATEGIES.entries()) {
      expect(options[i]?.value).toBe(strategy);
      expect(options[i]?.textContent).toBe(`sync.realtime.conflict.${strategy}`);
    }
  });

  it('backs every rendered key with an entry in the reference locale', () => {
    for (const strategy of STRATEGIES) {
      expect(typeof en.sync.realtime.conflict[strategy]).toBe('string');
    }
  });
});
