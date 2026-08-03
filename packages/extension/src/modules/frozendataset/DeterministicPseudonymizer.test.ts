import { describe, expect, it } from 'vitest';
import {
  DeterministicPseudonymizer,
  FROZEN_SALT_ENV_VAR,
  MissingSaltError,
  PSEUDONYM_GENERATORS,
  type PseudonymGenerator,
} from './DeterministicPseudonymizer.js';

const SALT_A = 'test-salt-alpha';
const SALT_B = 'test-salt-beta';

const pA = new DeterministicPseudonymizer(SALT_A);
const pB = new DeterministicPseudonymizer(SALT_B);

/**
 * Generators whose output is HMAC-derived — a different salt MUST produce
 * a different output. Generalization generators (keep, clear,
 * postalCodeGeneralize, dateMonthStart, geoRound1, kmRound10) are
 * salt-independent by design.
 */
const HMAC_DERIVED: Array<[PseudonymGenerator, unknown]> = [
  ['firstName', 'Jean'],
  ['lastName', 'Dupont'],
  ['companyName', 'Mutuaide Assistance'],
  ['phoneE164', '+33612345678'],
  ['email', 'jean.dupont@mutuaide.fr'],
  ['registrationSIV', 'AB-123-CD'],
  ['contractNumber', 'CTR-2024-AB123'],
  ['dateShift', '2024-03-15'],
];

