import { describe, it, expect, vi } from 'vitest';

/**
 * Hoisted mutable webview state + VS Code API mock. The i18n module reads the
 * persisted language at boot and writes every language change back.
 */
const vscodeApiMock = vi.hoisted(() => {
  const state: { current: Record<string, unknown> } = {
    current: { language: 'fr', syncDraft: { keep: 'me' } },
  };
  return {
    state,
    postMessage: vi.fn(),
    getState: vi.fn(() => state.current),
    setState: vi.fn((next: unknown) => {
      state.current = next as Record<string, unknown>;
    }),
  };
});

vi.mock('../hooks/useVSCodeApi', () => ({
  getVscodeApi: () => vscodeApiMock,
  useVSCodeApi: () => vscodeApiMock,
}));

import i18n from './index';

describe('i18n language persistence', () => {
  it('boots with the language persisted in the webview state', () => {
    expect(i18n.language).toBe('fr');
  });

  it('persists language changes to the webview state, merging existing keys', async () => {
    await i18n.changeLanguage('de');
    expect(vscodeApiMock.setState).toHaveBeenCalledWith(
      expect.objectContaining({ language: 'de', syncDraft: { keep: 'me' } }),
    );
    expect(vscodeApiMock.state.current['language']).toBe('de');
  });

  it('falls back to English when the persisted language is not supported', async () => {
    vscodeApiMock.state.current = { language: 'xx' };
    vi.resetModules();
    const fresh = await import('./index');
    expect(fresh.default.language).toBe('en');
  });
});
