import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { answerCapturedLocaleRequests, stubLocaleBridge } from './testing/mockLocaleBridge';

/**
 * VS Code API mock + locale bridge double. The i18n module lazy-loads every
 * non-English bundle over the bridge — the stub answers those requests with
 * the real locale JSONs so the assertions below keep testing genuine
 * translations. No language is persisted (getState → empty), so the module
 * boots in English without a bridge request.
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

import i18n, { changeLanguageLazy } from './index';

describe('i18n', () => {
  beforeEach(() => {
    stubLocaleBridge(vscodeApiMock.postMessage);
  });

  it('should initialize successfully', () => {
    expect(i18n.isInitialized).toBe(true);
  });

  it('should default to English', () => {
    expect(i18n.language).toBe('en');
  });

  it('should return English strings with t()', () => {
    expect(i18n.t('common.save')).toBe('Save');
    expect(i18n.t('common.cancel')).toBe('Cancel');
    expect(i18n.t('nav.home')).toBe('Home');
    expect(i18n.t('org.title')).toBe('Organizations');
    expect(i18n.t('notifications.title')).toBe('Notifications');
  });

  it('should return French strings after changing language', async () => {
    await changeLanguageLazy('fr');

    expect(i18n.t('common.save')).toBe('Enregistrer');
    expect(i18n.t('common.cancel')).toBe('Annuler');
    expect(i18n.t('nav.home')).toBe('Accueil');
    expect(i18n.t('org.title')).toBe('Organisations');
    expect(i18n.t('notifications.title')).toBe('Notifications');

    await changeLanguageLazy('en');
  });

  it('should fall back to English for missing keys', async () => {
    await changeLanguageLazy('fr');

    const missingKey = 'common.nonExistentKey';
    expect(i18n.t(missingKey)).toBe(missingKey);

    await changeLanguageLazy('en');
  });

  it('should return German strings after changing to de', async () => {
    await changeLanguageLazy('de');

    expect(i18n.t('common.save')).toBe('Speichern');

    await changeLanguageLazy('en');
  });

  it('should return Spanish strings after changing to es', async () => {
    await changeLanguageLazy('es');

    expect(i18n.t('common.save')).toBe('Guardar');

    await changeLanguageLazy('en');
  });

  it('should return Japanese strings after changing to ja', async () => {
    await changeLanguageLazy('ja');

    expect(i18n.t('common.save')).toBe('保存');

    await changeLanguageLazy('en');
  });

  it('should return Brazilian Portuguese strings after changing to pt-BR', async () => {
    await changeLanguageLazy('pt-BR');

    expect(i18n.t('common.save')).toBe('Salvar');

    await changeLanguageLazy('en');
  });

  it('should mirror the active language onto <html lang>', async () => {
    await changeLanguageLazy('ja');
    expect(document.documentElement.lang).toBe('ja');

    await changeLanguageLazy('pt-BR');
    expect(document.documentElement.lang).toBe('pt-BR');

    await changeLanguageLazy('en');
    expect(document.documentElement.lang).toBe('en');
  });

  it('should fall back to English for unsupported languages', async () => {
    // Direct instance call: an unsupported code never crosses the bridge
    // (changeLanguageLazy is typed on SupportedLanguage) — i18next falls
    // back to English on its own.
    await i18n.changeLanguage('xx');

    expect(i18n.t('common.save')).toBe('Save');

    await i18n.changeLanguage('en');
  });

  it('should have all nav keys in both languages', async () => {
    await changeLanguageLazy('fr');
    const navKeys = [
      'nav.home',
      'nav.orgs',
      'nav.seed',
      'nav.sync',
      'nav.monitor',
      'nav.compare',
      'nav.dataops',
      'nav.automation',
      'nav.reports',
      'nav.settings',
    ];

    for (const key of navKeys) {
      const enValue = i18n.t(key, { lng: 'en' });
      const frValue = i18n.t(key, { lng: 'fr' });

      expect(enValue).not.toBe(key);
      expect(frValue).not.toBe(key);
    }

    await changeLanguageLazy('en');
  });

  it('should have all org keys in both languages', async () => {
    await changeLanguageLazy('fr');
    const orgKeys = [
      'org.title',
      'org.connect',
      'org.disconnect',
      'org.edit',
      'org.noOrgs',
      'org.status_connected',
      'org.status_expired',
      'org.status_error',
      'org.status_refreshing',
      'org.safetyTier',
      'org.alias',
      'org.username',
      'org.instanceUrl',
      'org.orgType',
      'org.production',
      'org.sandbox',
      'org.scratch',
      'org.developer',
      'org.tier_critical',
      'org.tier_high',
      'org.tier_medium',
      'org.tier_low',
    ];

    for (const key of orgKeys) {
      const enValue = i18n.t(key, { lng: 'en' });
      const frValue = i18n.t(key, { lng: 'fr' });

      expect(enValue).not.toBe(key);
      expect(frValue).not.toBe(key);
    }

    await changeLanguageLazy('en');
  });
});

/**
 * Boot-time editor-locale detection (the `auto` language setting).
 *
 * Every case re-imports the module with `vi.resetModules()` so the module-load
 * boot restore runs again against a controlled webview state and a controlled
 * `navigator`. The locale bridge stub answers the bundle request the restore
 * fires, exactly like the extension would.
 */
