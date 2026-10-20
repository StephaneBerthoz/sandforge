import React, { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { SEED_LOCALES } from '@sandforge/shared';
import { Select } from '../../components/ui/Select';

/**
 * A locale's name in the panel's language, "French (France)" for `fr_FR`,
 * or the locale itself where the browser has no name for it.
 */
function localeName(names: Intl.DisplayNames | undefined, locale: string): string {
  try {
    return names?.of(locale.replace('_', '-')) ?? locale;
  } catch {
    return locale;
  }
}

/** Props for {@link SeedLocalePicker}. */
export interface SeedLocalePickerProps {
  /** The locale chosen, '' for the org's own. */
  value: string;
  /** A locale chosen, '' for the org's own. */
  onChange: (locale: string) => void;
  /** Test id of the select. */
  testId: string;
}

/**
 * The locale a seed draws its people, companies, addresses and phone numbers
 * in: the org's own by default, said as such, or one of the locales the
 * generator has names for (`SEED_LOCALES`).
 *
 * The run took the org's default locale and nothing else: a French org could
 * not be filled with American test data, nor an American org with French,
 * except from the command line's `--locale`.
 */
export const SeedLocalePicker: React.FC<SeedLocalePickerProps> = ({ value, onChange, testId }) => {
  const { t, i18n } = useTranslation();
  const hintId = useId();
  const options = useMemo(() => {
    let names: Intl.DisplayNames | undefined;
    try {
      names = new Intl.DisplayNames([i18n.language, 'en'], { type: 'language' });
    } catch {
      names = undefined;
    }
    return [
      { value: '', label: t('seed.locale.orgDefault') },
      ...SEED_LOCALES.map((locale) => ({ value: locale, label: localeName(names, locale) })),
    ];
  }, [t, i18n.language]);

  return (
    <div className="flex flex-col gap-0.5">
      <Select
        label={t('seed.locale.label')}
        options={options}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-describedby={hintId}
        data-testid={testId}
      />
      <p id={hintId} className="text-[11px] text-text-secondary">
        {t('seed.locale.hint')}
      </p>
    </div>
  );
};
