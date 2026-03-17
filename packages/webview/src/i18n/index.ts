import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './locales/en.json';
import fr from './locales/fr.json';
import de from './locales/de.json';
import es from './locales/es.json';
import ja from './locales/ja.json';
import ptBR from './locales/pt-BR.json';

/** Supported application languages. */
export type SupportedLanguage = 'en' | 'fr' | 'de' | 'es' | 'ja' | 'pt-BR';

/**
 * Initialize i18next with react-i18next integration.
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
  lng: 'en',
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
