import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import type { ForgeConfig, ForgeGraph, ForgeGraphEdge, ForgeGraphNode } from '@sandforge/shared';
import '../../i18n';
import { useForgeStore } from '../../stores/useForgeStore';
import { ReviewGraphSearch, graphMatches } from './ReviewGraphSearch';

/*
 * A graph of hundreds of objects, searched by name on Review, and a branch of
 * it left out at once: the object and what only it reaches.
 */

const CONFIG: ForgeConfig = {
  inputMode: 'record',
  recordId: '001000000000001AAA',
  depth: 'full',
  sourceOrgId: 'org-source',
  targetOrgId: 'org-target',
  anonymizePII: false,
  skipEmpty: false,
  batchSize: 'auto',
};

function node(objectApiName: string, level: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 1,
    fieldCount: 1,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 1,
    estimatedSizeMB: 0,
    estimatedApiCalls: 0,
    batchStrategy: 'auto',
  };
}

const edge = (sourceObject: string, targetObject: string): ForgeGraphEdge => ({
  sourceObject,
  targetObject,
  relationshipName: targetObject,
  type: 'lookup',
});

const GRAPH: ForgeGraph = {
  nodes: [
    node('Account', 0),
    node('Opportunity', 1),
    node('OpportunityLineItem', 2),
    node('OpportunityContactRole', 2),
    node('Contact', 1),
  ],
  edges: [
    edge('Account', 'Opportunity'),
    edge('Account', 'Contact'),
    edge('Opportunity', 'OpportunityLineItem'),
    edge('Opportunity', 'OpportunityContactRole'),
    edge('Contact', 'OpportunityContactRole'),
  ],
  totalRecords: 5,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 0,
};

/** The search as Review holds it, with the store's graph. */
const Harness: React.FC<{ onShow?: (name: string) => void }> = ({ onShow }) => {
  const [query, setQuery] = useState('');
  const graph = useForgeStore((s) => s.graph);
  return graph ? (
    <ReviewGraphSearch graph={graph} query={query} onQueryChange={setQuery} onShow={onShow} />
  ) : null;
};

const included = (): Record<string, boolean> =>
  Object.fromEntries(
    (useForgeStore.getState().graph?.nodes ?? []).map((n) => [n.objectApiName, n.included]),
  );

describe('graphMatches', () => {
  it('finds the objects whose name holds the text, whatever its case, by name', () => {
    expect(graphMatches(GRAPH, 'opportunity')).toEqual([
      'Opportunity',
      'OpportunityContactRole',
      'OpportunityLineItem',
    ]);
    expect(graphMatches(GRAPH, '  ')).toEqual([]);
  });
});

describe('ReviewGraphSearch', () => {
  beforeEach(() => {
    useForgeStore.getState().reset();
    useForgeStore.getState().setConfig(CONFIG);
    useForgeStore.getState().setGraph(GRAPH);
  });

  it('lists the objects the search matches and says how many', () => {
    render(<Harness />);
    fireEvent.change(screen.getByTestId('review-graph-search-input'), {
      target: { value: 'line' },
    });

    expect(screen.getByTestId('review-graph-search-count').textContent).toBe(
      '1 object matches, marked in the graph.',
    );
    expect(screen.getByTestId('review-graph-match-OpportunityLineItem')).toBeTruthy();

    fireEvent.change(screen.getByTestId('review-graph-search-input'), {
      target: { value: 'nothing' },
    });
    expect(screen.getByTestId('review-graph-search-count').textContent).toBe(
      'No object of the graph matches.',
    );
  });

  it('leaves out a branch, in the config too, and puts it back', () => {
    render(<Harness />);
    fireEvent.change(screen.getByTestId('review-graph-search-input'), {
      target: { value: 'Opportunity' },
    });
    const match = screen.getByTestId('review-graph-match-Opportunity');
    const leaveOut = within(match).getByTestId('review-graph-leave-out-branch');
    expect(leaveOut.getAttribute('aria-label')).toBe(
      'Leave out Opportunity and the 1 object only it reaches',
    );

    fireEvent.click(leaveOut);

    // The contact roles a contact reaches too stay in.
    expect(included()).toEqual({
      Account: true,
      Opportunity: false,
      OpportunityLineItem: false,
      OpportunityContactRole: true,
      Contact: true,
    });
    expect(useForgeStore.getState().config?.excludedObjects).toEqual([
      'Opportunity',
      'OpportunityLineItem',
    ]);
    expect(screen.getByTestId('review-graph-left-out').textContent).toBe(
      'Left out of the run: Opportunity, OpportunityLineItem.',
    );

    fireEvent.click(screen.getByTestId('review-graph-put-back'));
    expect(Object.values(included()).every(Boolean)).toBe(true);
    expect(useForgeStore.getState().config).not.toHaveProperty('excludedObjects');
  });

  it('offers no branch of the root, which is the whole clone, and none of an object left out', () => {
    useForgeStore.getState().toggleNodeIncluded('Contact');
    render(<Harness />);
    fireEvent.change(screen.getByTestId('review-graph-search-input'), { target: { value: 'c' } });

    expect(
      within(screen.getByTestId('review-graph-match-Account')).queryByTestId(
        'review-graph-leave-out-branch',
      ),
    ).toBeNull();
    expect(screen.getByTestId('review-graph-match-Account').textContent).toContain(
      'the whole clone',
    );
    const contact = screen.getByTestId('review-graph-match-Contact');
    expect(contact.textContent).toContain('left out');
    expect(within(contact).queryByTestId('review-graph-leave-out-branch')).toBeNull();
  });

  it('brings an object into view when the graph is shown', () => {
    const onShow = vi.fn();
    const { unmount } = render(<Harness onShow={onShow} />);
    fireEvent.change(screen.getByTestId('review-graph-search-input'), {
      target: { value: 'Contact' },
    });
    fireEvent.click(
      within(screen.getByTestId('review-graph-match-Contact')).getByTestId('review-graph-show'),
    );
    expect(onShow).toHaveBeenCalledWith('Contact');
    unmount();

    // The table shows every object: nothing to bring into view.
    render(<Harness />);
    fireEvent.change(screen.getByTestId('review-graph-search-input'), {
      target: { value: 'Contact' },
    });
    expect(screen.queryByTestId('review-graph-show')).toBeNull();
  });
});
