import { describe, it, expect } from 'vitest';

import {
  fnv1aHash,
  shortHash,
  checksum,
  verifyChecksum,
} from './hash-utils.js';

describe('fnv1aHash', () => {
  it('should return a number', () => {
    expect(typeof fnv1aHash('hello')).toBe('number');
  });

  it('should produce consistent results for the same input', () => {
    expect(fnv1aHash('test')).toBe(fnv1aHash('test'));
  });

  it('should produce different results for different inputs', () => {
    expect(fnv1aHash('hello')).not.toBe(fnv1aHash('world'));
  });

  it('should return a positive 32-bit integer', () => {
    const hash = fnv1aHash('some string');
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xFFFFFFFF);
  });

  it('should handle empty string', () => {
    const hash = fnv1aHash('');
    expect(typeof hash).toBe('number');
    expect(hash).toBeGreaterThanOrEqual(0);
  });

  it('should handle long strings', () => {
    const longStr = 'a'.repeat(10_000);
    const hash = fnv1aHash(longStr);
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xFFFFFFFF);
  });

  it('should be sensitive to single character changes', () => {
    expect(fnv1aHash('abc')).not.toBe(fnv1aHash('abd'));
  });
});

describe('shortHash', () => {
  it('should return an 8-character hex string', () => {
    const hash = shortHash('hello');
    expect(hash).toHaveLength(8);
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('should produce consistent results', () => {
    expect(shortHash('test')).toBe(shortHash('test'));
  });

  it('should produce different results for different inputs', () => {
    expect(shortHash('hello')).not.toBe(shortHash('world'));
  });

  it('should pad with leading zeros if needed', () => {
    const hash = shortHash('');
    expect(hash).toHaveLength(8);
  });
});

describe('checksum', () => {
  it('should return an 8-character hex string', () => {
    const result = checksum('hello world');
    expect(result).toHaveLength(8);
    expect(result).toMatch(/^[0-9a-f]{8}$/);
  });

  it('should produce consistent results', () => {
    expect(checksum('test data')).toBe(checksum('test data'));
  });

  it('should produce different results for different data', () => {
    expect(checksum('data1')).not.toBe(checksum('data2'));
  });

  it('should handle empty string', () => {
    const result = checksum('');
    expect(result).toHaveLength(8);
  });

  it('should handle special characters', () => {
    const result = checksum('hello\nworld\t!@#$%');
    expect(result).toHaveLength(8);
    expect(result).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('verifyChecksum', () => {
  it('should return true when checksum matches', () => {
    const data = 'some important data';
    const expected = checksum(data);
    expect(verifyChecksum(data, expected)).toBe(true);
  });

  it('should return false when checksum does not match', () => {
    expect(verifyChecksum('data', '00000000')).toBe(false);
  });

  it('should return false when data has been modified', () => {
    const original = 'original data';
    const expected = checksum(original);
    expect(verifyChecksum('modified data', expected)).toBe(false);
  });

  it('should detect even single character changes', () => {
    const data = 'some data';
    const expected = checksum(data);
    expect(verifyChecksum('some datb', expected)).toBe(false);
  });
});
