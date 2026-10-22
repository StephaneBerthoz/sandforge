import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import type { ForgeGraph } from '@sandforge/shared';

/**
 * When the live graph's library loads. The stand-in notes when its module is
 * evaluated: the Forge steps imported it up front, so every panel showing
 * Forge parsed React Flow and dagre before its input step, which draws none.
 */
const evaluated = vi.hoisted(() => new Set<string>());

/** The graph's chunk could not be fetched, as on a remote window that dropped. */
const graphUnreadable = vi.hoisted(() => ({ value: false }));

vi.mock('./LiveGraph', () => {
  evaluated.add('LiveGraph');
  return {
    LiveGraph: ({ graph, className }: { graph: ForgeGraph; className?: string }) => {
      if (graphUnreadable.value) {
        throw new TypeError(
          'Failed to fetch dynamically imported module: https://file+.vscode-resource.vscode-cdn.net/x/assets/chunks/LiveGraph-a1.js',
        );
      }
      return (
        <div data-testid="live-graph" className={className}>
          {graph.nodes.length}
        </div>
      );
    },
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

  it('says a graph whose chunk could not be fetched in its box, and leaves the step around it up', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    graphUnreadable.value = true;
    try {
      render(
        <div data-testid="step">
          <LiveGraph graph={GRAPH} className="h-full" />
        </div>,
      );

      const failed = await screen.findByTestId('live-graph-failed');
      expect(failed.textContent).toContain('This part did not load');
      expect(failed.className).toContain('h-full');
      expect(screen.getByTestId('step').contains(failed)).toBe(true);
    } finally {
      graphUnreadable.value = false;
    }
  });
});
