/**
 * Reads and writes CSV data.
 * Handles quoted fields containing commas, newlines, and escaped quotes.
 * Produces records keyed by header column names.
 */
export class CsvConnector {
  /**
   * Parse CSV content into an array of records.
   * The first row is treated as header names.
   * Supports quoted fields with commas and escaped quotes (double-quote).
   */
  read(csvContent: string): Record<string, unknown>[] {
    const trimmed = csvContent.trim();
    if (trimmed.length === 0) {
      return [];
    }

    const rows = parseRows(trimmed);
    if (rows.length < 2) {
      return [];
    }

    const headers = rows[0];
    const records: Record<string, unknown>[] = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row.length === 0 || (row.length === 1 && row[0] === '')) {
        continue;
      }

      const record: Record<string, unknown> = {};
      for (let j = 0; j < headers.length; j++) {
        const value = j < row.length ? row[j] : '';
        record[headers[j]] = parseValue(value);
      }
      records.push(record);
    }

    return records;
  }

  /**
   * Serialize an array of records into CSV string.
   * Uses all keys from the first record as headers.
   * Quotes values that contain commas, newlines, or double quotes.
   */
  write(records: Record<string, unknown>[]): string {
    if (records.length === 0) {
      return '';
    }

    const headers = Object.keys(records[0]);
    const lines: string[] = [headers.map(escapeField).join(',')];

    for (const record of records) {
      const values = headers.map((h) => {
        const val = record[h];
        if (val === null || val === undefined) {
          return '';
        }
        return escapeField(String(val));
      });
      lines.push(values.join(','));
    }

    return lines.join('\n');
  }
}

/**
 * Parse CSV text into rows of field arrays, respecting quoted fields.
 */
function parseRows(text: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          currentField += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      currentField += char;
      i++;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i++;
      continue;
    }

    if (char === ',') {
      currentRow.push(currentField);
      currentField = '';
      i++;
      continue;
    }

    if (char === '\r') {
      i++;
      continue;
    }

    if (char === '\n') {
      currentRow.push(currentField);
      currentField = '';
      rows.push(currentRow);
      currentRow = [];
      i++;
      continue;
    }

    currentField += char;
    i++;
  }

  currentRow.push(currentField);
  if (currentRow.length > 0) {
    rows.push(currentRow);
  }

  return rows;
}

/**
 * Parse a string value into its appropriate type (number, boolean, null, or string).
 */
function parseValue(value: string): unknown {
  if (value === '') {
    return '';
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  if (value === 'null') {
    return null;
  }

  const num = Number(value);
  if (!isNaN(num) && value.trim() !== '') {
    return num;
  }

  return value;
}

/**
 * Escape a field value for CSV output.
 * Wraps in double quotes if the value contains commas, newlines, or quotes.
 */
function escapeField(value: string): string {
  if (value.includes(',') || value.includes('\n') || value.includes('"')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
