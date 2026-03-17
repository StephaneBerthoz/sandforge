/** Exit codes used by the CLI */
export enum CliExitCode {
  Success = 0,
  Failure = 1,
  Warnings = 2,
  PartialSuccess = 3,
}

/** Human-readable labels for exit codes */
const EXIT_CODE_LABELS: Readonly<Record<number, string>> = {
  [CliExitCode.Success]: 'SUCCESS',
  [CliExitCode.Failure]: 'FAILURE',
  [CliExitCode.Warnings]: 'COMPLETED WITH WARNINGS',
  [CliExitCode.PartialSuccess]: 'PARTIAL SUCCESS',
};

/**
 * Formats CLI output into various human- and machine-readable formats.
 *
 * Supports JSON, ASCII table, CSV and HTML output generation.
 */
export class CliReporter {
  /**
   * Format data as pretty-printed JSON.
   *
   * @param data - The data object to serialise
   * @returns JSON string with 2-space indentation
   */
  formatJson(data: Record<string, unknown>): string {
    return JSON.stringify(data, null, 2);
  }

  /**
   * Format tabular data as an ASCII table with borders.
   *
   * @param headers - Column header labels
   * @param rows - Two-dimensional array of cell values
   * @returns Formatted ASCII table string
   */
  formatTable(headers: string[], rows: string[][]): string {
    if (headers.length === 0) {
      return '(empty table)';
    }

    // Calculate column widths
    const colWidths = headers.map((h, i) => {
      const cellMax = rows.reduce(
        (max, row) => Math.max(max, (row[i] ?? '').length),
        0
      );
      return Math.max(h.length, cellMax);
    });

    const separator = '+' + colWidths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
    const formatRow = (cells: string[]): string =>
      '|' +
      cells
        .map((cell, i) => ` ${(cell ?? '').padEnd(colWidths[i])} `)
        .join('|') +
      '|';

    const lines: string[] = [
      separator,
      formatRow(headers),
      separator,
    ];

    for (const row of rows) {
      lines.push(formatRow(row));
    }

    lines.push(separator);
    return lines.join('\n');
  }

  /**
   * Format tabular data as a CSV string.
   *
   * Values containing commas, double-quotes or newlines are quoted.
   *
   * @param headers - Column header labels
   * @param rows - Two-dimensional array of cell values
   * @returns RFC 4180 compliant CSV string
   */
  formatCsv(headers: string[], rows: string[][]): string {
    const escapeCsvField = (field: string): string => {
      if (
        field.includes(',') ||
        field.includes('"') ||
        field.includes('\n') ||
        field.includes('\r')
      ) {
        return `"${field.replace(/"/g, '""')}"`;
      }
      return field;
    };

    const lines: string[] = [headers.map(escapeCsvField).join(',')];
    for (const row of rows) {
      lines.push(row.map(escapeCsvField).join(','));
    }
    return lines.join('\n');
  }

  /**
   * Format data as a basic HTML report.
   *
   * @param title - The report title shown in the heading and browser tab
   * @param data - Key-value data to render as a definition list
   * @returns Complete HTML document string
   */
  formatHtml(title: string, data: Record<string, unknown>): string {
    const rows = Object.entries(data)
      .map(
        ([key, value]) =>
          `      <tr><td>${this.escapeHtml(key)}</td><td>${this.escapeHtml(String(value))}</td></tr>`
      )
      .join('\n');

    return [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head>',
      `  <meta charset="UTF-8">`,
      `  <title>${this.escapeHtml(title)}</title>`,
      '  <style>',
      '    body { font-family: sans-serif; margin: 2rem; }',
      '    table { border-collapse: collapse; width: 100%; }',
      '    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }',
      '    th { background-color: #f4f4f4; }',
      '    h1 { color: #333; }',
      '  </style>',
      '</head>',
      '<body>',
      `  <h1>${this.escapeHtml(title)}</h1>`,
      '  <table>',
      '    <thead>',
      '      <tr><th>Key</th><th>Value</th></tr>',
      '    </thead>',
      '    <tbody>',
      rows,
      '    </tbody>',
      '  </table>',
      '</body>',
      '</html>',
    ].join('\n');
  }

  /**
   * Format a human-readable exit message summarising the result.
   *
   * @param exitCode - Numeric exit code (0-3)
   * @param duration - Execution duration in milliseconds
   * @returns Formatted exit message string
   */
  formatExitMessage(exitCode: number, duration: number): string {
    const label = EXIT_CODE_LABELS[exitCode] ?? 'UNKNOWN';
    const seconds = (duration / 1000).toFixed(2);
    return `[${label}] Completed in ${seconds}s (exit code: ${exitCode})`;
  }

  /**
   * Escape special HTML characters to prevent XSS in generated reports.
   *
   * @param text - Raw text to escape
   * @returns HTML-safe string
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
