import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { getVscodeApi } from '../hooks/useVSCodeApi';

import en from './locales/en.json';
import fr from './locales/fr.json';
import de from './locales/de.json';
import es from './locales/es.json';
import ja from './locales/ja.json';
import ptBR from './locales/pt-BR.json';

/** Supported application languages. */
export type SupportedLanguage = 'en' | 'fr' | 'de' | 'es' | 'ja' | 'pt-BR';

/** Every language the UI ships a locale for, in selector display order. */
export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = [
  'en',
  'fr',
  'de',
  'es',
  'ja',
  'pt-BR',
];

/** Key under which the selected language is stored in the VS Code webview state. */
const LANGUAGE_STATE_KEY = 'language';

/**
 * Read the language persisted in the VS Code webview state (getState/setState,
 * the same mechanism useWebviewPersistedState relies on). Returns undefined
 * when no valid language was persisted or outside a webview context.
 */
function getPersistedLanguage(): SupportedLanguage | undefined {
  try {
    const state = getVscodeApi().getState() as Record<string, unknown> | null | undefined;
    const lng = state?.[LANGUAGE_STATE_KEY];
    if (typeof lng === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(lng)) {
      return lng as SupportedLanguage;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Persist the selected language into the VS Code webview state so the choice
 * survives webview reloads. Existing state keys (sync drafts, etc.) are merged,
 * not overwritten. Best-effort: silently ignored outside a webview.
 */
function persistLanguage(lng: string): void {
  try {
    const api = getVscodeApi();
    const existing = (api.getState() as Record<string, unknown> | null | undefined) ?? {};
    api.setState({ ...existing, [LANGUAGE_STATE_KEY]: lng });
  } catch {
    // Non-webview context (tests, dev server) — nothing to persist to.
  }
}

/**
 * Initialize i18next with react-i18next integration.
 * The initial language is restored from the persisted webview state;
 * English is the default and fallback language.
 * Interpolation escaping is disabled because React handles XSS prevention.
 */
void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    fr: { translation: fr },
    de: { translation: de },
    es: { translation: es },
    ja: { translation: ja },
    'pt-BR': { translation: ptBR },
  },
  lng: getPersistedLanguage() ?? 'en',
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
});

i18n.on('languageChanged', persistLanguage);

/**
 * One-shot recovery import, to call when the extension-side settings blob
 * arrives (`settings:response`). The webview state is per-document and dies
 * with the panel, while the blob (globalState) survives — so when the state
 * has NO persisted language but the blob carries a supported one, adopt it:
 * `changeLanguage` applies it AND re-persists it into the fresh webview
 * state via the `languageChanged` listener above, which makes every later
 * call a no-op (the state then has a language and wins).
 *
 * Blob layout is historical baggage: current builds nest the whole settings
 * object under the `settings` key (`{settings: {language}}`, see
 * useSettingsPageData.handleSave), older builds wrote `language` as a flat
 * category key. Both shapes are read.
 */
export function importLanguageFromSettings(settings: unknown): void {
  if (getPersistedLanguage() !== undefined) {
    return; // webview state is the source of truth — nothing to recover
  }
  const blob = settings as Record<string, unknown> | null | undefined;
  const nested = blob?.['settings'] as Record<string, unknown> | null | undefined;
  const candidate = blob?.['language'] ?? nested?.['language'];
  if (
    typeof candidate === 'string' &&
    (SUPPORTED_LANGUAGES as readonly string[]).includes(candidate) &&
    candidate !== i18n.language
  ) {
    void i18n.changeLanguage(candidate);
  }
}

export default i18n;
