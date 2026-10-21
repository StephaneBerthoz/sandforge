import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ForgeGraph } from '@sandforge/shared';

/**
 * When the live graph's library loads. The stand-in notes when its module is
 * evaluated: the Forge steps imported it up front, so every panel showing
 * Forge parsed React Flow and dagre before its input step, which draws none.
 */
const evaluated = vi.hoisted(() => new Set<string>());

vi.mock('./LiveGraph', () => {
  evaluated.add('LiveGraph');
  return {
    LiveGraph: ({ graph, className }: { graph: ForgeGraph; className?: string }) => (
      <div data-testid="live-graph" className={className}>
        {graph.nodes.length}
      </div>
    ),
  };
});

import { LiveGraph } from './lazyGraph';

const GRAPH = { rootObject: 'Account', nodes: [], edges: [] } as unknown as ForgeGraph;

describe('the live graph, loaded with the first graph drawn', () => {
  it('holds the box it is given while it loads, then draws the graph with the props it was given', async () => {
    expect([...evaluated]).toEqual([]);

    render(<LiveGraph graph={GRAPH} className="h-full" />);

    const placeholder = screen.getByTestId('live-graph-loading');
    expect(placeholder.getAttribute('aria-busy')).toBe('true');
    expect(placeholder.className).toContain('h-full');
    const graph = await screen.findByTestId('live-graph');
    expect(graph.className).toBe('h-full');
    expect(graph.textContent).toBe('0');
    expect([...evaluated]).toEqual(['LiveGraph']);
  });
});
