import { describe, it, expect, vi, afterEach } from 'vitest';
import { waitFor } from '@testing-library/react';

/**
 * Hoisted mutable webview state + VS Code API mock. The i18n module is
 * imported once (i18next is an externalized singleton — re-importing it
 * after resetModules does NOT produce a fresh instance), so each test sets
 * its preconditions explicitly: the live language via changeLanguage and
 * the persisted state via the mock.
 */
const vscodeApiMock = vi.hoisted(() => {
  const state: { current: Record<string, unknown> } = { current: {} };
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

import i18n, { importLanguageFromSettings } from './index';

/**
 * Simulate a brand-new webview document: the per-document state is empty
 * while i18n sits at a known language. changeLanguage re-persists through
 * the languageChanged listener, so the state is cleared AFTER switching.
 */
async function freshDocument(language: 'en' | 'fr' | 'de'): Promise<void> {
  await i18n.changeLanguage(language);
  vscodeApiMock.state.current = {};
}

describe('importLanguageFromSettings', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
    vscodeApiMock.state.current = {};
  });

  it('adopts the nested blob language when the webview state has none', async () => {
    await freshDocument('en');
    expect(i18n.language).toBe('en'); // booted on the default

    // Current blob layout (payload.settings): the whole settings object
    // stored under the 'settings' ConfigStore key.
    importLanguageFromSettings({ settings: { language: 'de' } });

    await waitFor(() => expect(i18n.language).toBe('de'));
    // changeLanguage re-persists into the fresh webview state.
    expect(vscodeApiMock.state.current['language']).toBe('de');
  });

  it('adopts a flat historical blob language', async () => {
    await freshDocument('en');

    importLanguageFromSettings({ language: 'ja' });

    await waitFor(() => expect(i18n.language).toBe('ja'));
    expect(vscodeApiMock.state.current['language']).toBe('ja');
  });

  it('keeps the webview state language when one is persisted (state wins)', async () => {
    // changeLanguage persists 'fr' automatically — exactly the real flow.
    await i18n.changeLanguage('fr');
    expect(vscodeApiMock.state.current['language']).toBe('fr');

    importLanguageFromSettings({ settings: { language: 'de' } });

    // Give any (unexpected) async change a chance to happen before asserting.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(i18n.language).toBe('fr');
  });

  it('ignores the default blob language — nothing to recover, no pointless write', async () => {
    await freshDocument('en');

    importLanguageFromSettings({ settings: { settings: { language: 'en' } } });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(i18n.language).toBe('en');
    expect(vscodeApiMock.state.current['language']).toBeUndefined();
  });

  it('ignores unsupported blob values', async () => {
    await freshDocument('en');

    importLanguageFromSettings({ settings: { settings: { language: 'xx' } } });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(i18n.language).toBe('en');
    expect(vscodeApiMock.state.current['language']).toBeUndefined();
  });

  it('is a no-op once the state has been healed (one-shot)', async () => {
    await freshDocument('en');
    importLanguageFromSettings({ settings: { language: 'de' } });
    await waitFor(() => expect(i18n.language).toBe('de'));

    // A later settings:response echo (e.g. after a save) must not override.
    importLanguageFromSettings({ settings: { language: 'fr' } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(i18n.language).toBe('de');
  });
});
