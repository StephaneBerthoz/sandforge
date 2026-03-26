import { describe, it, expect } from 'vitest';
import {
  getLocaleData,
  formatPhone,
  formatZipCode,
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
