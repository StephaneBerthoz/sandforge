/**
 * Phase 03 Plan 03-06 — hand-rolled RFC 4180 CSV utilities.
 *
 * Pure functions, ZERO external dependencies. RESEARCH §1 Option A —
 * `papaparse` is NOT imported in the extension package because the data
 * shape we serialize (a fixed 5-column table per metric sample) is bounded
 * and trivially round-trips via the rules below.
 *
 * Re-evaluation gate (deferred to v1.4): if any DashboardView ever exports
 * > 50,000 rows, switch to streaming-papaparse via Option B in RESEARCH §1.
 */

/**
 * RFC 4180 escape rules — a value is wrapped in double quotes when it
 * contains a comma, double-quote, CR, or LF. Embedded double-quotes are
 * doubled (`"` -> `""`). `null` / `undefined` map to the empty string.
 *
 * @example
 * escapeCsvField('hello')         // 'hello'
 * escapeCsvField('a,b')           // '"a,b"'
 * escapeCsvField('she said "hi"') // '"she said ""hi"""'
 */
export function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (
    str.includes('"') ||
    str.includes(',') ||
    str.includes('\n') ||
    str.includes('\r')
  ) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Serialize one row to a single comma-joined CSV line (no trailing CRLF). */
export function rowToCsv(row: readonly unknown[]): string {
  return row.map(escapeCsvField).join(',');
}

/**
 * Serialize many rows to a CSV string. Each row is joined by CRLF (RFC 4180
 * §2.1) and a trailing CRLF is appended after the last row so streaming
 * consumers see a clean line-terminator at EOF.
 */
export function rowsToCsv(rows: readonly (readonly unknown[])[]): string {
  return rows.map(rowToCsv).join('\r\n') + '\r\n';
}
