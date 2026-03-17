import type { SupportedLocale } from '@sandforge/shared';

/** Language codes that map to a supported locale. */
const LOCALE_MAP: Record<string, SupportedLocale> = {
  fr: 'fr',
  de: 'de',
  es: 'es',
  ja: 'ja',
  pt: 'pt-BR',
};

/**
 * Detects the user locale from the VSCode environment and maps it
 * to a SupportedLocale. Sends LOCALE_CHANGED messages to the WebView.
 */
export class LocaleDetector {
  private currentLocale: SupportedLocale;

  constructor(vscodeLanguage?: string) {
    this.currentLocale = LocaleDetector.mapToSupported(vscodeLanguage ?? 'en');
  }

  /** Map a VSCode language tag (e.g. 'fr', 'fr-FR', 'en-US', 'pt-BR') to a SupportedLocale. */
  static mapToSupported(lang: string): SupportedLocale {
    const lower = lang.toLowerCase();
    // Check for exact match first (e.g. 'pt-br')
    if (lower === 'pt-br') return 'pt-BR';
    const normalized = lower.split('-')[0];
    return LOCALE_MAP[normalized] ?? 'en';
  }

  /** Get the detected locale. */
  getLocale(): SupportedLocale {
    return this.currentLocale;
  }

  /** Update the locale (e.g. from user settings override). */
  setLocale(locale: SupportedLocale): void {
    this.currentLocale = locale;
  }

  /**
   * Resolve the effective locale: if settingLocale is 'auto' or undefined,
   * use the VSCode environment language; otherwise use the explicit setting.
   */
  resolve(settingLocale: string | undefined, vscodeLanguage: string): SupportedLocale {
    if (!settingLocale || settingLocale === 'auto') {
      this.currentLocale = LocaleDetector.mapToSupported(vscodeLanguage);
    } else {
      this.currentLocale = LocaleDetector.mapToSupported(settingLocale);
    }
    return this.currentLocale;
  }
}
