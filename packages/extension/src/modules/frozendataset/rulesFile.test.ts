import { describe, expect, it } from 'vitest';
import {
  parsePseudonymRules,
  resolveGenerator,
  RulesFileError,
  serializePseudonymRules,
} from './rulesFile.js';

describe('parsePseudonymRules', () => {
  it('parses a valid versioned rules file', () => {
    const file = parsePseudonymRules({
      rulesVersion: '1.2.0',
      rules: {
        'Account.Name': { generator: 'companyName' },
        'Account.Industry': { generator: 'keep', approved: true, comment: 'reviewed 2026-08' },
      },
    });
    expect(file.rulesVersion).toBe('1.2.0');
    expect(file.rules['Account.Name'].generator).toBe('companyName');
    expect(file.rules['Account.Industry'].approved).toBe(true);
  });

  it('rejects keep without explicit human approval', () => {
    expect(() =>
      parsePseudonymRules({
        rulesVersion: '1.0.0',
        rules: { 'Account.Industry': { generator: 'keep' } },
      }),
    ).toThrow(/approved/);
    expect(() =>
      parsePseudonymRules({
        rulesVersion: '1.0.0',
        rules: { 'Account.Industry': { generator: 'keep', approved: false } },
      }),
    ).toThrow(RulesFileError);
  });

  it('rejects unknown generators, bad keys and missing rulesVersion', () => {
    expect(() =>
      parsePseudonymRules({
        rulesVersion: '1.0.0',
        rules: { 'Account.X': { generator: 'scramble' } },
      }),
    ).toThrow(/unknown generator/);
    expect(() =>
      parsePseudonymRules({ rulesVersion: '1.0.0', rules: { NoDot: { generator: 'clear' } } }),
    ).toThrow(RulesFileError);
    expect(() => parsePseudonymRules({ rules: { 'Account.X': { generator: 'clear' } } })).toThrow(
      /rulesVersion/,
    );
    expect(() => parsePseudonymRules(null)).toThrow(RulesFileError);
  });

  it('lists every violation at once for actionable fixes', () => {
    try {
      parsePseudonymRules({
        rulesVersion: 'nope',
        rules: {
          'Account.A': { generator: 'keep' },
          'bad key': { generator: 'clear' },
        },
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RulesFileError);
      const violations = (error as RulesFileError).violations;
      expect(violations.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('resolveGenerator', () => {
  it('defaults to clear for any field without a rule — never clear-text', () => {
    const file = parsePseudonymRules({ rulesVersion: '1.0.0', rules: {} });
    expect(resolveGenerator(file, 'Contact', 'Description')).toBe('clear');
  });

  it('returns the configured generator', () => {
    const file = parsePseudonymRules({
      rulesVersion: '1.0.0',
      rules: { 'Contact.Email': { generator: 'email' } },
    });
    expect(resolveGenerator(file, 'Contact', 'Email')).toBe('email');
  });
});

describe('serializePseudonymRules', () => {
  it('round-trips with stable key ordering', () => {
    const file = parsePseudonymRules({
      rulesVersion: '1.0.0',
      rules: {
        'Contact.Email': { generator: 'email' },
        'Account.Name': { generator: 'companyName' },
      },
    });
    const serialized = serializePseudonymRules(file);
    expect(serialized.indexOf('Account.Name')).toBeLessThan(serialized.indexOf('Contact.Email'));
    expect(parsePseudonymRules(JSON.parse(serialized))).toEqual(file);
  });
});
