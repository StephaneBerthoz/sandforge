import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { ForgeTableView } from './ForgeTableView';
import type { ForgeGraph, ForgeGraphNode } from '../../stores/useForgeStore';

/* ---- Helpers ---- */

function makeNode(overrides: Partial<ForgeGraphNode> = {}): ForgeGraphNode {
  return {
    objectApiName: 'Account',
    recordCount: 100,
    fieldCount: 20,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 0,
    estimatedSizeMB: 0,
    estimatedApiCalls: 0,
    batchStrategy: 'auto',
    ...overrides,
  };
}

function makeGraph(nodes?: ForgeGraphNode[]): ForgeGraph {
  return {
    nodes: nodes ?? [
      makeNode({ objectApiName: 'Account', recordCount: 100, fieldCount: 20 }),
      makeNode({ objectApiName: 'Contact', recordCount: 200, fieldCount: 15 }),
      makeNode({ objectApiName: 'Opportunity', recordCount: 50, fieldCount: 30 }),
    ],
    edges: [],
    totalRecords: 350,
    estimatedSizeMB: 5,
    estimatedDurationSeconds: 30,
  };
}

/* ---- Tests ---- */

describe('ForgeTableView', () => {
  const mockOnNodeClick = vi.fn();
  const mockOnToggleIncluded = vi.fn();

  beforeEach(() => {
    mockOnNodeClick.mockClear();
    mockOnToggleIncluded.mockClear();
  });

  it('should render all nodes as table rows', () => {
    const graph = makeGraph();
    render(
      <ForgeTableView
        graph={graph}
        selectedNodeName={null}
        onNodeClick={mockOnNodeClick}
        onToggleIncluded={mockOnToggleIncluded}
      />,
    );
    expect(screen.getByTestId('forge-table-view')).toBeDefined();
    const rows = screen.getAllByTestId('forge-table-row');
    expect(rows).toHaveLength(3);
  });

  it('should call onNodeClick when a row is clicked', () => {
    const graph = makeGraph();
    render(
      <ForgeTableView
        graph={graph}
        selectedNodeName={null}
        onNodeClick={mockOnNodeClick}
        onToggleIncluded={mockOnToggleIncluded}
      />,
    );
    const rows = screen.getAllByTestId('forge-table-row');
    fireEvent.click(rows[0]);
    expect(mockOnNodeClick).toHaveBeenCalledWith('Account');
  });

  it('should call onToggleIncluded when a checkbox is changed', () => {
    const graph = makeGraph();
    render(
      <ForgeTableView
        graph={graph}
        selectedNodeName={null}
        onNodeClick={mockOnNodeClick}
        onToggleIncluded={mockOnToggleIncluded}
      />,
    );
    const checkbox = screen.getByTestId('forge-table-include-Contact');
    fireEvent.click(checkbox);
    expect(mockOnToggleIncluded).toHaveBeenCalledWith('Contact');
  });

  it('should change sort order when clicking a column header', () => {
    const graph = makeGraph();
    render(
      <ForgeTableView
        graph={graph}
        selectedNodeName={null}
        onNodeClick={mockOnNodeClick}
        onToggleIncluded={mockOnToggleIncluded}
      />,
    );

    // Default sort is by objectApiName asc: Account, Contact, Opportunity
    let rows = screen.getAllByTestId('forge-table-row');
    expect(rows[0].textContent).toContain('Account');
    expect(rows[2].textContent).toContain('Opportunity');

    // Click recordCount header to sort by records ascending
    fireEvent.click(screen.getByTestId('forge-table-sort-recordCount'));
    rows = screen.getAllByTestId('forge-table-row');
    // Ascending by recordCount: Opportunity(50), Account(100), Contact(200)
    expect(rows[0].textContent).toContain('Opportunity');
    expect(rows[2].textContent).toContain('Contact');

    // Click again to reverse to descending
    fireEvent.click(screen.getByTestId('forge-table-sort-recordCount'));
    rows = screen.getAllByTestId('forge-table-row');
    // Descending: Contact(200), Account(100), Opportunity(50)
    expect(rows[0].textContent).toContain('Contact');
    expect(rows[2].textContent).toContain('Opportunity');
  });

  it('should filter rows by searchQuery', () => {
    const graph = makeGraph();
    render(
      <ForgeTableView
        graph={graph}
        selectedNodeName={null}
        onNodeClick={mockOnNodeClick}
        onToggleIncluded={mockOnToggleIncluded}
        searchQuery="con"
      />,
    );
    const rows = screen.getAllByTestId('forge-table-row');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Contact');
  });

  it('should show no matching nodes message when search returns empty', () => {
    const graph = makeGraph();
    render(
      <ForgeTableView
        graph={graph}
        selectedNodeName={null}
        onNodeClick={mockOnNodeClick}
        onToggleIncluded={mockOnToggleIncluded}
        searchQuery="zzz-no-match"
      />,
    );
    expect(screen.getByTestId('forge-table-view').textContent).toContain('No matching objects');
  });

  it('should highlight the selected row', () => {
    const graph = makeGraph();
    render(
      <ForgeTableView
        graph={graph}
        selectedNodeName="Contact"
        onNodeClick={mockOnNodeClick}
        onToggleIncluded={mockOnToggleIncluded}
      />,
    );
    const rows = screen.getAllByTestId('forge-table-row');
    // The Contact row (second in alpha order) should have the highlight classes
    expect(rows[1].className).toContain('bg-forge/10');
  });

  it('should display PII count when node has PII fields', () => {
    const graph = makeGraph([
      makeNode({ objectApiName: 'Account', piiFields: ['Email', 'Phone'] }),
      makeNode({ objectApiName: 'Contact', piiFields: [] }),
    ]);
    render(
      <ForgeTableView
        graph={graph}
        selectedNodeName={null}
        onNodeClick={mockOnNodeClick}
        onToggleIncluded={mockOnToggleIncluded}
      />,
    );
    const rows = screen.getAllByTestId('forge-table-row');
    expect(rows[0].textContent).toContain('2');
    expect(rows[1].textContent).toContain('-');
  });
});
