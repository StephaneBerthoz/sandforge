import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '../../i18n';
import { ForgeDiscovery } from './ForgeDiscovery';
import { useForgeStore } from '../../stores/useForgeStore';
import type { ForgeGraph } from '../../stores/useForgeStore';

/* ---- Mocks ---- */

const mockSendMessage = vi.fn();

vi.mock('../../hooks/useMessageBus', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../hooks/useMessageBus');
  return { ...actual, useSendMessage: () => mockSendMessage };
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

/** The request of the discovery under way. */
const DISCOVERY = 'wv-discover-1';

/** Deliver the discovery response the extension emits when the BFS finishes. */
function emitDiscoveryResponse(): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: 'discover-1',
          type: 'forge:discover:response',
          timestamp: Date.now(),
          correlationId: DISCOVERY,
          payload: { graph },
        },
      }),
    );
  });
}

describe('ForgeDiscovery — escaping a running discovery', () => {
  beforeEach(() => {
    mockSendMessage.mockClear();
    const store = useForgeStore.getState();
    store.reset();
    store.awaitDiscovery(DISCOVERY);
    store.setPhase('discovery');
  });

  it('offers a way back while the BFS is still running', () => {
    render(<ForgeDiscovery />);
    expect(screen.getByTestId('forge-discovery-loading')).toBeDefined();

    fireEvent.click(screen.getByTestId('forge-discovery-cancel'));
    expect(useForgeStore.getState().phase).toBe('input');
  });

  it('stops the running BFS when the user walks back', () => {
    render(<ForgeDiscovery />);

    fireEvent.click(screen.getByTestId('forge-discovery-cancel'));

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    // Named by its request: a stop that named nothing took every Forge
    // operation of the window, a run of another panel with it.
    expect(mockSendMessage.mock.calls[0][0]).toMatchObject({
      type: 'forge:abort',
      payload: { requestId: DISCOVERY },
    });
  });

  it('stops the BFS of a second discovery too, the first one’s graph still in the store', () => {
    // Back, then Discover again: the last discovery's graph is still there.
    useForgeStore.getState().setGraph(graph);
    useForgeStore.getState().awaitDiscovery('wv-discover-2');
    render(<ForgeDiscovery />);

    fireEvent.click(screen.getByTestId('forge-discovery-cancel'));

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage.mock.calls[0][0]).toMatchObject({
      type: 'forge:abort',
      payload: { requestId: 'wv-discover-2' },
    });
    expect(useForgeStore.getState().discoveryId).toBeNull();
  });

  it('sends no abort when leaving a discovery that already finished', () => {
    emitDiscoveryResponse();
    render(<ForgeDiscovery />);

    fireEvent.click(screen.getByTestId('forge-back-btn'));

    expect(useForgeStore.getState().phase).toBe('input');
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('adopts the graph when the response lands during the discovery phase', () => {
    render(<ForgeDiscovery />);
    emitDiscoveryResponse();
    expect(useForgeStore.getState().graph).toBe(graph);
    expect(screen.getByTestId('forge-discovery')).toBeDefined();
  });

  it('leaves the spinner for a discovery stopped to make way for a newer one, and says so', () => {
    // A newer discovery, of another panel, stopped this one: answered
    // nothing, the screen span for good.
    useForgeStore.getState().setConfig({
      inputMode: 'record',
      recordId: '001000000000001AAA',
      depth: 'direct',
      sourceOrgId: 'org-src',
      targetOrgId: 'org-tgt',
      anonymizePII: false,
      skipEmpty: false,
      batchSize: 'auto',
    });
    // A new config is a new run, which waits on no discovery until it sends one.
    useForgeStore.getState().awaitDiscovery(DISCOVERY);
    render(<ForgeDiscovery />);
    expect(screen.getByTestId('forge-discovery-loading')).toBeDefined();

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            id: 'ext-stopped',
            type: 'forge:discover:error',
            timestamp: Date.now(),
            correlationId: DISCOVERY,
            payload: {
              message: 'The discovery was stopped to make way for a newer one.',
              code: 'DISCOVERY_SUPERSEDED',
              retryable: true,
            },
          },
        }),
      );
    });

    expect(screen.queryByTestId('forge-discovery-loading')).toBeNull();
    expect(screen.getByTestId('forge-discovery-empty').textContent).toContain(
      'The discovery was stopped to make way for a newer one, from this panel or another',
    );
    expect(screen.getByTestId('forge-retry-discovery')).toBeDefined();
  });

  it('ignores a graph that lands after the user walked back to input', () => {
    render(<ForgeDiscovery />);
    fireEvent.click(screen.getByTestId('forge-discovery-cancel'));

    emitDiscoveryResponse();
    expect(useForgeStore.getState().graph).toBeNull();
  });
});
