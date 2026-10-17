import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { CurrencyChosenBy, CurrencyReplaced } from '@sandforge/shared';

/** How the currency the rows went in was chosen, in the user's words. */
const CHOSEN_KEYS: Record<CurrencyChosenBy, string> = {
  corporate: 'forge.currencies.corporate',
  'record-type-default': 'forge.currencies.recordTypeDefault',
  decision: 'forge.currencies.decision',
};

/** Props for {@link ForgeCurrenciesResult}. */
export interface ForgeCurrenciesResultProps {
  /** The rows the run wrote in another currency than it read them in. */
  entries: readonly CurrencyReplaced[];
}

/**
 * The rows a run wrote in another currency than it read them in, per object:
 * the target does not hold theirs active, so each went in the target's
 * corporate currency or its record type's default — or in the one the user
 * mapped it to — and its amounts were converted into it at the source's
 * rates, or written as read where no rate converts them. Said with how many
 * rows and which fields.
 */
export const ForgeCurrenciesResult: React.FC<ForgeCurrenciesResultProps> = ({ entries }) => {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-testid="forge-results-currencies"
      className="rounded-sm border border-subtle px-4 py-2 text-xs text-text-secondary"
    >
      <h3 id={headingId} className="font-medium text-text-primary">
        {t('forge.currencies.title')}
      </h3>
      <p className="mt-0.5">{t('forge.currencies.hint')}</p>
      <ul className="mt-1 space-y-0.5">
        {entries.map((entry) => {
          const values = { from: entry.from, to: entry.to, fields: entry.fields.join(', ') };
          const amounts = entry.notConverted
            ? t('forge.currencies.notConverted', values)
            : entry.fields.length === 0
              ? t('forge.currencies.noAmount')
              : t(
                  entry.atTargetRate
                    ? 'forge.currencies.convertedAtTargetRate'
                    : 'forge.currencies.converted',
                  values,
                );
          return (
            <li
              key={[entry.objectApiName, entry.from, entry.to, entry.chosenBy].join('|')}
              data-testid="forge-results-currencies-row"
            >
              <span className="font-mono text-text-primary">{entry.objectApiName}</span>
              {` — ${t('forge.currencies.rows', { count: entry.rows, from: entry.from })}, `}
              {`${t(CHOSEN_KEYS[entry.chosenBy], values)} — ${amounts}`}
            </li>
          );
        })}
      </ul>
    </section>
  );
};
