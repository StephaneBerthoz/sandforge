import { describe, it, expect, beforeAll } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { createInstance, type i18n as I18n } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import type { CurrencyReplaced } from '@sandforge/shared';

import en from '../../i18n/locales/en.json';
import fr from '../../i18n/locales/fr.json';
import de from '../../i18n/locales/de.json';
import es from '../../i18n/locales/es.json';
import ptBR from '../../i18n/locales/pt-BR.json';
import ja from '../../i18n/locales/ja.json';
import { ForgeCurrenciesResult } from './ForgeCurrenciesResult';

/*
 * Every way a run says rows went in another currency, under a real i18next
 * instance in each of the six locales: a key the locale lacks would fall back
 * to English, and a placeholder a translation dropped would leave a currency
 * or a field unsaid.
 */
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

const base = { from: 'GBP', to: 'USD', rows: 2, fields: ['Amount'] };
/** Each variant, and what its line must name besides the currencies. */
const VARIANTS: Array<{ name: string; entry: CurrencyReplaced; names: string[] }> = [
  {
    name: 'the corporate currency',
    entry: { ...base, objectApiName: 'Opportunity', chosenBy: 'corporate' },
    names: ['Amount'],
  },
  {
    name: "the record type's default, at the target's rate",
    entry: {
      ...base,
      objectApiName: 'Account',
      to: 'EUR',
      chosenBy: 'record-type-default',
      fields: ['AnnualRevenue'],
      atTargetRate: true,
    },
    names: ['AnnualRevenue'],
  },
  {
    name: 'a decision, its amounts as read',
    entry: { ...base, objectApiName: 'Order__c', chosenBy: 'decision', notConverted: true },
    names: [],
  },
  {
    name: 'the currency of the record they belong to, at the dated rates',
    entry: {
      ...base,
      objectApiName: 'OpportunityLineItem',
      chosenBy: 'parent',
      fields: ['UnitPrice'],
      datedBy: 'CloseDate',
    },
    names: ['UnitPrice', 'CloseDate'],
  },
  {
    name: 'a price in the currency of the records its lines belong to',
    entry: {
      ...base,
      objectApiName: 'PricebookEntry',
      to: 'EUR',
      chosenBy: 'lines',
      fields: ['UnitPrice'],
      atTargetRate: true,
    },
    names: ['UnitPrice'],
  },
  {
    name: 'a price converted into the corporate currency',
    entry: {
      ...base,
      objectApiName: 'PricebookEntry',
      chosenBy: 'corporate',
      fields: ['UnitPrice'],
    },
    names: ['UnitPrice'],
  },
  {
    name: 'the static rates, the dated ones unconfirmed',
    entry: {
      ...base,
      objectApiName: 'Opportunity',
      chosenBy: 'corporate',
      datedUnconfirmed: 'CloseDate',
    },
    names: ['Amount', 'CloseDate'],
  },
  {
    name: 'no amount to convert',
    entry: { ...base, objectApiName: 'Contact', chosenBy: 'corporate', fields: [] },
    names: [],
  },
];

/** The one row the component renders for `entry` in `lng`. */
function rowIn(lng: string, entry: CurrencyReplaced): string {
  void instance.changeLanguage(lng);
  render(
    <I18nextProvider i18n={instance}>
      <ForgeCurrenciesResult entries={[entry]} />
    </I18nextProvider>,
  );
  const [row] = screen.getAllByTestId('forge-results-currencies-row');
  const text = row.textContent ?? '';
  cleanup();
  return text;
}

describe('ForgeCurrenciesResult in every locale', () => {
  for (const lng of Object.keys(LOCALES)) {
    for (const { name, entry, names } of VARIANTS) {
      it(`says ${name} in ${lng}`, () => {
        const text = rowIn(lng, entry);

        expect(text).not.toMatch(/forge\.currencies\.|\{\{|\}\}/);
        for (const said of [entry.objectApiName, entry.from, entry.to, ...names]) {
          expect(text).toContain(said);
        }
      });
    }
  }

  it('says in English the price that followed its lines and the rates it could not confirm', () => {
    expect(rowIn('en', VARIANTS[4].entry)).toBe(
      'PricebookEntry — 2 rows in GBP, written in EUR, the currency of the records their lines ' +
        "belong to — amounts converted at the source org's rate for GBP and the target org's for " +
        'EUR: UnitPrice',
    );
    expect(rowIn('en', VARIANTS[6].entry)).toBe(
      "Opportunity — 2 rows in GBP, written in USD, the target org's corporate currency — " +
        "amounts converted at the source org's rates: Amount — at the static rates: the dated " +
        'rates of CloseDate could not be confirmed',
    );
  });

  it('gives each variant its own words in each locale', () => {
    for (const lng of Object.keys(LOCALES)) {
      const lines = rowIn(lng, VARIANTS[4].entry);
      const parent = rowIn(lng, { ...VARIANTS[4].entry, chosenBy: 'parent' });
      const unconfirmed = rowIn(lng, VARIANTS[6].entry);
      const dated = rowIn(lng, {
        ...VARIANTS[6].entry,
        datedUnconfirmed: undefined,
        datedBy: 'CloseDate',
      });

      expect(lines).not.toBe(parent);
      expect(unconfirmed).not.toBe(dated);
    }
  });
});
