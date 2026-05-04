import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { ForgePage } from './ForgePage';

/* ---- Mocks ---- */

let mockPhase = 'input';

vi.mock('../../stores/useForgeStore', () => {
  const defaultState = {
    get phase() {
      return mockPhase;
    },
    config: null,
    templates: [],
    graph: null,
    result: null,
    history: [],
    plan: null,
    complianceReport: null,
    metadataDiffs: [],
    anonymizationRules: {
      email: 'fake',
      phone: 'mask',
      name: 'fake',
      address: 'fake',
      ssn_id: 'redact',
      financial: 'hash',
      other: 'nullify',
    },
    setConfig: vi.fn(),
    setPhase: vi.fn(),
    setGraph: vi.fn(),
    updateNodeStatus: vi.fn(),
    toggleNodeIncluded: vi.fn(),
    toggleAnonymizeField: vi.fn(),
    setAllNodesIncluded: vi.fn(),
    setAnonymizationRule: vi.fn(),
    updateNodeBatchStrategy: vi.fn(),
    setResult: vi.fn(),
    removeTemplate: vi.fn(),
    addTemplate: vi.fn(),
    updateTemplate: vi.fn(),
    setPlan: vi.fn(),
    setComplianceReport: vi.fn(),
    setMetadataDiffs: vi.fn(),
    logs: [],
    addLog: vi.fn(),
    clearLogs: vi.fn(),
    forgeAgain: vi.fn(),
    reset: vi.fn(),
  };

  const store = Object.assign(
    (selector: (state: typeof defaultState) => unknown) => selector(defaultState),
    { getState: () => defaultState },
  );

  return { useForgeStore: store };
});

let mockOrgState: Record<string, unknown> = {
  orgs: [{ id: 'org-1', alias: 'Dev' }],
  selectedOrgId: 'org-1',
};

vi.mock('../../stores/useOrgStore', () => ({
  useOrgStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mockOrgState),
}));

const mockNavigate = vi.fn();
vi.mock('../../stores/useAppStore', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ navigate: mockNavigate, currentRoute: 'forge' }),
}));

vi.mock('../../components/graph/LiveGraph', () => ({
  LiveGraph: ({ className }: { className?: string }) => (
    <div data-testid="live-graph" className={className}>
      LiveGraph mock
    </div>
  ),
}));

vi.mock('../../components/ui/SplitView', () => ({
  SplitView: ({ left, right }: { left: React.ReactNode; right: React.ReactNode }) => (
    <div data-testid="splitview">
      <div>{left}</div>
      <div>{right}</div>
    </div>
  ),
}));

/* ---- Tests ---- */

describe('ForgePage', () => {
  beforeEach(() => {
    mockOrgState = { orgs: [{ id: 'org-1', alias: 'Dev' }], selectedOrgId: 'org-1' };
    mockNavigate.mockClear();
  });

  it('should show empty state when no org selected', () => {
    mockOrgState = { orgs: [], selectedOrgId: null };
    render(<ForgePage />);
    expect(screen.getByTestId('empty-state')).toBeDefined();
    expect(screen.getByTestId('illustration-forge')).toBeDefined();
    expect(screen.getByTestId('empty-action-button')).toBeDefined();
  });

  it('should navigate to orgs when empty state CTA clicked', () => {
    mockOrgState = { orgs: [], selectedOrgId: null };
    render(<ForgePage />);
    fireEvent.click(screen.getByTestId('empty-action-button'));
    expect(mockNavigate).toHaveBeenCalledWith('orgs');
  });

  it('should render with forge-page test id', () => {
    mockPhase = 'input';
    render(<ForgePage />);
    expect(screen.getByTestId('forge-page')).toBeDefined();
  });

  it('should render input phase by default', () => {
    mockPhase = 'input';
    render(<ForgePage />);
    expect(screen.getByTestId('forge-input')).toBeDefined();
  });

  it('should show discovery view when phase is discovery', () => {
    mockPhase = 'discovery';
    render(<ForgePage />);
    // graph is null in the mock, so ForgeDiscovery renders the loading state
    expect(screen.getByTestId('forge-discovery-loading')).toBeDefined();
  });

  it('should show review view when phase is review', () => {
    mockPhase = 'review';
    render(<ForgePage />);
    expect(screen.getByTestId('forge-review')).toBeDefined();
  });

  it('should show execution view when phase is execution', () => {
    mockPhase = 'execution';
    render(<ForgePage />);
    expect(screen.getByTestId('forge-execution')).toBeDefined();
  });

  it('should show results view when phase is results', () => {
    mockPhase = 'results';
    render(<ForgePage />);
    expect(screen.getByTestId('forge-results')).toBeDefined();
  });
});
