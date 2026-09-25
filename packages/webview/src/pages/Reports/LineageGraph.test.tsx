import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { LineageGraph } from './LineageGraph';
import type { DataLineageGraph } from '@sandforge/shared';

/*
 * Mock ReactFlow since it requires a DOM with specific measurements. It writes
 * out what React Flow would draw as text — node labels, edge labels — and where
 * each node sits, so what the graph hands it can be read.
 */
vi.mock('@xyflow/react', () => ({
  __esModule: true,
  ReactFlow: ({
    nodes,
    edges,
  }: {
    nodes: Array<{ id: string; data: { label: string }; position: { x: number } }>;
    edges: Array<{ id: string; label?: string }>;
  }) => (
    <div data-testid="mock-reactflow" data-nodes={nodes.length} data-edges={edges.length}>
      {nodes.map((n) => (
        <span key={n.id} data-testid={`node-${n.id}`} data-x={n.position.x}>
          {n.data.label}
        </span>
      ))}
      {edges.map((e) =>
        e.label ? (
          <span key={e.id} data-testid={`edge-label-${e.id}`}>
            {e.label}
          </span>
        ) : null,
      )}
    </div>
  ),
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
}));

const lineage: DataLineageGraph = {
  nodes: [
    { id: 'n1', type: 'source', label: 'Prod Account', objectApiName: 'Account', orgId: 'prod' },
    { id: 'n2', type: 'transform', label: 'Uppercase Name' },
    { id: 'n3', type: 'filter', label: 'Active Only' },
    { id: 'n4', type: 'destination', label: 'Dev Account', objectApiName: 'Account', orgId: 'dev' },
  ],
  edges: [
    { sourceId: 'n1', targetId: 'n2', recordCount: 500 },
    { sourceId: 'n2', targetId: 'n3', label: 'transform' },
    { sourceId: 'n3', targetId: 'n4', recordCount: 350 },
  ],
  operationId: 'op-1',
  generatedAt: '2026-02-20T10:00:00Z',
};

describe('LineageGraph', () => {
  it('should render the lineage graph', () => {
    render(<LineageGraph lineage={lineage} />);
    expect(screen.getByTestId('lineage-graph')).toBeDefined();
  });

  it('should show empty state when no lineage', () => {
    render(<LineageGraph />);
    expect(screen.getByText('No lineage data available')).toBeDefined();
  });

  it('should show legend', () => {
    render(<LineageGraph lineage={lineage} />);
    expect(screen.getByTestId('lineage-legend')).toBeDefined();
  });

  it('should show node/edge counts', () => {
    render(<LineageGraph lineage={lineage} />);
    expect(screen.getByText(/4 nodes/)).toBeDefined();
    expect(screen.getByText(/3 edges/)).toBeDefined();
  });

  it('should render ReactFlow graph', () => {
    render(<LineageGraph lineage={lineage} />);
    expect(screen.getByTestId('mock-reactflow')).toBeDefined();
  });

  it('should pass correct node and edge counts to ReactFlow', () => {
    render(<LineageGraph lineage={lineage} />);
    const flow = screen.getByTestId('mock-reactflow');
    expect(flow.getAttribute('data-nodes')).toBe('4');
    expect(flow.getAttribute('data-edges')).toBe('3');
  });

  it('should show lineage title', () => {
    render(<LineageGraph lineage={lineage} />);
    expect(screen.getByText('Data Lineage')).toBeDefined();
  });

  it('should accept custom className', () => {
    const { container } = render(<LineageGraph lineage={lineage} className="custom-class" />);
    expect((container.firstChild as HTMLElement).className).toContain('custom-class');
  });

  describe('a run traced as it is recorded', () => {
    /** Generated records, two objects, one sandbox: what a seed run records. */
    const seedRun: DataLineageGraph = {
      operationId: 'op-seed',
      generatedAt: '2026-09-02T08:00:00.000Z',
      module: 'seed',
      action: 'seed_execute',
      nodes: [
        { id: 'source', type: 'source', label: 'Demo accounts', origin: 'generator' },
        { id: 'object:Account', type: 'object', label: 'Account', recordCount: 1 },
        { id: 'object:Contact', type: 'object', label: 'Contact', recordCount: 12 },
        { id: 'target', type: 'destination', label: 'target-sandbox', origin: 'org' },
      ],
      edges: [
        { sourceId: 'source', targetId: 'object:Account' },
        { sourceId: 'object:Account', targetId: 'target', recordCount: 1 },
        { sourceId: 'source', targetId: 'object:Contact' },
        { sourceId: 'object:Contact', targetId: 'target', recordCount: 12 },
      ],
    };

    it('names a source that is not an org by what it is, then by its own label', () => {
      render(<LineageGraph lineage={seedRun} />);

      expect(screen.getByTestId('node-source').textContent).toBe('Generated data · Demo accounts');
      expect(screen.getByTestId('node-target').textContent).toBe('target-sandbox');
    });

    it('counts the records on the way in, in the reader’s language', () => {
      render(<LineageGraph lineage={seedRun} />);

      expect(screen.getByTestId('edge-label-ledge-1').textContent).toBe('1 record');
      expect(screen.getByTestId('edge-label-ledge-3').textContent).toBe('12 records');
    });

    it('draws source, objects and target in three columns, with no empty one between', () => {
      render(<LineageGraph lineage={seedRun} />);

      const x = (id: string) => Number(screen.getByTestId(`node-${id}`).getAttribute('data-x'));
      expect([x('source'), x('object:Account'), x('target')]).toEqual([20, 240, 460]);
      expect(x('object:Contact')).toBe(240);
    });

    it('lists in its legend only the kinds of node it draws', () => {
      render(<LineageGraph lineage={seedRun} />);

      expect(screen.getByTestId('lineage-legend').textContent).toBe('SourceObjectDestination');
    });
  });
});
