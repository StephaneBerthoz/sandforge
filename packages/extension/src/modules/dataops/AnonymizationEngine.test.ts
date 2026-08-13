import { createHmac } from 'node:crypto';

import { describe, it, expect, beforeEach } from 'vitest';
import { AnonymizationEngine, MissingHashSaltError } from './AnonymizationEngine';
import type { DataOpsAnonymizationRule } from '@sandforge/shared';

function createMaskRule(field: string): DataOpsAnonymizationRule {
  return {
    objectApiName: 'Contact',
    fieldApiName: field,
    method: 'mask',
    config: { maskChar: '*', maskStart: 0, maskEnd: 5 },
  };
}

describe('AnonymizationEngine', () => {
  let engine: AnonymizationEngine;

  beforeEach(() => {
    engine = new AnonymizationEngine();
  });

  describe('anonymize', () => {
    it('should apply mask rules to matching fields', () => {
      const records = [{ Email: 'test@example.com', Name: 'Alice' }];
      const rules: DataOpsAnonymizationRule[] = [createMaskRule('Email')];

      const result = engine.anonymize(records, rules);

      expect(result[0]['Email']).toBe('*****example.com');
      expect(result[0]['Name']).toBe('Alice');
    });

    it('should not mutate original records', () => {
      const records = [{ Email: 'test@example.com' }];
      const rules: DataOpsAnonymizationRule[] = [createMaskRule('Email')];

      engine.anonymize(records, rules);

      expect(records[0]['Email']).toBe('test@example.com');
    });

    it('should handle multiple rules', () => {
      const records = [{ Email: 'test@example.com', Phone: '555-1234' }];
      const rules: DataOpsAnonymizationRule[] = [createMaskRule('Email'), createMaskRule('Phone')];

      const result = engine.anonymize(records, rules);

      expect(result[0]['Email']).toBe('*****example.com');
      expect(result[0]['Phone']).toBe('*****234');
    });

    it('should skip fields not present in the record', () => {
      const records = [{ Name: 'Bob' }];
      const rules: DataOpsAnonymizationRule[] = [createMaskRule('Email')];

      const result = engine.anonymize(records, rules);

      expect(result[0]['Name']).toBe('Bob');
      expect(result[0]['Email']).toBeUndefined();
    });
  });

  describe('applyRule', () => {
    it('should handle nullify rule type', () => {
      const rule: DataOpsAnonymizationRule = {
        objectApiName: 'Contact',
        fieldApiName: 'BirthDate',
        method: 'nullify',
        config: {},
      };
      expect(engine.applyRule('1990-01-01', rule)).toBeNull();
    });

    it('should handle constant rule type', () => {
      const rule: DataOpsAnonymizationRule = {
        objectApiName: 'Contact',
        fieldApiName: 'Status',
        method: 'constant',
        config: { constantValue: 'REDACTED' },
      };
      expect(engine.applyRule('Active', rule)).toBe('REDACTED');
    });

    it('should produce a real HMAC-SHA256, not a value merely labelled sha256', () => {
      const rule: DataOpsAnonymizationRule = {
        objectApiName: 'Contact',
        fieldApiName: 'SSN',
        method: 'hash',
        config: { hashAlgorithm: 'sha256', hashSalt: 'salt' },
      };
      // Computed independently: asserting only on the `sha256:` prefix is what
      // let a 32-bit hashCode ship under a cryptographic label.
      const expected = createHmac('sha256', 'salt')
        .update('123-45-6789')
        .digest('hex')
        .slice(0, 32);
      expect(engine.applyRule('123-45-6789', rule)).toBe(`sha256:${expected}`);
    });

    it('should be deterministic for the same value and salt', () => {
      const rule: DataOpsAnonymizationRule = {
        objectApiName: 'Contact',
        fieldApiName: 'SSN',
        method: 'hash',
        config: { hashAlgorithm: 'sha256', hashSalt: 'salt' },
      };
      // Foreign keys only keep joining if the same input maps to the same output.
      expect(engine.applyRule('123-45-6789', rule)).toBe(engine.applyRule('123-45-6789', rule));
    });

    it('should produce a different digest under a different salt', () => {
      const base = { objectApiName: 'Contact', fieldApiName: 'SSN', method: 'hash' as const };
      const a = engine.applyRule('123-45-6789', {
        ...base,
        config: { hashAlgorithm: 'sha256', hashSalt: 'salt-a' },
      });
      const b = engine.applyRule('123-45-6789', {
        ...base,
        config: { hashAlgorithm: 'sha256', hashSalt: 'salt-b' },
      });
      expect(a).not.toBe(b);
    });

    it('should refuse to hash without a salt rather than emit a reversible digest', () => {
      const rule: DataOpsAnonymizationRule = {
        objectApiName: 'Contact',
        fieldApiName: 'SSN',
        method: 'hash',
        config: { hashAlgorithm: 'sha256' },
      };
      expect(() => engine.applyRule('123-45-6789', rule)).toThrow(MissingHashSaltError);
    });

    it('should handle fake rule type', () => {
      const rule: DataOpsAnonymizationRule = {
        objectApiName: 'Contact',
        fieldApiName: 'Email',
        method: 'fake',
        config: { fakerMethod: 'internet.email', fakerLocale: 'en' },
      };
      const result = engine.applyRule('real@example.com', rule);
      // A fake email has to be an email, or the anonymized org fails the
      // validation rules the real one passed.
      expect(String(result)).toMatch(/^[a-z]+\.[a-z]+@example\.com$/);
    });

    it('should not encode the original value length in a fake value', () => {
      const rule: DataOpsAnonymizationRule = {
        objectApiName: 'Contact',
        fieldApiName: 'Notes__c',
        method: 'fake',
        config: {},
      };
      // The old output was `fake_<method>_<locale>_<length>`: the character
      // count alone re-identifies a record inside a known population.
      expect(String(engine.applyRule('ab', rule))).toMatch(/^fake_[0-9a-f]{8}$/);
      expect(String(engine.applyRule('a'.repeat(200), rule))).toMatch(/^fake_[0-9a-f]{8}$/);
    });

    it('should draw every fake field of one record from the same persona', () => {
      const records = [
        { Id: '003xx000001', FirstName: 'Alexander', Email: 'alexander.hamilton@treasury.gov' },
      ];
      const rules: DataOpsAnonymizationRule[] = [
        { objectApiName: 'Contact', fieldApiName: 'FirstName', method: 'fake', config: {} },
        { objectApiName: 'Contact', fieldApiName: 'Email', method: 'fake', config: {} },
      ];

      const [result] = engine.anonymize(records, rules);

      const firstName = String(result['FirstName']).toLowerCase();
      expect(String(result['Email']).startsWith(`${firstName}.`)).toBe(true);
    });

    it('should keep no plaintext prefix when truncating', () => {
      const rule: DataOpsAnonymizationRule = {
        objectApiName: 'Contact',
        fieldApiName: 'Description',
        method: 'truncate',
        config: {},
      };
      // `slice(0, 3)` left "Lon" — the opening characters are the identifying
      // ones, and no configured length means keep nothing.
      expect(engine.applyRule('Long description text', rule)).toBe('');
    });

    it('should keep the last N characters when config.truncateLength is set', () => {
      const config: DataOpsAnonymizationRule['config'] & { truncateLength: number } = {
        truncateLength: 4,
      };
      const rule: DataOpsAnonymizationRule = {
        objectApiName: 'Contact',
        fieldApiName: 'Description',
        method: 'truncate',
        config,
      };
      expect(engine.applyRule('Long description text', rule)).toBe('text');
    });

    it('should handle preserve_format rule type', () => {
      const rule: DataOpsAnonymizationRule = {
        objectApiName: 'Contact',
        fieldApiName: 'Phone',
        method: 'preserve_format',
        config: {},
      };
      expect(engine.applyRule('555-1234', rule)).toBe('000-0000');
    });

    it('should handle shuffle rule type', () => {
      const rule: DataOpsAnonymizationRule = {
        objectApiName: 'Contact',
        fieldApiName: 'Code',
        method: 'shuffle',
        config: {},
      };
      const result = engine.applyRule('ABCD', rule);
      expect(String(result)).toHaveLength(4);
    });

    it('should not shuffle by a fixed rotation anyone can undo', () => {
      const rule: DataOpsAnonymizationRule = {
        objectApiName: 'Contact',
        fieldApiName: 'Code',
        method: 'shuffle',
        config: { hashSalt: 'salt' },
      };
      // The old implementation rotated every value right by one character, so
      // the anonymized output was recovered by rotating it back.
      expect(engine.applyRule('ABCDEFGHIJ', rule)).not.toBe('JABCDEFGHI');
    });

    it('should produce a different permutation under a different salt', () => {
      const base = { objectApiName: 'Contact', fieldApiName: 'Code', method: 'shuffle' as const };
      const a = engine.applyRule('ABCDEFGHIJ', { ...base, config: { hashSalt: 'salt-a' } });
      const b = engine.applyRule('ABCDEFGHIJ', { ...base, config: { hashSalt: 'salt-b' } });
      expect(a).not.toBe(b);
    });

    it('should be deterministic for the same value and salt', () => {
      const rule: DataOpsAnonymizationRule = {
        objectApiName: 'Contact',
        fieldApiName: 'Code',
        method: 'shuffle',
        config: { hashSalt: 'salt' },
      };
      // Re-running the same extract must not produce a second, different value.
      expect(engine.applyRule('ABCDEFGHIJ', rule)).toBe(engine.applyRule('ABCDEFGHIJ', rule));
    });
  });

  describe('preview', () => {
    it('should only return the requested sample size', () => {
      const records = Array.from({ length: 10 }, (_, i) => ({
        Email: `user${i}@test.com`,
      }));
      const rules: DataOpsAnonymizationRule[] = [createMaskRule('Email')];

      const result = engine.preview(records, rules, 3);

      expect(result).toHaveLength(3);
    });

    it('should handle sampleSize larger than records', () => {
      const records = [{ Email: 'a@b.com' }];
      const rules: DataOpsAnonymizationRule[] = [createMaskRule('Email')];

      const result = engine.preview(records, rules, 100);

      expect(result).toHaveLength(1);
    });
  });

  describe('validateRules', () => {
    it('should return no errors for valid rules', () => {
      const rules: DataOpsAnonymizationRule[] = [createMaskRule('Email')];
      expect(engine.validateRules(rules)).toHaveLength(0);
    });

    it('should return error for mask rule without maskChar', () => {
      const rules: DataOpsAnonymizationRule[] = [
        {
          objectApiName: 'Contact',
          fieldApiName: 'Email',
          method: 'mask',
          config: {},
        },
      ];
      const errors = engine.validateRules(rules);
      expect(errors.some((e) => e.includes('maskChar'))).toBe(true);
    });

    it('should return error for hash rule without valid algorithm', () => {
      const rules: DataOpsAnonymizationRule[] = [
        {
          objectApiName: 'Contact',
          fieldApiName: 'SSN',
          method: 'hash',
          config: {},
        },
      ];
      const errors = engine.validateRules(rules);
      expect(errors.some((e) => e.includes('hashAlgorithm'))).toBe(true);
    });

    it('should return error for hash rule without a hashSalt', () => {
      const rules: DataOpsAnonymizationRule[] = [
        {
          objectApiName: 'Contact',
          fieldApiName: 'SSN',
          method: 'hash',
          config: { hashAlgorithm: 'sha256' },
        },
      ];
      const errors = engine.validateRules(rules);
      expect(errors.some((e) => e.includes('hashSalt'))).toBe(true);
    });
  });
});
