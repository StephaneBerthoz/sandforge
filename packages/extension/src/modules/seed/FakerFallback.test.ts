import { describe, it, expect, beforeEach } from 'vitest';
import { FakerFallback, generateByMethod } from './FakerFallback';
import type { FieldRule } from '@sandforge/shared';
import { GEO_DATA } from './GeoCoherentGenerator';
import { LOCALE_DATA } from './LocaleData';

function createFakerRule(method: string, fieldName?: string): FieldRule {
  return {
    fieldApiName: fieldName ?? 'TestField',
    ruleType: 'faker',
    config: { fakerMethod: method },
  };
}

describe('FakerFallback', () => {
  let faker: FakerFallback;

  beforeEach(() => {
    faker = new FakerFallback();
  });

  describe('generate', () => {
    it('should return empty array for zero count', () => {
      const result = faker.generate([createFakerRule('name')], 0);
      expect(result).toEqual([]);
    });

    it('should return empty array for empty field rules', () => {
      const result = faker.generate([], 5);
      expect(result).toEqual([]);
    });

    it('should generate the requested number of records', () => {
      const result = faker.generate([createFakerRule('name')], 10);
      expect(result).toHaveLength(10);
    });

    it('should populate all requested fields', () => {
      const rules = [createFakerRule('name', 'FullName'), createFakerRule('email', 'Email')];
      const result = faker.generate(rules, 3);

      for (const record of result) {
        expect(record).toHaveProperty('FullName');
        expect(record).toHaveProperty('Email');
      }
    });

    it('should generate different values for different indices', () => {
      const result = faker.generate([createFakerRule('name')], 5);
      const names = result.map((r) => r['TestField']);
      const unique = new Set(names);
      expect(unique.size).toBeGreaterThan(1);
    });

    it('should handle negative count as empty', () => {
      const result = faker.generate([createFakerRule('name')], -1);
      expect(result).toEqual([]);
    });

    it('should default to lorem for missing fakerMethod', () => {
      const rule: FieldRule = {
        fieldApiName: 'TestField',
        ruleType: 'faker',
        config: {},
      };
      const result = faker.generate([rule], 1);
      expect(result).toHaveLength(1);
      expect(typeof result[0]['TestField']).toBe('string');
    });

    it('should respect minValue and maxValue for numbers', () => {
      const rule: FieldRule = {
        fieldApiName: 'Amount',
        ruleType: 'faker',
        config: { fakerMethod: 'integer', minValue: 100, maxValue: 200 },
      };
      const result = faker.generate([rule], 20);

      for (const record of result) {
        const value = record['Amount'] as number;
        expect(value).toBeGreaterThanOrEqual(100);
        expect(value).toBeLessThanOrEqual(201);
      }
    });
  });

  describe('generateByMethod', () => {
    it('should generate a name string', () => {
      const value = generateByMethod('name', 0, { min: 0, max: 100 });
      expect(typeof value).toBe('string');
      expect(value as string).toContain(' ');
    });

    it('should generate an email address', () => {
      const value = generateByMethod('email', 0, { min: 0, max: 100 });
      expect(typeof value).toBe('string');
      expect(value as string).toContain('@');
    });

    it('should generate a phone number', () => {
      const value = generateByMethod('phone', 0, { min: 0, max: 100 });
      expect(typeof value).toBe('string');
      expect((value as string).length).toBeGreaterThan(0);
    });

    it('should generate a company name', () => {
      const value = generateByMethod('company', 0, { min: 0, max: 100 });
      expect(typeof value).toBe('string');
      expect((value as string).length).toBeGreaterThan(0);
    });

    it('should generate a boolean', () => {
      const value = generateByMethod('boolean', 0, { min: 0, max: 100 });
      expect(typeof value).toBe('boolean');
    });

    it('should generate a UUID', () => {
      const value = generateByMethod('uuid', 5, { min: 0, max: 100 });
      expect(typeof value).toBe('string');
      expect((value as string).split('-')).toHaveLength(5);
    });

    it('should generate a URL', () => {
      const value = generateByMethod('url', 3, { min: 0, max: 100 });
      expect(typeof value).toBe('string');
      expect(value as string).toContain('https://');
    });

    it('should generate a paragraph', () => {
      const value = generateByMethod('paragraph', 0, { min: 0, max: 100 });
      expect(typeof value).toBe('string');
      expect((value as string).split('.').length).toBeGreaterThan(2);
    });

    it('should fall back to sentence for unknown method', () => {
      const value = generateByMethod('unknownMethod', 0, { min: 0, max: 100 });
      expect(typeof value).toBe('string');
    });

    it('should generate a zip code', () => {
      const value = generateByMethod('zipCode', 0, { min: 0, max: 100 });
      expect(typeof value).toBe('string');
      expect((value as string).length).toBeGreaterThanOrEqual(5);
    });
  });

  describe('locale-aware generation', () => {
    it('should generate French names with fr_FR locale', () => {
      const frFaker = new FakerFallback('fr_FR');
      const rules = [createFakerRule('firstName', 'FirstName')];
      const result = frFaker.generate(rules, 5);
      const frNames = LOCALE_DATA.fr_FR.firstNames;
      for (const record of result) {
        expect(frNames).toContain(record['FirstName']);
      }
    });

    it('should generate German names with de_DE locale', () => {
      const deFaker = new FakerFallback('de_DE');
      const rules = [createFakerRule('firstName', 'FirstName')];
      const result = deFaker.generate(rules, 5);
      const deNames = LOCALE_DATA.de_DE.firstNames;
      for (const record of result) {
        expect(deNames).toContain(record['FirstName']);
      }
    });

    it('should generate Japanese names with ja_JP locale', () => {
      const jaFaker = new FakerFallback('ja_JP');
      const rules = [createFakerRule('firstName', 'FirstName')];
      const result = jaFaker.generate(rules, 5);
      const jaNames = LOCALE_DATA.ja_JP.firstNames;
      for (const record of result) {
        expect(jaNames).toContain(record['FirstName']);
      }
    });

    it('should generate geo-coherent city and country', () => {
      const frFaker = new FakerFallback('fr_FR');
      const rules = [createFakerRule('city', 'City'), createFakerRule('country', 'Country')];
      const result = frFaker.generate(rules, 5);
      for (const record of result) {
        expect(record['Country']).toBe('France');
        const frCities = GEO_DATA.fr_FR.map((t) => t.city);
        expect(frCities).toContain(record['City']);
      }
    });

    it('should generate locale-appropriate email domain', () => {
      const frFaker = new FakerFallback('fr_FR');
      const rules = [createFakerRule('email', 'Email')];
      const result = frFaker.generate(rules, 3);
      for (const record of result) {
        const email = record['Email'] as string;
        const domain = email.split('@')[1];
        expect(LOCALE_DATA.fr_FR.emailDomains).toContain(domain);
      }
    });

    it('should generate locale phone format', () => {
      const frFaker = new FakerFallback('fr_FR');
      const rules = [createFakerRule('phone', 'Phone')];
      const result = frFaker.generate(rules, 1);
      const phone = result[0]['Phone'] as string;
      expect(phone).toMatch(/^\+33/);
    });

    it('should support per-rule fakerLocale override', () => {
      const enFaker = new FakerFallback('en_US');
      const rule: FieldRule = {
        fieldApiName: 'FirstName',
        ruleType: 'faker',
        config: { fakerMethod: 'firstName', fakerLocale: 'fr_FR' },
      };
      const result = enFaker.generate([rule], 5);
      const frNames = LOCALE_DATA.fr_FR.firstNames;
      for (const record of result) {
        expect(frNames).toContain(record['FirstName']);
      }
    });

    it('should restore locale after per-rule override', () => {
      const enFaker = new FakerFallback('en_US');
      const rules: FieldRule[] = [
        {
          fieldApiName: 'FrenchName',
          ruleType: 'faker',
          config: { fakerMethod: 'firstName', fakerLocale: 'fr_FR' },
        },
        {
          fieldApiName: 'EnglishName',
          ruleType: 'faker',
          config: { fakerMethod: 'firstName' },
        },
      ];
      const result = enFaker.generate(rules, 3);
      const enNames = LOCALE_DATA.en_US.firstNames;
      for (const record of result) {
        expect(enNames).toContain(record['EnglishName']);
      }
    });

    it('should support setLocale to change locale', () => {
      const faker = new FakerFallback('en_US');
      faker.setLocale('de_DE');
      const rules = [createFakerRule('firstName', 'FirstName')];
      const result = faker.generate(rules, 3);
      const deNames = LOCALE_DATA.de_DE.firstNames;
      for (const record of result) {
        expect(deNames).toContain(record['FirstName']);
      }
    });

    it('should generate state from geo-coherent tuples', () => {
      const frFaker = new FakerFallback('fr_FR');
      const rules = [createFakerRule('state', 'State')];
      const result = frFaker.generate(rules, 3);
      const frStates = GEO_DATA.fr_FR.map((t) => t.state);
      for (const record of result) {
        expect(frStates).toContain(record['State']);
      }
    });
  });
});
