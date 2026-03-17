import { useState, useEffect, useCallback } from 'react';
import { I18nEngine } from '@sandforge/shared';
import type { SupportedLocale } from '@sandforge/shared';

/**
 * Custom translation hook powered by the shared I18nEngine.
 * Provides the same t(key, defaultOrParams?) API used throughout the app.
 * Re-renders components when the locale changes.
 */
export function useSfTranslation(): {
  t: (key: string, paramsOrDefault?: Record<string, string | number> | string) => string;
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => void;
} {
  const engine = I18nEngine.getInstance();
  const [locale, setLocaleState] = useState<SupportedLocale>(engine.getLocale());

  useEffect(() => {
    const unsubscribe = engine.onLocaleChange((newLocale) => {
      setLocaleState(newLocale);
    });
    return unsubscribe;
  }, [engine]);

  const t = useCallback(
    (key: string, paramsOrDefault?: Record<string, string | number> | string): string => {
      return engine.t(key, paramsOrDefault);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [locale],
  );

  const setLocale = useCallback(
    (newLocale: SupportedLocale) => {
      engine.setLocale(newLocale);
    },
    [engine],
  );

  return { t, locale, setLocale };
}
