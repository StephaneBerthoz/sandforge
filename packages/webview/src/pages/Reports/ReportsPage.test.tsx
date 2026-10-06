import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { ReportsPage } from './ReportsPage';
import type { GeneratedReport, AuditLogEntry, DataLineageGraph } from '@sandforge/shared';
import type { AnalyticsSummary } from './AnalyticsDashboard';

/* Mock ReactFlow */
vi.mock('@xyflow/react', () => ({
  __esModule: true,
  ReactFlow: ({ nodes, edges }: { nodes: unknown[]; edges: unknown[] }) => (
    <div data-testid="mock-reactflow" data-nodes={nodes.length} data-edges={edges.length} />
  ),
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
}));

/* Mock Recharts */
vi.mock('recharts', () => ({
  BarChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="mock-barchart">{children}</div>
  ),
  Bar: () => <div />,
  XAxis: () => <div />,
  YAxis: () => <div />,
  Tooltip: () => <div />,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="mock-linechart">{children}</div>
  ),
  Line: () => <div />,
  CartesianGrid: () => <div />,
}));

/*
 * No bridge-hook mocks: the page is presentational, and ReportsContainer is
 * what talks to the host. The page sending anything itself is what the
 * `reportsChannelsSent` assertions below catch.
 */
const mockPostMessage = vi.fn();
vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
  getVscodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

/** Outbound message types the page produced, envelope-unwrapped. */
function reportsChannelsSent(): string[] {
  return mockPostMessage.mock.calls
    .map((call: unknown[]) => (call[0] as { payload?: { type?: string } })?.payload?.type)
    .filter((type): type is string => typeof type === 'string' && type.startsWith('reports:'));
}

const reports: GeneratedReport[] = [
  {
    id: 'rpt-1',
    definitionId: 'def-1',
    type: 'seed_execution',
    title: 'Seed Report',
    summary: '500 records',
    sections: [],
    metadata: { module: 'seed' },
    generatedAt: '2026-02-20T10:00:00Z',
  },
];

const summary: AnalyticsSummary = {
  totalOperations: 100,
  successRate: 95.0,
  avgDuration: 5000,
  errorRate: 5.0,
};

const auditEntries: AuditLogEntry[] = [
  {
    id: 'aud-1',
    action: 'seed_execute',
    module: 'seed',
    details: {},
    timestamp: '2026-02-20T10:00:00Z',
  },
];

const lineageData: DataLineageGraph = {
  nodes: [
    { id: 'n1', type: 'source', label: 'Source' },
    { id: 'n2', type: 'destination', label: 'Dest' },
  ],
  edges: [{ sourceId: 'n1', targetId: 'n2' }],
  operationId: 'op-1',
  generatedAt: '2026-02-20T10:00:00Z',
};

