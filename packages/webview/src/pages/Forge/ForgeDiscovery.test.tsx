import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import '../../i18n';
import { ForgeDiscovery } from './ForgeDiscovery';
import type { ForgeGraph, ForgeGraphNode } from '../../stores/useForgeStore';
import { FORGE_GRAPH_MAX_OBJECTS, useForgeViewStore } from '../../stores/useForgeViewStore';

/* ---- Mocks ---- */

const mockSetPhase = vi.fn();
const mockToggleNodeIncluded = vi.fn();
const mockToggleAnonymizeField = vi.fn();
const mockSetNodesIncluded = vi.fn();
const mockSendMessage = vi.fn();

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
    makeNode({ objectApiName: 'Account', recordCount: 100 }),
    makeNode({ objectApiName: 'Contact', recordCount: 200, piiFields: ['Email'] }),
  ],
  edges: [
    {
      sourceObject: 'Account',
      targetObject: 'Contact',
      relationshipName: 'Contacts',
      type: 'lookup',
    },
  ],
  totalRecords: 300,
  estimatedSizeMB: 5.2,
  estimatedDurationSeconds: 45,
};

let mockGraph: ForgeGraph | null = defaultGraph;
/** The discovery the screen waits on, while it has yet to answer. */
let mockDiscoveryId: string | null = null;
/** The error the discovery the screen waited on ended on. */
let mockDiscoveryError: string | null = null;
const mockAwaitDiscovery = vi.fn();
let mockConfig: {
  inputMode: string;
  depth: string;
  sourceOrgId: string;
  targetOrgId: string;
  anonymizePII: boolean;
  skipEmpty: boolean;
  batchSize: string;
} | null = null;

const mockSetGraph = vi.fn();

vi.mock('../../stores/useForgeStore', () => {
  const defaultState = {
    get graph() {
      return mockGraph;
    },
    get config() {
      return mockConfig;
    },
    phase: 'discovery' as const,
    templates: [],
    result: null,
    history: [],
    setConfig: vi.fn(),
    setPhase: (...args: unknown[]) => mockSetPhase(...args),
    setGraph: (...args: unknown[]) => mockSetGraph(...args),
    updateNodeStatus: vi.fn(),
    toggleNodeIncluded: (...args: unknown[]) => mockToggleNodeIncluded(...args),
    toggleAnonymizeField: (...args: unknown[]) => mockToggleAnonymizeField(...args),
    setNodesIncluded: (...args: unknown[]) => mockSetNodesIncluded(...args),
    get discoveryId() {
      return mockDiscoveryId;
    },
    get discoveryError() {
      return mockDiscoveryError;
    },
    awaitDiscovery: (...args: unknown[]) => mockAwaitDiscovery(...args),
    settleDiscovery: vi.fn(),
    // No Clone directly waits on these discoveries.
    directDiscoveryId: null,
    directDiscoveryError: null,
    settleDirectRun: () => false,
    reset: vi.fn(),
  };

  const store = Object.assign(
    (selector: (state: typeof defaultState) => unknown) => selector(defaultState),
    { getState: () => defaultState },
  );

  return { useForgeStore: store };
});

vi.mock('../../hooks/useMessageBus', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../hooks/useMessageBus');
  return {
    ...actual,
    useSendMessage: () => mockSendMessage,
  };
});

// Mock LiveGraph to avoid ReactFlow complexity in unit tests
vi.mock('../../components/graph/LiveGraph', () => ({
  LiveGraph: ({ onNodeClick }: { onNodeClick?: (name: string) => void }) => (
    <div data-testid="live-graph">
      <button data-testid="mock-node-Account" onClick={() => onNodeClick?.('Account')}>
        Account
      </button>
      <button data-testid="mock-node-Contact" onClick={() => onNodeClick?.('Contact')}>
        Contact
      </button>
    </div>
  ),
}));

// Mock SplitView to render children directly
vi.mock('../../components/ui/SplitView', () => ({
  SplitView: ({ left, right }: { left: React.ReactNode; right: React.ReactNode }) => (
    <div data-testid="splitview">
      <div data-testid="splitview-left">{left}</div>
      <div data-testid="splitview-right">{right}</div>
    </div>
  ),
}));

