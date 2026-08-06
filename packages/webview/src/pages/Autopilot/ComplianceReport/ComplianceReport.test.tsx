import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ComplianceReport as ComplianceReportData } from '@sandforge/shared';
import '../../../i18n';
import { ComplianceReport } from './ComplianceReport';

/** Fixture report returned by the autopilot:compliance-report response. */
const REPORT: ComplianceReportData = {
  id: 'report-1',
  framework: 'gdpr',
  generatedAt: '2026-08-06T00:00:00.000Z',
  sourceOrgId: 'org-1',
  targetOrgId: 'org-2',
  totalFieldsScanned: 120,
  piiFieldsDetected: 2,
  piiFieldsAnonymized: 2,
  entries: [
    {
      objectApiName: 'Contact',
      fieldApiName: 'Email',
      piiCategory: 'PII',
      anonymizationMethod: 'hash',
      recordsAnonymized: 80,
      ruleApplied: 'gdpr-email',
      userOverridden: false,
    },
  ],
  objectSummaries: [],
  overallStatus: 'pass',
  checksumSha256: 'abc123',
};

/** Mock bridge query — state driven per test. */
interface QueryState {
  data: ComplianceReportData | null;
  loading: boolean;
  error: string | null;
  refetch: ReturnType<typeof vi.fn>;
}

let queryState: QueryState;

vi.mock('../../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: () => queryState,
}));

/** Mock autopilot store (only ComplianceTimeline still consumes it). */
vi.mock('../../../stores/useAutopilotStore', () => {
  const defaultState = {
    complianceFramework: 'gdpr' as const,
    rules: [],
    graph: null,
    executionStatus: 'completed' as const,
  };

  return {
    useAutopilotStore: (selector: (state: typeof defaultState) => unknown) =>
      selector(defaultState),
  };
});

describe('ComplianceReport', () => {
  beforeEach(() => {
    queryState = { data: REPORT, loading: false, error: null, refetch: vi.fn() };
  });

  it('should render without crashing', () => {
    render(<ComplianceReport />);
    expect(screen.getByTestId('compliance-report')).toBeDefined();
  });

  it('should show the report title', () => {
    render(<ComplianceReport />);
    expect(screen.getByText('Compliance Report')).toBeDefined();
  });

  it('should show export JSON button', () => {
    render(<ComplianceReport />);
    expect(screen.getByTestId('compliance-export-json')).toBeDefined();
  });

  it('should show framework badge from the report', () => {
    render(<ComplianceReport />);
    expect(screen.getByTestId('report-framework').textContent).toContain('GDPR');
  });

  it('should show entries table with real report entries', () => {
    render(<ComplianceReport />);
    expect(screen.getByTestId('compliance-rules-table')).toBeDefined();
    expect(screen.getByText('Contact')).toBeDefined();
    expect(screen.getByText('Email')).toBeDefined();
    expect(screen.getByText('gdpr-email')).toBeDefined();
  });

  it('should show a loading state while the report is fetched', () => {
    queryState = { ...queryState, data: null, loading: true };
    render(<ComplianceReport />);
    expect(screen.getByTestId('compliance-report-loading')).toBeDefined();
  });

  it('should show an error state with retry when the fetch fails', () => {
    queryState = { ...queryState, data: null, error: 'report boom' };
    render(<ComplianceReport />);
    expect(screen.getByTestId('compliance-report-error')).toBeDefined();
    fireEvent.click(screen.getByTestId('compliance-retry'));
    expect(queryState.refetch).toHaveBeenCalled();
  });
});
