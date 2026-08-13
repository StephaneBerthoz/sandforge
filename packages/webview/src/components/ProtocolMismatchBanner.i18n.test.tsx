import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import en from '../i18n/locales/en.json';
import { ProtocolMismatchBanner } from './ProtocolMismatchBanner';

vi.mock('../hooks/useVSCodeApi', () => ({
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

/** Trigger the banner the way the broker does after repeated version mismatches. */
function fireBanner(): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: 'bridge-1',
          type: 'bridge:reload-banner',
          timestamp: Date.now(),
          payload: { reason: 'protocol-mismatch' },
        },
      }),
    );
  });
}

describe('ProtocolMismatchBanner — translated chrome', () => {
  it('resolves the message, the reload button and the dismiss label through i18n', () => {
    render(<ProtocolMismatchBanner />);
    fireBanner();

    expect(screen.getByTestId('protocol-mismatch-banner').textContent).toContain(
      'bridge.protocolMismatch.message',
    );
    expect(screen.getByTestId('protocol-mismatch-reload').textContent).toBe('common.reload');
    expect(screen.getByTestId('protocol-mismatch-dismiss').getAttribute('aria-label')).toBe(
      'common.dismiss',
    );
  });

  it('backs every rendered key with an entry in the reference locale', () => {
    expect(en.bridge.protocolMismatch.message).toContain('Reload the window');
    expect(en.common.reload).toBe('Reload');
    expect(en.common.dismiss).toBe('Dismiss');
  });
});
