import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ReactFlowProvider } from 'reactflow';
import { RelationEdge } from './RelationEdge';
import type { RelationEdgeData } from './RelationEdge';
import type { EdgeProps } from 'reactflow';
import { Position } from 'reactflow';

/** Minimal EdgeProps wrapper for testing a custom edge. */
function makeEdgeProps(
  data: RelationEdgeData,
  overrides?: Partial<EdgeProps<RelationEdgeData>>,
): EdgeProps<RelationEdgeData> {
  return {
    id: 'test-edge',
    source: 'Account',
    target: 'Contact',
    sourceX: 0,
    sourceY: 0,
    targetX: 200,
    targetY: 150,
    sourcePosition: Position.Bottom,
    targetPosition: Position.Top,
    data,
    sourceHandleId: null,
    targetHandleId: null,
    markerStart: undefined,
    markerEnd: undefined,
    interactionWidth: 20,
    selected: false,
    animated: false,
    label: undefined,
    labelStyle: undefined,
    labelShowBg: undefined,
    labelBgStyle: undefined,
    labelBgPadding: undefined,
    labelBgBorderRadius: undefined,
    style: undefined,
    pathOptions: undefined,
    ...overrides,
  };
}

/** Render helper wrapping the edge in SVG + ReactFlowProvider. */
function renderRelationEdge(data: RelationEdgeData) {
  return render(
    <ReactFlowProvider>
      <svg>
        <RelationEdge {...makeEdgeProps(data)} />
      </svg>
    </ReactFlowProvider>,
  );
}

describe('RelationEdge', () => {
  it('should render a lookup edge', () => {
    const { container } = renderRelationEdge({
      relationshipType: 'lookup',
      required: false,
      isActive: false,
    });
    const g = container.querySelector('[data-testid="relation-edge"]');
    expect(g).not.toBeNull();
  });

  it('should render a master_detail edge', () => {
    const { container } = renderRelationEdge({
      relationshipType: 'master_detail',
      required: true,
      isActive: false,
    });
    const path = container.querySelector('path[id="test-edge"]');
    expect(path).not.toBeNull();
    expect(path?.getAttribute('stroke')).toBe('#f59e0b');
  });

  it('should render a hierarchical edge', () => {
    const { container } = renderRelationEdge({
      relationshipType: 'hierarchical',
      required: false,
      isActive: false,
    });
    const path = container.querySelector('path[id="test-edge"]');
    expect(path).not.toBeNull();
    expect(path?.getAttribute('stroke')).toBe('#06b6d4');
  });

  it('should render a polymorphic edge with diamond marker', () => {
    const { container } = renderRelationEdge({
      relationshipType: 'polymorphic',
      required: false,
      isActive: false,
    });
    const path = container.querySelector('path[id="test-edge"]');
    expect(path).not.toBeNull();
    expect(path?.getAttribute('marker-end')).toContain('sf-diamond-marker');
  });

  it('should apply dash animation when active', () => {
    const { container } = renderRelationEdge({
      relationshipType: 'lookup',
      required: false,
      isActive: true,
    });
    const path = container.querySelector('path[id="test-edge"]');
    expect(path).not.toBeNull();
    expect(path?.getAttribute('stroke-dasharray')).toBeTruthy();
  });
});
