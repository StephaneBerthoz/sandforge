import { describe, expect, it } from 'vitest';
import {
  computeChecksumSuffix,
  isSalesforceId,
  isValidSalesforceId18,
  to18,
} from './salesforceId.js';

describe('salesforceId checksum', () => {
  it('computes the documented checksum of a known 15-char body', () => {
    // Body '001g00000J95p3A': blocks '001g0' (no uppercase → 0 → 'A'),
    // '0000J' (bit 4 → 16 → 'Q'), '95p3A' (bit 4 → 16 → 'Q').
    expect(computeChecksumSuffix('001g00000J95p3A')).toBe('AQQ');
    expect(to18('001g00000J95p3A')).toBe('001g00000J95p3AAQQ');
  });

  it('round-trips: every encoded ID validates', () => {
    const bodies = [
      '001g00000J95p3A',
      '500AP00000fXeQs',
      '003XXXXXXXXXXXX',
      '012A000000BcdEF', // RecordType keyprefix (012) — different pod marker
      'a0B1n00000ZZZZZ',
      '001zzzzzzzzzzzz', // all-lowercase body → checksum 'AAA'
    ];
    for (const body of bodies) {
      const id18 = to18(body);
      expect(id18).toHaveLength(18);
      expect(isValidSalesforceId18(id18)).toBe(true);
    }
  });

  it('rejects known-invalid cases', () => {
    // The mission-provided example with a WRONG checksum suffix.
    expect(isValidSalesforceId18('001g00000J95p3AAJ')).toBe(false);
    // Right body, one checksum char flipped.
    expect(isValidSalesforceId18('001g00000J95p3AQR')).toBe(false);
    // Wrong lengths.
    expect(isValidSalesforceId18('001g00000J95p3AQ')).toBe(false);
    expect(isValidSalesforceId18('001g00000J95p3AQQA')).toBe(false);
    // Illegal characters.
    expect(isValidSalesforceId18('001g00000J95p3A!!')).toBe(false);
    expect(isValidSalesforceId18('')).toBe(false);
  });

  it('15-char form has no checksum — charset only', () => {
    expect(isSalesforceId('001g00000J95p3A')).toBe(true);
    expect(isSalesforceId('001g00000J95p3AAQQ')).toBe(true);
    expect(isSalesforceId('not-an-id')).toBe(false);
    expect(isSalesforceId('001g00000J95p3AAQQ ')).toBe(false);
  });

  it('throws on malformed body for suffix computation', () => {
    expect(() => computeChecksumSuffix('short')).toThrow(/15-character/);
  });
});
