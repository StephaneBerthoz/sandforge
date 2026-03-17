import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { ForgeResults } from './ForgeResults';

/* ---- Mocks ---- */

const mockReset = vi.fn();
const mockSetPhase = vi.fn();
const mockSetGraph = vi.fn();

const makeMockGraph = () => ({
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

const makeMockResult = () => ({
  id: 'exec-001',
  startedAt: Date.now() - 10_000,
  completedAt: Date.now(),
  totalRecords: 35,
  totalSuccess: 28,
  totalFailures: 2,
  status: 'partial' as const,
  graph: makeMockGraph(),
});

const makeErrorNode = () => ({
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
        get graph() { return mockGraph; },
        get result() { return mockResult; },
        reset: (...args: unknown[]) => mockReset(...args),
        setPhase: (...args: unknown[]) => mockSetPhase(...args),
        setGraph: (...args: unknown[]) => mockSetGraph(...args),
      }),
    {
      getState: () => ({
        graph: mockGraph,
        result: mockResult,
        reset: mockReset,
        setPhase: mockSetPhase,
        setGraph: mockSetGraph,
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

  it('should call reset when forge again button is clicked', () => {
    render(<ForgeResults />);
    const btn = screen.getByTestId('forge-again');
    fireEvent.click(btn);
    expect(mockReset).toHaveBeenCalledTimes(1);
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
});
