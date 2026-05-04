import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { ERDMiniMap } from './ERDMiniMap';
import type { ERDMiniMapProps } from './ERDMiniMap';
import type { ObjectNode, ERDEdge } from '@sandforge/shared';

const accountNode: ObjectNode = {
  apiName: 'Account',
  label: 'Account',
  recordCount: 500,
  fields: [],
  relationships: [],
};

const contactNode: ObjectNode = {
  apiName: 'Contact',
  label: 'Contact',
  recordCount: 1200,
  fields: [],
  relationships: [
    { fieldName: 'AccountId', targetObject: 'Account', type: 'Lookup', required: false },
  ],
};

const opportunityNode: ObjectNode = {
  apiName: 'Opportunity',
  label: 'Opportunity',
  recordCount: 300,
  fields: [],
  relationships: [
    { fieldName: 'AccountId', targetObject: 'Account', type: 'MasterDetail', required: true },
  ],
};

const lookupEdge: ERDEdge = {
  source: 'Contact',
  target: 'Account',
  field: 'AccountId',
  type: 'Lookup',
};

const masterEdge: ERDEdge = {
  source: 'Opportunity',
  target: 'Account',
  field: 'AccountId',
  type: 'MasterDetail',
};

const defaultProps: ERDMiniMapProps = {
  nodes: [accountNode, contactNode],
  edges: [lookupEdge],
  insertionOrder: ['Account', 'Contact'],
  selectedObjects: ['Account', 'Contact'],
  onObjectClick: vi.fn(),
};

describe('ERDMiniMap', () => {
  it('should render the minimap container', () => {
    render(<ERDMiniMap {...defaultProps} />);
    expect(screen.getByTestId('erd-minimap')).toBeDefined();
  });

  it('should render SVG element', () => {
    render(<ERDMiniMap {...defaultProps} />);
    expect(screen.getByTestId('erd-svg')).toBeDefined();
  });

  it('should render node for each object', () => {
    render(<ERDMiniMap {...defaultProps} />);
    expect(screen.getByTestId('erd-node-Account')).toBeDefined();
    expect(screen.getByTestId('erd-node-Contact')).toBeDefined();
  });

  it('should render edge between connected objects', () => {
    render(<ERDMiniMap {...defaultProps} />);
    expect(screen.getByTestId('edge-Contact-Account')).toBeDefined();
  });

  it('should show empty state when no nodes', () => {
    render(<ERDMiniMap {...defaultProps} nodes={[]} edges={[]} />);
    expect(screen.getByTestId('erd-minimap-empty')).toBeDefined();
    expect(screen.getByText('No objects selected')).toBeDefined();
  });

  it('should call onObjectClick when node is clicked', () => {
    const onClick = vi.fn();
    render(<ERDMiniMap {...defaultProps} onObjectClick={onClick} />);
    fireEvent.click(screen.getByTestId('erd-node-Account'));
    expect(onClick).toHaveBeenCalledWith('Account');
  });

  it('should display object label in nodes', () => {
    render(<ERDMiniMap {...defaultProps} />);
    const accountNode = screen.getByTestId('erd-node-Account');
    expect(accountNode.textContent).toContain('Account');
  });

  it('should display record count in nodes', () => {
    render(<ERDMiniMap {...defaultProps} />);
    const contactNodeEl = screen.getByTestId('erd-node-Contact');
    // toLocaleString() may produce different separators in different environments
    expect(contactNodeEl.textContent).toContain('1');
    expect(contactNodeEl.textContent).toContain('200');
    expect(contactNodeEl.textContent).toContain('records');
  });

  it('should show order badges', () => {
    render(<ERDMiniMap {...defaultProps} />);
    const accountNodeEl = screen.getByTestId('erd-node-Account');
    expect(accountNodeEl.textContent).toContain('1');
    const contactNodeEl = screen.getByTestId('erd-node-Contact');
    expect(contactNodeEl.textContent).toContain('2');
  });

  it('should render MasterDetail edges with correct marker', () => {
    render(
      <ERDMiniMap
        {...defaultProps}
        nodes={[accountNode, opportunityNode]}
        edges={[masterEdge]}
        insertionOrder={['Account', 'Opportunity']}
        selectedObjects={['Account', 'Opportunity']}
      />,
    );
    const edge = screen.getByTestId('edge-Opportunity-Account');
    expect(edge.getAttribute('marker-end')).toContain('arrow-master');
    expect(edge.getAttribute('stroke-width')).toBe('2.5');
  });

  it('should render Lookup edges with dashed style', () => {
    render(<ERDMiniMap {...defaultProps} />);
    const edge = screen.getByTestId('edge-Contact-Account');
    expect(edge.getAttribute('marker-end')).toContain('arrow-lookup');
    expect(edge.getAttribute('stroke-dasharray')).toBe('6 3');
  });

  it('should highlight circular dependency nodes', () => {
    render(<ERDMiniMap {...defaultProps} circularDeps={[['Account', 'Contact']]} />);
    const nodeEl = screen.getByTestId('erd-node-Account');
    const rect = nodeEl.querySelector('rect');
    expect(rect?.getAttribute('stroke-width')).toBe('2');
  });

  it('should show auto-added indicator for unselected nodes', () => {
    render(
      <ERDMiniMap
        {...defaultProps}
        nodes={[accountNode, contactNode]}
        selectedObjects={['Contact']}
      />,
    );
    const accountNodeEl = screen.getByTestId('erd-node-Account');
    expect(accountNodeEl.textContent).toContain('auto');
  });

  it('should truncate long labels', () => {
    const longNode: ObjectNode = {
      apiName: 'VeryLongObjectNameThatExceedsLimit__c',
      label: 'VeryLongObjectNameThatExceedsLimit',
      recordCount: 10,
      fields: [],
      relationships: [],
    };
    render(
      <ERDMiniMap
        {...defaultProps}
        nodes={[longNode]}
        edges={[]}
        insertionOrder={['VeryLongObjectNameThatExceedsLimit__c']}
        selectedObjects={['VeryLongObjectNameThatExceedsLimit__c']}
      />,
    );
    const nodeEl = screen.getByTestId('erd-node-VeryLongObjectNameThatExceedsLimit__c');
    expect(nodeEl.textContent).toContain('..');
  });

  it('should handle zoom via wheel event', () => {
    render(<ERDMiniMap {...defaultProps} />);
    const svg = screen.getByTestId('erd-svg');
    fireEvent.wheel(svg, { deltaY: 100 });
    // After zoom out, the transform group should still exist
    const g = svg.querySelector('g');
    expect(g).toBeDefined();
  });

  it('should handle pan via mouse drag', () => {
    render(<ERDMiniMap {...defaultProps} />);
    const svg = screen.getByTestId('erd-svg');
    fireEvent.mouseDown(svg, { button: 0, clientX: 50, clientY: 50 });
    fireEvent.mouseMove(svg, { clientX: 100, clientY: 100 });
    fireEvent.mouseUp(svg);
    // No crash — pan completed
    expect(svg).toBeDefined();
  });
});
