import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
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

  it('should call onNodeClick from the object-name button', () => {
    const graph = makeGraph();
    render(
      <ForgeTableView
        graph={graph}
        selectedNodeName={null}
        onNodeClick={mockOnNodeClick}
        onToggleIncluded={mockOnToggleIncluded}
      />,
    );
    const selectButton = screen.getByTestId('forge-table-select-Account');
    expect(selectButton.tagName).toBe('BUTTON');
    fireEvent.click(selectButton);
    expect(mockOnNodeClick).toHaveBeenCalledWith('Account');
  });

  it('should not select a node from the row itself, only from focusable controls', () => {
    const graph = makeGraph();
    render(
      <ForgeTableView
        graph={graph}
        selectedNodeName={null}
        onNodeClick={mockOnNodeClick}
        onToggleIncluded={mockOnToggleIncluded}
      />,
    );
    // A handler on the <tr> would be mouse-only: nothing focuses a table row.
    fireEvent.click(screen.getAllByTestId('forge-table-row')[0]);
    expect(mockOnNodeClick).not.toHaveBeenCalled();
  });

  it('should expose column headers as buttons carrying aria-sort on the th', () => {
    const graph = makeGraph();
    render(
      <ForgeTableView
        graph={graph}
        selectedNodeName={null}
        onNodeClick={mockOnNodeClick}
        onToggleIncluded={mockOnToggleIncluded}
      />,
    );
    const sortButton = screen.getByTestId('forge-table-sort-recordCount');
    expect(sortButton.tagName).toBe('BUTTON');
    expect(sortButton.getAttribute('type')).toBe('button');

    const header = sortButton.closest('th');
    expect(header).not.toBeNull();
    expect(header?.getAttribute('aria-sort')).toBeNull();

    fireEvent.click(sortButton);
    expect(header?.getAttribute('aria-sort')).toBe('ascending');
    fireEvent.click(sortButton);
    expect(header?.getAttribute('aria-sort')).toBe('descending');
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
    // The Contact row (second in alpha order) should have the highlight classes.
    // An opaque surface, not a tint: the status badge's own tint sat on top of
    // bg-forge/5 and read 4.35:1 on Light Modern.
    expect(rows[1].className).toContain('bg-surface-2');
    expect(rows[1].className).toContain('border-forge');
    expect(rows[1].className).not.toContain('bg-forge/');
  });

  it('writes the skipped status badge in the editor foreground', () => {
    const graph = makeGraph([makeNode({ objectApiName: 'Account', status: 'skipped' })]);
    render(
      <ForgeTableView
        graph={graph}
        selectedNodeName={null}
        onNodeClick={mockOnNodeClick}
        onToggleIncluded={mockOnToggleIncluded}
      />,
    );
    const badge = screen.getByText('Skipped');
    // text-gray-500 on bg-gray-500/20 read 2.7:1 on Dark Modern.
    expect(badge.className).toContain(
      'bg-[color-mix(in_srgb,var(--sf-text-secondary)_10%,transparent)]',
    );
    expect(badge.className).toContain('text-text-primary');
    expect(badge.className).not.toMatch(/\btext-gray-\d+\b/);
  });

  it('writes the status of a node a cancel stopped in the warning token', () => {
    const graph = makeGraph([makeNode({ objectApiName: 'Account', status: 'stopped' })]);
    render(
      <ForgeTableView
        graph={graph}
        selectedNodeName={null}
        onNodeClick={mockOnNodeClick}
        onToggleIncluded={mockOnToggleIncluded}
      />,
    );
    expect(screen.getByText('Stopped').className).toContain('text-status-warning');
  });

  it('writes the status of a node that failed in the error token, not the idle one', () => {
    // `error` had no entry, and a failed node took the idle style.
    const graph = makeGraph([makeNode({ objectApiName: 'Account', status: 'error' })]);
    render(
      <ForgeTableView
        graph={graph}
        selectedNodeName={null}
        onNodeClick={mockOnNodeClick}
        onToggleIncluded={mockOnToggleIncluded}
      />,
    );
    const badge = screen.getByTestId('forge-table-status-Account');
    expect(badge.className).toContain('bg-status-error/10');
    expect(badge.className).toContain('text-status-error');
    expect(badge.className).not.toContain('text-text-primary');
  });

  it('writes a node being scanned in the info token, as one being written', () => {
    const graph = makeGraph([
      makeNode({ objectApiName: 'Account', status: 'scanning' }),
      makeNode({ objectApiName: 'Contact', status: 'running' }),
    ]);
    render(
      <ForgeTableView
        graph={graph}
        selectedNodeName={null}
        onNodeClick={mockOnNodeClick}
        onToggleIncluded={mockOnToggleIncluded}
      />,
    );
    expect(screen.getByTestId('forge-table-status-Account').className).toContain(
      'text-status-info',
    );
    expect(screen.getByTestId('forge-table-status-Contact').className).toContain(
      'text-status-info',
    );
  });

  it('names each status in words, not by its code', () => {
    // The column printed the code itself — "done", "error" — in every language.
    const statuses = [
      'idle',
      'scanning',
      'running',
      'done',
      'error',
      'skipped',
      'stopped',
    ] as const;
    const graph = makeGraph(
      statuses.map((status, i) => makeNode({ objectApiName: `Object${i}`, status })),
    );
    render(
      <ForgeTableView
        graph={graph}
        selectedNodeName={null}
        onNodeClick={mockOnNodeClick}
        onToggleIncluded={mockOnToggleIncluded}
      />,
    );
    expect(
      statuses.map((_, i) => screen.getByTestId(`forge-table-status-Object${i}`).textContent),
    ).toEqual(['Not started', 'Scanning', 'Running', 'Done', 'Failed', 'Skipped', 'Stopped']);
  });

  it('names a status in the language the panel is set to', async () => {
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await i18n.changeLanguage('fr');
    try {
      const graph = makeGraph([makeNode({ objectApiName: 'Account', status: 'error' })]);
      render(
        <ForgeTableView
          graph={graph}
          selectedNodeName={null}
          onNodeClick={mockOnNodeClick}
          onToggleIncluded={mockOnToggleIncluded}
        />,
      );
      expect(screen.getByTestId('forge-table-status-Account').textContent).toBe(
        fr.forge.nodeStatus.error,
      );
    } finally {
      await i18n.changeLanguage('en');
    }
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

  it('names each include checkbox after the object of its row', () => {
    // The column has no header text, so an unnamed box in row seven is
    // announced as one of N identical checkboxes.
    const graph = makeGraph([
      makeNode({ objectApiName: 'Account' }),
      makeNode({ objectApiName: 'Contact' }),
    ]);
    render(
      <ForgeTableView
        graph={graph}
        selectedNodeName={null}
        onNodeClick={mockOnNodeClick}
        onToggleIncluded={mockOnToggleIncluded}
      />,
    );

    expect(screen.getByTestId('forge-table-include-Contact').getAttribute('aria-label')).toContain(
      'Contact',
    );
  });
});
