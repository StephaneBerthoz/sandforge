import { describe, it, expect } from 'vitest';
import {
  sanitizeSoqlValue,
  validateSoqlIdentifier,
  assertSoqlIdentifier,
} from './soqlValidator.js';

describe('sanitizeSoqlValue', () => {
  it('returns a plain string unchanged', () => {
    expect(sanitizeSoqlValue('hello')).toBe('hello');
  });

  it('escapes single quotes', () => {
    expect(sanitizeSoqlValue("O'Brien")).toBe("O\\'Brien");
  });

  it('escapes backslashes', () => {
    expect(sanitizeSoqlValue('path\\to')).toBe('path\\\\to');
  });

  it('escapes backslashes before single quotes', () => {
    expect(sanitizeSoqlValue("a\\'b")).toBe("a\\\\\\'b");
  });

  it('handles multiple single quotes', () => {
    expect(sanitizeSoqlValue("it's a 'test'")).toBe("it\\'s a \\'test\\'");
  });

  it('returns empty string unchanged', () => {
    expect(sanitizeSoqlValue('')).toBe('');
  });

  it('handles strings with only special characters', () => {
    expect(sanitizeSoqlValue("'''")).toBe("\\'\\'\\'");
  });

  it('does not alter numeric strings', () => {
    expect(sanitizeSoqlValue('12345')).toBe('12345');
  });

  it('neutralizes a SOQL injection attempt', () => {
    const malicious = "' OR Name != '";
    const sanitized = sanitizeSoqlValue(malicious);
    expect(sanitized).toBe("\\' OR Name != \\'");
    // All single quotes are now escaped, so no unescaped quote can break out of a SOQL string literal
    expect(sanitized).not.toMatch(/(?<!\\)'/);
  });
});

describe('validateSoqlIdentifier', () => {
  it('accepts simple object names', () => {
    expect(validateSoqlIdentifier('Account')).toBe(true);
  });

  it('accepts custom object names', () => {
    expect(validateSoqlIdentifier('Custom_Object__c')).toBe(true);
  });

  it('accepts namespaced field names', () => {
    expect(validateSoqlIdentifier('ns__Field__c')).toBe(true);
  });

  it('accepts single-letter names', () => {
    expect(validateSoqlIdentifier('A')).toBe(true);
  });

  it('rejects names starting with a number', () => {
    expect(validateSoqlIdentifier('1Account')).toBe(false);
  });

  it('rejects names starting with an underscore', () => {
    expect(validateSoqlIdentifier('_Account')).toBe(false);
  });

  it('rejects empty strings', () => {
    expect(validateSoqlIdentifier('')).toBe(false);
  });

  it('rejects names with spaces', () => {
    expect(validateSoqlIdentifier('My Account')).toBe(false);
  });

  it('rejects names with special characters', () => {
    expect(validateSoqlIdentifier('Account;DROP')).toBe(false);
  });

  it('rejects names with dots', () => {
    expect(validateSoqlIdentifier('Account.Name')).toBe(false);
  });

  it('rejects names exceeding 255 characters', () => {
    const longName = 'A' + 'a'.repeat(255);
    expect(longName.length).toBe(256);
    expect(validateSoqlIdentifier(longName)).toBe(false);
  });

  it('accepts names at exactly 255 characters', () => {
    const maxName = 'A' + 'a'.repeat(254);
    expect(maxName.length).toBe(255);
    expect(validateSoqlIdentifier(maxName)).toBe(true);
  });

  it('rejects SOQL injection in identifiers', () => {
    expect(validateSoqlIdentifier('Account WHERE 1=1')).toBe(false);
  });

  it('rejects single quotes in identifiers', () => {
    expect(validateSoqlIdentifier("Account'")).toBe(false);
  });
});

describe('assertSoqlIdentifier', () => {
  it('returns the name when valid', () => {
    expect(assertSoqlIdentifier('Account')).toBe('Account');
  });

  it('returns custom object names when valid', () => {
    expect(assertSoqlIdentifier('My_Object__c')).toBe('My_Object__c');
  });

  it('throws for invalid names', () => {
    expect(() => assertSoqlIdentifier('1Bad')).toThrow(
      'Invalid Salesforce API name',
    );
  });

  it('throws for empty strings', () => {
    expect(() => assertSoqlIdentifier('')).toThrow(
      'Invalid Salesforce API name',
    );
  });

  it('throws for names with injection attempts', () => {
    expect(() => assertSoqlIdentifier('Account; DROP')).toThrow(
      'Invalid Salesforce API name',
    );
  });

  it('includes the invalid name in the error message', () => {
    expect(() => assertSoqlIdentifier('bad name')).toThrow('"bad name"');
  });
});
