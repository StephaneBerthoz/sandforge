import { describe, it, expect } from 'vitest';
import {
  CLEANUP_ACTION_LIMIT,
  isSubjectEmail,
  isSubjectName,
  isSubjectPhone,
  ORPHAN_FILL_THRESHOLD,
  phoneDigits,
  SUBJECT_NAME_MAX_LENGTH,
  SUBJECT_PHONE_MATCH_DIGITS,
  SUBJECT_PHONE_MIN_DIGITS,
} from './data-compliance.js';

describe('data subject identifiers', () => {
  it('takes an email address, and nothing that is not one', () => {
    expect(isSubjectEmail('jane.doe@example.com')).toBe(true);
    expect(isSubjectEmail('jane doe@example.com')).toBe(false);
    expect(isSubjectEmail('jane@example')).toBe(false);
    expect(isSubjectEmail(`${'a'.repeat(250)}@example.com`)).toBe(false);
  });

  it('takes a phone number however it is punctuated, with enough digits to single out a line', () => {
    expect(phoneDigits('+33 (0)1 23.45-67 89')).toBe('330123456789');
    expect(isSubjectPhone('+33 1 23 45 67 89')).toBe(true);
    expect(isSubjectPhone('12 34')).toBe(false);
    expect(isSubjectPhone('1'.repeat(SUBJECT_PHONE_MIN_DIGITS))).toBe(true);
  });

  it('takes a name on one line, no longer than a record name', () => {
    expect(isSubjectName('Jane Doe')).toBe(true);
    expect(isSubjectName('   ')).toBe(false);
    expect(isSubjectName('Jane\nDoe')).toBe(false);
    expect(isSubjectName('x'.repeat(SUBJECT_NAME_MAX_LENGTH + 1))).toBe(false);
  });

  it('compares no more digits than a number needs to single out a line', () => {
    expect(SUBJECT_PHONE_MATCH_DIGITS).toBeGreaterThanOrEqual(SUBJECT_PHONE_MIN_DIGITS);
  });
});

describe('cleanup bounds', () => {
  it('relies on a lookup only when most records fill it', () => {
    expect(ORPHAN_FILL_THRESHOLD).toBeGreaterThan(0.5);
    expect(ORPHAN_FILL_THRESHOLD).toBeLessThan(1);
  });

  it('acts on a bounded number of records at a time', () => {
    expect(Number.isInteger(CLEANUP_ACTION_LIMIT)).toBe(true);
    expect(CLEANUP_ACTION_LIMIT).toBeGreaterThan(0);
  });
});
