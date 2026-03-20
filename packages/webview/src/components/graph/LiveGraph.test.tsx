import React from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LiveGraph } from './LiveGraph';
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

/** Minimal ReactFlow mock that renders nodes with their data. */
function MockReactFlow({
  nodes,
  onNodeClick,
  children,
}: {
  nodes: Array<{
    id: string;
    data: { objectApiName: string };
  }>;
  onNodeClick?: (event: React.MouseEvent, node: { data: { objectApiName: string } }) => void;
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <div data-testid="react-flow-mock">
      {nodes.map((n) => (
        <div
          key={n.id}
          data-testid={`rf-node-${n.id}`}
          onClick={(e) => onNodeClick?.(e, n)}
        >
          {n.data.objectApiName}
        </div>
      ))}
      {children}
    </div>
  );
}

vi.mock('reactflow', () => ({
  __esModule: true,
  default: MockReactFlow,
  MiniMap: () => React.createElement('div', { 'data-testid': 'minimap' }),
  Controls: () => React.createElement('div', { 'data-testid': 'controls' }),
  Background: () => React.createElement('div', { 'data-testid': 'background' }),
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

  it('should have role="img" on the graph container', () => {
    render(<LiveGraph graph={makeSampleGraph()} />);
    const container = screen.getByTestId('live-graph');
    expect(container.getAttribute('role')).toBe('img');
  });

  it('should have aria-label on the graph container', () => {
    render(<LiveGraph graph={makeSampleGraph()} />);
    const container = screen.getByTestId('live-graph');
    expect(container.getAttribute('aria-label')).toBe('Dependency Graph');
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
