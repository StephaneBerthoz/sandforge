import { describe, it, expect } from 'vitest';
import { SEED_LOCALES } from './seed-locales';

describe('SEED_LOCALES', () => {
  it('lists six locales, each once, written as Salesforce writes a locale', () => {
    expect(SEED_LOCALES).toHaveLength(6);
    expect(new Set(SEED_LOCALES).size).toBe(SEED_LOCALES.length);
    for (const locale of SEED_LOCALES) expect(locale).toMatch(/^[a-z]{2}_[A-Z]{2}$/);
  });

  it('starts with American English, where a locale the generator lacks falls back to', () => {
    expect(SEED_LOCALES[0]).toBe('en_US');
  });
});
