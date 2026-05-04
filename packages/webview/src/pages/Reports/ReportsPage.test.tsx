import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { ReportsPage } from './ReportsPage';
import type { GeneratedReport, AuditLogEntry, DataLineageGraph } from '@sandforge/shared';
import type { AnalyticsSummary } from './AnalyticsDashboard';

/* Mock ReactFlow */
vi.mock('reactflow', () => ({
  __esModule: true,
  default: ({ nodes, edges }: { nodes: unknown[]; edges: unknown[] }) => (
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

/* ------------------------------------------------------------------ */
/* Mock bridge hooks                                                   */
/* ------------------------------------------------------------------ */
const mockExportMutate = vi.fn();
const mockExportReset = vi.fn();

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: () => ({ data: null, loading: false, error: null, refetch: vi.fn() }),
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: () => ({
    mutate: mockExportMutate,
    data: null,
    loading: false,
    error: null,
    reset: mockExportReset,
  }),
}));

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
  it('should render the page', () => {
    render(<ReportsPage />);
    expect(screen.getByTestId('reports-page')).toBeDefined();
  });

  it('should show page title', () => {
    render(<ReportsPage />);
    expect(screen.getByText('Reports & Analytics')).toBeDefined();
  });

  it('should show tabs', () => {
    render(<ReportsPage />);
    expect(screen.getByText('Executions')).toBeDefined();
    expect(screen.getByText('Analytics')).toBeDefined();
    expect(screen.getByText('Audit Trail')).toBeDefined();
    expect(screen.getByText('Data Lineage')).toBeDefined();
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
    fireEvent.click(screen.getByText('Data Lineage'));
    expect(screen.getByTestId('lineage-graph')).toBeDefined();
  });

  it('should call onSelectReport', () => {
    const onSelect = vi.fn();
    render(<ReportsPage reports={reports} onSelectReport={onSelect} />);
    const wrapper = screen.getByTestId('report-rpt-1');
    fireEvent.click(wrapper.querySelector('[role="button"]')!);
    expect(onSelect).toHaveBeenCalledWith('rpt-1');
  });

  it('should call onExportReport and bridge mutation', () => {
    const onExport = vi.fn();
    render(<ReportsPage reports={reports} onExportReport={onExport} />);
    /* Select the report first */
    const wrapper = screen.getByTestId('report-rpt-1');
    fireEvent.click(wrapper.querySelector('[role="button"]')!);
    fireEvent.click(screen.getByTestId('export-report-btn'));
    expect(onExport).toHaveBeenCalledWith('rpt-1');
    expect(mockExportMutate).toHaveBeenCalledWith({ reportId: 'rpt-1' });
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
