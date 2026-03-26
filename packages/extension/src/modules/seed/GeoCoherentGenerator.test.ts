import { describe, it, expect } from 'vitest';
import { GeoCoherentGenerator, GEO_DATA } from './GeoCoherentGenerator';
import type { SupportedLocale } from './LocaleData';

describe('GeoCoherentGenerator', () => {
  it('should return coherent city+state+country for the same index', () => {
    const gen = new GeoCoherentGenerator('en_US');
    const addr = gen.getAddress(0);
    expect(gen.getCity(0)).toBe(addr.city);
    expect(gen.getState(0)).toBe(addr.state);
    expect(gen.getCountry(0)).toBe(addr.country);
    expect(gen.getZipCode(0)).toBe(addr.zipCode);
  });

  it('should return different addresses for different indices', () => {
    const gen = new GeoCoherentGenerator('en_US');
    const addr0 = gen.getAddress(0);
    const addr1 = gen.getAddress(1);
    expect(addr0.city).not.toBe(addr1.city);
  });

  it('should return French cities for fr_FR locale', () => {
    const gen = new GeoCoherentGenerator('fr_FR');
    const addr = gen.getAddress(0);
    expect(addr.country).toBe('France');
    expect(addr.city).toBe('Paris');
    expect(addr.state).toBe('Ile-de-France');
  });

  it('should fall back to en_US for unknown locale', () => {
    const gen = new GeoCoherentGenerator('xx_XX');
    const addr = gen.getAddress(0);
    expect(addr.country).toBe('United States');
  });

  it('should handle prefix locale matching', () => {
    const gen = new GeoCoherentGenerator('de');
    const addr = gen.getAddress(0);
    expect(addr.country).toBe('Germany');
  });

  it('should wrap around indices for consistency', () => {
    const gen = new GeoCoherentGenerator('en_US');
    const tupleCount = GEO_DATA.en_US.length;
    const addr = gen.getAddress(tupleCount); // wraps to index 0
    expect(addr).toEqual(gen.getAddress(0));
  });

  it('should default to en_US when no locale provided', () => {
    const gen = new GeoCoherentGenerator();
    const addr = gen.getAddress(0);
    expect(addr.country).toBe('United States');
  });

  describe('locale data completeness', () => {
    const locales: SupportedLocale[] = ['en_US', 'fr_FR', 'de_DE', 'es_ES', 'ja_JP', 'pt_BR'];

    for (const locale of locales) {
      it(`should have at least 10 unique addresses for ${locale}`, () => {
        const tuples = GEO_DATA[locale];
        expect(tuples.length).toBeGreaterThanOrEqual(10);
        const uniqueCities = new Set(tuples.map((t) => t.city));
        expect(uniqueCities.size).toBeGreaterThanOrEqual(10);
      });
    }
  });

  it('should return Japanese addresses for ja_JP', () => {
    const gen = new GeoCoherentGenerator('ja_JP');
    const addr = gen.getAddress(0);
    expect(addr.country).toBe('Japan');
    expect(addr.city).toBe('Tokyo');
  });

  it('should return Brazilian addresses for pt_BR', () => {
    const gen = new GeoCoherentGenerator('pt_BR');
    const addr = gen.getAddress(0);
    expect(addr.country).toBe('Brazil');
    expect(addr.city).toBe('Sao Paulo');
  });

  it('should return Spanish addresses for es_ES', () => {
    const gen = new GeoCoherentGenerator('es_ES');
    const addr = gen.getAddress(0);
    expect(addr.country).toBe('Spain');
    expect(addr.city).toBe('Madrid');
  });
});
