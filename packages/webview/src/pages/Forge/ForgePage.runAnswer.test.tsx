import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, within } from '@testing-library/react';
import type { ForgeExecutionResult, ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import '../../i18n';
import { useForgeStore } from '../../stores/useForgeStore';
import { ForgePage } from './ForgePage';

/*
 * The page with the real store: the run's answer has to reach the results
 * however late it comes after the run's last object, which only the store,
 * the page and the screens together can show.
 */

const stableApi = {
  postMessage: vi.fn(),
  getState: () => undefined,
  setState: () => undefined,
};
vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => stableApi,
  getVscodeApi: () => stableApi,
}));

vi.mock('../../stores/useOrgStore', () => ({
  useOrgStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ orgs: [{ id: 'org-target', alias: 'Target' }], selectedOrgId: 'org-target' }),
}));

vi.mock('../../stores/useAppStore', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ navigate: vi.fn(), currentRoute: 'forge' }),
}));

vi.mock('../../components/graph/LiveGraph', () => ({
  LiveGraph: () => <div data-testid="live-graph" />,
}));

/** The request that started the run on screen. */
const RUN_REQUEST = 'wv-forge-run';

function node(objectApiName: string, level: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 400,
    fieldCount: 20,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 15,
    estimatedSizeMB: 0,
    estimatedApiCalls: 2,
    batchStrategy: 'auto',
  };
}

const GRAPH: ForgeGraph = {
  nodes: [node('Opportunity', 0), node('OpportunityLineItem', 1)],
  edges: [],
  totalRecords: 800,
  estimatedSizeMB: 1,
  estimatedDurationSeconds: 10,
};

/** What the run answers once its last steps are done. */
const RESULT: ForgeExecutionResult = {
  forgeId: 'forge-late-answer',
  status: 'success',
  graph: GRAPH,
  duration: 9_000,
  timestamp: '2026-09-24T08:00:00.000Z',
  idRemapCount: 4,
  idRemapTable: {
    '006000000000001SRC': '006000000000001TGT',
    '00k000000000001SRC': '00k000000000001TGT',
    '00k000000000002SRC': '00k000000000002TGT',
    '01u000000000001SRC': '01u000000000001TGT',
  },
  createdCount: 4,
  linkedExistingCount: 0,
  readByObject: [
    { objectApiName: 'Opportunity', read: 1 },
    { objectApiName: 'OpportunityLineItem', read: 2 },
    { objectApiName: 'PricebookEntry', read: 1 },
  ],
  failedReads: [],
};

/** The extension posting `type` for the run on screen. */
function host(type: string, payload: Record<string, unknown>): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: `host-${type}-${Math.random()}`,
          type,
          timestamp: Date.now(),
          correlationId: RUN_REQUEST,
          payload,
        },
      }),
    );
  });
}

/** Let time pass, as the extension's last steps take it. */
async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

describe('ForgePage — a run that answers after its last object', () => {
  beforeEach(() => {
    const store = useForgeStore.getState();
    store.reset();
    store.setConfig({
      inputMode: 'record',
      recordId: '006000000000001SRC',
      depth: 'direct',
      sourceOrgId: 'org-source',
      targetOrgId: 'org-target',
      anonymizePII: false,
      skipEmpty: false,
      batchSize: 'auto',
    });
    store.setGraph(GRAPH);
    store.setExecutionRequestId(RUN_REQUEST);
    store.setPhase('execution');
  });

  it('shows the result it answers a second after its last object settled', async () => {
    render(<ForgePage />);
    host('forge:progress', { objectName: 'Opportunity', status: 'done', progress: 100 });
    host('forge:progress', { objectName: 'OpportunityLineItem', status: 'done', progress: 100 });

    // The statuses given back, the write dates read back: the run goes on.
    await wait(1_000);
    expect(screen.getByTestId('forge-execution-status').textContent).toBe('FINISHING...');

    host('forge:execute:response', { result: RESULT, operationId: 'forge-execute-1' });

    expect(useForgeStore.getState().result).toEqual(RESULT);
    const results = await screen.findByTestId('forge-results');
    const inserted = within(results).getAllByTestId('kpi-value')[0];
    expect(inserted.textContent).toBe('4');
    // The rate is measured on the records read, and the object the run added
    // beyond the graph has its row: both come from the answer alone.
    expect(results.textContent).toContain('100%');
    expect(
      within(screen.getByTestId('forge-results-table')).getByText('PricebookEntry'),
    ).toBeTruthy();
    expect(screen.getAllByTestId('forge-id-mapping-row')).toHaveLength(4);
  });

  it('shows the result it answers straight after its last object', async () => {
    render(<ForgePage />);
    host('forge:progress', { objectName: 'Opportunity', status: 'done', progress: 100 });
    host('forge:progress', { objectName: 'OpportunityLineItem', status: 'done', progress: 100 });
    host('forge:execute:response', { result: RESULT, operationId: 'forge-execute-1' });

    expect(useForgeStore.getState().result).toEqual(RESULT);
    const results = await screen.findByTestId('forge-results');
    expect(within(results).getAllByTestId('kpi-value')[0].textContent).toBe('4');
  });
});
