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
  /**
   * The envelope the handler actually posts, `{ report }`, not a bare report.
   * This mock used to hand the component an already-unwrapped report, so the
   * component could read `payload` as the report and still pass here while
   * crashing in production. Mocking the shape the product emits is the only
   * version of this test worth having.
   */
  data: { report: ComplianceReportData } | null;
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
    queryState = { data: { report: REPORT }, loading: false, error: null, refetch: vi.fn() };
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

  it('keeps what failed and its Retry, with the keyboard on it, while the report is read again', () => {
    // Retry gave way to "Loading" as it was pressed, and took the keyboard along.
    queryState = { ...queryState, data: null, error: 'report boom' };
    const { rerender } = render(<ComplianceReport />);
    const retry = screen.getByTestId('compliance-retry');
    retry.focus();

    queryState = { ...queryState, error: null, loading: true };
    rerender(<ComplianceReport />);

    expect(screen.getByTestId('compliance-retry')).toBe(retry);
    expect(document.activeElement).toBe(retry);
    expect(retry.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByTestId('compliance-report-error').textContent).toContain('report boom');
    expect(screen.queryByTestId('compliance-report-loading')).toBeNull();

    queryState = { ...queryState, data: { report: REPORT }, loading: false };
    rerender(<ComplianceReport />);
    expect(screen.getByTestId('compliance-report')).toBeDefined();
  });

  it('says it is loading, not that there is nothing, before its first read is sent', () => {
    queryState = { ...queryState, data: null, loading: false, error: null };
    render(<ComplianceReport />);
    expect(screen.getByTestId('compliance-report-loading')).toBeDefined();
  });
});
