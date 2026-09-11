import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { useNotificationStore, resetNotificationCounter } from '../../stores/useNotificationStore';
import { MonitorPage } from './MonitorPage';
import type { SalesforceOrg } from '@sandforge/shared';

const mockNavigate = vi.fn();
vi.mock('../../stores/useAppStore', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ navigate: mockNavigate, currentRoute: 'monitor' }),
}));

/* Mock recharts ResponsiveContainer for TrendCharts and TrendChart */
vi.mock('recharts', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="responsive-container" style={{ width: 400, height: 200 }}>
        {children}
      </div>
    ),
  };
});

/* ------------------------------------------------------------------ */
/* Mock bridge hooks                                                   */
/* ------------------------------------------------------------------ */
const mockRefetch = vi.fn();
const mockAbortMutate = vi.fn();
const mockAbortReset = vi.fn();

/** Mutable query state — tests mutate this before rendering. */
let mockMonitorQueryState = {
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  refetch: mockRefetch,
};

/** Mutable abort mutation state. */
let mockAbortMutationState = {
  mutate: mockAbortMutate,
  data: null as { success: boolean } | null,
  loading: false,
  error: null as string | null,
  reset: mockAbortReset,
};

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => {
    if (type === 'monitor:refresh') {
      return mockMonitorQueryState;
    }
    // AlertsPanel query — return empty alerts by default
    if (type === 'monitor:alerts') {
      return { data: { alerts: [] }, loading: false, error: null, refetch: vi.fn() };
    }
    // New panels — return empty data by default
    if (type === 'monitor:storage') {
      return {
        data: { success: true, objects: [], totalRecords: 0 },
        loading: false,
        error: null,
        refetch: vi.fn(),
      };
    }
    if (type === 'monitor:deployments') {
      return {
        data: { success: true, deployments: [] },
        loading: false,
        error: null,
        refetch: vi.fn(),
      };
    }
    if (type === 'monitor:api-usage') {
      return {
        data: { success: true, categories: [] },
        loading: false,
        error: null,
        refetch: vi.fn(),
      };
    }
    return { data: null, loading: false, error: null, refetch: vi.fn() };
  },
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) => {
    if (type === 'monitor:abort-job') {
      return mockAbortMutationState;
    }
    // AlertsPanel mutations
    return { mutate: vi.fn(), data: null, loading: false, error: null, reset: vi.fn() };
  },
}));

/** Helper to create a mock SalesforceOrg. */
function createMockOrg(overrides: Partial<SalesforceOrg> = {}): SalesforceOrg {
  return {
    id: 'org-1',
    alias: 'DevSandbox',
    username: 'admin@dev.sandbox',
    instanceUrl: 'https://dev-sandbox.salesforce.com',
    orgId: '00D000000000001',
    orgType: 'Sandbox',
    authMethod: 'oauth',
    safetyTier: 'low',
    appearance: { color: '#3B82F6', icon: 'cloud' },
    metadata: { apiVersion: '59.0', features: [], lastRefreshed: '2024-01-01T00:00:00Z' },
    status: 'connected',
    lastConnected: '2024-01-01T00:00:00Z',
    tags: [],
    ...overrides,
  } as SalesforceOrg;
}

/** Standard monitor:data payload for tests. */
const standardMonitorPayload = {
  limits: [
    { name: 'DailyApiRequests', max: 15000, remaining: 2550, usedPercent: 83 },
    { name: 'DataStorageMB', max: 5120, remaining: 1843, usedPercent: 64 },
    { name: 'DailyAsyncApexExecutions', max: 50000, remaining: 41100, usedPercent: 18 },
    { name: 'HourlyTimeBasedWorkflow', max: 500, remaining: 480, usedPercent: 4 },
  ],
  jobs: [
    {
      id: 'job-1',
      jobType: 'Bulk Query',
      status: 'Completed',
      objectType: 'Account',
      createdBy: 'admin@dev.sandbox',
      createdDate: '2024-01-01T12:00:00Z',
      totalRecords: 5000,
      processedRecords: 5000,
      failedRecords: 0,
    },
    {
      id: 'job-2',
      jobType: 'Bulk Upsert',
      status: 'Processing',
      objectType: 'Contact',
      createdBy: 'admin@dev.sandbox',
      createdDate: '2024-01-01T12:15:00Z',
      totalRecords: 10000,
      processedRecords: 3500,
      failedRecords: 12,
    },
  ],
  healthScore: 78,
  lastUpdated: new Date().toISOString(),
};

