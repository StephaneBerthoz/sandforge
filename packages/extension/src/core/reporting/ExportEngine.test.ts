import { describe, it, expect, beforeEach } from 'vitest';
import { ExportEngine } from './ExportEngine';
import type { GeneratedReport } from '@sandforge/shared';

function makeReport(overrides?: Partial<GeneratedReport>): GeneratedReport {
  return {
    id: 'report-001',
    definitionId: 'def-001',
    type: 'seed_execution',
    title: 'Test Report',
    summary: 'A test report summary',
    sections: [],
    metadata: {
      module: 'seed',
      orgId: 'org-123',
      duration: 1500,
      recordCount: 100,
    },
    generatedAt: '2026-01-15T12:00:00.000Z',
    ...overrides,
  };
}

describe('ExportEngine', () => {
  let engine: ExportEngine;

  beforeEach(() => {
    engine = new ExportEngine();
  });

  describe('exportToJson', () => {
    it('should export a report as formatted JSON', () => {
      const report = makeReport();
      const json = engine.exportToJson(report);
      const parsed = JSON.parse(json);

      expect(parsed.id).toBe('report-001');
      expect(parsed.title).toBe('Test Report');
      expect(parsed.sections).toEqual([]);
    });

    it('should include all report fields in the JSON output', () => {
      const report = makeReport({
        sections: [
          { title: 'Section 1', type: 'text', content: { value: 'hello' }, order: 0 },
        ],
      });

      const json = engine.exportToJson(report);
      const parsed = JSON.parse(json);

      expect(parsed.sections).toHaveLength(1);
      expect(parsed.metadata.module).toBe('seed');
      expect(parsed.generatedAt).toBe('2026-01-15T12:00:00.000Z');
    });

    it('should use 2-space indentation', () => {
      const report = makeReport();
      const json = engine.exportToJson(report);

      expect(json).toContain('  "id"');
    });
  });

  describe('exportToCsv', () => {
    it('should return empty string when no table sections exist', () => {
      const report = makeReport({
        sections: [
          { title: 'Text', type: 'text', content: { value: 'hello' }, order: 0 },
        ],
      });

      const csv = engine.exportToCsv(report);
      expect(csv).toBe('');
    });

    it('should export table section as CSV with headers and rows', () => {
      const report = makeReport({
        sections: [
          {
            title: 'Records',
            type: 'table',
            content: {
              rows: [
                { name: 'Account', count: 50 },
                { name: 'Contact', count: 100 },
              ],
            },
            order: 0,
          },
        ],
      });

      const csv = engine.exportToCsv(report);
      const lines = csv.split('\n');

      expect(lines[0]).toBe('name,count');
      expect(lines[1]).toBe('Account,50');
      expect(lines[2]).toBe('Contact,100');
    });

    it('should handle multiple table sections', () => {
      const report = makeReport({
        sections: [
          {
            title: 'Table A',
            type: 'table',
            content: { rows: [{ a: 1 }] },
            order: 0,
          },
          {
            title: 'Table B',
            type: 'table',
            content: { rows: [{ b: 2 }] },
            order: 1,
          },
        ],
      });

      const csv = engine.exportToCsv(report);
      const lines = csv.split('\n');

      expect(lines).toHaveLength(4);
    });

    it('should escape values containing commas', () => {
      const report = makeReport({
        sections: [
          {
            title: 'Records',
            type: 'table',
            content: {
              rows: [{ name: 'Smith, John', role: 'Admin' }],
            },
            order: 0,
          },
        ],
      });

      const csv = engine.exportToCsv(report);
      expect(csv).toContain('"Smith, John"');
    });

    it('should return empty string when table rows are not an array', () => {
      const report = makeReport({
        sections: [
          {
            title: 'Invalid',
            type: 'table',
            content: { rows: 'not-an-array' as unknown as Record<string, unknown>[] },
            order: 0,
          },
        ],
      });

      const csv = engine.exportToCsv(report);
      expect(csv).toBe('');
    });

    it('should handle empty rows array', () => {
      const report = makeReport({
        sections: [
          {
            title: 'Empty',
            type: 'table',
            content: { rows: [] },
            order: 0,
          },
        ],
      });

      const csv = engine.exportToCsv(report);
      expect(csv).toBe('');
    });
  });

  describe('exportToHtml', () => {
    it('should produce a valid HTML5 document', () => {
      const report = makeReport();
      const html = engine.exportToHtml(report);

      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('<html lang="en">');
      expect(html).toContain('</html>');
      expect(html).toContain('<meta charset="UTF-8">');
    });

    it('should include the report title and summary', () => {
      const report = makeReport();
      const html = engine.exportToHtml(report);

      expect(html).toContain('<h1>Test Report</h1>');
      expect(html).toContain('<p>A test report summary</p>');
    });

    it('should include the generated date', () => {
      const report = makeReport();
      const html = engine.exportToHtml(report);

      expect(html).toContain('2026-01-15T12:00:00.000Z');
    });

    it('should render table sections as HTML tables', () => {
      const report = makeReport({
        sections: [
          {
            title: 'Records',
            type: 'table',
            content: {
              rows: [{ name: 'Account', count: 50 }],
            },
            order: 0,
          },
        ],
      });

      const html = engine.exportToHtml(report);

      expect(html).toContain('<table>');
      expect(html).toContain('<th>name</th>');
      expect(html).toContain('<td>Account</td>');
      expect(html).toContain('<td>50</td>');
      expect(html).toContain('</table>');
    });

    it('should render text sections as paragraphs', () => {
      const report = makeReport({
        sections: [
          {
            title: 'Status',
            type: 'text',
            content: { value: 'All good' },
            order: 0,
          },
        ],
      });

      const html = engine.exportToHtml(report);

      expect(html).toContain('<h2>Status</h2>');
      expect(html).toContain('<p>All good</p>');
    });

    it('should render detail sections as definition lists', () => {
      const report = makeReport({
        sections: [
          {
            title: 'Info',
            type: 'detail',
            content: { org: 'Production', status: 'active' },
            order: 0,
          },
        ],
      });

      const html = engine.exportToHtml(report);

      expect(html).toContain('<dl>');
      expect(html).toContain('<dt>org</dt>');
      expect(html).toContain('<dd>Production</dd>');
      expect(html).toContain('</dl>');
    });

    it('should escape HTML special characters', () => {
      const report = makeReport({
        title: 'Report <script>alert("xss")</script>',
        sections: [],
      });

      const html = engine.exportToHtml(report);

      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;');
    });

    it('should handle empty sections array', () => {
      const report = makeReport({ sections: [] });
      const html = engine.exportToHtml(report);

      expect(html).toContain('<h1>Test Report</h1>');
      expect(html).toContain('</body>');
    });
  });

  describe('exportToMarkdown', () => {
    it('should start with a level-1 heading for the title', () => {
      const report = makeReport();
      const md = engine.exportToMarkdown(report);

      expect(md).toMatch(/^# Test Report/);
    });

    it('should include the summary and generated date', () => {
      const report = makeReport();
      const md = engine.exportToMarkdown(report);

      expect(md).toContain('A test report summary');
      expect(md).toContain('*Generated: 2026-01-15T12:00:00.000Z*');
    });

    it('should render table sections as markdown tables', () => {
      const report = makeReport({
        sections: [
          {
            title: 'Records',
            type: 'table',
            content: {
              rows: [
                { name: 'Account', count: 50 },
                { name: 'Contact', count: 100 },
              ],
            },
            order: 0,
          },
        ],
      });

      const md = engine.exportToMarkdown(report);

      expect(md).toContain('## Records');
      expect(md).toContain('| name | count |');
      expect(md).toContain('| --- | --- |');
      expect(md).toContain('| Account | 50 |');
      expect(md).toContain('| Contact | 100 |');
    });

    it('should render text sections as paragraphs', () => {
      const report = makeReport({
        sections: [
          {
            title: 'Status',
            type: 'text',
            content: { value: 'Completed' },
            order: 0,
          },
        ],
      });

      const md = engine.exportToMarkdown(report);

      expect(md).toContain('## Status');
      expect(md).toContain('Completed');
    });

    it('should render detail sections as key-value lists', () => {
      const report = makeReport({
        sections: [
          {
            title: 'Info',
            type: 'detail',
            content: { org: 'Production', status: 'active' },
            order: 0,
          },
        ],
      });

      const md = engine.exportToMarkdown(report);

      expect(md).toContain('## Info');
      expect(md).toContain('- **org**: Production');
      expect(md).toContain('- **status**: active');
    });

    it('should order sections by their order property', () => {
      const report = makeReport({
        sections: [
          {
            title: 'Second',
            type: 'text',
            content: { value: 'B' },
            order: 1,
          },
          {
            title: 'First',
            type: 'text',
            content: { value: 'A' },
            order: 0,
          },
        ],
      });

      const md = engine.exportToMarkdown(report);

      const firstIdx = md.indexOf('## First');
      const secondIdx = md.indexOf('## Second');
      expect(firstIdx).toBeLessThan(secondIdx);
    });

    it('should handle empty sections array', () => {
      const report = makeReport({ sections: [] });
      const md = engine.exportToMarkdown(report);

      expect(md).toContain('# Test Report');
      expect(md).toContain('A test report summary');
    });

    it('should handle table sections with empty rows', () => {
      const report = makeReport({
        sections: [
          {
            title: 'Empty Table',
            type: 'table',
            content: { rows: [] },
            order: 0,
          },
        ],
      });

      const md = engine.exportToMarkdown(report);

      expect(md).toContain('## Empty Table');
      expect(md).not.toContain('| --- |');
    });
  });
});