describe('ReportsPage', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
  });

  it('should render the page', () => {
    render(<ReportsPage />);
    expect(screen.getByTestId('reports-page')).toBeDefined();
  });

  it('should show page title', () => {
    render(<ReportsPage />);
    expect(screen.getByText('Reports & Analytics')).toBeDefined();
  });

  it('should show a tab for each producer', () => {
    render(
      <ReportsPage
        reports={reports}
        analyticsSummary={summary}
        auditEntries={auditEntries}
        lineageData={lineageData}
      />,
    );
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Executions',
      'Analytics',
      'Audit Trail',
      'Data Lineage',
    ]);
  });

  it('should show executions tab by default', () => {
    render(<ReportsPage reports={reports} />);
    expect(screen.getByTestId('execution-report-view')).toBeDefined();
  });

  it('should switch to analytics tab', () => {
    render(<ReportsPage analyticsSummary={summary} />);
    fireEvent.click(screen.getByText('Analytics'));
    expect(screen.getByTestId('analytics-dashboard')).toBeDefined();
  });

  it('should switch to audit tab', () => {
    render(<ReportsPage auditEntries={auditEntries} />);
    fireEvent.click(screen.getByText('Audit Trail'));
    expect(screen.getByTestId('audit-trail-viewer')).toBeDefined();
  });

  it('should switch to lineage tab', () => {
    render(<ReportsPage lineageData={lineageData} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Data Lineage' }));
    expect(screen.getByTestId('lineage-graph')).toBeDefined();
  });

  it('should call onSelectReport', () => {
    const onSelect = vi.fn();
    render(<ReportsPage reports={reports} onSelectReport={onSelect} />);
    const wrapper = screen.getByTestId('report-rpt-1');
    fireEvent.click(wrapper.querySelector('[role="button"]')!);
    expect(onSelect).toHaveBeenCalledWith('rpt-1');
  });

  it('should call onExportReport without touching the bridge', () => {
    const onExport = vi.fn();
    render(<ReportsPage reports={reports} onExportReport={onExport} />);
    /* Select the report first */
    const wrapper = screen.getByTestId('report-rpt-1');
    fireEvent.click(wrapper.querySelector('[role="button"]')!);
    fireEvent.click(screen.getByTestId('export-report-btn'));
    expect(onExport).toHaveBeenCalledWith('rpt-1');
    /* `reports:export` is declared nowhere — sending it would only time out. */
    expect(reportsChannelsSent()).toEqual([]);
  });

  it('should send no message on mount', () => {
    render(<ReportsPage />);
    expect(reportsChannelsSent()).toEqual([]);
  });

  /*
   * The page with no producer at all. Four tiles reading 0 / 0 / 0.0 % / 0
   * are not an empty state — nothing produced them, and "0.0 % success" in
   * amber reads as a failing org rather than as an absent feature.
   */
  describe('with no data source', () => {
    it('should print no KPI figures', () => {
      render(<ReportsPage />);

      expect(screen.queryByTestId('reports-kpi-row')).toBeNull();
      expect(screen.queryAllByTestId('kpi-card')).toHaveLength(0);
      expect(screen.queryByText('0.0%')).toBeNull();
    });

    it('offers no tab, rather than four that say "Coming soon"', () => {
      // A tab with no producer said "Coming soon"; and since an answer not in
      // yet leaves its prop undefined too, every tab of the shipped page said
      // it until the host answered, about features it already had.
      render(<ReportsPage />);

      expect(screen.queryAllByRole('tab')).toHaveLength(0);
      expect(screen.queryByText('Coming soon')).toBeNull();
    });

    it('offers only the tabs a producer feeds, opening on the first of them', () => {
      render(<ReportsPage auditEntries={auditEntries} lineageData={lineageData} />);

      expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
        'Audit Trail',
        'Data Lineage',
      ]);
      expect(screen.getByTestId('audit-trail-viewer')).toBeDefined();
    });
  });

  describe('while a producer reads', () => {
    it('says the executions and analytics tabs are loading, not coming', () => {
      render(<ReportsPage reportsLoading />);

      expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
        'Executions',
        'Analytics',
      ]);
      expect(screen.getByTestId('reports-executions-loading').textContent).toContain('Loading');
      expect(screen.queryByTestId('execution-report-view')).toBeNull();
      fireEvent.click(screen.getByText('Analytics'));
      expect(screen.getByTestId('reports-analytics-loading')).toBeDefined();
      expect(screen.queryByText('Coming soon')).toBeNull();
    });

    it('says the audit trail and the lineage are loading', () => {
      render(<ReportsPage auditLoading lineageLoading />);

      expect(screen.getByTestId('reports-audit-loading')).toBeDefined();
      fireEvent.click(screen.getByRole('tab', { name: 'Data Lineage' }));
      expect(screen.getByTestId('reports-lineage-loading')).toBeDefined();
    });

    it('keeps the tab of a read that failed, to say why', () => {
      render(<ReportsPage auditError="timed out" />);

      expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Audit Trail']);
      expect(screen.getByTestId('reports-audit-error').textContent).toContain('timed out');
    });
  });

  it('should render a measured empty list rather than a loading notice', () => {
    // `[]` is a producer saying "nothing to report"; `undefined` is an answer
    // not in yet, or no producer at all.
    render(<ReportsPage reports={[]} />);

    expect(screen.getByTestId('execution-report-view')).toBeDefined();
    expect(screen.queryByTestId('reports-executions-loading')).toBeNull();
  });

  describe('once the host answers for the audit trail and the lineage', () => {
    it('tells a trail with nothing recorded from a filter that matches nothing', () => {
      // The first is an install before its first write: it says what will
      // appear, and when. The second is the viewer's own "no entries" under
      // the filter that caused it, with the filter still there to change.
      const { unmount } = render(
        <ReportsPage auditEntries={[]} auditTotal={0} auditFacets={{ modules: [], orgs: [] }} />,
      );
      fireEvent.click(screen.getByText('Audit Trail'));
      expect(screen.getByTestId('reports-audit-empty')).toBeDefined();
      unmount();

      render(
        <ReportsPage
          auditEntries={[]}
          auditTotal={0}
          auditFacets={{ modules: ['sync'], orgs: [] }}
          auditFilter={{ module: 'sync' }}
          onAuditFilterChange={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByText('Audit Trail'));
      expect(screen.queryByTestId('reports-audit-empty')).toBeNull();
      expect(screen.getByTestId('audit-filters')).toBeDefined();
      expect(screen.getByText('No audit entries')).toBeDefined();
    });

    it('offers a pick of runs only when more than one is traced', () => {
      const onSelectLineageRun = vi.fn();
      const run = (operationId: string) => ({
        operationId,
        generatedAt: '2026-02-20T10:00:00Z',
        action: 'forge_execute' as const,
        targetLabel: 'target-sandbox',
      });
      const { unmount } = render(
        <ReportsPage
          lineageData={lineageData}
          lineageRuns={[run('op-1')]}
          onSelectLineageRun={onSelectLineageRun}
        />,
      );
      fireEvent.click(screen.getByRole('tab', { name: 'Data Lineage' }));
      expect(screen.queryByTestId('lineage-run')).toBeNull();
      unmount();

      render(
        <ReportsPage
          lineageData={lineageData}
          lineageRuns={[run('op-1'), run('op-0')]}
          onSelectLineageRun={onSelectLineageRun}
        />,
      );
      fireEvent.click(screen.getByRole('tab', { name: 'Data Lineage' }));
      // Each run is named by what it was, where it wrote and when.
      expect(
        screen.getAllByRole('option', { name: 'Forge Clone · target-sandbox · 2026-02-20 10:00' }),
      ).toHaveLength(2);
      fireEvent.change(screen.getByTestId('lineage-run'), { target: { value: 'op-0' } });
      expect(onSelectLineageRun).toHaveBeenCalledWith('op-0');
    });
  });

  it('should render KPI summary row', () => {
    render(
      <ReportsPage reports={reports} analyticsSummary={summary} auditEntries={auditEntries} />,
    );
    expect(screen.getByTestId('reports-kpi-row')).toBeDefined();
    expect(screen.getAllByTestId('kpi-card').length).toBe(4);
  });

  it('should render BentoTile content wrapper', () => {
    render(<ReportsPage />);
    expect(screen.getAllByTestId('bento-tile').length).toBeGreaterThanOrEqual(1);
  });
});