/* ---- Tests ---- */

describe('ForgeDiscovery', () => {
  beforeEach(() => {
    mockSetPhase.mockClear();
    mockSetGraph.mockClear();
    mockToggleNodeIncluded.mockClear();
    mockToggleAnonymizeField.mockClear();
    mockSetNodesIncluded.mockClear();
    mockSendMessage.mockClear();
    mockAwaitDiscovery.mockClear();
    mockGraph = defaultGraph;
    mockDiscoveryId = null;
    mockDiscoveryError = null;
    mockConfig = null;
    useForgeViewStore.setState({ setting: 'auto', choice: null });
  });

  it('should render with forge-discovery test id', () => {
    render(<ForgeDiscovery />);
    expect(screen.getByTestId('forge-discovery')).toBeDefined();
  });

  it('should render the graph inside splitview', () => {
    render(<ForgeDiscovery />);
    expect(screen.getByTestId('live-graph')).toBeDefined();
  });

  it('should show empty state when no node is selected', () => {
    render(<ForgeDiscovery />);
    expect(screen.getByTestId('forge-select-node-empty')).toBeDefined();
  });

  it('should show node detail when a node is clicked', () => {
    render(<ForgeDiscovery />);
    fireEvent.click(screen.getByTestId('mock-node-Account'));
    expect(screen.getByTestId('forge-node-detail')).toBeDefined();
    // The node name appears in the detail panel header (h3)
    const detail = screen.getByTestId('forge-node-detail');
    expect(detail.querySelector('h3')?.textContent).toBe('Account');
  });

  it('should call setPhase("input") when back button is clicked', () => {
    render(<ForgeDiscovery />);
    fireEvent.click(screen.getByTestId('forge-back-btn'));
    expect(mockSetPhase).toHaveBeenCalledWith('input');
  });

  it('should call setPhase("review") when execute button is clicked', () => {
    render(<ForgeDiscovery />);
    fireEvent.click(screen.getByTestId('forge-execute-btn'));
    expect(mockSetPhase).toHaveBeenCalledWith('review');
  });

  it('should display stats bar with correct counts', () => {
    render(<ForgeDiscovery />);
    const statsBar = screen.getByTestId('forge-stats-bar');
    expect(statsBar).toBeDefined();
    expect(screen.getByTestId('stat-objects').textContent).toBe('2');
    expect(screen.getByTestId('stat-records').textContent).toBe('300');
  });

  it('should show loading state while its discovery has yet to answer', () => {
    mockGraph = null;
    mockDiscoveryId = 'wv-discover-1';
    render(<ForgeDiscovery />);
    expect(screen.getByTestId('forge-discovery-loading')).toBeDefined();
  });

  it('shows the discovery under way, not the graph an earlier discovery left', () => {
    // Back, then Discover again: the last graph is still in the store.
    mockDiscoveryId = 'wv-discover-2';
    render(<ForgeDiscovery />);

    expect(screen.getByTestId('forge-discovery-loading')).toBeDefined();
    expect(screen.queryByTestId('live-graph')).toBeNull();
    expect(screen.queryByTestId('forge-execute-btn')).toBeNull();
  });

  it('should show live progress counters on forge:discover:progress while loading', async () => {
    mockGraph = null;
    mockDiscoveryId = 'wv-discover-1';
    render(<ForgeDiscovery />);
    // No progress before any event arrives
    expect(screen.queryByTestId('forge-discovery-progress')).toBeNull();
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            id: 'test-progress',
            type: 'forge:discover:progress',
            timestamp: Date.now(),
            correlationId: 'wv-discover-1',
            payload: { objectApiName: 'Account', discoveredCount: 134, queueRemaining: 12 },
          },
        }),
      );
    });
    await waitFor(() => {
      const line = screen.getByTestId('forge-discovery-progress');
      expect(line.textContent).toContain('134');
      expect(line.textContent).toContain('12');
    });
  });

  it("shows no counters of a discovery the flow no longer waits on, nor of another panel's", async () => {
    // Back, then Discover again: the discovery replaced may still be walking.
    mockGraph = null;
    mockDiscoveryId = 'wv-discover-2';
    render(<ForgeDiscovery />);
    act(() => {
      for (const correlationId of ['wv-discover-1', undefined]) {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              id: `progress-${String(correlationId)}`,
              type: 'forge:discover:progress',
              timestamp: Date.now(),
              correlationId,
              payload: { objectApiName: 'Account', discoveredCount: 134, queueRemaining: 12 },
            },
          }),
        );
      }
    });
    // Give a counter that was taken the chance to show.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.queryByTestId('forge-discovery-progress')).toBeNull();
  });

  it('should show empty state with the error its discovery ended on', () => {
    mockGraph = null;
    mockDiscoveryError = 'Discovery failed';
    render(<ForgeDiscovery />);

    expect(screen.getByTestId('forge-discovery-empty').textContent).toContain('Discovery failed');
    expect(screen.queryByTestId('forge-discovery-loading')).toBeNull();
  });

  it('should not render MetadataDiffBanner placeholder', () => {
    const { container } = render(<ForgeDiscovery />);
    // MetadataDiffBanner had data-testid="metadata-diff-banner" — verify it is absent
    expect(container.querySelector('[data-testid="metadata-diff-banner"]')).toBeNull();
  });

  it('should render "Review & Execute" label on the execute button', () => {
    render(<ForgeDiscovery />);
    const btn = screen.getByTestId('forge-execute-btn');
    expect(btn.textContent).toContain('Review');
    expect(btn.textContent).toContain('Execute');
    // Ensure old label is gone
    expect(btn.textContent).not.toBe('Execute Forge');
  });

  it('should call toggleNodeIncluded when include toggle is used', () => {
    render(<ForgeDiscovery />);
    // Select Account node first
    fireEvent.click(screen.getByTestId('mock-node-Account'));
    // Click the include toggle
    fireEvent.click(screen.getByTestId('node-include-toggle'));
    expect(mockToggleNodeIncluded).toHaveBeenCalledWith('Account');
  });

  // Retry discovery
  it('should show retry button on error state when config is set, and wait on the retry', () => {
    mockGraph = null;
    mockDiscoveryError = 'Discovery failed';
    mockConfig = {
      inputMode: 'record',
      depth: 'direct',
      sourceOrgId: 'src',
      targetOrgId: 'tgt',
      anonymizePII: false,
      skipEmpty: false,
      batchSize: 'auto',
    };
    render(<ForgeDiscovery />);

    fireEvent.click(screen.getByTestId('forge-retry-discovery'));

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const [retry] = mockSendMessage.mock.calls[0] as [{ id: string; type: string }];
    expect(retry.type).toBe('forge:discover');
    // Only the retry's answer is taken from then on.
    expect(mockAwaitDiscovery).toHaveBeenCalledWith(retry.id);
  });

  // A failed re-discovery must not hide behind the graph it failed to replace
  it('should surface a discovery error while an earlier graph is still on screen', () => {
    mockConfig = {
      inputMode: 'record',
      depth: 'direct',
      sourceOrgId: 'src',
      targetOrgId: 'tgt',
      anonymizePII: false,
      skipEmpty: false,
      batchSize: 'auto',
    };
    // mockGraph stays set: this is the second discovery of the session.
    mockDiscoveryError = 'INVALID_SESSION_ID: session expired';
    render(<ForgeDiscovery />);

    const banner = screen.getByTestId('forge-discovery-error');
    expect(banner.textContent).toContain('INVALID_SESSION_ID');
    // The previous graph stays readable rather than being blanked out.
    expect(screen.getByTestId('live-graph')).toBeDefined();

    fireEvent.click(screen.getByTestId('forge-discovery-error-retry'));
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage.mock.calls[0][0].type).toBe('forge:discover');
    expect(mockAwaitDiscovery).toHaveBeenCalledWith(mockSendMessage.mock.calls[0][0].id);
  });

  // View mode toggle
  it('should toggle between graph and table view', () => {
    render(<ForgeDiscovery />);
    // Default view shows graph
    expect(screen.getByTestId('live-graph')).toBeDefined();
    // Switch to table
    fireEvent.click(screen.getByTestId('forge-view-table'));
    expect(screen.getByTestId('forge-table-view')).toBeDefined();
    // Switch back to graph
    fireEvent.click(screen.getByTestId('forge-view-graph'));
    expect(screen.getByTestId('live-graph')).toBeDefined();
  });

  describe('graph or table, by setting', () => {
    /** A graph of `count` objects, as a wide discovery answers. */
    function graphOf(count: number): ForgeGraph {
      return {
        ...defaultGraph,
        nodes: Array.from({ length: count }, (_, i) =>
          makeNode({ objectApiName: i === 0 ? 'Account' : `Object${String(i)}__c` }),
        ),
        edges: [],
      };
    }

    it('lists a graph of more objects than auto draws, and draws one of that many', () => {
      mockGraph = graphOf(FORGE_GRAPH_MAX_OBJECTS + 1);
      const { unmount } = render(<ForgeDiscovery />);
      expect(screen.getByTestId('forge-table-view')).toBeDefined();
      expect(screen.queryByTestId('live-graph')).toBeNull();
      expect(screen.getByTestId('forge-view-table').getAttribute('aria-pressed')).toBe('true');
      unmount();

      mockGraph = graphOf(FORGE_GRAPH_MAX_OBJECTS);
      render(<ForgeDiscovery />);
      expect(screen.getByTestId('live-graph')).toBeDefined();
    });

    it('shows the view the setting names, whatever the graph holds', () => {
      useForgeViewStore.getState().adoptSetting('table');
      const { unmount } = render(<ForgeDiscovery />);
      expect(screen.getByTestId('forge-table-view')).toBeDefined();
      unmount();

      useForgeViewStore.getState().adoptSetting('graph');
      mockGraph = graphOf(400);
      render(<ForgeDiscovery />);
      expect(screen.getByTestId('live-graph')).toBeDefined();
    });

    it('comes back on the view picked with the switch, over the setting', () => {
      mockGraph = graphOf(400);
      const { unmount } = render(<ForgeDiscovery />);
      fireEvent.click(screen.getByTestId('forge-view-graph'));
      expect(screen.getByTestId('live-graph')).toBeDefined();
      unmount();

      render(<ForgeDiscovery />);
      expect(screen.getByTestId('live-graph')).toBeDefined();
    });
  });

  // Select All
  it('should include every node when Select All is clicked with no search', () => {
    render(<ForgeDiscovery />);
    fireEvent.click(screen.getByTestId('forge-select-all'));
    expect(mockSetNodesIncluded).toHaveBeenCalledWith(['Account', 'Contact'], true);
  });

  // Deselect All
  it('should exclude every node when Deselect All is clicked with no search', () => {
    render(<ForgeDiscovery />);
    fireEvent.click(screen.getByTestId('forge-deselect-all'));
    expect(mockSetNodesIncluded).toHaveBeenCalledWith(['Account', 'Contact'], false);
  });

  it('should only touch the rows a table search shows', () => {
    render(<ForgeDiscovery />);
    fireEvent.click(screen.getByTestId('forge-view-table'));
    fireEvent.change(screen.getByTestId('forge-node-search'), { target: { value: 'cont' } });

    fireEvent.click(screen.getByTestId('forge-deselect-all'));
    expect(mockSetNodesIncluded).toHaveBeenLastCalledWith(['Contact'], false);

    fireEvent.click(screen.getByTestId('forge-select-all'));
    expect(mockSetNodesIncluded).toHaveBeenLastCalledWith(['Contact'], true);
  });

  // Search input
  it('should render search input and accept input', () => {
    render(<ForgeDiscovery />);
    const searchInput = screen.getByTestId('forge-node-search');
    expect(searchInput).toBeDefined();
    fireEvent.change(searchInput, { target: { value: 'Account' } });
    expect((searchInput as HTMLInputElement).value).toBe('Account');
  });
});
