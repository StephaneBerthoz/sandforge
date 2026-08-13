import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '../../i18n';
import { ForgeDiscovery } from './ForgeDiscovery';
import type { ForgeGraph } from '../../stores/useForgeStore';

/* ---- Mocks ---- */

const mockSetPhase = vi.fn();
const mockSetGraph = vi.fn();

/** Phase the mocked forge store reports; the late-response guard reads it. */
let mockPhase: 'input' | 'discovery' = 'discovery';

vi.mock('../../stores/useForgeStore', () => {
  const defaultState = {
    graph: null,
    config: null,
    get phase() {
      return mockPhase;
    },
    templates: [],
    result: null,
    history: [],
    setConfig: vi.fn(),
    setPhase: (...args: unknown[]) => mockSetPhase(...args),
    setGraph: (...args: unknown[]) => mockSetGraph(...args),
    updateNodeStatus: vi.fn(),
    toggleNodeIncluded: vi.fn(),
    toggleAnonymizeField: vi.fn(),
    setAllNodesIncluded: vi.fn(),
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
  return { ...actual, useSendMessage: () => vi.fn() };
});

vi.mock('../../components/graph/LiveGraph', () => ({
  LiveGraph: () => <div data-testid="live-graph" />,
}));

vi.mock('../../components/ui/SplitView', () => ({
  SplitView: ({ left, right }: { left: React.ReactNode; right: React.ReactNode }) => (
    <div>
      {left}
      {right}
    </div>
  ),
}));

const graph: ForgeGraph = {
  nodes: [],
  edges: [],
  totalRecords: 0,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 0,
};

/** Deliver the discovery response the extension emits when the BFS finishes. */
function emitDiscoveryResponse(): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: 'discover-1',
          type: 'forge:discover:response',
          timestamp: Date.now(),
          payload: { graph },
        },
      }),
    );
  });
}

describe('ForgeDiscovery — escaping a running discovery', () => {
  beforeEach(() => {
    mockSetPhase.mockClear();
    mockSetGraph.mockClear();
    mockPhase = 'discovery';
  });

  it('offers a way back while the BFS is still running', () => {
    render(<ForgeDiscovery />);
    expect(screen.getByTestId('forge-discovery-loading')).toBeDefined();

    fireEvent.click(screen.getByTestId('forge-discovery-cancel'));
    expect(mockSetPhase).toHaveBeenCalledWith('input');
  });

  it('adopts the graph when the response lands during the discovery phase', () => {
    render(<ForgeDiscovery />);
    emitDiscoveryResponse();
    expect(mockSetGraph).toHaveBeenCalledWith(graph);
  });

  it('ignores a graph that lands after the user walked back to input', () => {
    render(<ForgeDiscovery />);
    fireEvent.click(screen.getByTestId('forge-discovery-cancel'));
    mockPhase = 'input';

    emitDiscoveryResponse();
    expect(mockSetGraph).not.toHaveBeenCalled();
  });
});
