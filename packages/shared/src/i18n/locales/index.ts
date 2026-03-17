import type { SupportedLocale, TranslationRecord } from '../types.js';
import { I18nEngine } from '../I18nEngine.js';
import * as en from './en/index.js';
import * as fr from './fr/index.js';

/**
 * All locale modules keyed by locale code.
 * WebView-level translations are in packages/webview/src/i18n/locales/.
 * This map only contains shared-layer translations that exist so far (en, fr).
 * Additional locales (de, es, ja, pt-BR) are handled at the WebView level.
 */
const localeModules: Partial<Record<SupportedLocale, Record<string, TranslationRecord>>> = {
  en: en as unknown as Record<string, TranslationRecord>,
  fr: fr as unknown as Record<string, TranslationRecord>,
};

/**
 * Load all translation namespaces into the I18nEngine singleton.
 * Call this once at application startup.
 */
export function loadAllTranslations(engine?: I18nEngine): void {
  const target = engine ?? I18nEngine.getInstance();
  for (const [locale, modules] of Object.entries(localeModules)) {
    for (const [ns, translations] of Object.entries(modules)) {
      target.loadNamespace(ns, locale as SupportedLocale, translations);
    }
  }
}
