import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { PriceCurrencySettled } from '@sandforge/shared';

/** How the prices went, in the user's words. */
const HOW_KEYS: Record<PriceCurrencySettled['how'], string> = {
  replaced: 'forge.prices.replaced',
  converted: 'forge.prices.converted',
  none: 'forge.prices.none',
};

/** Props for {@link PriceCurrenciesResult}. */
export interface PriceCurrenciesResultProps {
  /** The prices read in a currency the target does not hold active, and how each went. */
  entries: readonly PriceCurrencySettled[];
}

/**
 * The prices a run read in a currency the target does not hold active, or
 * whose lines' records went in another, and how each went: replaced by the
 * source's own price of the same product and price book in the currency
 * written, and linked to its copy; written in it at its amount converted; or
 * left in another currency, the target refusing the lines of a record in it.
 *
 * Sync listed them as notes among each object's refusals, "4 GBP → USD:
 * price(s) … replaced …" in red under the errors of its prices, though none
 * of it was refused.
 */
export const PriceCurrenciesResult: React.FC<PriceCurrenciesResultProps> = ({ entries }) => {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-testid="results-price-currencies"
      className="rounded-sm border border-subtle px-4 py-2 text-xs text-text-secondary"
    >
      <h3 id={headingId} className="font-medium text-text-primary">
        {t('forge.prices.title')}
      </h3>
      <p className="mt-0.5">{t('forge.prices.hint')}</p>
      <ul className="mt-1 space-y-0.5">
        {entries.map((entry) => (
          <li
            key={[entry.from, entry.to, entry.how, entry.forLines ? 'lines' : ''].join('|')}
            data-testid="results-price-currencies-row"
          >
            {`${t('forge.prices.prices', { count: entry.prices, from: entry.from })}, `}
            {t(HOW_KEYS[entry.how], { to: entry.to })}
            {entry.forLines ? ` — ${t('forge.prices.forLines', { to: entry.to })}` : ''}
          </li>
        ))}
      </ul>
    </section>
  );
};
