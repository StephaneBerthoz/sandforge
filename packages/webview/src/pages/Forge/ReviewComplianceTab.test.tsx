import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { ReviewComplianceTab } from './ReviewComplianceTab';
import type { ComplianceReport } from '@sandforge/shared';

/* ---- Mocks ---- */

let mockComplianceReport: ComplianceReport | null = null;

vi.mock('../../stores/useForgeStore', () => {
  const store = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        get complianceReport() {
          return mockComplianceReport;
        },
      }),
    {
      getState: () => ({
        complianceReport: mockComplianceReport,
      }),
    },
  );
  return { useForgeStore: store };
});

/* ---- Helpers ---- */

const makeReport = (
  overrides: Partial<ComplianceReport> = {},
): ComplianceReport => ({
  id: 'rpt-001',
  framework: 'gdpr',
  generatedAt: '2026-03-11T10:00:00Z',
  sourceOrgId: 'src-1',
  targetOrgId: 'tgt-1',
  totalFieldsScanned: 120,
  piiFieldsDetected: 15,
  piiFieldsAnonymized: 12,
  entries: [],
  objectSummaries: [],
  overallStatus: 'pass',
  checksumSha256: 'abc123',
  ...overrides,
});

/* ---- Tests ---- */

describe('ReviewComplianceTab', () => {
  it('should render with data-testid', () => {
    mockComplianceReport = null;
    render(<ReviewComplianceTab />);
    expect(screen.getByTestId('review-compliance-tab')).toBeDefined();
  });

  it('should have framework select with 5 options', () => {
    mockComplianceReport = null;
    render(<ReviewComplianceTab />);
    const select = screen.getByTestId('framework-select') as HTMLSelectElement;
    expect(select.options.length).toBe(5);
  });

  it('should show no-compliance message when framework is none', () => {
    mockComplianceReport = null;
    render(<ReviewComplianceTab />);
    expect(screen.getByTestId('no-compliance')).toBeDefined();
  });

  it('should show loading message when framework selected but no report', () => {
    mockComplianceReport = null;
    render(<ReviewComplianceTab />);
    const select = screen.getByTestId('framework-select');
    fireEvent.change(select, { target: { value: 'gdpr' } });
    expect(screen.getByTestId('compliance-loading')).toBeDefined();
    expect(screen.queryByTestId('no-compliance')).toBeNull();
  });

  it('should show compliance report when available', () => {
    mockComplianceReport = makeReport();
    render(<ReviewComplianceTab />);
    // Select a framework to trigger report display
    const select = screen.getByTestId('framework-select');
    fireEvent.change(select, { target: { value: 'gdpr' } });
    expect(screen.getByTestId('compliance-report')).toBeDefined();
    const report = screen.getByTestId('compliance-report');
    expect(report.textContent).toContain('15 PII fields detected');
    expect(report.textContent).toContain('12 fields anonymized');
  });

  it('should display correct status badge for partial compliance', () => {
    mockComplianceReport = makeReport({ overallStatus: 'partial' });
    render(<ReviewComplianceTab />);
    const select = screen.getByTestId('framework-select');
    fireEvent.change(select, { target: { value: 'gdpr' } });
    const report = screen.getByTestId('compliance-report');
    expect(report.textContent).toContain('PARTIAL');
  });
});