describe('DeterministicPseudonymizer — salt handling', () => {
  it('refuses to start without a salt, with an actionable message', () => {
    expect(() => new DeterministicPseudonymizer('')).toThrow(MissingSaltError);
    expect(() => new DeterministicPseudonymizer('')).toThrow(FROZEN_SALT_ENV_VAR);
    expect(() => DeterministicPseudonymizer.fromEnv({})).toThrow(MissingSaltError);
  });

  it('builds from the environment variable', () => {
    const p = DeterministicPseudonymizer.fromEnv({ [FROZEN_SALT_ENV_VAR]: SALT_A });
    expect(p.saltFingerprint).toBe(pA.saltFingerprint);
  });

  it('exposes a 12-hex SHA-256 fingerprint, never the salt', () => {
    expect(pA.saltFingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(pA.saltFingerprint).not.toBe(pB.saltFingerprint);
  });
});

describe('DeterministicPseudonymizer — determinism of every generator', () => {
  const cases: Array<[PseudonymGenerator, unknown]> = [
    ['keep', 'anything'],
    ['clear', 'secret'],
    ...HMAC_DERIVED,
    ['postalCodeGeneralize', '75012'],
    ['dateMonthStart', '1985-06-23'],
    ['geoRound1', 48.8566],
    ['kmRound10', 12344],
  ];

  it.each(cases)('%s: same input ⇒ same output', (generator, value) => {
    const first = pA.pseudonymize(generator, value);
    const second = new DeterministicPseudonymizer(SALT_A).pseudonymize(generator, value);
    expect(first).toEqual(second);
  });

  it.each(HMAC_DERIVED)('%s: different salt ⇒ different output', (generator, value) => {
    expect(pA.pseudonymize(generator, value)).not.toEqual(pB.pseudonymize(generator, value));
  });

  it('supports all documented generator names', () => {
    expect(PSEUDONYM_GENERATORS).toContain('dateShift');
    expect(PSEUDONYM_GENERATORS).toHaveLength(14);
  });

  it('null/undefined pass through for every generator (pitfall 6)', () => {
    for (const generator of PSEUDONYM_GENERATORS) {
      expect(pA.pseudonymize(generator, null)).toBeNull();
      expect(pA.pseudonymize(generator, undefined)).toBeUndefined();
    }
  });
});

describe('DeterministicPseudonymizer — cross-object joins', () => {
  it('same value on different objects/fields ⇒ same pseudonym', () => {
    // The HMAC input is "generator|value" only — no object, no field.
    const onContact = pA.pseudonymize('lastName', 'Dupont'); // Contact.LastName
    const onAccount = pA.pseudonymize('lastName', 'Dupont'); // Account.Name (same rule)
    const onAsset = pA.pseudonymize('lastName', 'Dupont'); // Asset.Beneficiary__c
    expect(onContact).toBe(onAccount);
    expect(onContact).toBe(onAsset);
  });
});

describe('DeterministicPseudonymizer — formats', () => {
  it('firstName / lastName come from the fictional pools', () => {
    expect(String(pA.pseudonymize('firstName', 'Jean'))).toMatch(/^[\p{Lu}][\p{L}]+$/u);
    expect(String(pA.pseudonymize('lastName', 'Dupont'))).toMatch(/^[\p{Lu}][\p{L}]+$/u);
    expect(pA.pseudonymize('firstName', 'Jean')).not.toBe('Jean');
  });

  it('companyName is a two-part fictional name', () => {
    const out = String(pA.pseudonymize('companyName', 'Mutuaide'));
    expect(out).toMatch(/^\p{Lu}\p{L}+ [\p{L} ]+$/u);
    expect(out).not.toContain('Mutuaide');
  });

  it('phoneE164 uses the fictional ARCEP range +3363998xxxx', () => {
    expect(pA.pseudonymize('phoneE164', '+33612345678')).toMatch(/^\+3363998\d{4}$/);
  });

  it('email lands on example.invalid', () => {
    expect(pA.pseudonymize('email', 'jean.dupont@mutuaide.fr')).toMatch(
      /^user-[0-9a-f]{8}@example\.invalid$/,
    );
  });

  it('registrationSIV keeps the AA-123-BB shape (letters without I/O/Q)', () => {
    const out = String(pA.pseudonymize('registrationSIV', 'AB-123-CD'));
    expect(out).toMatch(/^[A-HJ-NPR-Z]{2}-\d{3}-[A-HJ-NPR-Z]{2}$/);
  });

  it('contractNumber preserves shape: digit→digit, letter→letter, rest kept', () => {
    const out = String(pA.pseudonymize('contractNumber', 'CTR-2024-AB123'));
    expect(out).toMatch(/^[A-Z]{3}-\d{4}-[A-Z]{2}\d{3}$/);
    expect(out).toHaveLength('CTR-2024-AB123'.length);
    expect(out).not.toBe('CTR-2024-AB123');
  });

  it('postalCodeGeneralize zeroes at length — 5 AND 4 digits (pitfall 4)', () => {
    expect(pA.pseudonymize('postalCodeGeneralize', '75012')).toBe('75000');
    expect(pA.pseudonymize('postalCodeGeneralize', '8011')).toBe('8000');
    expect(pA.pseudonymize('postalCodeGeneralize', '69003')).toBe('69000');
  });

  it('dateMonthStart snaps to the first of the month', () => {
    expect(pA.pseudonymize('dateMonthStart', '1985-06-23')).toBe('1985-06-01');
    expect(pA.pseudonymize('dateMonthStart', '1985-06-23T10:30:00Z')).toBe('1985-06-01');
  });

  it('dateShift offset is uniform, derived from the salt, within 200–400 days', () => {
    expect(pA.dateShiftDays).toBeGreaterThanOrEqual(200);
    expect(pA.dateShiftDays).toBeLessThanOrEqual(400);
    // Uniform: the same offset object-wide, dataset-wide.
    expect(new DeterministicPseudonymizer(SALT_A).dateShiftDays).toBe(pA.dateShiftDays);
  });

  it('dateShift preserves durations exactly', () => {
    const d1 = '2024-01-10';
    const d2 = '2024-03-15';
    const s1 = Date.parse(String(pA.pseudonymize('dateShift', d1)));
    const s2 = Date.parse(String(pA.pseudonymize('dateShift', d2)));
    expect(s2 - s1).toBe(Date.parse(d2) - Date.parse(d1));
    // And the applied shift matches the advertised offset.
    expect(Date.parse(d1) - s1).toBe(pA.dateShiftDays * 86_400_000);
  });

  it('dateShift keeps date-only shape and shifts datetimes as instants', () => {
    expect(String(pA.pseudonymize('dateShift', '2024-01-10'))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const shifted = String(pA.pseudonymize('dateShift', '2024-01-10T08:30:00.000Z'));
    expect(shifted).toMatch(/^\d{4}-\d{2}-\d{2}T08:30:00\.000Z$/);
  });

  it('geoRound1 rounds to ~11 km (1 decimal), preserving type', () => {
    const num = pA.pseudonymize('geoRound1', 48.8566);
    expect(num).toBe(48.9);
    expect(Math.abs((num as number) - 48.8566)).toBeLessThanOrEqual(0.05);
    expect(pA.pseudonymize('geoRound1', '2.3522')).toBe('2.4');
  });

  it('kmRound10 rounds to the nearest 10, preserving type', () => {
    expect(pA.pseudonymize('kmRound10', 12344)).toBe(12340);
    expect(pA.pseudonymize('kmRound10', 12345)).toBe(12350);
    expect(pA.pseudonymize('kmRound10', '12346')).toBe('12350');
  });

  it('clear empties, keep preserves', () => {
    expect(pA.pseudonymize('clear', 'secret')).toBe('');
    expect(pA.pseudonymize('keep', 'public')).toBe('public');
  });
});
