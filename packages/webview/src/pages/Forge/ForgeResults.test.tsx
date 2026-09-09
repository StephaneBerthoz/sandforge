import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import type { ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import { ForgeResults, ID_REMAP_VIRTUALIZE_THRESHOLD } from './ForgeResults';

/* ---- Mocks ---- */

/**
 * Mock @tanstack/react-virtual: jsdom has no layout, so the real virtualizer
 * measures a zero-height scroll container and yields no rows at all. This
 * stand-in yields a fixed window (10 visible + overscan on both sides), which
 * is what makes "renders a window, not the whole list" observable in a test.
 */
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; estimateSize: () => number; overscan?: number }) => {
    const rowHeight = opts.estimateSize();
    const overscan = opts.overscan ?? 5;
    const visibleCount = Math.min(opts.count, 10 + overscan * 2);
    const items = Array.from({ length: visibleCount }, (_, i) => ({
      index: i,
      start: i * rowHeight,
      size: rowHeight,
    }));
    return {
      getVirtualItems: () => items,
      getTotalSize: () => opts.count * rowHeight,
    };
  },
}));

const mockReset = vi.fn();
const mockForgeAgain = vi.fn();
const mockSetPhase = vi.fn();
const mockSetGraph = vi.fn();

const makeMockGraph = (): ForgeGraph => ({
  nodes: [
    {
      objectApiName: 'Account',
      recordCount: 10,
      fieldCount: 15,
      status: 'done' as const,
      progress: 100,
      included: true,
      piiFields: [] as string[],
      anonymizeFields: [] as string[],
      level: 0,
      successCount: 10,
      failureCount: 0,
      errors: [] as string[],
      createableFieldCount: 0,
      estimatedSizeMB: 0,
      estimatedApiCalls: 0,
      batchStrategy: 'auto' as const,
    },
    {
      objectApiName: 'Contact',
      recordCount: 20,
      fieldCount: 18,
      status: 'done' as const,
      progress: 100,
      included: true,
      piiFields: [] as string[],
      anonymizeFields: [] as string[],
      level: 1,
      successCount: 18,
      failureCount: 2,
      errors: ['FIELD_INTEGRITY_EXCEPTION'],
      createableFieldCount: 0,
      estimatedSizeMB: 0,
      estimatedApiCalls: 0,
      batchStrategy: 'auto' as const,
    },
    {
      objectApiName: 'Case',
      recordCount: 5,
      fieldCount: 10,
      status: 'skipped' as const,
      progress: 0,
      included: false,
      piiFields: [] as string[],
      anonymizeFields: [] as string[],
      level: 2,
      successCount: 0,
      failureCount: 0,
      errors: [] as string[],
      createableFieldCount: 0,
      estimatedSizeMB: 0,
      estimatedApiCalls: 0,
      batchStrategy: 'auto' as const,
    },
  ],
  edges: [],
  totalRecords: 35,
  estimatedSizeMB: 1.2,
  estimatedDurationSeconds: 10,
});

const mockLogs = [
  { id: 'log-1', timestamp: Date.now(), level: 'info' as const, message: 'Processing Account' },
  { id: 'log-2', timestamp: Date.now(), level: 'error' as const, message: 'Error on Case' },
];

const makeMockResult = () => ({
  id: 'exec-001',
  startedAt: Date.now() - 10_000,
  completedAt: Date.now(),
  totalRecords: 35,
  totalSuccess: 28,
  totalFailures: 2,
  status: 'partial' as const,
  graph: makeMockGraph(),
  idRemapCount: 42,
  idRemapTable: {} as Record<string, string>,
  duration: 10000,
  timestamp: '2026-03-20T10:00:00.000Z',
});

const makeErrorNode = (): ForgeGraphNode => ({
  objectApiName: 'Opportunity',
  recordCount: 8,
  fieldCount: 12,
  status: 'error' as const,
  progress: 40,
  included: true,
  piiFields: [] as string[],
  anonymizeFields: ['Email__c'] as string[],
  level: 1,
  successCount: 3,
  failureCount: 5,
  errors: ['UNABLE_TO_LOCK_ROW'],
  createableFieldCount: 0,
  estimatedSizeMB: 0,
  estimatedApiCalls: 5,
  batchStrategy: 'auto' as const,
});

const makeMockGraphWithError = () => {
  const base = makeMockGraph();
  return {
    ...base,
    nodes: [...base.nodes, makeErrorNode()],
    totalRecords: base.totalRecords + 8,
  };
};

let mockGraph = makeMockGraph();
let mockResult = makeMockResult();

