import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import type { BaseMessage } from '@sandforge/shared';
import '../../i18n';

const mockPostMessage = vi.fn();
vi.mock('../../hooks/useVSCodeApi', () => {
  const api = {
    postMessage: (...args: unknown[]) => mockPostMessage(...args),
    getState: () => undefined,
    setState: () => undefined,
  };
  return { getVscodeApi: () => api, useVSCodeApi: () => api };
});

/* React Flow needs a measured DOM; the graph's own tests cover its drawing. */
vi.mock('@xyflow/react', () => ({
  __esModule: true,
  ReactFlow: ({ nodes }: { nodes: unknown[] }) => (
    <div data-testid="mock-reactflow" data-nodes={nodes.length} />
  ),
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
}));

/** Drives the container without standing up the whole bridge, one state per request. */
type QueryState = { data: unknown; loading: boolean; error: string | null };
const queries: Record<string, QueryState> = {};
const queryCalls: Array<{ type: string; payload?: Record<string, unknown> }> = [];
/** The refetch each request type is given, the same one at every render. */
const refetches: Record<string, ReturnType<typeof vi.fn>> = {};
vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string, payload?: Record<string, unknown>) => {
    queryCalls.push({ type, payload });
    const refetch = (refetches[type] ??= vi.fn());
    return { ...(queries[type] ?? { data: null, loading: true, error: null }), refetch };
  },
}));

import { ReportsContainer } from './ReportsContainer';
import { useNotificationStore } from '../../stores/useNotificationStore';

const answer = (type: string, data: unknown): void => {
  queries[type] = { data, loading: false, error: null };
};

/** The messages of one type the page posted to the host, by the bridge rather than a query. */
const posted = <T,>(type: string): Array<BaseMessage & { payload: T }> =>
  mockPostMessage.mock.calls
    .map((call) => (call[0] as { payload: BaseMessage & { payload: T } }).payload)
    .filter((message) => message.type === type);

/** Answer a posted request on `type`, correlated as a handler does. */
function reply(request: BaseMessage, type: string, payload: unknown): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: `resp-${request.id}`,
          type,
          timestamp: Date.now(),
          correlationId: request.id,
          payload,
        },
      }),
    );
  });
}

/** The payload of the latest request of one type. */
const lastPayload = (type: string): Record<string, unknown> | undefined =>
  queryCalls.filter((c) => c.type === type).pop()?.payload;

const report = (id: string) => ({
  id,
  definitionId: id,
  type: 'sync_execution',
  title: `Sync — ${id}`,
  summary: 'completed · 120 processed',
  sections: [{ title: 'Outcome', type: 'summary', order: 0, content: { status: 'completed' } }],
  metadata: { module: 'sync', duration: 9_000, recordCount: 120 },
  generatedAt: '2026-09-09T10:00:00.000Z',
});

const entry = {
  id: 'aud-1',
  action: 'sync_execute',
  module: 'sync',
  orgId: '00D000000000001AAA',
  orgAlias: 'target-sandbox',
  operationId: 'op-1',
  outcome: 'success',
  objects: [{ objectApiName: 'Account', created: 2, updated: 0, deleted: 0, failed: 0 }],
  details: {},
  timestamp: '2026-09-09T10:00:00.000Z',
};

const facets = {
  modules: ['forge', 'sync'],
  orgs: [{ orgId: '00D000000000001AAA', orgAlias: 'target-sandbox' }],
};

const graph = (operationId: string) => ({
  operationId,
  generatedAt: '2026-09-09T10:00:00.000Z',
  module: 'sync',
  action: 'sync_execute',
  nodes: [
    { id: 'source', type: 'source', label: 'source-uat', origin: 'org' },
    { id: 'object:Account', type: 'object', label: 'Account', recordCount: 2 },
    { id: 'target', type: 'destination', label: 'target-sandbox', origin: 'org' },
  ],
  edges: [
    { sourceId: 'source', targetId: 'object:Account' },
    { sourceId: 'object:Account', targetId: 'target', recordCount: 2 },
  ],
});

