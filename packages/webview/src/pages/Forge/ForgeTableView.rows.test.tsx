import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import '../../i18n';
import { ForgeTableView } from './ForgeTableView';
import type { ForgeGraph, ForgeGraphNode } from '../../stores/useForgeStore';

/**
 * How many components have drawn themselves: the table and each of its rows
 * read their words once per render.
 */
const renders = vi.hoisted(() => ({ count: 0 }));
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: (...args: Parameters<typeof actual.useTranslation>) => {
      renders.count += 1;
      return actual.useTranslation(...args);
    },
  };
});

function node(objectApiName: string, overrides: Partial<ForgeGraphNode> = {}): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 10,
    fieldCount: 20,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 1,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 15,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
    ...overrides,
  };
}

/** Forty objects: more than a graph is drawn for. */
const GRAPH: ForgeGraph = {
  nodes: Array.from({ length: 40 }, (_, i) => node(`Object${String(i).padStart(2, '0')}__c`)),
  edges: [],
  totalRecords: 400,
  estimatedSizeMB: 1,
  estimatedDurationSeconds: 10,
};

/** `graph` with the object `name` left out, as the store gives it: every other node as it was. */
function leftOut(graph: ForgeGraph, name: string): ForgeGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.objectApiName === name ? { ...n, included: false } : n)),
  };
}

describe('ForgeTableView — the rows drawn again', () => {
  const onToggleIncluded = vi.fn();

  beforeEach(() => {
    onToggleIncluded.mockClear();
  });

  it('draws again the row of the object a box left out, and none of the others', () => {
    const { rerender } = render(
      <ForgeTableView graph={GRAPH} onToggleIncluded={onToggleIncluded} />,
    );
    renders.count = 0;

    rerender(
      <ForgeTableView graph={leftOut(GRAPH, 'Object07__c')} onToggleIncluded={onToggleIncluded} />,
    );

    expect(screen.getByTestId('forge-table-include-Object07__c')).toHaveProperty('checked', false);
    // The table, to sort its rows again, and the one row.
    expect(renders.count).toBe(2);
  });

  it('is not drawn again for the props it was drawn with', () => {
    const { rerender } = render(
      <ForgeTableView graph={GRAPH} onToggleIncluded={onToggleIncluded} />,
    );
    renders.count = 0;

    rerender(<ForgeTableView graph={GRAPH} onToggleIncluded={onToggleIncluded} />);

    expect(renders.count).toBe(0);
  });

  it('names an object with nothing to open as text, not as a button', () => {
    render(<ForgeTableView graph={GRAPH} onToggleIncluded={onToggleIncluded} />);

    const [row] = screen.getAllByTestId('forge-table-row');
    expect(within(row).queryByRole('button')).toBeNull();
    expect(row.textContent).toContain('Object00__c');
    expect(screen.queryByTestId('forge-table-select-Object00__c')).toBeNull();
  });
});
