import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import '../../i18n';
import { ForgeDiscovery } from './ForgeDiscovery';
import type { ForgeGraph, ForgeGraphNode } from '../../stores/useForgeStore';

/* ---- Mocks ---- */

const mockSetPhase = vi.fn();
const mockToggleNodeIncluded = vi.fn();
const mockToggleAnonymizeField = vi.fn();
const mockSetAllNodesIncluded = vi.fn();
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
    setAllNodesIncluded: (...args: unknown[]) => mockSetAllNodesIncluded(...args),
    setResult: vi.fn(),
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
    mockSetAllNodesIncluded.mockClear();
    mockSendMessage.mockClear();
    mockGraph = defaultGraph;
    mockConfig = null;
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

  it('should show loading state when graph is null (waiting for discovery)', () => {
    mockGraph = null;
    render(<ForgeDiscovery />);
    expect(screen.getByTestId('forge-discovery-loading')).toBeDefined();
  });

  it('should show empty state when discovery response returns error', async () => {
    mockGraph = null;
    render(<ForgeDiscovery />);
    // Simulate error response from extension
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            id: 'test-1',
            type: 'forge:discover:error',
            timestamp: Date.now(),
            payload: { message: 'Discovery failed' },
          },
        }),
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId('forge-discovery-empty')).toBeDefined();
    });
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

  // UX-20: Retry discovery
  it('should show retry button on error state when config is set', async () => {
    mockGraph = null;
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
    // Simulate error
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            id: 'test-retry',
            type: 'forge:discover:error',
            timestamp: Date.now(),
            payload: { message: 'Discovery failed' },
          },
        }),
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId('forge-retry-discovery')).toBeDefined();
    });
    // Click retry
    fireEvent.click(screen.getByTestId('forge-retry-discovery'));
    expect(mockSendMessage).toHaveBeenCalled();
  });

  // UX-11: View mode toggle
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

  // UX-21: Select All
  it('should call setAllNodesIncluded(true) when Select All is clicked', () => {
    render(<ForgeDiscovery />);
    fireEvent.click(screen.getByTestId('forge-select-all'));
    expect(mockSetAllNodesIncluded).toHaveBeenCalledWith(true);
  });

  // UX-21: Deselect All
  it('should call setAllNodesIncluded(false) when Deselect All is clicked', () => {
    render(<ForgeDiscovery />);
    fireEvent.click(screen.getByTestId('forge-deselect-all'));
    expect(mockSetAllNodesIncluded).toHaveBeenCalledWith(false);
  });

  // UX-22: Search input
  it('should render search input and accept input', () => {
    render(<ForgeDiscovery />);
    const searchInput = screen.getByTestId('forge-node-search');
    expect(searchInput).toBeDefined();
    fireEvent.change(searchInput, { target: { value: 'Account' } });
    expect((searchInput as HTMLInputElement).value).toBe('Account');
  });
});
