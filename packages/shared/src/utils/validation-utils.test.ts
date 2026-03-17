import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import {
  safeParse,
  isNonEmptyString,
  isPositiveInteger,
  isValidEmail,
  isValidUrl,
  isValidCron,
} from './validation-utils.js';

describe('safeParse', () => {
  const schema = z.object({
    name: z.string().min(1),
    age: z.number().int().positive(),
  });

  it('should return success with valid data', () => {
    const result = safeParse(schema, { name: 'Alice', age: 30 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ name: 'Alice', age: 30 });
    }
  });

  it('should return failure with invalid data', () => {
    const result = safeParse(schema, { name: '', age: -1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });

  it('should return errors with path information', () => {
    const result = safeParse(schema, { name: 123, age: 'not a number' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const hasNameError = result.errors.some((e) => e.startsWith('name:'));
      const hasAgeError = result.errors.some((e) => e.startsWith('age:'));
      expect(hasNameError).toBe(true);
      expect(hasAgeError).toBe(true);
    }
  });

  it('should handle missing fields', () => {
    const result = safeParse(schema, {});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('should handle null input', () => {
    const result = safeParse(schema, null);
    expect(result.success).toBe(false);
  });

  it('should work with simple schemas', () => {
    const stringSchema = z.string().email();
    const valid = safeParse(stringSchema, 'user@example.com');
    expect(valid.success).toBe(true);

    const invalid = safeParse(stringSchema, 'not-email');
    expect(invalid.success).toBe(false);
  });
});

describe('isNonEmptyString', () => {
  it('should return true for non-empty strings', () => {
    expect(isNonEmptyString('hello')).toBe(true);
    expect(isNonEmptyString('a')).toBe(true);
  });

  it('should return false for empty string', () => {
    expect(isNonEmptyString('')).toBe(false);
  });

  it('should return false for whitespace-only strings', () => {
    expect(isNonEmptyString('   ')).toBe(false);
    expect(isNonEmptyString('\t\n')).toBe(false);
  });

  it('should return false for non-string values', () => {
    expect(isNonEmptyString(null)).toBe(false);
    expect(isNonEmptyString(undefined)).toBe(false);
    expect(isNonEmptyString(123)).toBe(false);
    expect(isNonEmptyString(true)).toBe(false);
    expect(isNonEmptyString({})).toBe(false);
    expect(isNonEmptyString([])).toBe(false);
  });
});

describe('isPositiveInteger', () => {
  it('should return true for positive integers', () => {
    expect(isPositiveInteger(1)).toBe(true);
    expect(isPositiveInteger(42)).toBe(true);
    expect(isPositiveInteger(1000000)).toBe(true);
  });

  it('should return false for zero', () => {
    expect(isPositiveInteger(0)).toBe(false);
  });

  it('should return false for negative numbers', () => {
    expect(isPositiveInteger(-1)).toBe(false);
    expect(isPositiveInteger(-100)).toBe(false);
  });

  it('should return false for floating point numbers', () => {
    expect(isPositiveInteger(1.5)).toBe(false);
    expect(isPositiveInteger(0.1)).toBe(false);
  });

  it('should return false for non-number values', () => {
    expect(isPositiveInteger('1')).toBe(false);
    expect(isPositiveInteger(null)).toBe(false);
    expect(isPositiveInteger(undefined)).toBe(false);
    expect(isPositiveInteger(NaN)).toBe(false);
    expect(isPositiveInteger(Infinity)).toBe(false);
  });
});

describe('isValidEmail', () => {
  it('should accept valid emails', () => {
    expect(isValidEmail('user@example.com')).toBe(true);
    expect(isValidEmail('name.surname@domain.co.uk')).toBe(true);
    expect(isValidEmail('user+tag@example.org')).toBe(true);
  });

  it('should reject emails without @', () => {
    expect(isValidEmail('userexample.com')).toBe(false);
  });

  it('should reject emails without domain', () => {
    expect(isValidEmail('user@')).toBe(false);
  });

  it('should reject emails without local part', () => {
    expect(isValidEmail('@example.com')).toBe(false);
  });

  it('should reject emails with spaces', () => {
    expect(isValidEmail('user @example.com')).toBe(false);
    expect(isValidEmail('user@ example.com')).toBe(false);
  });

  it('should reject empty string', () => {
    expect(isValidEmail('')).toBe(false);
  });
});

describe('isValidUrl', () => {
  it('should accept valid HTTP URLs', () => {
    expect(isValidUrl('http://example.com')).toBe(true);
    expect(isValidUrl('https://example.com')).toBe(true);
    expect(isValidUrl('https://example.com/path?q=1')).toBe(true);
  });

  it('should accept other valid URL schemes', () => {
    expect(isValidUrl('ftp://files.example.com')).toBe(true);
  });

  it('should reject plain strings', () => {
    expect(isValidUrl('not-a-url')).toBe(false);
    expect(isValidUrl('example.com')).toBe(false);
  });

  it('should reject empty string', () => {
    expect(isValidUrl('')).toBe(false);
  });
});

describe('isValidCron', () => {
  it('should accept valid 5-field cron expressions', () => {
    expect(isValidCron('* * * * *')).toBe(true);
    expect(isValidCron('0 12 * * 1-5')).toBe(true);
    expect(isValidCron('*/15 * * * *')).toBe(true);
    expect(isValidCron('0 0 1,15 * *')).toBe(true);
  });

  it('should reject expressions with too few fields', () => {
    expect(isValidCron('* * * *')).toBe(false);
  });

  it('should accept expressions with 6 or 7 fields', () => {
    expect(isValidCron('* * * * * *')).toBe(true);
    expect(isValidCron('* * * * * * *')).toBe(true);
  });

  it('should accept expressions with L, ?, and named days', () => {
    expect(isValidCron('* * * * L')).toBe(true);
    expect(isValidCron('0 12 ? * MON')).toBe(true);
  });

  it('should reject empty string', () => {
    expect(isValidCron('')).toBe(false);
  });

  it('should handle extra whitespace between fields', () => {
    expect(isValidCron('*  *  *  *  *')).toBe(true);
  });
});

describe('isValidCron extended', () => {
  it('should accept named days', () => {
    expect(isValidCron('0 12 * * MON')).toBe(true);
  });
  it('should accept L/W/# characters', () => {
    expect(isValidCron('0 0 L * *')).toBe(true);
  });
  it('should accept 6-field cron (with seconds)', () => {
    expect(isValidCron('0 0 12 * * ?')).toBe(true);
  });
  it('should accept 7-field cron (Quartz/Salesforce)', () => {
    expect(isValidCron('0 0 12 ? * MON-FRI *')).toBe(true);
  });
  it('should reject empty string', () => {
    expect(isValidCron('')).toBe(false);
  });
  it('should reject too few fields', () => {
    expect(isValidCron('0 0')).toBe(false);
  });
});
