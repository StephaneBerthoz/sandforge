import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReactFlowProvider } from 'reactflow';
import '../../../i18n';
import { AutopilotGraph } from './AutopilotGraph';

/** Polyfill ResizeObserver for jsdom (required by ReactFlow). */
beforeAll(() => {
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

  /** Polyfill DOMMatrixReadOnly for jsdom (required by ReactFlow d3-zoom). */
  if (typeof globalThis.DOMMatrixReadOnly === 'undefined') {
    globalThis.DOMMatrixReadOnly = class DOMMatrixReadOnly {
      m22: number;
      constructor() {
        this.m22 = 1;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  }

  /** Stub missing SVG element methods used by ReactFlow. */
  if (typeof SVGElement !== 'undefined') {
    Object.defineProperty(SVGElement.prototype, 'getScreenCTM', {
      value: () => ({ inverse: () => ({ m22: 1 }) }),
      writable: true,
    });
    Object.defineProperty(SVGElement.prototype, 'createSVGMatrix', {
      value: () => ({ inverse: () => ({}), multiply: () => ({}) }),
      writable: true,
    });
  }

  /** Stub getBoundingClientRect for jsdom elements used by ReactFlow. */
  Element.prototype.getBoundingClientRect = vi.fn(() => ({
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    top: 0,
    right: 800,
    bottom: 600,
    left: 0,
    toJSON: () => ({}),
  }));
});

/** Mock the autopilot store. */
vi.mock('../../../stores/useAutopilotStore', () => ({
  useAutopilotStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      graph: null,
      selectedNodeName: null,
      selectNode: vi.fn(),
    }),
}));

/** Render helper wrapping the graph in ReactFlowProvider. */
function renderAutopilotGraph() {
  return render(
    <ReactFlowProvider>
      <div style={{ width: 800, height: 600 }}>
        <AutopilotGraph />
      </div>
    </ReactFlowProvider>,
  );
}

describe('AutopilotGraph', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render the graph container', () => {
    renderAutopilotGraph();
    expect(screen.getByTestId('autopilot-graph')).toBeDefined();
  });

  it('should render the legend', () => {
    renderAutopilotGraph();
    expect(screen.getByTestId('graph-legend')).toBeDefined();
  });

  it('should render graph controls', () => {
    renderAutopilotGraph();
    expect(screen.getByTestId('graph-controls')).toBeDefined();
  });

  it('should render empty graph when store has no graph data', () => {
    renderAutopilotGraph();
    // No nodes should be rendered
    expect(screen.queryByTestId('object-node')).toBeNull();
  });
});
