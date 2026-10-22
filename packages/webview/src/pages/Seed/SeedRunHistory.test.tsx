import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { BaseMessage, SalesforceOrg, SeedRunRemovalInfo } from '@sandforge/shared';
import '../../i18n';

const mockPostMessage = vi.fn();

/** Stable identity so useSendMessage's useCallback does not re-fire. */
const stableApi = {
  postMessage: (...args: unknown[]) => mockPostMessage(...args),
  getState: () => undefined,
  setState: () => undefined,
};

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => stableApi,
  getVscodeApi: () => stableApi,
}));

import { SeedRunHistory } from './SeedRunHistory';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';

const DEV = {
  id: 'org-dev',
  alias: 'DEV-SANDBOX',
  status: 'connected',
} as unknown as SalesforceOrg;

/** A seed whose records are still in the org, and one removed whole. */
const RUNS: SeedRunRemovalInfo[] = [
  {
    runId: 'op-2',
    targetOrgId: 'org-dev',
    startedAt: '2026-10-18T08:00:00.000Z',
    endedAt: '2026-10-18T08:01:00.000Z',
    created: 5,
    left: [{ objectApiName: 'Account', count: 5 }],
  },
  {
    runId: 'op-1',
    targetOrgId: 'org-dev',
    startedAt: '2026-10-17T08:00:00.000Z',
    endedAt: '2026-10-17T08:01:00.000Z',
    created: 1,
    left: [],
    removed: {
      removedAt: '2026-10-17T09:00:00.000Z',
      deleted: 1,
      alreadyGone: 0,
      kept: 0,
      refused: 0,
    },
  },
];

function sentAll(type: string): Array<BaseMessage & { payload: Record<string, unknown> }> {
  return mockPostMessage.mock.calls
    .map(
      (call) =>
        (call[0] as { payload: BaseMessage & { payload: Record<string, unknown> } }).payload,
    )
    .filter((message) => message.type === type);
}

function answer(requestType: string, type: string, payload: unknown): void {
  const request = sentAll(requestType).pop();
  if (!request) throw new Error(`no '${requestType}' was sent`);
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: `resp-${type}-${Math.random()}`,
          type,
          timestamp: Date.now(),
          correlationId: request.id,
          payload,
        },
      }),
    );
  });
}

describe('SeedRunHistory', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    useOrgStore.setState({ orgs: [DEV] });
  });

  it('lists the seeds kept, newest first, and says which can still be removed', () => {
    render(<SeedRunHistory />);
    answer('seed:removal:list', 'seed:removal:list:response', { runs: RUNS });

    expect(screen.getByTestId('seed-run-history-op-2').textContent).toContain(
      'DEV-SANDBOX · 5 records created',
    );
    expect(screen.getByTestId('seed-run-history-state-op-2').textContent).toBe('can be removed');
    expect(screen.getByTestId('seed-run-history-state-op-1').textContent).toMatch(/^removed on /);
  });

  it('opens a seed onto its removal, which reads what the run kept', async () => {
    render(<SeedRunHistory />);
    answer('seed:removal:list', 'seed:removal:list:response', { runs: RUNS });

    const toggle = screen.getByTestId('seed-run-history-toggle-op-2');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    // The removal is loaded as it is opened, then asks for what the run kept.
    await waitFor(() =>
      expect(sentAll('seed:removal:info').pop()?.payload).toEqual({ runId: 'op-2' }),
    );
  });

  it('says a seed that stopped before it ended is partial, lists what the org confirmed, and still offers its removal', () => {
    render(<SeedRunHistory />);
    answer('seed:removal:list', 'seed:removal:list:response', {
      runs: [{ ...RUNS[0], runId: 'op-cut', unfinished: true }, RUNS[1]],
    });

    expect(screen.getByTestId('seed-run-history-unfinished-op-cut').textContent).toBe(
      'partial: the seed stopped before it ended — its window closed, or the extension stopped — and lists what the org had confirmed by then: records of a call still under way may be in the org unlisted',
    );
    expect(screen.getByTestId('seed-run-history-state-op-cut').textContent).toBe('can be removed');
    expect(screen.queryByTestId('seed-run-history-unfinished-op-1')).toBeNull();
  });

  it('says a seed still writing in this window is running, offers no removal, and leads to Live Operations', () => {
    useAppStore.setState({ currentRoute: 'seed' });
    render(<SeedRunHistory />);
    answer('seed:removal:list', 'seed:removal:list:response', {
      runs: [
        {
          ...RUNS[0],
          runId: 'op-live',
          running: true,
          refusal: { code: 'RUNNING', message: 'The seed is still writing.' },
        },
        RUNS[1],
      ],
    });

    expect(screen.getByTestId('seed-run-history-running-op-live').textContent).toBe(
      "running: the seed is still writing in this window. Stop it with the wizard's Cancel or from Monitor's Live Operations, and remove it once it has ended",
    );
    expect(screen.queryByTestId('seed-run-history-unfinished-op-live')).toBeNull();
    expect(screen.queryByTestId('seed-run-history-toggle-op-live')).toBeNull();
    fireEvent.click(screen.getByTestId('seed-run-history-live-op-live'));
    expect(useAppStore.getState().currentRoute).toBe('monitor');
  });

  it('says a seed another window is writing is running there, never partial, and offers no removal', () => {
    render(<SeedRunHistory />);
    answer('seed:removal:list', 'seed:removal:list:response', {
      runs: [
        {
          ...RUNS[0],
          runId: 'op-other',
          runningElsewhere: true,
          refusal: { code: 'RUNNING', message: 'The seed is still writing in another window.' },
        },
        RUNS[1],
      ],
    });

    expect(screen.getByTestId('seed-run-history-elsewhere-op-other').textContent).toBe(
      'running in another window: the seed is still writing there. Remove it once it has ended',
    );
    expect(screen.queryByTestId('seed-run-history-unfinished-op-other')).toBeNull();
    expect(screen.queryByTestId('seed-run-history-toggle-op-other')).toBeNull();
  });

  it('says how long the seeds are kept: until removed, and the latest twenty once removed', () => {
    render(<SeedRunHistory />);
    answer('seed:removal:list', 'seed:removal:list:response', { runs: RUNS });

    expect(screen.getByTestId('seed-run-history').textContent).toContain(
      'A seed whose records are still in its org stays listed until it is removed; of the seeds ' +
        'removed, the 20 latest are listed.',
    );
  });

  it('lists a CSV import and a clone among the seeds, each named by the way that wrote it, and offers their removal', () => {
    render(<SeedRunHistory />);
    answer('seed:removal:list', 'seed:removal:list:response', {
      runs: [
        { ...RUNS[0], runId: 'op-csv', origin: 'csv' },
        { ...RUNS[0], runId: 'op-clone', origin: 'clone', sourceOrgId: 'org-src' },
        RUNS[1],
      ],
    });

    expect(screen.getByTestId('seed-run-history-origin-op-csv').textContent).toBe('CSV Upload');
    expect(screen.getByTestId('seed-run-history-origin-op-clone').textContent).toBe(
      'Clone from Org',
    );
    expect(screen.getByTestId('seed-run-history-state-op-clone').textContent).toBe(
      'can be removed',
    );
    // A seed the generator wrote is not named.
    expect(screen.queryByTestId('seed-run-history-origin-op-1')).toBeNull();
  });

  it('shows nothing when no seed is kept', () => {
    render(<SeedRunHistory />);
    answer('seed:removal:list', 'seed:removal:list:response', { runs: [] });

    expect(screen.queryByTestId('seed-run-history')).toBeNull();
  });
});
