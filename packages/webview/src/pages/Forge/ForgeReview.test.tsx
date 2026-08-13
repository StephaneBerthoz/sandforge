import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '../../i18n';
import { ForgeReview } from './ForgeReview';
import type { ForgeGraphNode, ForgeGraph } from '../../stores/useForgeStore';
import type { MetadataDiffEntry } from '../../stores/useForgeStore';
import type { ForgeAnonymizationCategory, AnonymizationMethod } from '@sandforge/shared';

/* ---- Mocks ---- */

const mockSetPhase = vi.fn();
const mockToggleNodeIncluded = vi.fn();
const mockSendBridgeMessage = vi.fn();
const mockSetPlan = vi.fn();
const mockSetMetadataDiffs = vi.fn();

vi.mock('../../bridge/sendBridgeMessage', () => ({
  sendBridgeMessage: (...args: unknown[]) => mockSendBridgeMessage(...args),
}));

function makeNode(overrides: Partial<ForgeGraphNode> = {}): ForgeGraphNode {
  return {
    objectApiName: 'Account',
    recordCount: 100,
    fieldCount: 20,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 0,
    estimatedSizeMB: 0,
    estimatedApiCalls: 0,
    batchStrategy: 'auto',
    ...overrides,
  };
}

const defaultGraph: ForgeGraph = {
  nodes: [
    makeNode({ objectApiName: 'Account', piiFields: ['Email'] }),
    makeNode({ objectApiName: 'Contact', piiFields: ['Phone', 'FirstName'] }),
  ],
  edges: [],
  totalRecords: 200,
  estimatedSizeMB: 2,
  estimatedDurationSeconds: 10,
};

/** Only the ForgeConfig fields ForgeReview reads. */
interface MockConfig {
  anonymizePII: boolean;
  sourceOrgId: string;
  targetOrgId: string;
}

const defaultConfig: MockConfig = {
  anonymizePII: true,
  sourceOrgId: 'src-org',
  targetOrgId: 'tgt-org',
};

let mockGraph: ForgeGraph | null = defaultGraph;
let mockConfig: MockConfig | null = { ...defaultConfig };
let mockMetadataDiffs: MetadataDiffEntry[] = [];
const mockAnonymizationRules: Record<ForgeAnonymizationCategory, AnonymizationMethod> = {
  email: 'fake',
  phone: 'mask',
  name: 'fake',
  address: 'fake',
  ssn_id: 'redact',
  financial: 'hash',
  other: 'nullify',
};

vi.mock('../../stores/useForgeStore', () => {
  const defaultState = {
    get graph() {
      return mockGraph;
    },
    get config() {
      return mockConfig;
    },
    get metadataDiffs() {
      return mockMetadataDiffs;
    },
    get anonymizationRules() {
      return mockAnonymizationRules;
    },
    plan: null,
    complianceReport: null,
    setPhase: (...args: unknown[]) => mockSetPhase(...args),
    toggleNodeIncluded: (...args: unknown[]) => mockToggleNodeIncluded(...args),
    setPlan: (...args: unknown[]) => mockSetPlan(...args),
    setMetadataDiffs: (...args: unknown[]) => mockSetMetadataDiffs(...args),
    setAnonymizationRule: vi.fn(),
    updateNodeBatchStrategy: vi.fn(),
  };

  const store = Object.assign(
    (selector: (state: typeof defaultState) => unknown) => selector(defaultState),
    { getState: () => defaultState },
  );
  return { useForgeStore: store };
});

vi.mock('../../components/graph/LiveGraph', () => ({
  LiveGraph: ({ onIncludeToggle }: { onIncludeToggle?: (name: string) => void }) => (
    <div data-testid="live-graph">
      <button data-testid="mock-toggle-Account" onClick={() => onIncludeToggle?.('Account')}>
        Toggle Account
      </button>
    </div>
  ),
}));

/* ---- Tests ---- */