vi.mock('../../stores/useForgeStore', () => {
  const store = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        get graph() {
          return mockGraph;
        },
        get result() {
          return mockResult;
        },
        reset: (...args: unknown[]) => mockReset(...args),
        forgeAgain: (...args: unknown[]) => mockForgeAgain(...args),
        setPhase: (...args: unknown[]) => mockSetPhase(...args),
        setGraph: (...args: unknown[]) => mockSetGraph(...args),
        logs: mockLogs,
      }),
    {
      getState: () => ({
        graph: mockGraph,
        result: mockResult,
        reset: mockReset,
        forgeAgain: mockForgeAgain,
        setPhase: mockSetPhase,
        setGraph: mockSetGraph,
        logs: mockLogs,
      }),
    },
  );
  return { useForgeStore: store };
});

/* ---- Tests ---- */

describe('ForgeResults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGraph = makeMockGraph();
    mockResult = makeMockResult();
  });

  it('should render with forge-results test id', () => {
    render(<ForgeResults />);
    expect(screen.getByTestId('forge-results')).toBeDefined();
  });

  it('should render 6 KPI cards', () => {
    render(<ForgeResults />);
    const cards = screen.getAllByTestId('kpi-card');
    expect(cards.length).toBe(6);
  });

  it('should display correct inserted count in KPI', () => {
    render(<ForgeResults />);
    const values = screen.getAllByTestId('kpi-value');
    // inserted = 10 (Account) + 18 (Contact) + 0 (Case) = 28
    expect(values[0].textContent).toBe('28');
  });

  it('should display correct skipped count in KPI', () => {
    render(<ForgeResults />);
    const values = screen.getAllByTestId('kpi-value');
    // skipped = Case with 5 records (status=skipped)
    expect(values[1].textContent).toBe('5');
  });

  it('should display idRemaps from result.idRemapCount, not inserted', () => {
    render(<ForgeResults />);
    const values = screen.getAllByTestId('kpi-value');
    // idRemaps = result.idRemapCount = 42, NOT inserted count of 28
    expect(values[2].textContent).toBe('42');
  });

  it('should display success rate in KPI', () => {
    render(<ForgeResults />);
    const values = screen.getAllByTestId('kpi-value');
    // successRate = round(28/35*100) = 80%
    expect(values[3].textContent).toBe('80%');
  });

  it('should render results table with correct rows', () => {
    render(<ForgeResults />);
    const table = screen.getByTestId('forge-results-table');
    expect(table).toBeDefined();
    // 3 nodes = 3 data rows
    const rows = table.querySelectorAll('tbody tr');
    expect(rows.length).toBe(3);
  });

  it('should show error text for nodes with errors', () => {
    render(<ForgeResults />);
    expect(screen.getByText('FIELD_INTEGRITY_EXCEPTION')).toBeDefined();
  });

  it('should call forgeAgain (not reset) when forge again button is clicked', () => {
    render(<ForgeResults />);
    const btn = screen.getByTestId('forge-again');
    fireEvent.click(btn);
    expect(mockForgeAgain).toHaveBeenCalledTimes(1);
    expect(mockReset).not.toHaveBeenCalled();
  });

  it('should render copy report button', () => {
    render(<ForgeResults />);
    const btn = screen.getByTestId('forge-copy-report');
    expect(btn).toBeDefined();
  });

  it('should render save template button', () => {
    render(<ForgeResults />);
    const btn = screen.getByTestId('forge-save-template');
    expect(btn).toBeDefined();
  });

  it('should render export JSON button', () => {
    render(<ForgeResults />);
    const btn = screen.getByTestId('forge-export-json');
    expect(btn).toBeDefined();
  });

  it('should render retry failed button when failed nodes exist', () => {
    mockGraph = makeMockGraphWithError();
    mockResult = { ...makeMockResult(), graph: mockGraph };
    render(<ForgeResults />);
    const btn = screen.getByTestId('forge-retry-failed');
    expect(btn).toBeDefined();
  });

  it('should not render retry failed button when no failed nodes', () => {
    render(<ForgeResults />);
    expect(screen.queryByTestId('forge-retry-failed')).toBeNull();
  });

  it('should call setGraph and setPhase on retry', () => {
    mockGraph = makeMockGraphWithError();
    mockResult = { ...makeMockResult(), graph: mockGraph };
    render(<ForgeResults />);
    const btn = screen.getByTestId('forge-retry-failed');
    fireEvent.click(btn);
    expect(mockSetGraph).toHaveBeenCalledTimes(1);
    const graphArg = mockSetGraph.mock.calls[0][0];
    const retryNode = graphArg.nodes.find(
      (n: Record<string, unknown>) => n.objectApiName === 'Opportunity',
    );
    expect(retryNode.status).toBe('idle');
    expect(retryNode.progress).toBe(0);
    expect(mockSetPhase).toHaveBeenCalledWith('execution');
  });

  /* ---- UX-19: Duration + Timestamp ---- */

  it('should display duration and timestamp from result', () => {
    render(<ForgeResults />);
    const duration = screen.getByTestId('forge-results-duration');
    expect(duration).toBeDefined();
    // duration = 10000ms => 10s => formatElapsed(10) = "0:10"
    expect(duration.textContent).toContain('0:10');
    const timestamp = screen.getByTestId('forge-results-timestamp');
    expect(timestamp).toBeDefined();
    expect(timestamp.textContent).toContain('2026');
  });

  /* ---- UX-18: Sort by column ---- */

  it('should sort table rows when clicking a column header', () => {
    render(<ForgeResults />);
    // Default sort is objectApiName asc: Account, Case, Contact
    const rows = screen.getAllByTestId('forge-results-row');
    expect(rows[0].textContent).toContain('Account');
    expect(rows[1].textContent).toContain('Case');
    expect(rows[2].textContent).toContain('Contact');

    // Click objectApiName header again to toggle to desc
    fireEvent.click(screen.getByTestId('forge-results-sort-object'));
    const rowsDesc = screen.getAllByTestId('forge-results-row');
    expect(rowsDesc[0].textContent).toContain('Contact');
    expect(rowsDesc[1].textContent).toContain('Case');
    expect(rowsDesc[2].textContent).toContain('Account');
  });

  /* ---- UX-18: Filter by status ---- */

  it('should filter table rows by status', () => {
    render(<ForgeResults />);
    const filter = screen.getByTestId('forge-results-status-filter');
    expect(filter).toBeDefined();

    // Filter to "done" only
    fireEvent.change(filter, { target: { value: 'done' } });
    const rows = screen.getAllByTestId('forge-results-row');
    // Account (done) + Contact (done) = 2 rows, Case (skipped) filtered out
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('Account');
    expect(rows[1].textContent).toContain('Contact');
  });

  /* ---- UX-14: Collapsible logs toggle ---- */

  it('should toggle execution logs visibility', () => {
    render(<ForgeResults />);
    const toggleBtn = screen.getByTestId('forge-results-toggle-logs');
    expect(toggleBtn).toBeDefined();
    // Logs should be collapsed by default (no logstream visible)
    expect(screen.queryByTestId('logstream')).toBeNull();
    // Click to expand
    fireEvent.click(toggleBtn);
    expect(screen.getByTestId('logstream')).toBeDefined();
    // Click again to collapse
    fireEvent.click(toggleBtn);
    expect(screen.queryByTestId('logstream')).toBeNull();
  });

  /* ---- PERF-10: the Id remap table is virtualized ---- */

  /** One source -> target pair per cloned record, as the executor returns them. */
  const makeIdRemapTable = (count: number): Record<string, string> => {
    const table: Record<string, string> = {};
    for (let i = 0; i < count; i++) {
      const suffix = String(i).padStart(9, '0');
      table[`001SRC${suffix}`] = `001TGT${suffix}`;
    }
    return table;
  };

  it('should render a window, not 5000 rows, for a large id remap table', () => {
    mockResult = { ...makeMockResult(), idRemapTable: makeIdRemapTable(5000) };
    render(<ForgeResults />);

    const rows = screen.getAllByTestId('forge-id-mapping-row');
    expect(rows.length).toBeGreaterThan(0);
    // A plain table would mount all 5000 rows (10 000 cells) at once.
    expect(rows.length).toBeLessThan(100);
    expect(screen.getByTestId('forge-id-mapping-virtual')).toBeDefined();
  });

  it('should still announce the full count while rendering only a window', () => {
    mockResult = { ...makeMockResult(), idRemapTable: makeIdRemapTable(5000) };
    render(<ForgeResults />);

    const panel = screen.getByTestId('forge-id-mapping');
    expect(panel.textContent).toContain('5000');
    expect(screen.getAllByTestId('forge-id-mapping-row').length).toBeLessThan(100);
  });

  it('should keep the plain table below the virtualization threshold', () => {
    const count = ID_REMAP_VIRTUALIZE_THRESHOLD;
    mockResult = { ...makeMockResult(), idRemapTable: makeIdRemapTable(count) };
    render(<ForgeResults />);

    expect(screen.getByTestId('forge-id-mapping-table')).toBeDefined();
    expect(screen.queryByTestId('forge-id-mapping-virtual')).toBeNull();
    expect(screen.getAllByTestId('forge-id-mapping-row')).toHaveLength(count);
  });
});
