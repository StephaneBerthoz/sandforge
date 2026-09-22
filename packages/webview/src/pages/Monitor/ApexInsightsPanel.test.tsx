import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { ApexInsightsPanel } from './ApexInsightsPanel';

let mockData: Record<string, unknown> | null = null;
let mockLoading = false;

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => {
    if (type === 'monitor:apex-insights') {
      return { data: mockData, loading: mockLoading, error: null, refetch: vi.fn() };
    }
    return { data: null, loading: false, error: null, refetch: vi.fn() };
  },
}));

describe('ApexInsightsPanel', () => {
  beforeEach(() => {
    mockData = null;
    mockLoading = false;
    useOrgStore.setState({ selectedOrgId: 'org-1', orgs: [] });
  });

  it('renders loading skeleton when loading', () => {
    mockLoading = true;
    render(<ApexInsightsPanel />);
    expect(screen.getByTestId('apex-insights-panel-loading')).toBeDefined();
  });

  it('renders empty state when no analyses', () => {
    mockData = { success: true, analyses: [], topIssues: [] };
    render(<ApexInsightsPanel />);
    expect(screen.getByTestId('apex-insights-panel-empty')).toBeDefined();
    expect(screen.getByText('Apex Insights')).toBeDefined();
  });

  it('renders analysis rows and top issues', () => {
    mockData = {
      success: true,
      analyses: [
        {
          logId: 'log-001-abcdef',
          totalDuration: 1200,
          soqlQueries: 45,
          dmlStatements: 12,
          heapUsed: 65000,
          cpuTime: 800,
          issues: [{ type: 'N+1', severity: 'warning', message: 'SOQL inside loop' }],
        },
        {
          logId: 'log-002-ghijkl',
          totalDuration: 300,
          soqlQueries: 5,
          dmlStatements: 2,
          heapUsed: 12000,
          cpuTime: 100,
          issues: [],
        },
      ],
      topIssues: [{ type: 'N+1', severity: 'warning', message: 'SOQL inside loop' }],
    };
    render(<ApexInsightsPanel />);

    expect(screen.getByTestId('apex-insights-panel')).toBeDefined();
    expect(screen.getByTestId('apex-analysis-row-log-001-abcdef')).toBeDefined();
    expect(screen.getByTestId('apex-analysis-row-log-002-ghijkl')).toBeDefined();
    expect(screen.getByTestId('apex-issue-0')).toBeDefined();
    expect(screen.getByText('warning')).toBeDefined();
  });

  it('shows no-issues message when topIssues is empty', () => {
    mockData = {
      success: true,
      analyses: [
        {
          logId: 'log-001-abcdef',
          totalDuration: 300,
          soqlQueries: 5,
          dmlStatements: 2,
          heapUsed: 12000,
          cpuTime: 100,
          issues: [],
        },
      ],
      topIssues: [],
    };
    render(<ApexInsightsPanel />);

    expect(screen.getByTestId('apex-insights-panel')).toBeDefined();
    expect(screen.getByText('No performance issues detected')).toBeDefined();
  });
});

describe('ApexInsightsPanel SOQL bars', () => {
  beforeEach(() => {
    mockLoading = false;
    useOrgStore.setState({ selectedOrgId: 'org-1', orgs: [] });
  });

  it('names each SOQL bar after the log on its row', () => {
    mockData = {
      success: true,
      analyses: [
        {
          logId: 'log-001-abcdef',
          totalDuration: 1200,
          soqlQueries: 45,
          dmlStatements: 12,
          heapUsed: 65000,
          cpuTime: 800,
          issues: [],
        },
      ],
      topIssues: [],
    };
    render(<ApexInsightsPanel />);
    expect(screen.getByRole('progressbar', { name: 'SOQL queries, log log-001-' })).toBeDefined();
  });
});

describe('ApexInsightsPanel list bound', () => {
  beforeEach(() => {
    mockLoading = false;
    useOrgStore.setState({ selectedOrgId: 'org-1', orgs: [] });
  });

  const analysis = {
    logId: 'log-001-abcdef',
    totalDuration: 1200,
    soqlQueries: 45,
    dmlStatements: 12,
    heapUsed: 65000,
    cpuTime: 800,
    issues: [],
  };

  it('says the analysis covers the most recent logs only when older ones were left unread', () => {
    mockData = { success: true, analyses: [analysis], topIssues: [], truncated: true };
    render(<ApexInsightsPanel />);

    expect(screen.getByTestId('apex-insights-list-cap').textContent).toBe(
      'Only the 1 most recent are read here: the list and its counts stop there.',
    );
  });

  it('says nothing of a bound when every log was analysed', () => {
    mockData = { success: true, analyses: [analysis], topIssues: [], truncated: false };
    render(<ApexInsightsPanel />);

    expect(screen.queryByTestId('apex-insights-list-cap')).toBeNull();
  });
});
