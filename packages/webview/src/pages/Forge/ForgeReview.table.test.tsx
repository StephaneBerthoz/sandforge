import { describe, it, expect, vi, beforeEach } from 'vitest';
import { memo } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { ForgeConfig, ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import '../../i18n';
import { useForgeStore } from '../../stores/useForgeStore';
import { useForgeViewStore } from '../../stores/useForgeViewStore';
import { ForgeReview } from './ForgeReview';

/**
 * Review with the real store: what it hands the table, which draws again only
 * when those change.
 */

vi.mock('../../bridge/sendBridgeMessage', () => ({
  sendBridgeMessage: () => 'wv-request',
}));

/** How often the table was drawn with new props from Review. */
const tableDraws = vi.hoisted(() => ({ count: 0 }));
vi.mock('./ForgeTableView', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ForgeTableView')>();
  // Memoized like the table: it counts the props Review hands it anew.
  const Counted = memo(function Counted(props: Parameters<typeof actual.ForgeTableView>[0]) {
    tableDraws.count += 1;
    return <actual.ForgeTableView {...props} />;
  });
  return { ...actual, ForgeTableView: Counted };
});

const CONFIG: ForgeConfig = {
  inputMode: 'record',
  recordId: '001000000000001AAA',
  depth: 'full',
  sourceOrgId: 'org-src',
  targetOrgId: 'org-tgt',
  anonymizePII: false,
  skipEmpty: false,
  batchSize: 'auto',
};

function node(objectApiName: string): ForgeGraphNode {
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
  };
}

/** Thirty objects: more than auto draws as a graph. */
const GRAPH: ForgeGraph = {
  nodes: Array.from({ length: 30 }, (_, i) => node(`Object${String(i)}__c`)),
  edges: [],
  totalRecords: 300,
  estimatedSizeMB: 1,
  estimatedDurationSeconds: 10,
};

describe('ForgeReview — the table of a wide graph', () => {
  beforeEach(() => {
    useForgeViewStore.setState({ setting: 'auto', choice: null });
    const store = useForgeStore.getState();
    store.reset();
    store.setConfig(CONFIG);
    store.setGraph(GRAPH);
    store.setPhase('review');
    tableDraws.count = 0;
  });

  it('is not drawn again by what Review hears that is not the graph', () => {
    render(<ForgeReview />);
    expect(screen.getByTestId('forge-table-view')).toBeDefined();
    tableDraws.count = 0;

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            id: 'ext-diff',
            type: 'forge:metadata-diff:response',
            timestamp: Date.now(),
            payload: { diffs: [] },
          },
        }),
      );
    });
    fireEvent.click(screen.getByTestId('tab-compliance'));

    expect(tableDraws.count).toBe(0);
  });

  it('is drawn again once the graph changes: a box ticked on one of its rows', () => {
    render(<ForgeReview />);
    tableDraws.count = 0;

    fireEvent.click(screen.getByTestId('forge-table-include-Object4__c'));

    expect(useForgeStore.getState().graph?.nodes[4].included).toBe(false);
    expect(tableDraws.count).toBe(1);
  });
});
