import type { GeneratedReport, ReportSection } from '@sandforge/shared';

/**
 * Exports generated reports to various output formats.
 * Supports JSON, CSV, HTML, and Markdown output.
 */
export class ExportEngine {
  /**
   * Export a report as a formatted JSON string.
   * @param report - The generated report to export
   * @returns A JSON string with 2-space indentation
   */
  exportToJson(report: GeneratedReport): string {
    return JSON.stringify(report, null, 2);
  }

  /**
   * Export a report as CSV. Only table-type sections are included.
   * Each table section produces a header row followed by data rows.
   * @param report - The generated report to export
   * @returns A CSV-formatted string
   */
  exportToCsv(report: GeneratedReport): string {
    const tableSections = report.sections
      .filter((s) => s.type === 'table')
      .sort((a, b) => a.order - b.order);

    if (tableSections.length === 0) {
      return '';
    }

    const csvParts: string[] = [];

    for (const section of tableSections) {
      const rows = this.extractTableRows(section);
      if (rows.length === 0) {
        continue;
      }

      const headers = Object.keys(rows[0]);
      csvParts.push(headers.map((h) => this.escapeCsvValue(h)).join(','));

      for (const row of rows) {
        const values = headers.map((h) => {
          const val = row[h];
          return this.escapeCsvValue(String(val ?? ''));
        });
        csvParts.push(values.join(','));
      }
    }

    return csvParts.join('\n');
  }

  /**
   * Export a report as an HTML document.
   * Produces a complete HTML5 document with styled sections.
   * @param report - The generated report to export
   * @returns A complete HTML document string
   */
  exportToHtml(report: GeneratedReport): string {
    const sortedSections = [...report.sections].sort(
      (a, b) => a.order - b.order
    );

    const sectionsHtml = sortedSections
      .map((section) => this.renderHtmlSection(section))
      .join('\n');

    return [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head>',
      '<meta charset="UTF-8">',
      `<title>${this.escapeHtml(report.title)}</title>`,
      '<style>',
      'body { font-family: sans-serif; margin: 2rem; }',
      'table { border-collapse: collapse; width: 100%; margin: 1rem 0; }',
      'th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }',
      'th { background-color: #f5f5f5; }',
      '.section { margin-bottom: 2rem; }',
      '</style>',
      '</head>',
      '<body>',
      `<h1>${this.escapeHtml(report.title)}</h1>`,
      `<p>${this.escapeHtml(report.summary)}</p>`,
      `<p><em>Generated: ${this.escapeHtml(report.generatedAt)}</em></p>`,
      sectionsHtml,
      '</body>',
      '</html>',
    ].join('\n');
  }

  /**
   * Export a report as a Markdown document.
   * Produces headings, paragraphs, and tables for each section.
   * @param report - The generated report to export
   * @returns A Markdown-formatted string
   */
  exportToMarkdown(report: GeneratedReport): string {
    const sortedSections = [...report.sections].sort(
      (a, b) => a.order - b.order
    );

    const parts: string[] = [
      `# ${report.title}`,
      '',
      report.summary,
      '',
      `*Generated: ${report.generatedAt}*`,
      '',
    ];

    for (const section of sortedSections) {
      parts.push(this.renderMarkdownSection(section));
      parts.push('');
    }

    return parts.join('\n');
  }

  private renderHtmlSection(section: ReportSection): string {
    const lines: string[] = [
      '<div class="section">',
      `<h2>${this.escapeHtml(section.title)}</h2>`,
    ];

    switch (section.type) {
      case 'table': {
        const rows = this.extractTableRows(section);
        if (rows.length > 0) {
          const headers = Object.keys(rows[0]);
          lines.push('<table>');
          lines.push(
            '<tr>' +
              headers.map((h) => `<th>${this.escapeHtml(h)}</th>`).join('') +
              '</tr>'
          );
          for (const row of rows) {
            lines.push(
              '<tr>' +
                headers
                  .map(
                    (h) =>
                      `<td>${this.escapeHtml(String(row[h] ?? ''))}</td>`
                  )
                  .join('') +
                '</tr>'
            );
          }
          lines.push('</table>');
        }
        break;
      }
      case 'text': {
        const value = section.content['value'];
        lines.push(`<p>${this.escapeHtml(String(value ?? ''))}</p>`);
        break;
      }
      case 'summary':
      case 'detail':
      case 'chart':
      default: {
        const entries = Object.entries(section.content);
        if (entries.length > 0) {
          lines.push('<dl>');
          for (const [key, val] of entries) {
            lines.push(`<dt>${this.escapeHtml(key)}</dt>`);
            lines.push(
              `<dd>${this.escapeHtml(String(val ?? ''))}</dd>`
            );
          }
          lines.push('</dl>');
        }
        break;
      }
    }

    lines.push('</div>');
    return lines.join('\n');
  }

  private renderMarkdownSection(section: ReportSection): string {
    const lines: string[] = [`## ${section.title}`];

    switch (section.type) {
      case 'table': {
        const rows = this.extractTableRows(section);
        if (rows.length > 0) {
          const headers = Object.keys(rows[0]);
          lines.push('');
          lines.push('| ' + headers.join(' | ') + ' |');
          lines.push('| ' + headers.map(() => '---').join(' | ') + ' |');
          for (const row of rows) {
            const values = headers.map((h) => String(row[h] ?? ''));
            lines.push('| ' + values.join(' | ') + ' |');
          }
        }
        break;
      }
      case 'text': {
        const value = section.content['value'];
        lines.push('');
        lines.push(String(value ?? ''));
        break;
      }
      case 'summary':
      case 'detail':
      case 'chart':
      default: {
        const entries = Object.entries(section.content);
        if (entries.length > 0) {
          lines.push('');
          for (const [key, val] of entries) {
            lines.push(`- **${key}**: ${String(val ?? '')}`);
          }
        }
        break;
      }
    }

    return lines.join('\n');
  }

  private extractTableRows(
    section: ReportSection
  ): Record<string, unknown>[] {
    const rows = section.content['rows'];
    if (!Array.isArray(rows)) {
      return [];
    }
    return rows.filter(
      (row): row is Record<string, unknown> =>
        typeof row === 'object' && row !== null
    );
  }

  private escapeCsvValue(value: string): string {
    if (value.includes(',') || value.includes('"') || value.includes('\n')) {
      return `"${value.replace(/"/g, '""')}"`;
    }
    return value;
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
