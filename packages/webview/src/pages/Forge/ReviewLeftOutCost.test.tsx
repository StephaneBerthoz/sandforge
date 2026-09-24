import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import type { ForgeGraph, ForgeGraphEdge, ForgeGraphNode } from '@sandforge/shared';
import '../../i18n';
import { useForgeStore } from '../../stores/useForgeStore';
import { ReviewLeftOutCost } from './ReviewLeftOutCost';

function node(objectApiName: string, overrides: Partial<ForgeGraphNode> = {}): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 12,
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

function edge(sourceObject: string, targetObject: string): ForgeGraphEdge {
  return {
    sourceObject,
    targetObject,
    relationshipName: `${sourceObject}To${targetObject}`,
    type: 'lookup',
    required: true,
  };
}

/** An opportunity's lines and orders, the prices and items they cannot go without. */
const GRAPH: ForgeGraph = {
  nodes: [
    node('Opportunity', { level: 0 }),
    node('OpportunityLineItem'),
    node('PricebookEntry', { level: 2 }),
    node('Order'),
    node('OrderItem', { level: 2 }),
  ],
  edges: [
    edge('Opportunity', 'OpportunityLineItem'),
    edge('PricebookEntry', 'OpportunityLineItem'),
    edge('Order', 'OrderItem'),
  ],
  totalRecords: 60,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 1,
};

/** Review's notice, drawn from the graph the store holds. */
function Notice(): React.ReactElement | null {
  const graph = useForgeStore((s) => s.graph);
  return graph ? <ReviewLeftOutCost graph={graph} /> : null;
}

/** What the notice says, line by line. */
function lines(): string[] {
  return screen.getAllByTestId('forge-left-out-cost-row').map((row) => row.textContent ?? '');
}

describe('ReviewLeftOutCost', () => {
  beforeEach(() => {
    useForgeStore.getState().reset();
    useForgeStore.getState().setGraph(GRAPH);
  });

  it('says nothing while the user left nothing out', () => {
    render(<Notice />);
    expect(screen.queryByTestId('forge-left-out-cost')).toBeNull();
  });

  it('says what an object unchecked on the page costs the objects the run writes, before the run', () => {
    // Unchecked, the prices said nothing until the run came back without a
    // single line.
    render(<Notice />);

    act(() => {
      useForgeStore.getState().toggleNodeIncluded('PricebookEntry');
      useForgeStore.getState().toggleNodeIncluded('OrderItem');
    });

    expect(screen.getByTestId('forge-left-out-cost').textContent).toContain(
      'What the objects left out cost',
    );
    expect(lines()).toEqual([
      'OpportunityLineItem: records that need a record of PricebookEntry are not written, unless the target already holds it.',
      'Order: records past Draft are written as drafts and stay drafts: the platform gives them their status only with OrderItem records under them.',
    ]);

    // Checked again, it costs nothing.
    act(() => {
      useForgeStore.getState().toggleNodeIncluded('PricebookEntry');
      useForgeStore.getState().toggleNodeIncluded('OrderItem');
    });
    expect(screen.queryByTestId('forge-left-out-cost')).toBeNull();
  });

  it('says nothing of an object discovery left out', () => {
    useForgeStore.getState().setGraph({
      ...GRAPH,
      nodes: GRAPH.nodes.map((n) =>
        n.objectApiName === 'PricebookEntry' ? { ...n, included: false, recordCount: 0 } : n,
      ),
    });
    render(<Notice />);
    expect(screen.queryByTestId('forge-left-out-cost')).toBeNull();
  });

  it('says what leaving out the selling model options costs the prices', () => {
    render(
      <ReviewLeftOutCost
        graph={{
          nodes: [
            node('Product2'),
            node('ProductSellingModel'),
            node('PricebookEntry'),
            node('ProductSellingModelOption', { included: false, leftOutByUser: true }),
          ],
          edges: [],
        }}
      />,
    );
    expect(lines()).toEqual([
      "PricebookEntry: prices sold under a selling model are not written: each needs its product's ProductSellingModelOption for that model.",
    ]);
  });
});
