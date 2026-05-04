import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { escapeCsvField, rowToCsv, rowsToCsv } from './csv-utils.js';

/**
 * Phase 03 Plan 03-06 — csv-utils unit + round-trip property tests.
 *
 * The property test embeds a minimal RFC 4180 reader (no extra dependency)
 * to prove that any string sent through `rowsToCsv` round-trips back through
 * the reader unchanged. This is the strongest possible guarantee that the
 * hand-rolled escaping is correct without pulling in `papaparse`.
 */

/** Minimal RFC 4180 single-record parser used solely by the property test. */
function parseSingleRecord(csv: string): string[] {
  // Strip the trailing CRLF appended by `rowsToCsv`.
  const trimmed = csv.endsWith('\r\n') ? csv.slice(0, -2) : csv;
  const fields: string[] = [];
  let buf = '';
  let inQuotes = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (inQuotes) {
      if (ch === '"') {
        if (trimmed[i + 1] === '"') {
          buf += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        buf += ch;
      }
    } else {
      if (ch === ',') {
        fields.push(buf);
        buf = '';
      } else if (ch === '"' && buf === '') {
        inQuotes = true;
      } else {
        buf += ch;
      }
    }
  }
  fields.push(buf);
  return fields;
}

describe('escapeCsvField', () => {
  it('returns plain string unchanged when it has no special chars', () => {
    expect(escapeCsvField('hello')).toBe('hello');
  });

  it('quotes a string containing a comma', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"');
  });

  it('escapes embedded double-quotes by doubling them', () => {
    expect(escapeCsvField('she said "hi"')).toBe('"she said ""hi"""');
  });

  it('quotes a string containing a newline', () => {
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
  });

  it('quotes a string containing a carriage return', () => {
    expect(escapeCsvField('line1\rline2')).toBe('"line1\rline2"');
  });

  it('coerces null and undefined to the empty string', () => {
    expect(escapeCsvField(null)).toBe('');
    expect(escapeCsvField(undefined)).toBe('');
  });

  it('coerces numbers and booleans via String()', () => {
    expect(escapeCsvField(42)).toBe('42');
    expect(escapeCsvField(true)).toBe('true');
    expect(escapeCsvField(0)).toBe('0');
    expect(escapeCsvField(false)).toBe('false');
  });

  it('returns empty string for empty string input (no quoting)', () => {
    expect(escapeCsvField('')).toBe('');
  });
});

describe('rowToCsv', () => {
  it('joins fields with a comma', () => {
    expect(rowToCsv(['a', 'b', 'c'])).toBe('a,b,c');
  });

  it('mixes plain and quoted fields correctly', () => {
    expect(rowToCsv(['a', 'b,c', 42])).toBe('a,"b,c",42');
  });
});

describe('rowsToCsv', () => {
  it('joins rows with CRLF and appends trailing CRLF', () => {
    expect(rowsToCsv([['a', 'b'], ['c', 'd']])).toBe('a,b\r\nc,d\r\n');
  });

  it('serializes a header row + data rows', () => {
    const out = rowsToCsv([['ts', 'value'], ['2026-01-01T00:00:00Z', 1.5]]);
    expect(out).toBe('ts,value\r\n2026-01-01T00:00:00Z,1.5\r\n');
  });
});

describe('round-trip property', () => {
  it('any string survives rowsToCsv -> parseSingleRecord unchanged (100 runs)', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const csv = rowsToCsv([[s]]);
        const parsed = parseSingleRecord(csv);
        expect(parsed).toEqual([s]);
      }),
      { numRuns: 100 },
    );
  });
});
