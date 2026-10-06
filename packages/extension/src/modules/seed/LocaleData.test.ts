import { describe, it, expect } from 'vitest';
import {
  getLocaleData,
  formatPhone,
  formatZipCode,
  isReservedEmailDomain,
  isReservedPhone,
  localeOfPhone,
  reservedPhone,
  LOCALE_DATA,
  type SupportedLocale,
} from './LocaleData';

describe('LocaleData', () => {
  describe('getLocaleData', () => {
    it('should return French data for fr_FR', () => {
      const data = getLocaleData('fr_FR');
      expect(data.firstNames).toContain('Marie');
      expect(data.firstNames).toContain('Pierre');
      expect(data.cities).toContain('Paris');
    });

    it('should fall back to en_US for unknown locale', () => {
      const data = getLocaleData('unknown');
      expect(data.firstNames).toContain('Alice');
      expect(data.cities).toContain('New York');
    });

    it('should prefix-match fr to fr_FR', () => {
      const data = getLocaleData('fr');
      expect(data.firstNames).toContain('Marie');
      expect(data.cities).toContain('Paris');
    });

    it('should prefix-match de to de_DE', () => {
      const data = getLocaleData('de');
      expect(data.firstNames).toContain('Max');
      expect(data.cities).toContain('Berlin');
    });

    it('should prefix-match ja to ja_JP', () => {
      const data = getLocaleData('ja');
      expect(data.firstNames).toContain('Taro');
      expect(data.cities).toContain('Tokyo');
    });

    it('should return exact match for es_ES', () => {
      const data = getLocaleData('es_ES');
      expect(data.firstNames).toContain('Carlos');
      expect(data.cities).toContain('Madrid');
    });

    it('should return exact match for pt_BR', () => {
      const data = getLocaleData('pt_BR');
      expect(data.firstNames).toContain('Joao');
      expect(data.cities).toContain('Sao Paulo');
    });
  });

  describe('locale data completeness', () => {
    const locales: SupportedLocale[] = ['en_US', 'fr_FR', 'de_DE', 'es_ES', 'ja_JP', 'pt_BR'];

    for (const locale of locales) {
      it(`should have at least 10 firstNames for ${locale}`, () => {
        expect(LOCALE_DATA[locale].firstNames.length).toBeGreaterThanOrEqual(10);
      });

      it(`should have at least 10 lastNames for ${locale}`, () => {
        expect(LOCALE_DATA[locale].lastNames.length).toBeGreaterThanOrEqual(10);
      });

      it(`should have at least 10 cities for ${locale}`, () => {
        expect(LOCALE_DATA[locale].cities.length).toBeGreaterThanOrEqual(10);
      });

      it(`should have at least 10 companies for ${locale}`, () => {
        expect(LOCALE_DATA[locale].companies.length).toBeGreaterThanOrEqual(10);
      });

      it(`should have email domains for ${locale}`, () => {
        expect(LOCALE_DATA[locale].emailDomains.length).toBeGreaterThan(0);
      });

      it(`gives ${locale} only email domains no mailbox can be at`, () => {
        for (const domain of LOCALE_DATA[locale].emailDomains) {
          expect(isReservedEmailDomain(domain), domain).toBe(true);
        }
      });
    }
  });

  describe('formatPhone', () => {
    it('should produce correct length string with no X chars remaining', () => {
      const result = formatPhone('+33 X XX XX XX XX', 0);
      expect(result).not.toContain('X');
      expect(result.length).toBe('+33 X XX XX XX XX'.length);
    });

    it('should produce different results for different indices', () => {
      const r1 = formatPhone('+1 XXX-XXX-XXXX', 0);
      const r2 = formatPhone('+1 XXX-XXX-XXXX', 1);
      expect(r1).not.toBe(r2);
    });

    it('should only contain digits where X was', () => {
      const result = formatPhone('+33 X XX XX XX XX', 5);
      // Remove non-digit, non-plus, non-space chars — should be empty
      const xRemaining = result.replace(/[0-9+\- ]/g, '');
      expect(xRemaining).toBe('');
    });

    it('gives each index below the capacity of its X digits a number of its own', () => {
      // The digits used to depend on the index modulo 10: every tenth record
      // shared its number with the first.
      const numbers = Array.from({ length: 100 }, (_, i) => formatPhone('+1 212-555-01XX', i));
      expect(new Set(numbers).size).toBe(100);
    });
  });

  describe('isReservedEmailDomain', () => {
    it('accepts the domains RFC 2606 and RFC 6761 reserve, and the names under them', () => {
      for (const domain of [
        'example.com',
        'example.net',
        'example.org',
        'mail.example.com',
        'acme.example',
        'courriel.test',
        'acme.com.invalid',
        'EXAMPLE.ORG.',
      ]) {
        expect(isReservedEmailDomain(domain), domain).toBe(true);
      }
    });

    it('refuses a domain somebody can register, however much it looks like an example', () => {
      for (const domain of [
        'mail.com',
        'test.com',
        'exemple.fr',
        'example.fr',
        'example.com.br',
        'example.company',
        'mytest',
      ]) {
        expect(isReservedEmailDomain(domain), domain).toBe(false);
      }
    });
  });

  describe('isReservedPhone', () => {
    it('recognises a number nobody holds, however it is written', () => {
      for (const written of [
        '+1 212-555-0142',
        '(212) 555-0142',
        '1-212-555-0142',
        '555-0142',
        '+33 6 39 98 12 34',
        '06 39 98 12 34',
        '+33 (0)1 99 00 12 34',
        '0033 5 36 49 12 34',
        '+49 30 23125 123',
        '0221 4710123',
        '+34 312 345 678',
        '+81 90-0123-4567',
        '090-0123-4567',
        '+55 11 90123-4567',
        '(85) 90123-4567',
      ]) {
        expect(isReservedPhone(written), written).toBe(true);
      }
    });

    it('refuses a number someone may hold', () => {
      for (const written of [
        '+1 415-867-5309',
        '+1 212-555-1234',
        '+33 6 12 34 56 78',
        '01 99 01 12 34',
        '+49 30 1234567',
        '+34 612 345 678',
        '+81 90-1234-5678',
        '+55 11 91234-5678',
        '+44 7700 900123',
      ]) {
        expect(isReservedPhone(written), written).toBe(false);
      }
    });

    it("refuses another locale's reserved number when a locale is named", () => {
      expect(isReservedPhone('+33 6 39 98 12 34', 'fr_FR')).toBe(true);
      expect(isReservedPhone('+33 6 39 98 12 34', 'en_US')).toBe(false);
    });
  });

  describe('localeOfPhone', () => {
    it('reads the locale from the country code of a number in international form', () => {
      expect(localeOfPhone('+33 6 12 34 56 78')).toBe('fr_FR');
      expect(localeOfPhone('0049 30 1234567')).toBe('de_DE');
      expect(localeOfPhone('+1 (415) 867-5309')).toBe('en_US');
      expect(localeOfPhone('06 12 34 56 78')).toBeUndefined();
      expect(localeOfPhone('+44 20 7946 0123')).toBeUndefined();
    });
  });

  describe('reservedPhone', () => {
    const locales: SupportedLocale[] = ['en_US', 'fr_FR', 'de_DE', 'es_ES', 'ja_JP', 'pt_BR'];

    for (const locale of locales) {
      it(`gives each of the first thousand ${locale} records its own number nobody holds`, () => {
        const numbers = Array.from({ length: 1000 }, (_, i) => reservedPhone(locale, i));
        expect(new Set(numbers).size).toBe(1000);
        for (const number of numbers) {
          expect(isReservedPhone(number, locale), number).toBe(true);
        }
      });
    }
  });

  describe('formatZipCode', () => {
    it('should produce correct length string with no # chars remaining', () => {
      const result = formatZipCode('#####', 0);
      expect(result).not.toContain('#');
      expect(result.length).toBe(5);
    });

    it('should handle format with separator', () => {
      const result = formatZipCode('###-####', 3);
      expect(result).not.toContain('#');
      expect(result.length).toBe(8); // 3 digits + dash + 4 digits
      expect(result[3]).toBe('-');
    });

    it('should produce different results for different indices', () => {
      const r1 = formatZipCode('#####', 0);
      const r2 = formatZipCode('#####', 1);
      expect(r1).not.toBe(r2);
    });
  });
});
