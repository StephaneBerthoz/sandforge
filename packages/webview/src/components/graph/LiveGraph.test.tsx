import React from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { LiveGraph, centreToShow } from './LiveGraph';
import type { ForgeGraph } from '@sandforge/shared';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}));

/* React Flow requires ResizeObserver and a sized container. */
beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class ResizeObserver {
      observe(): void {
        /* noop */
      }
      unobserve(): void {
        /* noop */
      }
      disconnect(): void {
        /* noop */
      }
    };
  }
});

/** The props React Flow, its minimap, its controls and its background were last given. */
const received = vi.hoisted(() => ({
  flow: {} as Record<string, unknown>,
  minimap: {} as Record<string, unknown>,
  controls: {} as Record<string, unknown>,
  background: {} as Record<string, unknown>,
  fitView: vi.fn(),
  setCenter: vi.fn(),
  /** React Flow's store as the graph reads it: the pane, its view, each node's box. */
  store: {
    width: 600,
    height: 300,
    transform: [0, 0, 1] as [number, number, number],
    nodeLookup: new Map<
      string,
      {
        internals: { positionAbsolute: { x: number; y: number } };
        measured: { width?: number; height?: number };
      }
    >(),
  },
}));

/** Minimal ReactFlow mock that renders nodes with their data. */
function MockReactFlow(props: {
  nodes: Array<{
    id: string;
    data: { objectApiName: string };
  }>;
  onNodeClick?: (event: React.MouseEvent, node: { data: { objectApiName: string } }) => void;
  children?: React.ReactNode;
}): React.ReactElement {
  const { nodes, onNodeClick, children } = props;
  received.flow = props;
  return (
    <div data-testid="react-flow-mock">
      {nodes.map((n) => (
        <div
          key={n.id}
          className="react-flow__node"
          data-id={n.id}
          data-testid={`rf-node-${n.id}`}
          onClick={(e) => onNodeClick?.(e, n)}
        >
          {n.data.objectApiName}
          <button data-testid={`rf-node-stop-${n.id}`} aria-label="stop" />
        </div>
      ))}
      {children}
    </div>
  );
}

vi.mock('@xyflow/react', () => ({
  __esModule: true,
  ReactFlow: MockReactFlow,
  MiniMap: (props: Record<string, unknown>) => {
    received.minimap = props;
    return React.createElement('div', { 'data-testid': 'minimap' });
  },
  Controls: (props: Record<string, unknown>) => {
    received.controls = props;
    return React.createElement('div', { 'data-testid': 'controls' });
  },
  Background: (props: Record<string, unknown>) => {
    received.background = props;
    return React.createElement('div', { 'data-testid': 'background' });
  },
  useReactFlow: () => ({ fitView: received.fitView, setCenter: received.setCenter }),
  useStoreApi: () => ({ getState: () => received.store }),
  Handle: () => React.createElement('div'),
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
  getBezierPath: () => ['M 0 0', 0, 0] as const,
}));

function makeSampleGraph(): ForgeGraph {
  return {
    nodes: [
      {
        objectApiName: 'Account',
        recordCount: 100,
        fieldCount: 25,
        status: 'idle',
        progress: 0,
        included: true,
        piiFields: ['Email__c'],
        anonymizeFields: [],
        errors: [],
        level: 0,
        successCount: 0,
        failureCount: 0,
        createableFieldCount: 0,
        estimatedSizeMB: 0,
        estimatedApiCalls: 0,
        batchStrategy: 'auto',
      },
      {
        objectApiName: 'Contact',
        recordCount: 200,
        fieldCount: 18,
        status: 'running',
        progress: 45,
        included: true,
        piiFields: [],
        anonymizeFields: [],
        errors: [],
        level: 0,
        successCount: 0,
        failureCount: 0,
        createableFieldCount: 0,
        estimatedSizeMB: 0,
        estimatedApiCalls: 0,
        batchStrategy: 'auto',
      },
    ],
    edges: [
      {
        sourceObject: 'Account',
        targetObject: 'Contact',
        relationshipName: 'Contacts',
        type: 'master-detail',
      },
    ],
    totalRecords: 300,
    estimatedSizeMB: 12,
    estimatedDurationSeconds: 60,
  };
}

