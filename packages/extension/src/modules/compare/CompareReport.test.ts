import { describe, it, expect, beforeEach } from 'vitest';
import { CompareReport } from './CompareReport';
import type { CompareReportData } from './CompareReport';
import type { CompareItem, CompareResult, CompareSummary } from '@sandforge/shared';

function createSummary(overrides?: Partial<CompareSummary>): CompareSummary {
  return {
    totalItems: 4,
    added: 1,
    removed: 1,
    modified: 1,
    unchanged: 1,
    byType: {
      ApexClass: { added: 1, removed: 1, modified: 1 },
    },
    ...overrides,
  };
}

function createItem(
  componentType: CompareItem['componentType'],
  fullName: string,
  status: CompareItem['status'],
  severity: CompareItem['severity'] = 'info',
): CompareItem {
  return {
    componentType,
    fullName,
    status,
    severity,
    deployable: status !== 'unchanged',
  };
}

function createResult(overrides?: Partial<CompareResult>): CompareResult {
  return {
    configId: 'config-1',
    sourceOrgId: 'source-org',
    targetOrgId: 'target-org',
    mode: 'metadata',
    summary: createSummary(),
    diffs: [
      createItem('ApexClass', 'ClassA', 'added'),
      createItem('ApexClass', 'ClassB', 'removed', 'breaking'),
      createItem('ApexClass', 'ClassC', 'modified', 'warning'),
      createItem('Flow', 'FlowA', 'unchanged'),
    ],
    timestamp: '2026-02-20T10:00:00Z',
    duration: 5000,
    ...overrides,
  };
}

describe('CompareReport', () => {
  let report: CompareReport;

  beforeEach(() => {
    report = new CompareReport();
  });

  describe('generate', () => {
    it('should produce a report with correct title', () => {
      const result = createResult();
      const data = report.generate(result);

      expect(data.title).toBe('Compare Report: source-org vs target-org');
    });

    it('should include the timestamp', () => {
      const result = createResult();
      const data = report.generate(result);

      expect(data.generatedAt).toBe('2026-02-20T10:00:00Z');
    });

    it('should include source and target org IDs', () => {
      const result = createResult();
      const data = report.generate(result);

      expect(data.sourceOrg).toBe('source-org');
      expect(data.targetOrg).toBe('target-org');
    });

    it('should include the summary', () => {
      const result = createResult();
      const data = report.generate(result);

      expect(data.summary.totalItems).toBe(4);
      expect(data.summary.added).toBe(1);
    });

    it('should group items by component type into sections', () => {
      const result = createResult();
      const data = report.generate(result);

      expect(data.sections).toHaveLength(2);
      const sectionTitles = data.sections.map((s) => s.title);
      expect(sectionTitles).toContain('ApexClass');
      expect(sectionTitles).toContain('Flow');
    });

    it('should place items in their correct section', () => {
      const result = createResult();
      const data = report.generate(result);

      const apexSection = data.sections.find((s) => s.title === 'ApexClass');
      expect(apexSection?.items).toHaveLength(3);

      const flowSection = data.sections.find((s) => s.title === 'Flow');
      expect(flowSection?.items).toHaveLength(1);
    });

    it('should handle an empty diffs array', () => {
      const result = createResult({
        diffs: [],
        summary: createSummary({ totalItems: 0, added: 0, removed: 0, modified: 0, unchanged: 0 }),
      });
      const data = report.generate(result);

      expect(data.sections).toHaveLength(0);
    });

    it('should handle a single component type', () => {
      const result = createResult({
        diffs: [createItem('Flow', 'FlowA', 'added')],
      });
      const data = report.generate(result);

      expect(data.sections).toHaveLength(1);
      expect(data.sections[0].title).toBe('Flow');
    });
  });

  describe('toMarkdown', () => {
    it('should start with a level-1 heading', () => {
      const data = report.generate(createResult());
      const md = report.toMarkdown(data);

      expect(md).toMatch(/^# Compare Report:/);
    });

    it('should include the generated timestamp', () => {
      const data = report.generate(createResult());
      const md = report.toMarkdown(data);

      expect(md).toContain('**Generated:** 2026-02-20T10:00:00Z');
    });

    it('should include a summary table', () => {
      const data = report.generate(createResult());
      const md = report.toMarkdown(data);

      expect(md).toContain('## Summary');
      expect(md).toContain('| Total Items | 4 |');
      expect(md).toContain('| Added | 1 |');
    });

    it('should include a section heading for each component type', () => {
      const data = report.generate(createResult());
      const md = report.toMarkdown(data);

      expect(md).toContain('## ApexClass');
      expect(md).toContain('## Flow');
    });

    it('should include item rows in section tables', () => {
      const data = report.generate(createResult());
      const md = report.toMarkdown(data);

      expect(md).toContain('| ClassA | added | info | Yes |');
      expect(md).toContain('| ClassB | removed | breaking | Yes |');
    });

    it('should show "No differences found." for empty sections', () => {
      const data: CompareReportData = {
        title: 'Test',
        generatedAt: '2026-01-01T00:00:00Z',
        sourceOrg: 'a',
        targetOrg: 'b',
        summary: createSummary({ totalItems: 0, added: 0, removed: 0, modified: 0, unchanged: 0 }),
        sections: [{ title: 'ApexClass', items: [] }],
      };

      const md = report.toMarkdown(data);

      expect(md).toContain('No differences found.');
    });
  });

  describe('toJson', () => {
    it('should produce valid JSON', () => {
      const data = report.generate(createResult());
      const json = report.toJson(data);

      expect(() => JSON.parse(json)).not.toThrow();
    });

    it('should contain all report fields', () => {
      const data = report.generate(createResult());
      const json = report.toJson(data);
      const parsed = JSON.parse(json) as CompareReportData;

      expect(parsed.title).toBe(data.title);
      expect(parsed.sourceOrg).toBe(data.sourceOrg);
      expect(parsed.targetOrg).toBe(data.targetOrg);
      expect(parsed.summary.totalItems).toBe(data.summary.totalItems);
      expect(parsed.sections).toHaveLength(data.sections.length);
    });

    it('should be formatted with 2-space indentation', () => {
      const data = report.generate(createResult());
      const json = report.toJson(data);

      expect(json).toContain('  "title"');
    });

    it('should preserve section items', () => {
      const data = report.generate(createResult());
      const json = report.toJson(data);
      const parsed = JSON.parse(json) as CompareReportData;

      const apexSection = parsed.sections.find((s) => s.title === 'ApexClass');
      expect(apexSection?.items).toHaveLength(3);
    });
  });
});
