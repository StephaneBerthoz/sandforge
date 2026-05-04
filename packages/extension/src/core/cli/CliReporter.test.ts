import { describe, it, expect, beforeEach } from 'vitest';
import { CliReporter, CliExitCode } from './CliReporter.js';

describe('CliReporter', () => {
  let reporter: CliReporter;

  beforeEach(() => {
    reporter = new CliReporter();
  });

  describe('formatJson', () => {
    it('should format data as pretty-printed JSON', () => {
      const data = { name: 'test', value: 42 };
      const result = reporter.formatJson(data);
      expect(result).toBe(JSON.stringify(data, null, 2));
    });

    it('should handle empty objects', () => {
      const result = reporter.formatJson({});
      expect(result).toBe('{}');
    });

    it('should handle nested objects', () => {
      const data = { outer: { inner: 'value' } };
      const result = reporter.formatJson(data);
      const parsed = JSON.parse(result) as Record<string, unknown>;
      expect(parsed).toEqual(data);
    });

    it('should handle arrays in data', () => {
      const data = { items: [1, 2, 3] };
      const result = reporter.formatJson(data);
      expect(result).toContain('[');
      expect(result).toContain('1');
    });

    it('should handle null values', () => {
      const data = { key: null };
      const result = reporter.formatJson(data);
      expect(result).toContain('null');
    });
  });

  describe('formatTable', () => {
    it('should format headers and rows as an ASCII table', () => {
      const headers = ['Name', 'Age'];
      const rows = [
        ['Alice', '30'],
        ['Bob', '25'],
      ];
      const result = reporter.formatTable(headers, rows);

      expect(result).toContain('Name');
      expect(result).toContain('Age');
      expect(result).toContain('Alice');
      expect(result).toContain('30');
      expect(result).toContain('Bob');
      expect(result).toContain('25');
      expect(result).toContain('+');
      expect(result).toContain('|');
    });

    it('should handle empty headers', () => {
      const result = reporter.formatTable([], []);
      expect(result).toBe('(empty table)');
    });

    it('should handle rows with varying column lengths', () => {
      const headers = ['Short', 'LongerHeader'];
      const rows = [['A very long cell value', 'B']];
      const result = reporter.formatTable(headers, rows);
      expect(result).toContain('A very long cell value');
    });

    it('should align columns correctly', () => {
      const headers = ['Key', 'Value'];
      const rows = [['x', 'y']];
      const result = reporter.formatTable(headers, rows);
      const lines = result.split('\n');
      // All content lines should start and end with '|' or '+'
      for (const line of lines) {
        expect(line[0]).toMatch(/[|+]/);
      }
    });

    it('should handle a single column', () => {
      const headers = ['Item'];
      const rows = [['One'], ['Two']];
      const result = reporter.formatTable(headers, rows);
      expect(result).toContain('Item');
      expect(result).toContain('One');
      expect(result).toContain('Two');
    });

    it('should produce 3 separators (top, after header, bottom)', () => {
      const headers = ['A'];
      const rows = [['1']];
      const result = reporter.formatTable(headers, rows);
      const separatorCount = result.split('\n').filter((l) => l.startsWith('+')).length;
      expect(separatorCount).toBe(3);
    });
  });

  describe('formatCsv', () => {
    it('should format headers and rows as CSV', () => {
      const headers = ['Name', 'Age'];
      const rows = [['Alice', '30']];
      const result = reporter.formatCsv(headers, rows);
      expect(result).toBe('Name,Age\nAlice,30');
    });

    it('should escape fields containing commas', () => {
      const headers = ['Name'];
      const rows = [['Smith, John']];
      const result = reporter.formatCsv(headers, rows);
      expect(result).toContain('"Smith, John"');
    });

    it('should escape fields containing double quotes', () => {
      const headers = ['Quote'];
      const rows = [['He said "hello"']];
      const result = reporter.formatCsv(headers, rows);
      expect(result).toContain('"He said ""hello"""');
    });

    it('should escape fields containing newlines', () => {
      const headers = ['Text'];
      const rows = [['Line1\nLine2']];
      const result = reporter.formatCsv(headers, rows);
      expect(result).toContain('"Line1\nLine2"');
    });

    it('should handle empty rows', () => {
      const headers = ['A', 'B'];
      const rows: string[][] = [];
      const result = reporter.formatCsv(headers, rows);
      expect(result).toBe('A,B');
    });

    it('should handle headers with special characters', () => {
      const headers = ['Name, First', 'Age'];
      const rows = [['Alice', '30']];
      const result = reporter.formatCsv(headers, rows);
      expect(result).toContain('"Name, First"');
    });

    it('should handle multiple rows', () => {
      const headers = ['X'];
      const rows = [['1'], ['2'], ['3']];
      const result = reporter.formatCsv(headers, rows);
      const lines = result.split('\n');
      expect(lines).toHaveLength(4);
    });

    it('should handle carriage return in fields', () => {
      const headers = ['Data'];
      const rows = [['a\rb']];
      const result = reporter.formatCsv(headers, rows);
      expect(result).toContain('"a\rb"');
    });
  });

  describe('formatHtml', () => {
    it('should produce a valid HTML document', () => {
      const result = reporter.formatHtml('Report', { status: 'ok' });
      expect(result).toContain('<!DOCTYPE html>');
      expect(result).toContain('<html');
      expect(result).toContain('</html>');
    });

    it('should include the title in h1 and title tags', () => {
      const result = reporter.formatHtml('My Report', {});
      expect(result).toContain('<title>My Report</title>');
      expect(result).toContain('<h1>My Report</h1>');
    });

    it('should render data as table rows', () => {
      const result = reporter.formatHtml('Test', {
        name: 'Alice',
        age: 30,
      });
      expect(result).toContain('<td>name</td>');
      expect(result).toContain('<td>Alice</td>');
      expect(result).toContain('<td>age</td>');
      expect(result).toContain('<td>30</td>');
    });

    it('should escape HTML special characters in title', () => {
      const result = reporter.formatHtml('<script>alert(1)</script>', {});
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;script&gt;');
    });

    it('should escape HTML special characters in data values', () => {
      const result = reporter.formatHtml('Test', {
        xss: '<img onerror=alert(1)>',
      });
      expect(result).not.toContain('<img');
      expect(result).toContain('&lt;img');
    });

    it('should include table headers Key and Value', () => {
      const result = reporter.formatHtml('Test', { a: 1 });
      expect(result).toContain('<th>Key</th>');
      expect(result).toContain('<th>Value</th>');
    });

    it('should handle empty data', () => {
      const result = reporter.formatHtml('Empty', {});
      expect(result).toContain('<tbody>');
      expect(result).toContain('</tbody>');
    });

    it('should include CSS styles', () => {
      const result = reporter.formatHtml('Styled', {});
      expect(result).toContain('<style>');
      expect(result).toContain('border-collapse');
    });
  });

  describe('formatExitMessage', () => {
    it('should format success exit message', () => {
      const result = reporter.formatExitMessage(CliExitCode.Success, 1234);
      expect(result).toBe('[SUCCESS] Completed in 1.23s (exit code: 0)');
    });

    it('should format failure exit message', () => {
      const result = reporter.formatExitMessage(CliExitCode.Failure, 500);
      expect(result).toBe('[FAILURE] Completed in 0.50s (exit code: 1)');
    });

    it('should format warnings exit message', () => {
      const result = reporter.formatExitMessage(CliExitCode.Warnings, 2000);
      expect(result).toBe('[COMPLETED WITH WARNINGS] Completed in 2.00s (exit code: 2)');
    });

    it('should format partial success exit message', () => {
      const result = reporter.formatExitMessage(CliExitCode.PartialSuccess, 3500);
      expect(result).toBe('[PARTIAL SUCCESS] Completed in 3.50s (exit code: 3)');
    });

    it('should handle unknown exit codes', () => {
      const result = reporter.formatExitMessage(99, 100);
      expect(result).toContain('[UNKNOWN]');
      expect(result).toContain('exit code: 99');
    });

    it('should format zero duration', () => {
      const result = reporter.formatExitMessage(CliExitCode.Success, 0);
      expect(result).toContain('0.00s');
    });

    it('should format sub-second durations', () => {
      const result = reporter.formatExitMessage(CliExitCode.Success, 50);
      expect(result).toContain('0.05s');
    });

    it('should format large durations', () => {
      const result = reporter.formatExitMessage(CliExitCode.Success, 120000);
      expect(result).toContain('120.00s');
    });
  });
});
