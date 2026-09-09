import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
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

/** Drives the container without standing up the whole bridge. */
const queryState: { data: unknown; loading: boolean; error: string | null } = {
  data: undefined,
  loading: false,
  error: null,
};
vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: () => ({ ...queryState, refetch: vi.fn() }),
}));

import { ReportsContainer } from './ReportsContainer';

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

describe('ReportsContainer', () => {
  beforeEach(() => {
    queryState.data = undefined;
    queryState.loading = false;
    queryState.error = null;
    mockPostMessage.mockClear();
  });

  it('says the executions tab is unwired while nothing has answered', () => {
    // `undefined` is "no producer supplied this" — the state the module was
    // shipped in. It must not be confused with an empty history.
    render(<ReportsContainer />);

    expect(screen.getByTestId('reports-page')).toBeDefined();
    expect(screen.queryByTestId('reports-kpi-row')).toBeNull();
  });

  it('renders the KPI row once the host answers, even with no runs yet', () => {
    // `[]` is a measurement: the org has run nothing. The zeros are honest
    // here in a way they never were before a producer existed.
    queryState.data = {
      reports: [],
      summary: { totalOperations: 0, successRate: 0, avgDuration: 0, errorRate: 0 },
    };

    render(<ReportsContainer />);

    expect(screen.getByTestId('reports-kpi-row')).toBeDefined();
  });

  it('shows the reports the host built from stored history', () => {
    queryState.data = {
      reports: [report('sync-1'), report('sync-2')],
      summary: { totalOperations: 2, successRate: 100, avgDuration: 9_000, errorRate: 0 },
    };

    render(<ReportsContainer />);

    expect(screen.getByTestId('reports-kpi-row')).toBeDefined();
    expect(screen.getAllByText(/Sync — sync-/).length).toBeGreaterThan(0);
  });

  it('does not claim the feature is unwired when the read merely failed', () => {
    // Leaving `reports` undefined on an error would make the page say "not
    // wired yet" about a feature that is wired and simply did not answer.
    queryState.error = "Bridge query 'reports:list' failed";

    render(<ReportsContainer />);

    expect(screen.getByTestId('reports-page')).toBeDefined();
  });
});
