import { describe, it, expect, beforeEach } from 'vitest';
import { DataMasker } from './DataMasker';
import type { MaskRule } from './DataMasker';

describe('DataMasker', () => {
  let masker: DataMasker;

  beforeEach(() => {
    masker = new DataMasker();
  });

  describe('mask', () => {
    it('should nullify a field with nullify strategy', () => {
      const records = [{ Name: 'John Doe', SSN: '123-45-6789' }];
      const rules: MaskRule[] = [{ fieldName: 'SSN', strategy: 'nullify' }];

      const result = masker.mask(records, rules);

      expect(result[0].SSN).toBeNull();
      expect(result[0].Name).toBe('John Doe');
    });

    it('should replace a field with constant value', () => {
      const records = [{ Name: 'John', Phone: '555-1234' }];
      const rules: MaskRule[] = [
        { fieldName: 'Phone', strategy: 'constant', config: { replacement: 'REDACTED' } },
      ];

      const result = masker.mask(records, rules);

      expect(result[0].Phone).toBe('REDACTED');
    });

    it('should use default constant when no replacement specified', () => {
      const records = [{ Phone: '555-1234' }];
      const rules: MaskRule[] = [{ fieldName: 'Phone', strategy: 'constant' }];

      const result = masker.mask(records, rules);

      expect(result[0].Phone).toBe('***');
    });

    it('should hash a field value deterministically', () => {
      const records = [{ Email: 'test@example.com' }];
      const rules: MaskRule[] = [{ fieldName: 'Email', strategy: 'hash' }];

      const result1 = masker.mask(records, rules);
      const result2 = masker.mask(records, rules);

      expect(result1[0].Email).toBe(result2[0].Email);
      expect(typeof result1[0].Email).toBe('string');
      expect(result1[0].Email).not.toBe('test@example.com');
    });

    it('should generate fake email for email-like values', () => {
      const records = [{ Email: 'real@company.com' }];
      const rules: MaskRule[] = [{ fieldName: 'Email', strategy: 'fake' }];

      const result = masker.mask(records, rules);

      expect(result[0].Email).toBe('masked@example.com');
    });

    it('should generate fake string of same length', () => {
      const records = [{ Name: 'John' }];
      const rules: MaskRule[] = [{ fieldName: 'Name', strategy: 'fake' }];

      const result = masker.mask(records, rules);

      expect(result[0].Name).toBe('XXXX');
    });

    it('should generate fake value for numbers', () => {
      const records = [{ Revenue: 1000000 }];
      const rules: MaskRule[] = [{ fieldName: 'Revenue', strategy: 'fake' }];

      const result = masker.mask(records, rules);

      expect(result[0].Revenue).toBe(0);
    });

    it('should apply mask_partial leaving last N chars visible', () => {
      const records = [{ Phone: '555-123-4567' }];
      const rules: MaskRule[] = [
        { fieldName: 'Phone', strategy: 'mask_partial', config: { visibleChars: 4 } },
      ];

      const result = masker.mask(records, rules);

      expect(result[0].Phone).toBe('********4567');
    });

    it('should return full value for mask_partial when value is shorter than visibleChars', () => {
      const records = [{ Code: 'AB' }];
      const rules: MaskRule[] = [
        { fieldName: 'Code', strategy: 'mask_partial', config: { visibleChars: 5 } },
      ];

      const result = masker.mask(records, rules);

      expect(result[0].Code).toBe('AB');
    });

    it('should not modify original records', () => {
      const records = [{ Name: 'John', SSN: '123-45-6789' }];
      const rules: MaskRule[] = [{ fieldName: 'SSN', strategy: 'nullify' }];

      masker.mask(records, rules);

      expect(records[0].SSN).toBe('123-45-6789');
    });

    it('should handle records without the masked field', () => {
      const records = [{ Name: 'John' }];
      const rules: MaskRule[] = [{ fieldName: 'SSN', strategy: 'nullify' }];

      const result = masker.mask(records, rules);

      expect(result[0]).toEqual({ Name: 'John' });
    });

    it('should apply multiple mask rules', () => {
      const records = [{ Name: 'John', Email: 'john@test.com', Phone: '555-1234' }];
      const rules: MaskRule[] = [
        { fieldName: 'Email', strategy: 'fake' },
        { fieldName: 'Phone', strategy: 'nullify' },
      ];

      const result = masker.mask(records, rules);

      expect(result[0].Email).toBe('masked@example.com');
      expect(result[0].Phone).toBeNull();
      expect(result[0].Name).toBe('John');
    });

    it('should return copies when no rules are provided', () => {
      const records = [{ Name: 'John' }];
      const result = masker.mask(records, []);

      expect(result[0]).toEqual(records[0]);
      expect(result[0]).not.toBe(records[0]);
    });

    it('should handle empty records array', () => {
      const rules: MaskRule[] = [{ fieldName: 'Name', strategy: 'nullify' }];

      expect(masker.mask([], rules)).toEqual([]);
    });
  });
});
