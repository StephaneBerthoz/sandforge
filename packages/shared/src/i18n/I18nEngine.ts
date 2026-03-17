import type { TranslationRecord, SupportedLocale } from './types.js';

/**
 * Lightweight i18n engine for the SandForge application.
 * Singleton that manages translations with namespace-based organization,
 * dot-path key resolution, and {{param}} interpolation.
 */
export class I18nEngine {
  private static instance: I18nEngine | null = null;
  private locale: SupportedLocale = 'en';
  private namespaces = new Map<string, Map<SupportedLocale, TranslationRecord>>();
  private listeners = new Set<(locale: SupportedLocale) => void>();

  private constructor() {}

  /** Get or create the singleton instance. */
  static getInstance(): I18nEngine {
    if (!I18nEngine.instance) {
      I18nEngine.instance = new I18nEngine();
    }
    return I18nEngine.instance;
  }

  /** Reset the singleton (for testing). */
  static reset(): void {
    I18nEngine.instance = null;
  }

  /** Load translations for a namespace and locale. */
  loadNamespace(ns: string, locale: SupportedLocale, translations: TranslationRecord): void {
    if (!this.namespaces.has(ns)) {
      this.namespaces.set(ns, new Map());
    }
    this.namespaces.get(ns)!.set(locale, translations);
  }

  /**
   * Translate a dot-separated key with optional params or default value.
   * - t('common.save') — namespace 'common', path 'save'
   * - t('seed.strategies.ai') — namespace 'seed', path 'strategies.ai'
   * - t('common.save', 'Save') — with default fallback
   * - t('org.connected', \{ alias: 'MyOrg' \}) — with interpolation
   */
  t(key: string, paramsOrDefault?: Record<string, string | number> | string): string {
    const dotIndex = key.indexOf('.');
    if (dotIndex === -1) {
      return typeof paramsOrDefault === 'string' ? paramsOrDefault : key;
    }

    const ns = key.substring(0, dotIndex);
    const path = key.substring(dotIndex + 1);

    let text = this.resolve(ns, this.locale, path);
    if (text === undefined && this.locale !== 'en') {
      text = this.resolve(ns, 'en', path);
    }
    if (text === undefined) {
      return typeof paramsOrDefault === 'string' ? paramsOrDefault : key;
    }

    if (typeof paramsOrDefault === 'object' && paramsOrDefault !== null) {
      text = this.interpolate(text, paramsOrDefault);
    }
    return text;
  }

  /** Set the active locale. Notifies all listeners. */
  setLocale(locale: SupportedLocale): void {
    if (this.locale !== locale) {
      this.locale = locale;
      for (const listener of this.listeners) {
        listener(locale);
      }
    }
  }

  /** Get the current locale. */
  getLocale(): SupportedLocale {
    return this.locale;
  }

  /** Subscribe to locale changes. Returns an unsubscribe function. */
  onLocaleChange(callback: (locale: SupportedLocale) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  /** Get all loaded namespace names. */
  getLoadedNamespaces(): string[] {
    return Array.from(this.namespaces.keys());
  }

  /** Check if a key has a translation in the current or fallback locale. */
  hasKey(key: string): boolean {
    const dotIndex = key.indexOf('.');
    if (dotIndex === -1) return false;
    const ns = key.substring(0, dotIndex);
    const path = key.substring(dotIndex + 1);
    return (
      this.resolve(ns, this.locale, path) !== undefined ||
      this.resolve(ns, 'en', path) !== undefined
    );
  }

  private resolve(ns: string, locale: SupportedLocale, path: string): string | undefined {
    const nsMap = this.namespaces.get(ns);
    if (!nsMap) return undefined;
    const translations = nsMap.get(locale);
    if (!translations) return undefined;

    const parts = path.split('.');
    let current: TranslationRecord | string = translations;
    for (const part of parts) {
      if (typeof current === 'string') return undefined;
      const next: string | TranslationRecord | undefined = current[part];
      if (next === undefined) return undefined;
      current = next;
    }
    return typeof current === 'string' ? current : undefined;
  }

  private interpolate(text: string, params: Record<string, string | number>): string {
    return text.replace(/\{\{(\w+)\}\}/g, (_, paramKey: string) => {
      return paramKey in params ? String(params[paramKey]) : `{{${paramKey}}}`;
    });
  }
}