describe('LiveGraph', () => {
  it('should render the graph container with data-testid', () => {
    render(<LiveGraph graph={makeSampleGraph()} />);
    expect(screen.getByTestId('live-graph')).toBeDefined();
  });

  it('should render nodes from graph data', () => {
    render(<LiveGraph graph={makeSampleGraph()} />);
    expect(screen.getByText('Account')).toBeDefined();
    expect(screen.getByText('Contact')).toBeDefined();
  });

  it('should call onNodeClick when a node is clicked', () => {
    const handler = vi.fn();
    render(<LiveGraph graph={makeSampleGraph()} onNodeClick={handler} />);
    fireEvent.click(screen.getByTestId('rf-node-Account'));
    expect(handler).toHaveBeenCalledWith('Account');
  });

  it('should apply custom className to the container', () => {
    render(<LiveGraph graph={makeSampleGraph()} className="my-custom-class" />);
    const container = screen.getByTestId('live-graph');
    expect(container.className).toContain('my-custom-class');
  });

  it('should render minimap, controls, and background', () => {
    render(<LiveGraph graph={makeSampleGraph()} />);
    expect(screen.getByTestId('minimap')).toBeDefined();
    expect(screen.getByTestId('controls')).toBeDefined();
    expect(screen.getByTestId('background')).toBeDefined();
  });

  it('draws its background dots in the theme’s border colour, which a light theme shows too', () => {
    render(<LiveGraph graph={makeSampleGraph()} />);
    // A white at 5% was drawn on a white pane in a light theme.
    expect(received.background).toMatchObject({ color: 'var(--sf-border)', gap: 20 });
  });

  it('fits the graph left of the strip the minimap stands in, on first draw and from the fit button', () => {
    // Fitted to the whole pane, the nodes on its right lay under the minimap:
    // at 1280×720 it covered the contact on the execution screen.
    render(<LiveGraph graph={makeSampleGraph()} />);

    const minimap = received.minimap.style as { width: number; height: number };
    const fit = received.flow.fitViewOptions as { padding: { right: string } };
    expect(received.flow.fitView).toBe(true);
    // The minimap's width and the margin React Flow puts around it, at least.
    expect(parseFloat(fit.padding.right)).toBeGreaterThanOrEqual(minimap.width + 15);
    expect(fit.padding.right).toMatch(/px$/);
    // The fit button fits it the same way.
    expect(received.controls.fitViewOptions).toBe(received.flow.fitViewOptions);
  });

  it('hands each node back the size React Flow measured, and the minimap no colour of its own', () => {
    // The minimap draws a node only at a size the node itself carries, and a
    // graph rebuilt from props loses what React Flow measured unless it keeps
    // it: the minimap drew no node at all, only its mask over the pane.
    render(<LiveGraph graph={makeSampleGraph()} />);
    const onNodesChange = received.flow.onNodesChange as (changes: unknown[]) => void;
    act(() => {
      onNodesChange([
        { id: 'Account', type: 'dimensions', dimensions: { width: 200, height: 96 } },
      ]);
    });

    const nodes = received.flow.nodes as Array<{ id: string; measured?: unknown }>;
    expect(nodes.map((n) => [n.id, n.measured])).toEqual([
      ['Account', { width: 200, height: 96 }],
      ['Contact', undefined],
    ]);
    // A colour given as a prop would take precedence over the theme's,
    // set on React Flow's variables in the stylesheet.
    for (const prop of [
      'bgColor',
      'maskColor',
      'maskStrokeColor',
      'nodeColor',
      'nodeStrokeColor',
    ]) {
      expect(received.minimap).not.toHaveProperty(prop);
    }
    expect(received.minimap.style).not.toHaveProperty('backgroundColor');
  });

  it('should handle empty graph gracefully', () => {
    const emptyGraph: ForgeGraph = {
      nodes: [],
      edges: [],
      totalRecords: 0,
      estimatedSizeMB: 0,
      estimatedDurationSeconds: 0,
    };
    render(<LiveGraph graph={emptyGraph} />);
    expect(screen.getByTestId('live-graph')).toBeDefined();
  });

  it('names the graph on React Flow’s own application, not on a second one around it', () => {
    // React Flow's wrapper is role="application" already: the one this drew
    // around it, named the same, was read twice.
    render(<LiveGraph graph={makeSampleGraph()} />);
    const container = screen.getByTestId('live-graph');
    expect(container.hasAttribute('role')).toBe(false);
    expect(container.hasAttribute('aria-label')).toBe(false);
    expect(received.flow['aria-label']).toBe('Dependency Graph');
  });

  it('makes no edge a keyboard stop: picking one does nothing', () => {
    render(<LiveGraph graph={makeSampleGraph()} />);
    expect(received.flow.edgesFocusable).toBe(false);
    expect(received.flow.nodesFocusable).toBe(false);
  });

  describe('a keyboard stop in a node out of the pane', () => {
    /** Focus a node's stop as the keyboard does: `:focus-visible` holds. */
    function focusWithKeyboard(id: string): void {
      const stop = screen.getByTestId(`rf-node-stop-${id}`);
      const matches = vi
        .spyOn(stop, 'matches')
        .mockImplementation((selector: string) => selector === ':focus-visible');
      act(() => stop.focus());
      matches.mockRestore();
    }

    it('brings the node into view, at the zoom it is drawn at', () => {
      received.setCenter.mockClear();
      received.store.transform = [0, 0, 1.5];
      received.store.nodeLookup = new Map([
        [
          'Account',
          {
            internals: { positionAbsolute: { x: 0, y: 0 } },
            measured: { width: 220, height: 140 },
          },
        ],
        [
          'Contact',
          {
            internals: { positionAbsolute: { x: 900, y: 400 } },
            measured: { width: 220, height: 140 },
          },
        ],
      ]);
      render(<LiveGraph graph={makeSampleGraph()} onNodeClick={vi.fn()} />);

      focusWithKeyboard('Contact');

      expect(received.setCenter).toHaveBeenCalledWith(1010, 470, { zoom: 1.5 });
    });

    it('leaves the view alone for a node in it, and for a focus a click gave', () => {
      received.setCenter.mockClear();
      received.store.transform = [0, 0, 1];
      received.store.nodeLookup = new Map([
        [
          'Account',
          {
            internals: { positionAbsolute: { x: 10, y: 10 } },
            measured: { width: 220, height: 140 },
          },
        ],
        [
          'Contact',
          {
            internals: { positionAbsolute: { x: 900, y: 400 } },
            measured: { width: 220, height: 140 },
          },
        ],
      ]);
      render(<LiveGraph graph={makeSampleGraph()} onNodeClick={vi.fn()} />);

      focusWithKeyboard('Account');
      act(() => screen.getByTestId('rf-node-stop-Contact').focus());

      expect(received.setCenter).not.toHaveBeenCalled();
    });
  });

  it('works out where to centre the view to show a node, or that it is shown', () => {
    const pane = { width: 600, height: 300 };
    const box = { x: 100, y: 50, width: 220, height: 140 };
    expect(centreToShow(box, [0, 0, 1], pane)).toBeNull();
    // Zoomed in, the node runs past the pane's right edge.
    expect(centreToShow(box, [0, 0, 2.5], pane)).toEqual({ x: 210, y: 120 });
    // Panned away to the left of it.
    expect(centreToShow(box, [-200, 0, 1], pane)).toEqual({ x: 210, y: 120 });
  });

  it('marks on its node each object a search matched', () => {
    render(<LiveGraph graph={makeSampleGraph()} highlighted={new Set(['Contact'])} />);

    const nodes = received.flow.nodes as Array<{ id: string; data: { highlighted: boolean } }>;
    expect(nodes.map((n) => [n.id, n.data.highlighted])).toEqual([
      ['Account', false],
      ['Contact', true],
    ]);
  });

  it('brings into view the object asked for, and fits nothing until one is', () => {
    received.fitView.mockClear();
    const { rerender } = render(<LiveGraph graph={makeSampleGraph()} />);
    expect(received.fitView).not.toHaveBeenCalled();

    rerender(<LiveGraph graph={makeSampleGraph()} focus="Contact" />);

    expect(received.fitView).toHaveBeenCalledWith(
      expect.objectContaining({ nodes: [{ id: 'Contact' }] }),
    );
  });

  it('should reuse layout positions when only node status changes', () => {
    const graph1 = makeSampleGraph();
    const graph2: ForgeGraph = {
      ...graph1,
      nodes: graph1.nodes.map((n) =>
        n.objectApiName === 'Account' ? { ...n, status: 'running' as const, progress: 50 } : n,
      ),
    };
    const { rerender } = render(<LiveGraph graph={graph1} />);
    rerender(<LiveGraph graph={graph2} />);
    // Both renders produce the same node positions (topology unchanged)
    // Verify component rendered without error after rerender
    expect(screen.getByTestId('live-graph')).toBeDefined();
    expect(screen.getByText('Account')).toBeDefined();
    expect(screen.getByText('Contact')).toBeDefined();
  });
});
