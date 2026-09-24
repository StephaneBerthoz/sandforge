import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { ForgePage } from './ForgePage';

/* ---- Mocks ---- */

let mockPhase = 'input';
/** Where the last run stopped, as the execution screen recorded it. */
let mockStoppedAt: number | null = null;
const mockSetStoppedAt = vi.fn();

// Only the store stands in: the helpers the screens import with it are its own.
vi.mock('../../stores/useForgeStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/useForgeStore')>();
  const defaultState = {
    get phase() {
      return mockPhase;
    },
    get stoppedAt() {
      return mockStoppedAt;
    },
    setStoppedAt: (...args: unknown[]) => mockSetStoppedAt(...args),
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
    setNodesIncluded: vi.fn(),
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
    fileCopy: { enabled: false, maxFileSizeMB: 10, acceptedAsIs: false },
    setFileCopy: vi.fn(),
  };

  const store = Object.assign(
    (selector: (state: typeof defaultState) => unknown) => selector(defaultState),
    { getState: () => defaultState },
  );

  return { ...actual, useForgeStore: store };
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

  it('should show the record-scoped journey steps in the empty state', () => {
    mockOrgState = { orgs: [], selectedOrgId: null };
    render(<ForgePage />);
    expect(screen.getByText('Populate your sandbox from a real record')).toBeDefined();
    expect(screen.getByTestId('empty-steps')).toBeDefined();
    expect(screen.getByTestId('empty-step-0').textContent).toContain(
      'Connect an org via SFDX import',
    );
    expect(screen.getByTestId('empty-step-1').textContent).toContain(
      'Paste a root record ID (e.g. an Account from UAT)',
    );
    expect(screen.getByTestId('empty-step-4').textContent).toContain('IDs are remapped');
  });

  it('should offer the connect CTA when no orgs exist', () => {
    mockOrgState = { orgs: [], selectedOrgId: null };
    render(<ForgePage />);
    expect(screen.getByTestId('empty-action-button').textContent).toBe('Connect an Org');
  });

  it('should offer the select CTA when orgs exist but none is selected', () => {
    mockOrgState = { orgs: [{ id: 'org-1', alias: 'Dev' }], selectedOrgId: null };
    render(<ForgePage />);
    expect(screen.getByTestId('empty-action-button').textContent).toBe('Select an Org');
    expect(screen.getByTestId('empty-step-0').textContent).toContain('Select a source org');
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

  describe('a stopped run, told to a screen reader', () => {
    beforeEach(() => {
      mockStoppedAt = null;
      mockSetStoppedAt.mockClear();
    });

    it('says where the run stopped, from the screen the abort goes back to', () => {
      // A finished run is spoken from the results screen. An aborted one went
      // back to the input screen in the same instant, and nothing said so.
      mockPhase = 'input';
      mockStoppedAt = 75;
      render(<ForgePage />);

      const region = screen.getByTestId('forge-run-stopped-status');
      expect(region.getAttribute('role')).toBe('status');
      expect(region.textContent).toBe('Forge stopped at 75%.');
    });

    it('says nothing while no run has stopped', () => {
      mockPhase = 'input';
      render(<ForgePage />);
      expect(screen.getByTestId('forge-run-stopped-status').textContent).toBe('');
    });

    it('forgets the stopped run when the page closes, so coming back does not repeat it', () => {
      mockPhase = 'input';
      mockStoppedAt = 75;
      const { unmount } = render(<ForgePage />);
      unmount();
      expect(mockSetStoppedAt).toHaveBeenCalledWith(null);
    });
  });
});
