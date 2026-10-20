import { describe, it, expect, beforeAll } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createInstance, type i18n as I18n } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import type { PriceCurrencySettled } from '@sandforge/shared';

import en from '../../i18n/locales/en.json';
import fr from '../../i18n/locales/fr.json';
import de from '../../i18n/locales/de.json';
import es from '../../i18n/locales/es.json';
import ptBR from '../../i18n/locales/pt-BR.json';
import ja from '../../i18n/locales/ja.json';
import { PriceCurrenciesResult } from './PriceCurrenciesResult';

const LOCALES = { en, fr, de, es, 'pt-BR': ptBR, ja } as const;
let instance: I18n;

beforeAll(async () => {
  instance = createInstance();
  await instance.use(initReactI18next).init({
    resources: Object.fromEntries(
      Object.entries(LOCALES).map(([lng, translation]) => [lng, { translation }]),
    ),
    lng: 'en',
    fallbackLng: false,
    interpolation: { escapeValue: false },
  });
});

const ENTRIES: PriceCurrencySettled[] = [
  { from: 'GBP', to: 'USD', how: 'replaced', forLines: false, prices: 4 },
  { from: 'GBP', to: 'EUR', how: 'converted', forLines: true, prices: 1 },
  { from: 'GBP', to: 'CHF', how: 'none', forLines: true, prices: 2 },
];

/** The rows the component renders for `entries` in `lng`. */
function rowsIn(lng: string, entries: readonly PriceCurrencySettled[]): string[] {
  void instance.changeLanguage(lng);
  render(
    <I18nextProvider i18n={instance}>
      <PriceCurrenciesResult entries={entries} />
    </I18nextProvider>,
  );
  const rows = screen
    .getAllByTestId('results-price-currencies-row')
    .map((row) => row.textContent ?? '');
  cleanup();
  return rows;
}

describe('PriceCurrenciesResult', () => {
  it('says how each price read in another currency went, apart from any refusal', () => {
    void instance.changeLanguage('en');
    render(
      <I18nextProvider i18n={instance}>
        <PriceCurrenciesResult entries={ENTRIES} />
      </I18nextProvider>,
    );

    expect(screen.getByRole('heading', { name: 'Prices in another currency' })).toBeDefined();
    expect(
      screen.getAllByTestId('results-price-currencies-row').map((row) => row.textContent),
    ).toEqual([
      "4 prices in GBP, replaced by the source org's own price in USD for the same product and price book, and linked to its copy",
      '1 price in GBP, written in EUR at their amount converted: the source org holds no price in it for the same product and price book — EUR being the currency of the records their lines belong to',
      '2 prices in GBP, no price in CHF for the same product and price book, and they go in another currency for other lines: the target org refuses the lines of a record in CHF — CHF being the currency of the records their lines belong to',
    ]);
    cleanup();
  });

  for (const lng of Object.keys(LOCALES)) {
    it(`says every way a price went in ${lng}, with both currencies and the count`, () => {
      const rows = rowsIn(lng, ENTRIES);

      expect(rows).toHaveLength(ENTRIES.length);
      rows.forEach((text, at) => {
        const entry = ENTRIES[at];
        expect(text).not.toMatch(/forge\.prices\.|\{\{|\}\}/);
        for (const said of [entry.from, entry.to, String(entry.prices)]) {
          expect(text).toContain(said);
        }
      });
    });
  }
});