describe('i18n editor-locale detection at boot', () => {
  beforeEach(() => {
    stubLocaleBridge(vscodeApiMock.postMessage);
    vscodeApiMock.state.current = {};
    vscodeApiMock.postMessage.mockClear();
    vscodeApiMock.setState.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Re-import the i18n module and wait for its boot restore to settle.
   *
   * `vi.resetModules()` re-evaluates this module but NOT `i18next`, which
   * lives in node_modules and stays the same singleton: re-running its
   * `init()` re-emits `languageChanged`, and the previous module instance's
   * listener would write the current language straight back into the webview
   * state — masking the very "nothing persisted" case under test. Detaching
   * the stale listener first leaves only the freshly imported module wired,
   * which is the real single-import situation in a webview.
   */
  async function bootFreshI18n(): Promise<typeof import('./index')> {
    i18n.off('languageChanged');
    vi.resetModules();
    const fresh = await import('./index');
    await answerCapturedLocaleRequests(vscodeApiMock.postMessage);
    await fresh.i18nReady;
    return fresh;
  }

  it('adopts the editor locale on first launch when nothing was persisted', async () => {
    vi.stubGlobal('navigator', { language: 'fr-FR', languages: ['fr-FR', 'fr'] });

    const fresh = await bootFreshI18n();

    expect(fresh.default.language).toBe('fr');
    expect(fresh.default.t('common.save')).toBe('Enregistrer');
  });

  it('maps a regional tag onto the shipped locale (pt-PT → pt-BR)', async () => {
    vi.stubGlobal('navigator', { language: 'pt-PT', languages: ['pt-PT'] });

    const fresh = await bootFreshI18n();

    expect(fresh.default.language).toBe('pt-BR');
  });

  it('skips editor locales with no shipped bundle and keeps English', async () => {
    vi.stubGlobal('navigator', { language: 'zh-CN', languages: ['zh-CN'] });

    const fresh = await bootFreshI18n();

    expect(fresh.default.language).toBe('en');
  });

  it('falls through the editor preference list to the first shipped locale', async () => {
    vi.stubGlobal('navigator', { language: 'zh-CN', languages: ['zh-CN', 'ko-KR', 'ja-JP'] });

    const fresh = await bootFreshI18n();

    expect(fresh.default.language).toBe('ja');
  });

  it('lets a persisted user choice win over the editor locale', async () => {
    vscodeApiMock.state.current = { language: 'de' };
    vi.stubGlobal('navigator', { language: 'ja-JP', languages: ['ja-JP'] });

    const fresh = await bootFreshI18n();

    expect(fresh.default.language).toBe('de');
  });

  it('does NOT persist a detected language — the settings blob must still win', async () => {
    vi.stubGlobal('navigator', { language: 'fr-FR', languages: ['fr-FR'] });

    const fresh = await bootFreshI18n();

    expect(fresh.default.language).toBe('fr');
    // Nothing written to the webview state: `importLanguageFromSettings`
    // still sees "no user choice here" and can recover the real one.
    expect(vscodeApiMock.state.current['language']).toBeUndefined();

    fresh.importLanguageFromSettings({ settings: { language: 'de' } });
    await answerCapturedLocaleRequests(vscodeApiMock.postMessage);
    expect(fresh.default.language).toBe('de');
  });
});
