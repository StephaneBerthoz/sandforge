import { describe, it, expect } from 'vitest';
import { FIRST_NAMES, LAST_NAMES, STREETS, companiesOf, companyAt } from './localeNames';
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

    it(`names the branches of ${locale} companies after a region, every one unlike the others`, () => {
      const companies = companiesOf(locale);
      const all = new Set<string>();
      for (let round = 0; round < 8; round++) {
        companies.forEach((company, index) => {
          const name = companyAt(locale, index, round);
          if (round === 0) expect(name).toBe(company);
          else expect(name).not.toBe(company);
          all.add(name);
        });
      }
      expect(all.size).toBe(companies.length * 8);
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

  it('puts the region beside the root, where a regional company of the group has it', () => {
    const index = companiesOf('de_DE').indexOf('Kaltenbrunn GmbH');
    expect(companyAt('de_DE', index, 1)).toBe('Kaltenbrunn Nord GmbH');
    expect(companyAt('fr_FR', companiesOf('fr_FR').indexOf('Groupe Vercourt'), 1)).toBe(
      'Groupe Vercourt Ouest',
    );
    expect(companyAt('de_DE', index, 7)).toBe('Kaltenbrunn Nord GmbH 2');
  });
});
