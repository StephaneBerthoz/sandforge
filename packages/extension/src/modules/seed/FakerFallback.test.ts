import { describe, it, expect, beforeEach } from 'vitest';
import { FakerFallback, generateByMethod } from './FakerFallback';
import type { FieldRule } from '@sandforge/shared';

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
      const rules = [
        createFakerRule('name', 'FullName'),
        createFakerRule('email', 'Email'),
      ];
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
      expect(value as string).toContain('(');
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
      expect((value as string).length).toBe(5);
    });
  });
});