describe('ForgeReview', () => {
  beforeEach(() => {
    mockSetPhase.mockClear();
    mockToggleNodeIncluded.mockClear();
    mockSendBridgeMessage.mockClear();
    mockSetPlan.mockClear();
    mockSetMetadataDiffs.mockClear();
    mockGraph = defaultGraph;
    mockConfig = { ...defaultConfig };
    mockMetadataDiffs = [];
  });

  /** Deliver an extension -> webview message the way the real bus does. */
  function sendFromExtension(type: string, payload: Record<string, unknown>): void {
    // act(): the listener sets React state, so the re-render has to be
    // flushed before asserting on the DOM.
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type, id: `resp-${type}`, timestamp: Date.now(), payload },
          origin: '',
        }),
      );
    });
  }

  it('should render with data-testid="forge-review"', () => {
    render(<ForgeReview />);
    expect(screen.getByTestId('forge-review')).toBeDefined();
  });

  it('should have 4 tabs (plan, anonymization, compliance, metadata)', () => {
    render(<ForgeReview />);
    expect(screen.getByTestId('tab-plan')).toBeDefined();
    expect(screen.getByTestId('tab-anonymization')).toBeDefined();
    expect(screen.getByTestId('tab-compliance')).toBeDefined();
    expect(screen.getByTestId('tab-metadata')).toBeDefined();
  });

  it('should have Plan tab active by default', () => {
    render(<ForgeReview />);
    // ReviewPlanTab renders plan-loading when plan is null
    expect(screen.getByTestId('plan-loading')).toBeDefined();
  });

  it('should render execute button', () => {
    render(<ForgeReview />);
    expect(screen.getByTestId('execute-button')).toBeDefined();
  });

  it('should call setPhase("discovery") when back button clicked', () => {
    render(<ForgeReview />);
    fireEvent.click(screen.getByTestId('back-button'));
    expect(mockSetPhase).toHaveBeenCalledWith('discovery');
  });

  it('should send forge:execute with the graph and config when execute button clicked', () => {
    render(<ForgeReview />);
    fireEvent.click(screen.getByTestId('execute-button'));
    // The phase switch alone is not the behaviour under test: without this
    // request the extension never starts the run (regression guard for the
    // wiring gap where the button only ever called setPhase).
    expect(mockSendBridgeMessage).toHaveBeenCalledWith('forge:execute', {
      graph: defaultGraph,
      config: mockConfig,
    });
    expect(mockSetPhase).toHaveBeenCalledWith('execution');
  });

  it('should not send forge:execute when the graph is missing', () => {
    mockGraph = null;
    render(<ForgeReview />);
    fireEvent.click(screen.getByTestId('execute-button'));
    expect(mockSendBridgeMessage).not.toHaveBeenCalled();
    expect(mockSetPhase).not.toHaveBeenCalledWith('execution');
  });

  describe('plan channel', () => {
    it('should store the plan when forge:plan:response arrives', () => {
      render(<ForgeReview />);
      // useForgeForm sends forge:plan:request and the extension answers, but
      // nothing consumed the reply — the Plan tab showed "Generating execution
      // plan…" for the rest of the session.
      const plan = { waves: [], cycleResolutions: [] };
      sendFromExtension('forge:plan:response', { plan });

      expect(mockSetPlan).toHaveBeenCalledWith(plan);
    });

    it('should surface forge:plan:error instead of loading forever', () => {
      render(<ForgeReview />);
      sendFromExtension('forge:plan:error', { message: 'Describe failed on Account' });

      expect(screen.getByTestId('plan-error').textContent).toContain('Describe failed on Account');
      expect(screen.queryByTestId('plan-loading')).toBeNull();
    });
  });

  describe('metadata-diff channel', () => {
    /** The metadata-diff requests recorded on the mocked transport. */
    function diffRequests(): unknown[][] {
      return mockSendBridgeMessage.mock.calls.filter(
        (call) => call[0] === 'forge:metadata-diff:request',
      );
    }

    it('should request the diff on mount with the org ids and graph objects', () => {
      render(<ForgeReview />);
      // The channel was routed and implemented on the extension side but never
      // sent, so metadataDiffs had no writer at all.
      expect(mockSendBridgeMessage).toHaveBeenCalledWith('forge:metadata-diff:request', {
        sourceOrgId: 'src-org',
        targetOrgId: 'tgt-org',
        objectApiNames: ['Account', 'Contact'],
      });
    });

    it('should request the diff only once when the graph identity changes', () => {
      const { rerender } = render(<ForgeReview />);
      // Toggling a node replaces the graph object in the store, which is a
      // dependency of the request effect. The handler emits an
      // operation:started per request, so every toggle would otherwise push a
      // phantom operation into the activity feed.
      mockGraph = { ...defaultGraph, nodes: [...defaultGraph.nodes] };
      rerender(<ForgeReview />);
      mockGraph = { ...defaultGraph, nodes: [...defaultGraph.nodes] };
      rerender(<ForgeReview />);

      expect(diffRequests()).toHaveLength(1);
    });

    it('should cap the requested objects at the 100 the extension schema accepts', () => {
      mockGraph = {
        ...defaultGraph,
        nodes: Array.from({ length: 120 }, (_, i) => makeNode({ objectApiName: `Obj${i}__c` })),
      };
      render(<ForgeReview />);

      const payload = diffRequests()[0][1] as { objectApiNames: string[] };
      expect(payload.objectApiNames).toHaveLength(100);
    });

    it('should not request the diff when the config is missing', () => {
      mockConfig = null;
      render(<ForgeReview />);
      expect(diffRequests()).toHaveLength(0);
    });

    it('should store the diffs when forge:metadata-diff:response arrives', () => {
      render(<ForgeReview />);
      const diffs = [
        {
          objectApiName: 'Account',
          fieldApiName: 'CustomField__c',
          issue: 'missing',
          severity: 'error',
          details: 'Field does not exist in target org',
        },
      ];
      sendFromExtension('forge:metadata-diff:response', { diffs });

      expect(mockSetMetadataDiffs).toHaveBeenCalledWith(diffs);
    });

    it('should show the metadata tab as pending until the response lands', () => {
      render(<ForgeReview />);
      fireEvent.click(screen.getByTestId('tab-metadata'));
      // An empty diff list means "not compared yet" while the request is in
      // flight; "no differences" there would be a lie.
      expect(screen.getByTestId('metadata-loading')).toBeDefined();
      expect(screen.queryByTestId('no-diffs')).toBeNull();

      sendFromExtension('forge:metadata-diff:response', { diffs: [] });
      expect(screen.getByTestId('no-diffs')).toBeDefined();
    });

    it('should surface forge:metadata-diff:error instead of loading forever', () => {
      render(<ForgeReview />);
      fireEvent.click(screen.getByTestId('tab-metadata'));
      sendFromExtension('forge:metadata-diff:error', {
        message: 'Metadata diff service not configured',
      });

      expect(screen.getByTestId('metadata-error').textContent).toContain(
        'Metadata diff service not configured',
      );
      expect(screen.queryByTestId('metadata-loading')).toBeNull();
    });
  });

  it('should disable anonymization tab when anonymizePII is false', () => {
    mockConfig = { ...defaultConfig, anonymizePII: false };
    render(<ForgeReview />);
    const anonTab = screen.getByTestId('tab-anonymization');
    expect(anonTab).toHaveProperty('disabled', true);
  });

  it('should show PII badge on anonymization tab', () => {
    render(<ForgeReview />);
    const anonTab = screen.getByTestId('tab-anonymization');
    // 1 PII from Account + 2 from Contact = 3
    expect(anonTab.textContent).toContain('3');
  });

  it('should show metadata badge when diffs are present', () => {
    mockMetadataDiffs = [
      {
        objectApiName: 'Account',
        fieldApiName: 'X',
        issue: 'missing',
        severity: 'error',
        details: 'x',
      },
    ];
    render(<ForgeReview />);
    const metaTab = screen.getByTestId('tab-metadata');
    expect(metaTab.textContent).toContain('1');
  });

  it('should switch tabs on click', () => {
    render(<ForgeReview />);
    fireEvent.click(screen.getByTestId('tab-compliance'));
    // ReviewComplianceTab renders no-compliance by default
    expect(screen.getByTestId('review-compliance-tab')).toBeDefined();
  });

  it('should render live graph and support include toggle', () => {
    render(<ForgeReview />);
    expect(screen.getByTestId('live-graph')).toBeDefined();
    fireEvent.click(screen.getByTestId('mock-toggle-Account'));
    expect(mockToggleNodeIncluded).toHaveBeenCalledWith('Account');
  });

  /* ---- A11Y: Tab ARIA roles ---- */

  it('should have role="tablist" on the tab container', () => {
    render(<ForgeReview />);
    expect(screen.getByTestId('review-tabs').getAttribute('role')).toBe('tablist');
  });

  it('should have role="tab" and aria-selected on each tab button', () => {
    render(<ForgeReview />);
    const planTab = screen.getByTestId('tab-plan');
    const complianceTab = screen.getByTestId('tab-compliance');
    expect(planTab.getAttribute('role')).toBe('tab');
    expect(planTab.getAttribute('aria-selected')).toBe('true');
    expect(complianceTab.getAttribute('role')).toBe('tab');
    expect(complianceTab.getAttribute('aria-selected')).toBe('false');
  });

  it('should update aria-selected when switching tabs', () => {
    render(<ForgeReview />);
    const planTab = screen.getByTestId('tab-plan');
    const complianceTab = screen.getByTestId('tab-compliance');
    expect(planTab.getAttribute('aria-selected')).toBe('true');
    expect(complianceTab.getAttribute('aria-selected')).toBe('false');

    fireEvent.click(complianceTab);
    expect(planTab.getAttribute('aria-selected')).toBe('false');
    expect(complianceTab.getAttribute('aria-selected')).toBe('true');
  });

  it('should have role="tabpanel" with aria-labelledby on tab content', () => {
    render(<ForgeReview />);
    const tabpanel = screen.getByRole('tabpanel');
    expect(tabpanel.getAttribute('id')).toBe('tabpanel-plan');
    expect(tabpanel.getAttribute('aria-labelledby')).toBe('tab-plan');
  });
});