describe('ReportsContainer', () => {
  beforeEach(() => {
    for (const key of Object.keys(queries)) delete queries[key];
    for (const key of Object.keys(refetches)) delete refetches[key];
    queryCalls.length = 0;
    mockPostMessage.mockClear();
  });

  it('says each tab is loading while nothing has answered, not that it is coming', () => {
    // An answer not in yet left every prop undefined, which the page read as
    // "no producer": all four tabs said "Coming soon" about features it had.
    render(<ReportsContainer />);

    expect(screen.getByTestId('reports-page')).toBeDefined();
    expect(screen.queryByTestId('reports-kpi-row')).toBeNull();
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    expect(screen.getByTestId('reports-executions-loading')).toBeDefined();
    expect(screen.queryByText('Coming soon')).toBeNull();
  });

  it('says a tab is loading before the first query has even been sent', () => {
    // `loading` turns on in the effect that sends the query, a render after
    // the first: until then nothing has answered, and nothing has failed.
    queries['reports:list'] = { data: null, loading: false, error: null };
    queries['reports:audit'] = { data: null, loading: false, error: null };
    queries['reports:lineage'] = { data: null, loading: false, error: null };

    render(<ReportsContainer />);

    expect(screen.getAllByRole('tab')).toHaveLength(4);
    expect(screen.getByTestId('reports-executions-loading')).toBeDefined();
  });

  it('renders the KPI row once the host answers, even with no runs yet', () => {
    // `[]` is a measurement: the org has run nothing. The zeros are honest
    // here in a way they never were before a producer existed.
    answer('reports:list', {
      reports: [],
      summary: { totalOperations: 0, successRate: 0, avgDuration: 0, errorRate: 0 },
    });

    render(<ReportsContainer />);

    expect(screen.getByTestId('reports-kpi-row')).toBeDefined();
  });

  it('shows the reports the host built from stored history', () => {
    answer('reports:list', {
      reports: [report('sync-1'), report('sync-2')],
      summary: { totalOperations: 2, successRate: 100, avgDuration: 9_000, errorRate: 0 },
    });

    render(<ReportsContainer />);

    expect(screen.getByTestId('reports-kpi-row')).toBeDefined();
    expect(screen.getAllByText(/Sync — sync-/).length).toBeGreaterThan(0);
  });

  it('does not claim the feature is unwired when the read merely failed', () => {
    // Leaving `reports` undefined on an error would make the page say "not
    // wired yet" about a feature that is wired and simply did not answer.
    queries['reports:list'] = {
      data: null,
      loading: false,
      error: "Bridge query 'reports:list' failed",
    };

    render(<ReportsContainer />);

    expect(screen.getByTestId('reports-page')).toBeDefined();
  });

  it('says the reports could not be read, with a retry, rather than that none were generated', () => {
    // Given an empty list, the tab said "No reports generated yet" and the
    // tiles counted 0 reports; the analytics tab, given no summary, was gone.
    queries['reports:list'] = { data: null, loading: false, error: 'timed out' };

    render(<ReportsContainer />);

    expect(screen.getByTestId('reports-executions-error-message').textContent).toContain(
      'The reports could not be read: timed out',
    );
    expect(screen.queryByText('No reports generated yet')).toBeNull();
    expect(screen.queryByText('Total Reports')).toBeNull();
    fireEvent.click(screen.getByTestId('reports-executions-error-retry'));
    expect(refetches['reports:list']).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('tab', { name: 'Analytics' }));
    expect(screen.getByTestId('reports-analytics-error-message').textContent).toBe(
      'The analytics could not be loaded: they come with the reports, which could not be read.',
    );
    fireEvent.click(screen.getByTestId('reports-analytics-error-retry'));
    expect(refetches['reports:list']).toHaveBeenCalledTimes(2);
  });

  it('asks for the newest page of the audit trail and for the latest lineage', () => {
    render(<ReportsContainer />);

    expect(lastPayload('reports:audit')).toEqual({ limit: 100 });
    expect(queryCalls.some((c) => c.type === 'reports:lineage' && c.payload === undefined)).toBe(
      true,
    );
  });

  it('says what the audit tab will show once a run writes, on an install with nothing recorded', () => {
    answer('reports:audit', {
      entries: [],
      total: 0,
      offset: 0,
      facets: { modules: [], orgs: [] },
    });

    render(<ReportsContainer />);
    fireEvent.click(screen.getByText('Audit Trail'));

    expect(screen.getByTestId('reports-audit-empty')).toBeDefined();
    expect(screen.getByText('Nothing recorded yet')).toBeDefined();
    expect(screen.queryByTestId('reports-audit-soon')).toBeNull();
    expect(screen.queryByText('Coming soon')).toBeNull();
  });

  it('lists the recorded runs, and counts the whole trail in the KPI row', () => {
    answer('reports:audit', { entries: [entry], total: 240, offset: 0, facets });

    render(<ReportsContainer />);
    fireEvent.click(screen.getByText('Audit Trail'));

    expect(screen.getByTestId('audit-aud-1')).toBeDefined();
    expect(screen.getByText('240')).toBeDefined();
  });

  it('asks the host again with the org picked, from the newest entry', () => {
    answer('reports:audit', { entries: [entry], total: 240, offset: 0, facets });
    render(<ReportsContainer />);
    fireEvent.click(screen.getByText('Audit Trail'));

    fireEvent.click(screen.getByTestId('audit-show-more'));
    expect(lastPayload('reports:audit')).toEqual({ limit: 200 });

    fireEvent.change(screen.getByTestId('org-filter'), {
      target: { value: '00D000000000001AAA' },
    });
    expect(lastPayload('reports:audit')).toEqual({ orgId: '00D000000000001AAA', limit: 100 });
  });

  it('says why the trail is missing when it could not be read, not that nothing was recorded', () => {
    queries['reports:audit'] = { data: null, loading: false, error: 'timed out' };

    render(<ReportsContainer />);
    fireEvent.click(screen.getByText('Audit Trail'));

    expect(screen.getByTestId('reports-audit-error')).toBeDefined();
    expect(screen.queryByTestId('reports-audit-empty')).toBeNull();
  });

  describe('exporting the audit trail', () => {
    const seed = { ...entry, id: 'aud-2', action: 'seed_execute', module: 'seed' };
    const hostile = { ...entry, id: 'aud-3', orgAlias: '=cmd|calc', details: { code: '@SUM(1)' } };

    function openTrail(): void {
      answer('reports:audit', { entries: [entry, seed], total: 240, offset: 0, facets });
      render(<ReportsContainer />);
      fireEvent.click(screen.getByText('Audit Trail'));
    }

    it('asks for every entry the filters match, not the page, and saves them as a CSV file', () => {
      openTrail();
      fireEvent.change(screen.getByTestId('org-filter'), {
        target: { value: '00D000000000001AAA' },
      });
      fireEvent.click(screen.getByTestId('audit-export-csv'));

      const [request] = posted<Record<string, unknown>>('reports:audit');
      expect(request.payload).toEqual({ orgId: '00D000000000001AAA', limit: 2000 });
      expect(posted('file:save')).toEqual([]);

      reply(request, 'reports:audit:response', {
        entries: [entry, seed, hostile],
        total: 3,
        offset: 0,
        facets,
      });

      const [save] = posted<{ suggestedName: string; content: string; extensions: string[] }>(
        'file:save',
      );
      expect(save.payload.suggestedName).toMatch(/^sandforge-audit-trail-\d{4}-\d{2}-\d{2}\.csv$/);
      expect(save.payload.extensions).toEqual(['csv']);
      const lines = save.payload.content.split('\n');
      expect(lines).toHaveLength(4);
      expect(lines[3]).toContain(`"'=cmd|calc"`);
      expect(lines[3]).toContain(`"'@SUM(1)"`);
    });

    it('narrows the file to the action picked, as the list is, and says so in the JSON', () => {
      openTrail();
      fireEvent.change(screen.getByTestId('action-filter'), { target: { value: 'seed_execute' } });
      fireEvent.click(screen.getByTestId('audit-export-json'));

      const [request] = posted<Record<string, unknown>>('reports:audit');
      reply(request, 'reports:audit:response', {
        entries: [entry, seed],
        total: 2,
        offset: 0,
        facets,
      });

      const [save] = posted<{ suggestedName: string; content: string }>('file:save');
      expect(save.payload.suggestedName).toMatch(/\.json$/);
      const file = JSON.parse(save.payload.content) as {
        filter: Record<string, unknown>;
        entries: Array<{ id: string }>;
      };
      expect(file.filter).toEqual({ action: 'seed_execute' });
      expect(file.entries.map((e) => e.id)).toEqual(['aud-2']);
    });

    it('says the export could not be made when the trail could not be read for it', () => {
      useNotificationStore.setState({ notifications: [] });
      openTrail();
      fireEvent.click(screen.getByTestId('audit-export-csv'));

      const [request] = posted<Record<string, unknown>>('reports:audit');
      reply(request, 'reports:error', { message: 'unreadable', code: 'X', retryable: false });

      expect(posted('file:save')).toEqual([]);
      expect(useNotificationStore.getState().notifications.map((n) => n.message)).toContain(
        'The audit trail could not be read for the export: unreadable',
      );
    });
  });

  it('says what the lineage tab will show once a run writes, when none is traced', () => {
    answer('reports:lineage', { lineage: null, runs: [] });

    render(<ReportsContainer />);
    fireEvent.click(screen.getByText('Data Lineage'));

    expect(screen.getByTestId('reports-lineage-empty')).toBeDefined();
    expect(screen.queryByTestId('reports-lineage-soon')).toBeNull();
  });

  it('asks for the lineage of the run an audit entry records, from the entry', () => {
    answer('reports:audit', { entries: [entry], total: 1, facets });
    answer('reports:lineage', {
      lineage: graph('op-2'),
      runs: [
        { operationId: 'op-2', generatedAt: '2026-09-09T11:00:00.000Z', action: 'forge_execute' },
        { operationId: 'op-1', generatedAt: '2026-09-09T10:00:00.000Z', action: 'sync_execute' },
      ],
    });

    render(<ReportsContainer />);
    fireEvent.click(screen.getByText('Audit Trail'));
    fireEvent.click(screen.getByTestId('audit-view-run-aud-1'));

    expect(lastPayload('reports:lineage')).toEqual({ operationId: 'op-1' });
    expect(screen.getByRole('tab', { name: 'Data Lineage' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('draws the latest run’s lineage, and asks for another run when one is picked', () => {
    answer('reports:lineage', {
      lineage: graph('op-2'),
      runs: [
        { operationId: 'op-2', generatedAt: '2026-09-09T10:00:00.000Z', action: 'sync_execute' },
        { operationId: 'op-1', generatedAt: '2026-09-08T10:00:00.000Z', action: 'forge_execute' },
      ],
    });

    render(<ReportsContainer />);
    fireEvent.click(screen.getByText('Data Lineage'));

    expect(screen.getByTestId('lineage-graph')).toBeDefined();
    fireEvent.change(screen.getByTestId('lineage-run'), { target: { value: 'op-1' } });
    expect(lastPayload('reports:lineage')).toEqual({ operationId: 'op-1' });
  });
});
