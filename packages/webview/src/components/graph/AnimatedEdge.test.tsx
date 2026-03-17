import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { AnimatedEdge } from './AnimatedEdge';
import type { AnimatedEdgeData } from './AnimatedEdge';
import type { EdgeProps } from 'reactflow';
import { Position } from 'reactflow';

vi.mock('reactflow', async () => {
  const actual = await vi.importActual<typeof import('reactflow')>('reactflow');
  return {
    ...actual,
    getBezierPath: () => ['M 0 0 C 50 0 50 100 100 100', 50, 50] as const,
    Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
  };
});

/** Build minimal EdgeProps for testing. */
function makeEdgeProps(overrides: Partial<AnimatedEdgeData> = {}): EdgeProps<AnimatedEdgeData> {
  return {
    id: 'edge-1',
    source: 'node-a',
    target: 'node-b',
    sourceX: 0,
    sourceY: 0,
    targetX: 100,
    targetY: 100,
    sourcePosition: Position.Bottom,
    targetPosition: Position.Top,
    sourceHandleId: null,
    targetHandleId: null,
    data: {
      relationshipType: 'lookup',
      relationshipName: 'Contacts',
      ...overrides,
    },
    selected: false,
    animated: false,
    interactionWidth: 10,
  };
}

describe('AnimatedEdge', () => {
  it('should render a path element', () => {
    const { container } = render(
      <svg>
        <AnimatedEdge {...makeEdgeProps()} />
      </svg>,
    );
    const paths = container.querySelectorAll('path');
    // 2 paths: invisible hit area + visible
    expect(paths.length).toBe(2);
  });

  it('should render as dashed for lookup relationships', () => {
    const { container } = render(
      <svg>
        <AnimatedEdge {...makeEdgeProps({ relationshipType: 'lookup' })} />
      </svg>,
    );
    const visiblePath = container.querySelectorAll('path')[1];
    expect(visiblePath?.getAttribute('stroke-dasharray')).toBe('5,5');
  });

  it('should render with strokeWidth 2 for master-detail relationships', () => {
    const { container } = render(
      <svg>
        <AnimatedEdge {...makeEdgeProps({ relationshipType: 'master-detail' })} />
      </svg>,
    );
    const visiblePath = container.querySelectorAll('path')[1];
    expect(visiblePath?.getAttribute('stroke-width')).toBe('2');
  });

  it('should render with strokeWidth 1 for lookup relationships', () => {
    const { container } = render(
      <svg>
        <AnimatedEdge {...makeEdgeProps({ relationshipType: 'lookup' })} />
      </svg>,
    );
    const visiblePath = container.querySelectorAll('path')[1];
    expect(visiblePath?.getAttribute('stroke-width')).toBe('1');
  });

  it('should render the relationship name as label text', () => {
    const { container } = render(
      <svg>
        <AnimatedEdge {...makeEdgeProps({ relationshipName: 'Opportunities' })} />
      </svg>,
    );
    const text = container.querySelector('text');
    expect(text?.textContent).toBe('Opportunities');
  });

  it('should not render label when relationshipName is empty', () => {
    const { container } = render(
      <svg>
        <AnimatedEdge {...makeEdgeProps({ relationshipName: '' })} />
      </svg>,
    );
    const text = container.querySelector('text');
    expect(text).toBeNull();
  });

  it('should have data-testid on the group element', () => {
    const { container } = render(
      <svg>
        <AnimatedEdge {...makeEdgeProps()} />
      </svg>,
    );
    const group = container.querySelector('[data-testid="animated-edge"]');
    expect(group).not.toBeNull();
  });
});
