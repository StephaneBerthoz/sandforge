import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import '../../i18n';
import de from '../../i18n/locales/de.json';
import en from '../../i18n/locales/en.json';
import es from '../../i18n/locales/es.json';
import fr from '../../i18n/locales/fr.json';
import ja from '../../i18n/locales/ja.json';
import ptBR from '../../i18n/locales/pt-BR.json';
import { ReportsPage } from './ReportsPage';
import type { RunsSummary } from './ReportsPage';
import { useAppStore } from '../../stores/useAppStore';
import type { GeneratedReport, AuditLogEntry, DataLineageGraph } from '@sandforge/shared';

/* Mock ReactFlow */
vi.mock('@xyflow/react', () => ({
  __esModule: true,
  ReactFlow: ({ nodes, edges }: { nodes: unknown[]; edges: unknown[] }) => (
    <div data-testid="mock-reactflow" data-nodes={nodes.length} data-edges={edges.length} />
  ),
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
}));

/** The Lineage tab's chunk could not be fetched, as on a remote window that dropped. */
const lineageUnreadable = vi.hoisted(() => ({ value: false }));
vi.mock('./LineageGraph', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./LineageGraph')>();
  return {
    ...actual,
    LineageGraph: (props: React.ComponentProps<typeof actual.LineageGraph>) => {
      if (lineageUnreadable.value) {
        throw new TypeError(
          'Failed to fetch dynamically imported module: https://file+.vscode-resource.vscode-cdn.net/x/assets/chunks/LineageGraph-a1.js',
        );
      }
      return <actual.LineageGraph {...props} />;
    },
  };
});

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

