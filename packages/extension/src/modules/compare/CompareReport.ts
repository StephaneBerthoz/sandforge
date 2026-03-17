import type {
  CompareItem,
  CompareResult,
  CompareSummary,
  MetadataComponentType,
} from '@sandforge/shared';

/** A section within a comparison report */
export interface ReportSection {
  title: string;
  items: CompareItem[];
}

/** Structured report data generated from comparison results */
export interface CompareReportData {
  title: string;
  generatedAt: string;
  sourceOrg: string;
  targetOrg: string;
  summary: CompareSummary;
  sections: ReportSection[];
}

/**
 * Generates structured reports from comparison results.
 * Supports output in markdown and JSON formats for integration
 * with external tools and documentation workflows.
 */
export class CompareReport {
  /**
   * Generate a structured report from a CompareResult.
   * Groups diff items by component type into report sections.
   */
  generate(result: CompareResult): CompareReportData {
    const sections = groupBySections(result.diffs);

    return {
      title: `Compare Report: ${result.sourceOrgId} vs ${result.targetOrgId}`,
      generatedAt: result.timestamp,
      sourceOrg: result.sourceOrgId,
      targetOrg: result.targetOrgId,
      summary: result.summary,
      sections,
    };
  }

  /** Convert a CompareReportData to markdown format */
  toMarkdown(report: CompareReportData): string {
    const lines: string[] = [];

    lines.push(`# ${report.title}`);
    lines.push('');
    lines.push(`**Generated:** ${report.generatedAt}`);
    lines.push(`**Source Org:** ${report.sourceOrg}`);
    lines.push(`**Target Org:** ${report.targetOrg}`);
    lines.push('');

    lines.push('## Summary');
    lines.push('');
    lines.push(`| Metric | Count |`);
    lines.push(`| --- | --- |`);
    lines.push(`| Total Items | ${report.summary.totalItems} |`);
    lines.push(`| Added | ${report.summary.added} |`);
    lines.push(`| Removed | ${report.summary.removed} |`);
    lines.push(`| Modified | ${report.summary.modified} |`);
    lines.push(`| Unchanged | ${report.summary.unchanged} |`);
    lines.push('');

    for (const section of report.sections) {
      lines.push(`## ${section.title}`);
      lines.push('');

      if (section.items.length === 0) {
        lines.push('No differences found.');
        lines.push('');
        continue;
      }

      lines.push(`| Component | Status | Severity | Deployable |`);
      lines.push(`| --- | --- | --- | --- |`);

      for (const item of section.items) {
        lines.push(
          `| ${item.fullName} | ${item.status} | ${item.severity} | ${item.deployable ? 'Yes' : 'No'} |`
        );
      }

      lines.push('');
    }

    return lines.join('\n');
  }

  /** Convert a CompareReportData to a formatted JSON string */
  toJson(report: CompareReportData): string {
    return JSON.stringify(report, null, 2);
  }
}

/** Group CompareItems into sections by component type */
function groupBySections(diffs: CompareItem[]): ReportSection[] {
  const grouped = new Map<MetadataComponentType, CompareItem[]>();

  for (const item of diffs) {
    const existing = grouped.get(item.componentType) ?? [];
    existing.push(item);
    grouped.set(item.componentType, existing);
  }

  const sections: ReportSection[] = [];

  for (const [componentType, items] of grouped) {
    sections.push({
      title: componentType,
      items,
    });
  }

  return sections;
}
