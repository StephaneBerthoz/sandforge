import React from 'react';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import type { ImpactAnalysis } from './ImpactGraph';
import { ImpactGraph } from './ImpactGraph';

/* React Flow requires ResizeObserver. */
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

/** Mock ReactFlow used by LiveGraph. */
function MockReactFlow({
  nodes,
  children,
}: {
  nodes: Array<{ id: string; data: { objectApiName: string } }>;
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <div data-testid="mock-reactflow" data-nodes={nodes.length}>
      {nodes.map((n) => (
        <div key={n.id} data-testid={`rf-node-${n.id}`}>
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

const mockAnalysis: ImpactAnalysis = {
  impactScore: 65,
  riskLevel: 'medium',
  affectedComponents: [
    { fullName: 'AccountController', componentType: 'ApexClass', impactType: 'direct' },
    { fullName: 'AccountTrigger', componentType: 'ApexTrigger', impactType: 'indirect' },
  ],
  dependencies: [{ source: 'AccountController', target: 'AccountTrigger', type: 'triggers' }],
  recommendations: ['Review AccountTrigger for side effects', 'Run all Account-related tests'],
};

describe('ImpactGraph', () => {
  it('should render the impact card', () => {
    render(<ImpactGraph analysis={mockAnalysis} />);
    expect(screen.getByText('Impact Analysis')).toBeDefined();
  });

  it('should show risk level badge', () => {
    render(<ImpactGraph analysis={mockAnalysis} />);
    expect(screen.getByText('medium')).toBeDefined();
  });

  it('should show impact score', () => {
    render(<ImpactGraph analysis={mockAnalysis} />);
    expect(screen.getByText(/Impact Score: 65/)).toBeDefined();
  });

  it('should show affected component count', () => {
    render(<ImpactGraph analysis={mockAnalysis} />);
    expect(screen.getByText('2 affected components')).toBeDefined();
  });

  it('should render LiveGraph with correct data', () => {
    render(<ImpactGraph analysis={mockAnalysis} />);
    expect(screen.getByTestId('impact-live-graph')).toBeDefined();
    expect(screen.getByTestId('live-graph')).toBeDefined();
  });

  it('should convert analysis components to LiveGraph nodes', () => {
    render(<ImpactGraph analysis={mockAnalysis} />);
    const flow = screen.getByTestId('mock-reactflow');
    expect(flow.getAttribute('data-nodes')).toBe('2');
  });

  it('should render node names from affected components', () => {
    render(<ImpactGraph analysis={mockAnalysis} />);
    expect(screen.getByText('AccountController')).toBeDefined();
    expect(screen.getByText('AccountTrigger')).toBeDefined();
  });

  it('should render recommendations', () => {
    render(<ImpactGraph analysis={mockAnalysis} />);
    expect(screen.getByTestId('impact-recommendations')).toBeDefined();
    expect(screen.getByText('Review AccountTrigger for side effects')).toBeDefined();
  });

  it('should show no data when no analysis', () => {
    render(<ImpactGraph />);
    expect(screen.getByText('No data available')).toBeDefined();
  });

  it('should accept custom className', () => {
    const { container } = render(<ImpactGraph analysis={mockAnalysis} className="custom" />);
    expect((container.firstChild as HTMLElement).className).toContain('custom');
  });
});