const summary: RunsSummary = {
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
    useAppStore.setState({ navigationIntent: null });
  });

  it('should render the page', () => {
    render(<ReportsPage />);
    expect(screen.getByTestId('reports-page')).toBeDefined();
  });

  it('titles the page Reports in the header every module page has', () => {
    // A bare h1 read "Reports and analytics" over an Analytics tab that
    // repeated two of the four figures above it.
    render(<ReportsPage />);
    const header = screen.getByTestId('page-header');
    expect(within(header).getByRole('heading', { level: 1 }).textContent).toBe('Reports');
  });

  it('names the page after its module in every language, as the launcher does', () => {
    for (const catalogue of [en, fr, de, es, ptBR, ja]) {
      expect(catalogue.reports.title).toBe(catalogue.nav.reports);
    }
  });

  it('calls the data lineage « lignage » in French, the word the trade uses', () => {
    expect(fr.reports.lineage).toBe('Lignage des données');
    expect(JSON.stringify(fr.reports)).not.toMatch(/lignée/i);
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
      'Audit trail',
      'Data lineage',
    ]);
    // The module pages' tab bar, each tab with its icon.
    expect(screen.getByTestId('page-tabs')).toBeDefined();
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab.querySelector('svg')).not.toBeNull();
    }
  });

  it('opens on the tab another page asked for, once', () => {
    // Sync's and Automation's histories open Reports where their runs are.
    useAppStore.setState({ navigationIntent: { route: 'reports', reportsTab: 'audit' } });
    render(<ReportsPage reports={reports} auditEntries={auditEntries} />);

    expect(screen.getByRole('tab', { name: 'Audit trail' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(useAppStore.getState().navigationIntent).toBeNull();
  });

  it('should show executions tab by default', () => {
    render(<ReportsPage reports={reports} />);
    expect(screen.getByTestId('execution-report-view')).toBeDefined();
  });

  it('offers no Analytics tab: its figures are the ones above the tabs', () => {
    render(<ReportsPage reports={reports} analyticsSummary={summary} />);
    expect(screen.queryByRole('tab', { name: 'Analytics' })).toBeNull();
  });

  it('keeps a Lineage tab whose chunk could not be fetched to its tab, and the other tabs work', async () => {
    // The page's boundary caught it: the Executions tab went with it.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    lineageUnreadable.value = true;
    try {
      render(<ReportsPage reports={reports} lineageData={lineageData} />);
      fireEvent.click(screen.getByRole('tab', { name: 'Data lineage' }));

      expect((await screen.findByTestId('reports-lineage-failed')).textContent).toContain(
        'This part did not load',
      );
      fireEvent.click(screen.getByRole('tab', { name: 'Executions' }));
      expect(screen.getByTestId('execution-report-view')).toBeDefined();
    } finally {
      lineageUnreadable.value = false;
    }
  });

  it('should switch to audit tab', () => {
    render(<ReportsPage auditEntries={auditEntries} />);
    fireEvent.click(screen.getByText('Audit trail'));
    expect(screen.getByTestId('audit-trail-viewer')).toBeDefined();
  });

  it('should switch to lineage tab', async () => {
    render(<ReportsPage lineageData={lineageData} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Data lineage' }));
    expect(await screen.findByTestId('lineage-graph')).toBeDefined();
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
        'Audit trail',
        'Data lineage',
      ]);
      expect(screen.getByTestId('audit-trail-viewer')).toBeDefined();
    });
  });

  describe('while a producer reads', () => {
    it('says the executions tab is loading, not coming', () => {
      render(<ReportsPage reportsLoading />);

      expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Executions']);
      expect(screen.getByTestId('reports-executions-loading').textContent).toContain('Loading');
      expect(screen.queryByTestId('execution-report-view')).toBeNull();
      expect(screen.queryByText('Coming soon')).toBeNull();
    });

    it('says the audit trail and the lineage are loading', () => {
      render(<ReportsPage auditLoading lineageLoading />);

      expect(screen.getByTestId('reports-audit-loading')).toBeDefined();
      fireEvent.click(screen.getByRole('tab', { name: 'Data lineage' }));
      expect(screen.getByTestId('reports-lineage-loading')).toBeDefined();
    });

    it('keeps the tab of a read that failed, to say why', () => {
      render(<ReportsPage auditError="timed out" />);

      expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Audit trail']);
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
      fireEvent.click(screen.getByText('Audit trail'));
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
      fireEvent.click(screen.getByText('Audit trail'));
      expect(screen.queryByTestId('reports-audit-empty')).toBeNull();
      expect(screen.getByTestId('audit-filters')).toBeDefined();
      expect(screen.getByText('No audit entries')).toBeDefined();
    });

    it('opens the lineage tab on the run an audit entry records, when its graph is kept', async () => {
      const onSelectLineageRun = vi.fn();
      const traced: AuditLogEntry = { ...auditEntries[0], id: 'aud-op-0', operationId: 'op-0' };
      render(
        <ReportsPage
          auditEntries={[traced]}
          lineageData={lineageData}
          lineageRuns={[
            { operationId: 'op-1', generatedAt: '2026-02-20T10:00:00Z' },
            { operationId: 'op-0', generatedAt: '2026-02-19T10:00:00Z' },
          ]}
          onSelectLineageRun={onSelectLineageRun}
        />,
      );
      fireEvent.click(screen.getByRole('tab', { name: 'Audit trail' }));

      fireEvent.click(screen.getByTestId('audit-view-run-aud-op-0'));

      expect(onSelectLineageRun).toHaveBeenCalledWith('op-0');
      expect(screen.getByRole('tab', { name: 'Data lineage' }).getAttribute('aria-selected')).toBe(
        'true',
      );
      expect(await screen.findByTestId('mock-reactflow')).toBeDefined();
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
      fireEvent.click(screen.getByRole('tab', { name: 'Data lineage' }));
      expect(screen.queryByTestId('lineage-run')).toBeNull();
      unmount();

      render(
        <ReportsPage
          lineageData={lineageData}
          lineageRuns={[run('op-1'), run('op-0')]}
          onSelectLineageRun={onSelectLineageRun}
        />,
      );
      fireEvent.click(screen.getByRole('tab', { name: 'Data lineage' }));
      // Each run is named by what it was, where it wrote and when.
      expect(
        screen.getAllByRole('option', { name: 'Forge clone · target-sandbox · 2026-02-20 10:00' }),
      ).toHaveLength(2);
      fireEvent.change(screen.getByTestId('lineage-run'), { target: { value: 'op-0' } });
      expect(onSelectLineageRun).toHaveBeenCalledWith('op-0');
    });

    it('names a traced run without an action by its module, as the navigation does', () => {
      render(
        <ReportsPage
          lineageData={lineageData}
          lineageRuns={[
            { operationId: 'op-1', generatedAt: '2026-02-20T10:00:00Z', module: 'frozen' },
            { operationId: 'op-0', generatedAt: '2026-02-19T10:00:00Z', module: 'dataops' },
          ]}
          onSelectLineageRun={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole('tab', { name: 'Data lineage' }));

      expect(
        screen.getByRole('option', { name: 'Frozen Dataset · 2026-02-20 10:00' }),
      ).toBeDefined();
      expect(screen.getByRole('option', { name: 'DataOps · 2026-02-19 10:00' })).toBeDefined();
    });
  });

  it('sums the runs up in four figures, none of them twice', () => {
    // "Total reports" and "Total operations" counted the same runs, and the
    // Analytics tab printed two of the figures again with the error rate,
    // a hundred minus the success rate.
    render(
      <ReportsPage reports={reports} analyticsSummary={summary} auditEntries={auditEntries} />,
    );
    expect(screen.getByTestId('reports-kpi-row')).toBeDefined();
    const tiles = screen.getAllByTestId('kpi-card').map((tile) => tile.textContent);
    expect(tiles).toEqual(['Runs1', 'Success rate95.0%', 'Average duration5s', 'Audit entries1']);
  });

  it('should render BentoTile content wrapper', () => {
    render(<ReportsPage />);
    expect(screen.getAllByTestId('bento-tile').length).toBeGreaterThanOrEqual(1);
  });
});
