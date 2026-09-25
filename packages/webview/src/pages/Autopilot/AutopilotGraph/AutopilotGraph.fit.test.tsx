import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../../i18n';
import { AutopilotGraph } from './AutopilotGraph';
import { LEGEND_HEIGHT } from './GraphLegend';
import { CONTROLS_WIDTH } from './GraphControls';

/** The props React Flow and its minimap were last given, and what the controls asked it. */
const received = vi.hoisted(() => ({
  flow: {} as Record<string, unknown>,
  minimap: {} as Record<string, unknown>,
  fitView: vi.fn((_options?: unknown) => Promise.resolve(true)),
}));

vi.mock('@xyflow/react', () => ({
  __esModule: true,
  ReactFlowProvider: ({ children }: { children?: React.ReactNode }) => children,
  ReactFlow: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
    received.flow = props;
    return React.createElement('div', { 'data-testid': 'react-flow-mock' }, props.children);
  },
  MiniMap: (props: Record<string, unknown>) => {
    received.minimap = props;
    return React.createElement('div', { 'data-testid': 'minimap' });
  },
  Background: () => React.createElement('div'),
  Handle: () => React.createElement('div'),
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
  useReactFlow: () => ({
    zoomIn: vi.fn(() => Promise.resolve(true)),
    zoomOut: vi.fn(() => Promise.resolve(true)),
    fitView: received.fitView,
  }),
}));

vi.mock('../../../stores/useAutopilotStore', () => ({
  useAutopilotStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ graph: null, selectedNodeName: null, selectNode: vi.fn() }),
}));

/** A padding React Flow is given in pixels, as a number; NaN for any other. */
const pixels = (padding: unknown): number =>
  typeof padding === 'string' && padding.endsWith('px') ? parseFloat(padding) : Number.NaN;

describe('AutopilotGraph fitted to its pane', () => {
  it('leaves the minimap and the legend a strip along the bottom, and the controls one down the right', () => {
    // Fitted to the whole pane, the nodes at its bottom lay under them: at
    // 1280×720 the contact had a corner under the minimap and one under the
    // legend.
    render(<AutopilotGraph />);

    const minimap = received.minimap.style as { height: number };
    const { padding } = received.flow.fitViewOptions as {
      padding: { bottom: unknown; right: unknown };
    };
    expect(received.flow.fitView).toBe(true);
    // Each with the margin it stands at from the pane's edge, below and above it.
    expect(pixels(padding.bottom)).toBeGreaterThanOrEqual(minimap.height + 2 * 15);
    expect(pixels(padding.bottom)).toBeGreaterThanOrEqual(LEGEND_HEIGHT + 2 * 12);
    expect(pixels(padding.right)).toBeGreaterThanOrEqual(CONTROLS_WIDTH + 2 * 12);
  });

  it('fits it the same way from the fit button', () => {
    render(<AutopilotGraph />);

    fireEvent.click(screen.getByTestId('fit-view-btn'));

    const { padding } = received.flow.fitViewOptions as { padding: unknown };
    expect(received.fitView).toHaveBeenCalledWith(expect.objectContaining({ padding }));
  });
});
