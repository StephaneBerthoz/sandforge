import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, within, fireEvent } from '@testing-library/react';
import type { ForgeExecutionResult, ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import '../../i18n';
import { useForgeStore } from '../../stores/useForgeStore';
import { ForgePage } from './ForgePage';

/*
 * The page with the real store, left and come back to as the side bar leaves
 * it: unmounted, then mounted again. What a run reports while the page is
 * away, and how it ends, has to be there when it comes back, which only the
 * store, the page and the screens together can show.
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

/** What the extension says of a run whose session expired under it. */
const SESSION_EXPIRED = 'INVALID_SESSION_ID: Session expired or invalid';

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

/** The run as the history keeps it: the opportunity and a line item it created before it stopped. */
const STOPPED_RUN: ForgeExecutionResult = {
  forgeId: 'forge-stopped',
  status: 'failure',
  graph: GRAPH,
  duration: 4_000,
  timestamp: '2026-09-24T08:00:00.000Z',
  idRemapCount: 2,
  idRemapTable: {
    '006000000000001SRC': '006000000000001TGT',
    '00k000000000001SRC': '00k000000000001TGT',
  },
  idRemapCreated: [
    { objectApiName: 'Opportunity', sourceIds: ['006000000000001SRC'] },
    { objectApiName: 'OpportunityLineItem', sourceIds: ['00k000000000001SRC'] },
  ],
  createdCount: 2,
  linkedExistingCount: 0,
  readByObject: [
    { objectApiName: 'Opportunity', read: 1 },
    { objectApiName: 'OpportunityLineItem', read: 2 },
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

/** The run's error, as `sendHandlerError` posts it. */
function stopped(message: string, result?: ForgeExecutionResult): void {
  host('forge:execute:error', {
    message,
    code: 'EXECUTE_ERROR',
    retryable: true,
    ...(result ? { result } : {}),
  });
}

/** What the log on screen says, line by line. */
function logLines(): string[] {
  return screen.getAllByTestId('logstream-entry').map((entry) => entry.textContent ?? '');
}

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

describe('ForgePage — a run that stops on an error', () => {
  it('says why it stopped and what it had created, and shows what it wrote', async () => {
    render(<ForgePage />);
    host('forge:progress', { objectName: 'Opportunity', status: 'done', progress: 100 });
    host('forge:progress', { objectName: 'OpportunityLineItem', status: 'running', progress: 50 });

    stopped(SESSION_EXPIRED, STOPPED_RUN);

    expect(screen.getByTestId('forge-execution-status').textContent).toBe('STOPPED');
    const error = screen.getByTestId('forge-execution-error');
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.textContent).toContain(`The run stopped before its end: ${SESSION_EXPIRED}`);
    expect(screen.getByTestId('forge-execution-error-written').textContent).toBe(
      'Before it stopped, it had created 2 records in the target org.',
    );
    // Pause and Abort had nothing left to act on, and stayed as the only
    // controls on the screen.
    expect(screen.queryByTestId('forge-pause-button')).toBeNull();
    expect(screen.queryByTestId('forge-abort-button')).toBeNull();
    // One object of two had settled.
    expect(screen.getByTestId('forge-run-stopped-status').textContent).toBe(
      'Forge stopped at 50%.',
    );

    fireEvent.click(screen.getByTestId('forge-execution-see-stopped'));

    const results = await screen.findByTestId('forge-results');
    expect(within(results).getAllByTestId('kpi-value')[0].textContent).toBe('2');
    expect(within(results).getByTestId('forge-results-stopped').textContent).toBe(
      `The run stopped before its end: ${SESSION_EXPIRED}`,
    );
    expect(within(results).getAllByTestId('forge-id-mapping-row')).toHaveLength(2);
    expect(useForgeStore.getState().result).toEqual(STOPPED_RUN);
  });

  it('goes back to the Review of a run that said nothing of what it wrote', async () => {
    render(<ForgePage />);
    host('forge:progress', { objectName: 'Opportunity', status: 'running', progress: 10 });

    stopped(SESSION_EXPIRED);

    expect(screen.queryByTestId('forge-execution-error-written')).toBeNull();
    expect(screen.queryByTestId('forge-execution-see-stopped')).toBeNull();

    fireEvent.click(screen.getByTestId('forge-execution-back-to-review'));

    await screen.findByTestId('forge-review');
    // The graph comes back as discovery left it, for the run started next.
    expect(useForgeStore.getState().graph?.nodes.map((n) => n.status)).toEqual(['idle', 'idle']);
  });

  it('keeps the error and the log when the page is left and come back to', () => {
    const { unmount } = render(<ForgePage />);
    host('forge:progress', { objectName: 'Opportunity', status: 'done', progress: 100 });
    stopped(SESSION_EXPIRED);

    unmount();
    render(<ForgePage />);

    // It came back as a run under way: "FORGING...", its log emptied, and
    // nothing to say it had stopped.
    expect(screen.getByTestId('forge-execution-status').textContent).toBe('STOPPED');
    expect(screen.getByTestId('forge-execution-error').textContent).toContain(SESSION_EXPIRED);
    const lines = logLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Opportunity: done (100%)');
    expect(lines[1]).toContain(SESSION_EXPIRED);
  });

  it('takes the error that comes while the page is away', () => {
    const { unmount } = render(<ForgePage />);
    host('forge:progress', { objectName: 'Opportunity', status: 'done', progress: 100 });
    unmount();

    stopped(SESSION_EXPIRED, STOPPED_RUN);
    render(<ForgePage />);

    expect(screen.getByTestId('forge-execution-error').textContent).toContain(SESSION_EXPIRED);
    expect(screen.getByTestId('forge-execution-error-written').textContent).toBe(
      'Before it stopped, it had created 2 records in the target org.',
    );
    expect(screen.getByTestId('forge-run-stopped-status').textContent).toBe(
      'Forge stopped at 50%.',
    );
  });
});

describe('ForgePage — a run left while it goes on', () => {
  it('shows where each object stands when come back to, not where it stood when left', () => {
    const { unmount } = render(<ForgePage />);
    host('forge:progress', { objectName: 'Opportunity', status: 'running', progress: 40 });
    unmount();

    host('forge:progress', { objectName: 'Opportunity', status: 'done', progress: 100 });
    host('forge:progress', { objectName: 'OpportunityLineItem', status: 'running', progress: 10 });
    render(<ForgePage />);

    // Done, Running, Queued, Failed: Opportunity still read "running" and its
    // line items "queued", and the log started empty.
    const [done, running, queued, failed] = screen
      .getAllByTestId('kpi-value')
      .map((value) => value.textContent);
    expect([done, running, queued, failed]).toEqual(['1', '1', '0', '0']);
    expect(logLines()).toHaveLength(3);
    expect(logLines()[2]).toContain('OpportunityLineItem: running (10%)');
  });

  it('still takes nothing another run reports while the page is away', () => {
    const { unmount } = render(<ForgePage />);
    unmount();

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            id: 'host-other',
            type: 'forge:progress',
            timestamp: Date.now(),
            correlationId: 'wv-forge-other',
            payload: { objectName: 'Opportunity', status: 'done', progress: 100 },
          },
        }),
      );
    });
    render(<ForgePage />);

    expect(useForgeStore.getState().graph?.nodes.map((n) => n.status)).toEqual(['idle', 'idle']);
    expect(screen.getByTestId('logstream-empty')).toBeTruthy();
  });
});
