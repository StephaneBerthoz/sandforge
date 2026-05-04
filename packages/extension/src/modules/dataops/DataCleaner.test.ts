import { describe, it, expect, beforeEach } from 'vitest';
import { DataCleaner } from './DataCleaner';
import type { CleanRule } from './DataCleaner';

describe('DataCleaner', () => {
  let cleaner: DataCleaner;

  beforeEach(() => {
    cleaner = new DataCleaner();
  });

  describe('clean', () => {
    it('should apply multiple rules in order', () => {
      const records = [
        { Name: '  Alice  ', Email: 'ALICE@TEST.COM' },
        { Name: '  Bob  ', Email: 'BOB@TEST.COM' },
      ];
      const rules: CleanRule[] = [
        { type: 'trim', fields: ['Name'] },
        { type: 'normalize_email', fields: ['Email'] },
      ];

      const result = cleaner.clean(records, rules);

      expect(result[0]['Name']).toBe('Alice');
      expect(result[0]['Email']).toBe('alice@test.com');
    });

    it('should handle remove_empty rule', () => {
      const records = [
        { Name: 'Alice', Email: 'alice@test.com' },
        { Name: '', Email: '' },
        { Name: 'Charlie', Email: '' },
      ];
      const rules: CleanRule[] = [{ type: 'remove_empty', fields: ['Name', 'Email'] }];

      const result = cleaner.clean(records, rules);

      expect(result).toHaveLength(2);
    });

    it('should not mutate original records', () => {
      const records = [{ Name: '  Alice  ' }];
      const rules: CleanRule[] = [{ type: 'trim', fields: ['Name'] }];

      cleaner.clean(records, rules);

      expect(records[0]['Name']).toBe('  Alice  ');
    });
  });

  describe('trimWhitespace', () => {
    it('should trim leading and trailing whitespace', () => {
      const records = [{ Name: '  Alice  ', City: '  NY  ' }];
      const result = cleaner.trimWhitespace(records, ['Name', 'City']);

      expect(result[0]['Name']).toBe('Alice');
      expect(result[0]['City']).toBe('NY');
    });

    it('should skip non-string fields', () => {
      const records = [{ Name: 'Alice', Age: 30 }];
      const result = cleaner.trimWhitespace(records, ['Name', 'Age']);

      expect(result[0]['Age']).toBe(30);
    });
  });

  describe('removeDuplicates', () => {
    it('should remove duplicate records based on key fields', () => {
      const records = [
        { Email: 'a@b.com', Name: 'Alice' },
        { Email: 'a@b.com', Name: 'Alice Dup' },
        { Email: 'c@d.com', Name: 'Charlie' },
      ];
      const result = cleaner.removeDuplicates(records, ['Email']);

      expect(result).toHaveLength(2);
      expect(result[0]['Name']).toBe('Alice');
    });

    it('should keep all records when no duplicates exist', () => {
      const records = [{ Email: 'a@b.com' }, { Email: 'c@d.com' }];
      const result = cleaner.removeDuplicates(records, ['Email']);

      expect(result).toHaveLength(2);
    });

    it('should handle composite keys', () => {
      const records = [
        { First: 'A', Last: 'B' },
        { First: 'A', Last: 'C' },
        { First: 'A', Last: 'B' },
      ];
      const result = cleaner.removeDuplicates(records, ['First', 'Last']);

      expect(result).toHaveLength(2);
    });
  });

  describe('normalizePhoneNumbers', () => {
    it('should strip non-digit characters', () => {
      const records = [{ Phone: '(555) 123-4567' }];
      const result = cleaner.normalizePhoneNumbers(records, 'Phone');

      expect(result[0]['Phone']).toBe('5551234567');
    });

    it('should preserve leading plus sign', () => {
      const records = [{ Phone: '+1 (555) 123-4567' }];
      const result = cleaner.normalizePhoneNumbers(records, 'Phone');

      expect(result[0]['Phone']).toBe('+15551234567');
    });

    it('should skip non-string values', () => {
      const records = [{ Phone: 12345 }];
      const result = cleaner.normalizePhoneNumbers(records, 'Phone');

      expect(result[0]['Phone']).toBe(12345);
    });
  });

  describe('normalizeEmails', () => {
    it('should lowercase emails', () => {
      const records = [{ Email: 'USER@EXAMPLE.COM' }];
      const result = cleaner.normalizeEmails(records, 'Email');

      expect(result[0]['Email']).toBe('user@example.com');
    });

    it('should trim whitespace from emails', () => {
      const records = [{ Email: '  user@test.com  ' }];
      const result = cleaner.normalizeEmails(records, 'Email');

      expect(result[0]['Email']).toBe('user@test.com');
    });

    it('should skip non-string values', () => {
      const records = [{ Email: null }];
      const result = cleaner.normalizeEmails(records, 'Email');

      expect(result[0]['Email']).toBeNull();
    });
  });
});
