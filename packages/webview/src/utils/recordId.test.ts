import { describe, it, expect } from 'vitest';
import { extractRecordId } from './recordId';

describe('extractRecordId', () => {
  it('should accept a plain 15-char ID', () => {
    expect(extractRecordId('001XXXXXXXXXXXX')).toBe('001XXXXXXXXXXXX');
  });

  it('should accept a plain 18-char ID', () => {
    expect(extractRecordId('001XXXXXXXXXXXXXXX')).toBe('001XXXXXXXXXXXXXXX');
  });

  it('should trim surrounding whitespace', () => {
    expect(extractRecordId('  001XXXXXXXXXXXXXXX  ')).toBe('001XXXXXXXXXXXXXXX');
  });

  it('should extract the ID from a Lightning URL', () => {
    expect(
      extractRecordId(
        'https://myorg.lightning.force.com/lightning/r/Account/001XXXXXXXXXXXXXXX/view',
      ),
    ).toBe('001XXXXXXXXXXXXXXX');
  });

  it('should extract the ID from a URL with a query string', () => {
    expect(extractRecordId('https://myorg.salesforce.com/001XXXXXXXXXXXXXXX?foo=bar')).toBe(
      '001XXXXXXXXXXXXXXX',
    );
  });

  it('should extract the ID from a URL ending with the ID', () => {
    expect(extractRecordId('https://myorg.salesforce.com/001XXXXXXXXXXXX')).toBe('001XXXXXXXXXXXX');
  });

  it('should return null for invalid input', () => {
    expect(extractRecordId('')).toBeNull();
    expect(extractRecordId('not-an-id')).toBeNull();
    expect(extractRecordId('001XX')).toBeNull();
  });
});