describe('MonitorPage', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useOrgStore.setState({ selectedOrgId: null, orgs: [] });
    resetNotificationCounter();
    useNotificationStore.setState({ notifications: [] });
    mockRefetch.mockClear();
    mockAbortMutate.mockClear();
    mockAbortReset.mockClear();
    // Reset to default idle state
    mockMonitorQueryState = {
      data: null,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    mockAbortMutationState = {
      mutate: mockAbortMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockAbortReset,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 1. Empty state (no org selected)
  it('should show EmptyState with module illustration when zero orgs', () => {
    render(<MonitorPage />);
    expect(screen.getByTestId('empty-state')).toBeDefined();
    expect(screen.getByTestId('illustration-monitor')).toBeDefined();
    expect(screen.getByTestId('empty-action-button')).toBeDefined();
  });

  it('should show the monitoring journey steps and connect CTA when zero orgs', () => {
    render(<MonitorPage />);
    expect(screen.getByText('Keep an eye on your org health')).toBeDefined();
    expect(screen.getByTestId('empty-step-0').textContent).toContain(
      'Connect an org via SFDX import',
    );
    expect(screen.getByTestId('empty-step-1').textContent).toContain('Pick the org to watch');
    expect(screen.getByTestId('empty-action-button').textContent).toBe('Connect an Org');
  });

  it('should show org selector empty state when orgs exist but none selected', () => {
    useOrgStore.setState({
      selectedOrgId: null,
      orgs: [createMockOrg({ status: 'connected' })],
    });
    render(<MonitorPage />);
    expect(screen.getByTestId('monitor-empty')).toBeDefined();
    expect(screen.getByText('Select an org to monitor')).toBeDefined();
  });

  it('should show org selector in empty state when orgs exist', () => {
    useOrgStore.setState({
      selectedOrgId: null,
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);
    expect(screen.getByTestId('monitor-empty')).toBeDefined();
    expect(screen.getByText('DevSandbox')).toBeDefined();
  });

  // 2. Loading state
  it('should show skeleton loading when org is selected and no data yet', () => {
    mockMonitorQueryState = {
      data: null,
      loading: true,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);
    expect(screen.getByTestId('monitor-loading')).toBeDefined();
    const skeletons = screen.getAllByTestId('skeleton');
    expect(skeletons.length).toBeGreaterThanOrEqual(4);
  });

  it('should render SkeletonTable and SkeletonPanel during loading', () => {
    mockMonitorQueryState = {
      data: null,
      loading: true,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);
    expect(screen.getByTestId('skeleton-table')).toBeDefined();
    expect(screen.getAllByTestId('skeleton-panel-section').length).toBeGreaterThanOrEqual(2);
  });

  // 3. Dashboard render with KPI row layout
  it('should render the monitor page with bento layout after receiving data', () => {
    mockMonitorQueryState = {
      data: standardMonitorPayload,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    expect(screen.getByTestId('monitor-page')).toBeDefined();
    // Header shows org name and refresh button
    expect(screen.getByText('DevSandbox')).toBeDefined();
    expect(screen.getByTestId('refresh-btn')).toBeDefined();
    // KPI row is rendered
    expect(screen.getByTestId('kpi-row')).toBeDefined();
  });

  it('should show the last updated timestamp', () => {
    mockMonitorQueryState = {
      data: standardMonitorPayload,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    // The lastUpdatedStr is rendered as a text span (e.g., "0s ago")
    expect(screen.getByText(/ago/)).toBeDefined();
  });

  // 4. Bento Row 1: HealthGauge + KPI cards + Alerts count
  it('should render health gauge in bento row 1', () => {
    mockMonitorQueryState = {
      data: standardMonitorPayload,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    expect(screen.getByTestId('health-gauge')).toBeDefined();
    expect(screen.getByText('78')).toBeDefined();
  });

  it('should render KPI row with health, API, storage, and alerts tiles', () => {
    mockMonitorQueryState = {
      data: standardMonitorPayload,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    const kpiRow = screen.getByTestId('kpi-row');
    expect(kpiRow).toBeDefined();
    // KPI row contains 5 child tiles (health, api, data storage, file storage, alerts)
    expect(kpiRow.children.length).toBe(5);
  });

  it('should render alerts KPI in bento row 1', () => {
    mockMonitorQueryState = {
      data: standardMonitorPayload,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    // Alerts KPI shows the "Alerts" label text and count value
    expect(screen.getByText('Alerts')).toBeDefined();
    expect(screen.getByText('alert(s)')).toBeDefined();
  });

  it('should display correct API Calls KPI values', () => {
    mockMonitorQueryState = {
      data: standardMonitorPayload,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    // API Calls: used = 15000 - 2550 = 12,450
    // The KPI row renders the value and subtitle in the KPIStat component
    expect(screen.getByText('API Calls Today')).toBeDefined();
    expect(screen.getByText(/12[,\s ]?450/)).toBeDefined();
    expect(screen.getByText(/\/\s?15[,\s ]?000/)).toBeDefined();
  });

  it('should still render dashboard with spinner when refreshing with existing data', () => {
    mockMonitorQueryState = {
      data: standardMonitorPayload,
      loading: true,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    // When loading with existing data (lastUpdated present), it renders the dashboard, not skeletons.
    // The refresh button shows a spinning icon.
    expect(screen.getByTestId('monitor-page')).toBeDefined();
    expect(screen.getByTestId('refresh-btn')).toBeDefined();
  });

  // 5. Trends + Jobs columns
  it('should render the trends and jobs sections', () => {
    mockMonitorQueryState = {
      data: standardMonitorPayload,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    // Trends section header and no-data fallback message
    expect(screen.getByText('Trends')).toBeDefined();
    // Jobs section header
    expect(screen.getByText('Jobs')).toBeDefined();
  });

  // 6. Governor Limits section (collapsed by default, expand to see rows)
  it('should render the Governor Limits section and show data when expanded', () => {
    mockMonitorQueryState = {
      data: standardMonitorPayload,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    // Governor Limits header is visible
    expect(screen.getByText('Governor Limits')).toBeDefined();

    // Limits are collapsed by default -- expand via the toggle
    const limitsHeader = screen.getByText('Governor Limits');
    const toggleButton = limitsHeader.parentElement?.querySelector('button');
    expect(toggleButton).toBeDefined();
    fireEvent.click(toggleButton!);

    // Now limit names should be visible
    expect(screen.getByText('DailyApiRequests')).toBeDefined();
    expect(screen.getByText('DataStorageMB')).toBeDefined();
    expect(screen.getByText('HourlyTimeBasedWorkflow')).toBeDefined();
  });

  it('should show percentage badges in limits section when expanded', () => {
    mockMonitorQueryState = {
      data: standardMonitorPayload,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    // Expand the limits section
    const limitsHeader = screen.getByText('Governor Limits');
    const toggleButton = limitsHeader.parentElement?.querySelector('button');
    fireEvent.click(toggleButton!);

    // Percentages are rendered in badges: 83%, 64%, 18%, 4%
    expect(screen.getByText('83%')).toBeDefined();
    expect(screen.getByText('64%')).toBeDefined();
    expect(screen.getByText('18%')).toBeDefined();
    expect(screen.getByText('4%')).toBeDefined();
  });

  // 7. PredictionsTile (only renders when trends have predictedTimeToLimit)
  it('should render the predictions tile when trends have predictions', () => {
    const payloadWithPredictions = {
      ...standardMonitorPayload,
      trends: {
        DailyApiRequests: {
          sparklineData: [10, 20, 30],
          predictedTimeToLimit: 5,
        },
      },
    };
    mockMonitorQueryState = {
      data: payloadWithPredictions,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    expect(screen.getByTestId('predictions-tile')).toBeDefined();
  });

  // 8. Jobs Table (grouped by job type)
  it('should render the JobsTable with grouped job data', () => {
    mockMonitorQueryState = {
      data: standardMonitorPayload,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    expect(screen.getByTestId('job-group-Bulk Query')).toBeDefined();
    expect(screen.getByTestId('job-group-Bulk Upsert')).toBeDefined();
    expect(screen.getByTestId('job-filters')).toBeDefined();
  });

  it('should show job details when group is expanded', () => {
    mockMonitorQueryState = {
      data: standardMonitorPayload,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    fireEvent.click(screen.getByTestId('group-toggle-Bulk Query'));
    expect(screen.getByText('Account')).toBeDefined();
    expect(screen.getByTestId('job-row-job-1')).toBeDefined();
  });

  it('should show job progress with error count when expanded', () => {
    mockMonitorQueryState = {
      data: standardMonitorPayload,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    fireEvent.click(screen.getByTestId('group-toggle-Bulk Upsert'));
    expect(screen.getByText('(12 err)')).toBeDefined();
  });

  // 9. Refresh button
  it('should call refetch when refresh button is clicked', () => {
    mockMonitorQueryState = {
      data: standardMonitorPayload,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    mockRefetch.mockClear();
    fireEvent.click(screen.getByTestId('refresh-btn'));
    expect(mockRefetch).toHaveBeenCalledOnce();
  });

  // 10. Error handling
  it('should show error retry banner on query error and add a notification', () => {
    mockMonitorQueryState = {
      data: standardMonitorPayload,
      loading: false,
      error: 'Connection timeout',
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    expect(screen.getByTestId('monitor-error')).toBeDefined();
    // Error retry banner shows generic message, not raw error text
    expect(screen.getByText('Failed to refresh dashboard data')).toBeDefined();
    expect(screen.getByTestId('error-retry-btn')).toBeDefined();
    expect(screen.getByTestId('error-details-btn')).toBeDefined();
    expect(screen.getByTestId('monitor-page')).toBeDefined();

    const notifications = useNotificationStore.getState().notifications;
    expect(notifications.length).toBe(1);
    expect(notifications[0].level).toBe('error');
    expect(notifications[0].message).toBe('Connection timeout');
  });

  it('should show loading state when loading with no data', () => {
    mockMonitorQueryState = {
      data: null,
      loading: true,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    expect(screen.getByTestId('monitor-loading')).toBeDefined();
  });

  it('should dismiss the error banner when error is cleared on rerender', () => {
    mockMonitorQueryState = {
      data: standardMonitorPayload,
      loading: false,
      error: 'Transient error',
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    const { rerender } = render(<MonitorPage />);

    expect(screen.getByTestId('monitor-error')).toBeDefined();
    // Error retry banner shows generic message
    expect(screen.getByText('Failed to refresh dashboard data')).toBeDefined();

    // When the error clears on next query cycle, banner disappears
    mockMonitorQueryState = {
      data: standardMonitorPayload,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    rerender(<MonitorPage />);
    expect(screen.queryByTestId('monitor-error')).toBeNull();
  });

  // 11. Org selector change via store (header shows current org, no inline selector)
  it('should change org via store and show the selected org name', () => {
    mockMonitorQueryState = {
      data: standardMonitorPayload,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    const org1 = createMockOrg({ id: 'org-1', alias: 'DevSandbox' });
    const org2 = createMockOrg({ id: 'org-2', alias: 'QASandbox' });
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [org1, org2],
    });
    const { rerender } = render(<MonitorPage />);

    expect(screen.getByText('DevSandbox')).toBeDefined();

    // Simulate switching org via store
    useOrgStore.setState({ selectedOrgId: 'org-2' });
    rerender(<MonitorPage />);
    expect(screen.getByText('QASandbox')).toBeDefined();
    expect(useOrgStore.getState().selectedOrgId).toBe('org-2');
  });

  // 12. Auto-refresh toggle
  it('should toggle auto-refresh on and off', () => {
    mockMonitorQueryState = {
      data: standardMonitorPayload,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    const toggleBtn = screen.getByTestId('auto-refresh-toggle');
    // Initially uses ghost variant (not active)
    expect(toggleBtn.className).toContain('bg-transparent');

    // Click to enable — switches to primary variant
    fireEvent.click(toggleBtn);
    expect(toggleBtn.className).not.toContain('bg-transparent');

    // Click again to disable — back to ghost
    fireEvent.click(toggleBtn);
    expect(toggleBtn.className).toContain('bg-transparent');
  });

  it('should auto-refresh every 30 seconds when enabled', () => {
    mockMonitorQueryState = {
      data: standardMonitorPayload,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    mockRefetch.mockClear();

    fireEvent.click(screen.getByTestId('auto-refresh-toggle'));

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(mockRefetch).toHaveBeenCalled();

    mockRefetch.mockClear();
    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(mockRefetch).toHaveBeenCalled();
  });

  it('should show org identity in header when org is selected', () => {
    mockMonitorQueryState = {
      data: standardMonitorPayload,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    // Header shows the org alias and org type badge
    expect(screen.getByText('DevSandbox')).toBeDefined();
    expect(screen.getByText('SANDBOX')).toBeDefined();
  });

  it('should render HealthScoreCard when healthReport is present in payload', () => {
    const healthReport = {
      overallScore: 75,
      overallStatus: 'healthy' as const,
      factors: [
        {
          name: 'DailyApiRequests',
          category: 'limits' as const,
          score: 50,
          weight: 0.2,
          status: 'warning' as const,
          detail: '80% used',
          recommendation: 'Review batch jobs.',
          trend: 'stable' as const,
        },
        {
          name: 'DataStorageMB',
          category: 'storage' as const,
          score: 100,
          weight: 0.2,
          status: 'healthy' as const,
          detail: '20% used',
          recommendation: 'No action needed.',
          trend: 'stable' as const,
        },
      ],
      summary: 'Your org is healthy but DailyApiRequests is trending up.',
      topRisks: [
        {
          name: 'DailyApiRequests',
          category: 'limits' as const,
          score: 50,
          weight: 0.2,
          status: 'warning' as const,
          detail: '80% used',
          recommendation: 'Review batch jobs.',
          trend: 'stable' as const,
        },
      ],
    };

    mockMonitorQueryState = {
      data: { ...standardMonitorPayload, healthReport },
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    expect(screen.getByTestId('health-score-card')).toBeDefined();
    expect(screen.getByTestId('health-summary')).toBeDefined();
    expect(screen.getByText(healthReport.summary)).toBeDefined();
  });

  it('should render OrgInfoPanel when orgInfo is present in payload', () => {
    const orgInfo = {
      name: 'Acme Corp',
      orgId: '00D000000000001',
      type: 'Sandbox' as const,
      edition: 'Enterprise Edition',
      instanceName: 'NA100',
      apiVersion: '60.0',
      userCount: 150,
      customObjectCount: 45,
      apexClassCount: 230,
      flowCount: 18,
      lastLoginDate: '2026-02-24T09:00:00Z',
    };

    mockMonitorQueryState = {
      data: { ...standardMonitorPayload, orgInfo },
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    expect(screen.getByTestId('org-info-panel')).toBeDefined();
    // The panel shows org name as h3 and orgId as monospace span
    expect(screen.getByText('Acme Corp')).toBeDefined();
    expect(screen.getByText('00D000000000001')).toBeDefined();
    // Edition and instance are shown in the grid
    expect(screen.getByText('Enterprise Edition')).toBeDefined();
    expect(screen.getByText('NA100')).toBeDefined();
  });

  // ── Dashboard Refresh UX (05-02) ──

  it('should show panel overlays when refreshing with existing data', () => {
    mockMonitorQueryState = {
      data: standardMonitorPayload,
      loading: true,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    // Panel overlays should be visible during refresh
    const overlays = screen.getAllByTestId('panel-overlay');
    expect(overlays.length).toBeGreaterThanOrEqual(1);
    // Dashboard content is still visible (not replaced by skeletons)
    expect(screen.getByTestId('monitor-page')).toBeDefined();
    expect(screen.getByTestId('kpi-row')).toBeDefined();
  });

  it('should show error retry banner with Retry and Details buttons on error', () => {
    mockMonitorQueryState = {
      data: standardMonitorPayload,
      loading: false,
      error: 'Connection timeout',
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    expect(screen.getByTestId('monitor-error')).toBeDefined();
    expect(screen.getByTestId('error-retry-btn')).toBeDefined();
    expect(screen.getByTestId('error-details-btn')).toBeDefined();
    expect(screen.getByText('Failed to refresh dashboard data')).toBeDefined();
  });

  it('should call retryFailed when Retry button is clicked in error banner', () => {
    mockMonitorQueryState = {
      data: standardMonitorPayload,
      loading: false,
      error: 'Server error',
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    mockRefetch.mockClear();
    fireEvent.click(screen.getByTestId('error-retry-btn'));
    expect(mockRefetch).toHaveBeenCalled();
  });

  it('should show stale data indicator when data exceeds 2 minutes', () => {
    const twoMinutesAgo = new Date(Date.now() - 130_000).toISOString();
    mockMonitorQueryState = {
      data: { ...standardMonitorPayload, lastUpdated: twoMinutesAgo },
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    expect(screen.getByTestId('stale-data-indicator')).toBeDefined();
    expect(screen.getByTestId('stale-data-badge')).toBeDefined();
  });

  it('should trigger refresh when stale data badge is clicked', () => {
    const twoMinutesAgo = new Date(Date.now() - 130_000).toISOString();
    mockMonitorQueryState = {
      data: { ...standardMonitorPayload, lastUpdated: twoMinutesAgo },
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    mockRefetch.mockClear();
    fireEvent.click(screen.getByTestId('stale-data-badge'));
    expect(mockRefetch).toHaveBeenCalled();
  });

  it('should not show stale data indicator when data is fresh', () => {
    mockMonitorQueryState = {
      data: standardMonitorPayload,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    expect(screen.queryByTestId('stale-data-indicator')).toBeNull();
  });

  it('should render with empty limits and jobs gracefully', () => {
    mockMonitorQueryState = {
      data: {
        limits: [],
        jobs: [],
        healthScore: 0,
        lastUpdated: new Date().toISOString(),
      },
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    expect(screen.getByTestId('monitor-page')).toBeDefined();
    expect(screen.getByTestId('health-gauge')).toBeDefined();
    const zeroElements = screen.getAllByText('0');
    expect(zeroElements.length).toBeGreaterThanOrEqual(1);
  });

  // 13. New panels integration
  it('should render StorageBreakdownPanel in dashboard', () => {
    mockMonitorQueryState = {
      data: standardMonitorPayload,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    // StorageBreakdownPanel renders its empty state by default
    expect(screen.getByTestId('storage-panel-empty')).toBeDefined();
  });

  it('should render DeploymentTimeline in dashboard', () => {
    mockMonitorQueryState = {
      data: standardMonitorPayload,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    // DeploymentTimeline renders its container
    expect(screen.getByTestId('deployment-timeline')).toBeDefined();
  });

  it('should render ApiUsagePanel in dashboard', () => {
    mockMonitorQueryState = {
      data: standardMonitorPayload,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    // ApiUsagePanel renders its empty state by default
    expect(screen.getByTestId('api-usage-panel-empty')).toBeDefined();
  });

  it('should render LimitExportButton in Trends section', () => {
    mockMonitorQueryState = {
      data: standardMonitorPayload,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({
      selectedOrgId: 'org-1',
      orgs: [createMockOrg()],
    });
    render(<MonitorPage />);

    expect(screen.getByTestId('limit-export-btn')).toBeDefined();
    expect(screen.getByText('Export CSV')).toBeDefined();
  });

  /* ---------------------------------------------------------------- */
  /* Job insights — every state told apart                             */
  /* ---------------------------------------------------------------- */

  // An empty band is the trap: "scanned, nothing wrong", "nothing ran" and
  // "nothing received" look identical when all three render zero rows. The
  // page says which one it is, and an abort is never a single click.

  /** A stall the extension proved: the batch counter did not move in an hour of watching. */
  const stalledInsight = {
    type: 'stuck',
    severity: 'critical',
    title: 'BatchApex job-2: no batch completed in 1h05m',
    detail: '3 of 10 batches processed, unchanged across 1h05m of observation.',
    affectedJobs: ['job-2'],
    recommendation: 'Check the job in Setup, then abort it if it is still at the same batch.',
  };

  /** Old but unproven: a warning, never an abort. */
  const unfinishedInsight = {
    type: 'long_running',
    severity: 'warning',
    title: '1 job unfinished 3h10m after submission',
    detail: 'Queueable job-1 is Processing; this job type reports no progress.',
    affectedJobs: ['job-1'],
    recommendation: 'Keep watching.',
  };

  function renderWithInsights(jobInsights: unknown[]): void {
    mockMonitorQueryState = {
      data: { ...standardMonitorPayload, jobInsights },
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({ selectedOrgId: 'org-1', orgs: [createMockOrg()] });
    render(<MonitorPage />);
  }

  function clickBandAbort(): void {
    const row = screen.getByTestId('monitor-job-insight-critical');
    fireEvent.click(within(row).getByRole('button', { name: 'Abort Job' }));
  }

  it('says there was nothing to scan when the org ran no jobs', () => {
    mockMonitorQueryState = {
      data: { ...standardMonitorPayload, jobs: [], jobInsights: [] },
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({ selectedOrgId: 'org-1', orgs: [createMockOrg()] });
    render(<MonitorPage />);

    const idle = screen.getByTestId('monitor-job-insights-idle');
    expect(within(idle).getByText('No recent jobs')).toBeDefined();
    // Nothing ran is not the same claim as nothing is wrong.
    expect(within(idle).queryByText('No performance issues detected')).toBeNull();
    expect(screen.queryByTestId('monitor-job-insights-clear')).toBeNull();
    expect(screen.queryByTestId('monitor-job-insights-unknown')).toBeNull();
    expect(screen.queryByTestId('monitor-job-insights')).toBeNull();
  });

  it('says nothing is known, not that no job ran, when no payload ever arrived', () => {
    mockMonitorQueryState = {
      data: null,
      loading: false,
      error: 'INVALID_SESSION_ID',
      refetch: mockRefetch,
    };
    useOrgStore.setState({ selectedOrgId: 'org-1', orgs: [createMockOrg()] });
    render(<MonitorPage />);

    expect(screen.getByTestId('monitor-error')).toBeDefined();
    const unknown = screen.getByTestId('monitor-job-insights-unknown');
    expect(within(unknown).getByText('No data available')).toBeDefined();
    expect(within(unknown).queryByText('No recent jobs')).toBeNull();
    expect(screen.queryByTestId('monitor-job-insights-idle')).toBeNull();
    expect(screen.queryByTestId('monitor-job-insights-clear')).toBeNull();
  });

  it('does not read a payload that carries no verdict as a clean scan', () => {
    // standardMonitorPayload has jobs but no jobInsights field.
    mockMonitorQueryState = {
      data: { ...standardMonitorPayload },
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    useOrgStore.setState({ selectedOrgId: 'org-1', orgs: [createMockOrg()] });
    render(<MonitorPage />);

    const unknown = screen.getByTestId('monitor-job-insights-unknown');
    expect(within(unknown).getByText('No data available')).toBeDefined();
    expect(screen.queryByTestId('monitor-job-insights-clear')).toBeNull();
    expect(screen.queryByTestId('monitor-job-insights')).toBeNull();
  });

  // Silence has to be earned out loud: the clear line names how many jobs the
  // verdict covers.
  it('says the scan found nothing wrong, and over how many jobs', () => {
    renderWithInsights([]);

    const clear = screen.getByTestId('monitor-job-insights-clear');
    // standardMonitorPayload carries two jobs: the denominator is printed.
    expect(clear.textContent).toContain('2');
    expect(within(clear).getByText('No performance issues detected')).toBeDefined();
    expect(screen.queryByTestId('monitor-job-insights-idle')).toBeNull();
    expect(screen.queryByTestId('monitor-job-insights-unknown')).toBeNull();
    expect(screen.queryByTestId('monitor-job-insights')).toBeNull();
  });

  // A warning is not an emergency, and not an all-clear either.
  it('shows an unfinished-job warning without an abort, and never the clear verdict', () => {
    renderWithInsights([unfinishedInsight]);

    const warning = screen.getByTestId('monitor-job-insight-warning');
    expect(within(warning).getByText(unfinishedInsight.title)).toBeDefined();
    expect(within(warning).queryByRole('button')).toBeNull();
    expect(screen.queryByTestId('monitor-job-insight-critical')).toBeNull();
    expect(screen.queryByTestId('monitor-job-insights-clear')).toBeNull();
  });

  it('bands critical insights in red, with an Abort only on a proven stall', () => {
    const repeatedFailures = {
      type: 'frequent_failures',
      severity: 'critical',
      title: '3 BatchApex jobs failed',
      detail: '3 of the last 20 jobs are BatchApex failures.',
      affectedJobs: ['job-1'],
      recommendation: 'Read the most recent failure.',
    };
    renderWithInsights([stalledInsight, repeatedFailures, unfinishedInsight]);

    const criticalRows = screen.getAllByTestId('monitor-job-insight-critical');
    expect(criticalRows).toHaveLength(2);
    const stallRow = criticalRows.find((row) => row.textContent?.includes(stalledInsight.title));
    const failureRow = criticalRows.find((row) =>
      row.textContent?.includes(repeatedFailures.title),
    );
    expect(within(stallRow!).getByRole('button', { name: 'Abort Job' })).toBeDefined();
    // Failed jobs are already finished: there is nothing to abort.
    expect(within(failureRow!).queryByRole('button')).toBeNull();
    const warningRow = screen.getByTestId('monitor-job-insight-warning');
    expect(within(warningRow).queryByRole('button')).toBeNull();
    expect(screen.queryByTestId('monitor-job-insights-clear')).toBeNull();
    expect(screen.queryByTestId('monitor-job-insights-idle')).toBeNull();
  });

  it('neither bands an info insight nor lets it hide the clear verdict', () => {
    renderWithInsights([
      {
        type: 'high_consumer',
        severity: 'info',
        title: 'Heavy job',
        detail: 'Reads many rows',
        affectedJobs: ['job-1'],
        recommendation: 'None',
      },
    ]);

    expect(screen.getByTestId('monitor-job-insights-clear')).toBeDefined();
    expect(screen.queryByText('Heavy job')).toBeNull();
  });

  it('opens a typed confirmation on Abort and sends nothing on the click', () => {
    renderWithInsights([stalledInsight]);

    clickBandAbort();

    const dialog = screen.getByRole('dialog');
    // The confirmation names the job and repeats the evidence it rests on.
    expect(dialog.textContent).toContain('job-2');
    expect(dialog.textContent).toContain(stalledInsight.detail);
    expect((screen.getByTestId('danger-confirm-btn') as HTMLButtonElement).disabled).toBe(true);
    expect(mockAbortMutate).not.toHaveBeenCalled();
  });

  it('aborts the named job only once the confirmation text is typed and confirmed', () => {
    renderWithInsights([stalledInsight]);

    clickBandAbort();
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'Abort Job' } });
    expect(mockAbortMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));

    expect(mockAbortMutate).toHaveBeenCalledTimes(1);
    expect(mockAbortMutate).toHaveBeenCalledWith({ orgId: 'org-1', jobId: 'job-2' });
  });

  it('sends nothing when the confirmation is cancelled', () => {
    renderWithInsights([stalledInsight]);

    clickBandAbort();
    fireEvent.click(within(screen.getByRole('dialog')).getByText('Cancel'));

    expect(mockAbortMutate).not.toHaveBeenCalled();
  });
});
