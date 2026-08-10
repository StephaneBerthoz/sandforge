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

const SUPPORTED_LANGUAGES: readonly string[] = ['en', 'fr', 'de', 'es', 'ja', 'pt-BR'];

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
    if (typeof lng === 'string' && SUPPORTED_LANGUAGES.includes(lng)) {
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

export default i18n;
