import { describe, it, expect } from 'vitest';
import { FIRST_NAMES, LAST_NAMES, STREETS, companiesOf } from './localeNames';
import type { SupportedLocale } from './LocaleData';

const LOCALES: SupportedLocale[] = ['en_US', 'fr_FR', 'de_DE', 'es_ES', 'ja_JP', 'pt_BR'];

describe('locale names', () => {
  for (const locale of LOCALES) {
    it(`gives ${locale} two hundred first names and two hundred last names, each once`, () => {
      // Fifteen of each made the thousand contacts of a template fifteen people.
      for (const names of [FIRST_NAMES[locale], LAST_NAMES[locale]]) {
        expect(names.length).toBeGreaterThanOrEqual(200);
        expect(new Set(names).size).toBe(names.length);
        for (const name of names) expect(name).toMatch(/^\p{L}[\p{L}'-]*$/u);
      }
    });

    it(`names ${locale} companies from made-up roots, each once, several hundred of them`, () => {
      const companies = companiesOf(locale);
      expect(companies.length).toBeGreaterThanOrEqual(300);
      expect(new Set(companies).size).toBe(companies.length);
      for (const company of companies) expect(company).not.toContain('{root}');
    });

    it(`writes ${locale} streets with their house number`, () => {
      const { names, format } = STREETS[locale];
      expect(names.length).toBeGreaterThanOrEqual(10);
      expect(format).toContain('{street}');
      expect(format).toContain('{n}');
    });
  }

  it('lists companies root by root, so that neighbours do not share a root', () => {
    const [first, second] = companiesOf('en_US');
    expect(first.split(' ')[0]).not.toBe(second.split(' ')[0]);
  });
});
