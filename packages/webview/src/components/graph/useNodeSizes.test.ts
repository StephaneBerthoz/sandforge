import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { Node, NodeChange } from '@xyflow/react';
import { useNodeSizes } from './useNodeSizes';

/** A size React Flow reports for a node it measured. */
const measured = (id: string, width: number, height: number): NodeChange<Node> => ({
  id,
  type: 'dimensions',
  dimensions: { width, height },
});

describe('useNodeSizes', () => {
  it('keeps the size React Flow reports for each node, the last one for a node measured again', () => {
    const { result } = renderHook(() => useNodeSizes<Node>());

    act(() =>
      result.current.onNodesChange([measured('Account', 200, 84), measured('Contact', 200, 96)]),
    );
    act(() => result.current.onNodesChange([measured('Contact', 200, 108)]));

    expect([...result.current.sizes]).toEqual([
      ['Account', { width: 200, height: 84 }],
      ['Contact', { width: 200, height: 108 }],
    ]);
  });

  it('makes no new map when every size reported is the one it holds, nor for any other change', () => {
    // A new map rebuilds every node of the graph: an update that measures
    // the nodes at their known sizes, a selection or a drag must not.
    const { result } = renderHook(() => useNodeSizes<Node>());
    act(() => result.current.onNodesChange([measured('Account', 200, 84)]));
    const held = result.current.sizes;

    act(() =>
      result.current.onNodesChange([
        measured('Account', 200, 84),
        { id: 'Account', type: 'select', selected: true },
        { id: 'Account', type: 'position', position: { x: 10, y: 20 } },
        { id: 'Account', type: 'dimensions' },
      ]),
    );

    expect(result.current.sizes).toBe(held);
  });
});
