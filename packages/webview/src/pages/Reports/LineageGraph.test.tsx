import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { LineageGraph } from './LineageGraph';
import type { DataLineageGraph } from '@sandforge/shared';

/* Mock ReactFlow since it requires a DOM with specific measurements */
vi.mock('reactflow', () => ({
  __esModule: true,
  default: ({ nodes, edges }: { nodes: unknown[]; edges: unknown[] }) => (
    <div data-testid="mock-reactflow" data-nodes={nodes.length} data-edges={edges.length} />
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
});
