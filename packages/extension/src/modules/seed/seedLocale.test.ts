import { describe, it, expect, vi } from 'vitest';
import { orgSeedLocale, seedLocaleOf } from './seedLocale';

function org(answer: unknown) {
  return {
    query: vi.fn(async (soql: string) => {
      expect(soql).toBe('SELECT DefaultLocaleSidKey FROM Organization LIMIT 1');
      if (answer instanceof Error) throw answer;
      return { records: [{ DefaultLocaleSidKey: answer }] };
    }),
  };
}

describe('seed locale', () => {
  it("draws in the org's default locale when nobody chose one", async () => {
    // The panel drew every seed in en_US, whatever the org's country.
    expect(await seedLocaleOf(undefined, org('fr_FR'))).toBe('fr_FR');
    expect(await orgSeedLocale(org('ja_JP'))).toBe('ja_JP');
  });

  it('draws in the locale chosen, without asking the org', async () => {
    const conn = org('fr_FR');
    expect(await seedLocaleOf('de_DE', conn)).toBe('de_DE');
    expect(conn.query).not.toHaveBeenCalled();
  });

  it('falls back on en_US when the org will not say, or says something no locale is', async () => {
    expect(await seedLocaleOf(undefined, org(new Error('INVALID_TYPE')))).toBe('en_US');
    expect(await seedLocaleOf(undefined, org("fr_FR' OR 1=1"))).toBe('en_US');
    expect(await seedLocaleOf(undefined, org(null))).toBe('en_US');
  });
});
