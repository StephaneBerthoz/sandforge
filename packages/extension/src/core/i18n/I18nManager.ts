type TranslationMap = Record<string, string>;

/**
 * Manages translations for the VSCode extension backend.
 * Provides a simple key-based translation system with locale fallback and interpolation.
 */
export class I18nManager {
  private currentLocale: string;
  private translations: Map<string, TranslationMap> = new Map();
  private fallbackLocale: string;

  constructor(defaultLocale: string = 'en', fallbackLocale: string = 'en') {
    this.currentLocale = defaultLocale;
    this.fallbackLocale = fallbackLocale;
  }

  /** Register translations for a locale */
  registerLocale(locale: string, translations: TranslationMap): void {
    const existing = this.translations.get(locale);
    this.translations.set(locale, existing ? { ...existing, ...translations } : translations);
  }

  /** Set the current locale */
  setLocale(locale: string): void {
    this.currentLocale = locale;
  }

  /** Get the current locale */
  getLocale(): string {
    return this.currentLocale;
  }

  /** Get all registered locale codes */
  getAvailableLocales(): string[] {
    return Array.from(this.translations.keys());
  }

  /**
   * Translate a key with optional interpolation.
   * Falls back to fallback locale if key not found in current locale.
   * Returns the key itself if no translation found.
   */
  t(key: string, params?: Record<string, string | number>): string {
    let text = this.getTranslation(this.currentLocale, key);
    if (text === undefined) {
      text = this.getTranslation(this.fallbackLocale, key);
    }
    if (text === undefined) {
      return key;
    }
    if (params) {
      text = this.interpolate(text, params);
    }
    return text;
  }

  /** Check if a translation key exists in current or fallback locale */
  hasKey(key: string): boolean {
    return (
      this.getTranslation(this.currentLocale, key) !== undefined ||
      this.getTranslation(this.fallbackLocale, key) !== undefined
    );
  }

  /** Get missing keys for a locale compared to fallback */
  getMissingKeys(locale: string): string[] {
    const fallbackKeys = Object.keys(this.translations.get(this.fallbackLocale) ?? {});
    const localeTranslations = this.translations.get(locale);
    if (!localeTranslations) return fallbackKeys;
    return fallbackKeys.filter((key) => !(key in localeTranslations));
  }

  private getTranslation(locale: string, key: string): string | undefined {
    const translations = this.translations.get(locale);
    if (!translations) return undefined;
    return translations[key];
  }

  private interpolate(text: string, params: Record<string, string | number>): string {
    return text.replace(/\{\{(\w+)\}\}/g, (_, paramKey: string) => {
      return paramKey in params ? String(params[paramKey]) : `{{${paramKey}}}`;
    });
  }
}
