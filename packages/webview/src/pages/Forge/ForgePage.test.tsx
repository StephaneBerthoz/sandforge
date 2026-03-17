import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { ForgePage } from './ForgePage';

/* ---- Mocks ---- */

let mockPhase = 'input';

vi.mock('../../stores/useForgeStore', () => {
  const defaultState = {
    get phase() { return mockPhase; },
    config: null,
    templates: [],
    graph: null,
    result: null,
    history: [],
    plan: null,
    complianceReport: null,
    metadataDiffs: [],
    anonymizationRules: {
      email: 'fake', phone: 'mask', name: 'fake', address: 'fake',
      ssn_id: 'redact', financial: 'hash', other: 'nullify',
    },
    setConfig: vi.fn(),
    setPhase: vi.fn(),
    setGraph: vi.fn(),
    updateNodeStatus: vi.fn(),
    toggleNodeIncluded: vi.fn(),
    toggleAnonymizeField: vi.fn(),
    setAnonymizationRule: vi.fn(),
    updateNodeBatchStrategy: vi.fn(),
    setResult: vi.fn(),
    reset: vi.fn(),
  };

  const store = Object.assign(
    (selector: (state: typeof defaultState) => unknown) => selector(defaultState),
    { getState: () => defaultState },
  );

  return { useForgeStore: store };
});

vi.mock('../../stores/useOrgStore', () => ({
  useOrgStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ orgs: [] }),
}));

vi.mock('../../components/graph/LiveGraph', () => ({
  LiveGraph: ({ className }: { className?: string }) => (
    <div data-testid="live-graph" className={className}>LiveGraph mock</div>
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
