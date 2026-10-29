import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
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

/** Whether the removal's file could not be fetched: it throws as React.lazy does then. */
const removalFile = vi.hoisted(() => ({ unfetched: false }));

vi.mock('./SeedRunRemoval', async (original) => {
  const actual = await original<typeof import('./SeedRunRemoval')>();
  const { createElement } = await import('react');
  return {
    ...actual,
    SeedRunRemoval: (props: Parameters<typeof actual.SeedRunRemoval>[0]) => {
      if (removalFile.unfetched) {
        throw new TypeError(
          'Failed to fetch dynamically imported module: https://panel.test/assets/SeedRunRemoval-x.js',
        );
      }
      return createElement(actual.SeedRunRemoval, props);
    },
  };
});

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
    removalFile.unfetched = false;
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

  it('says under the seed that its removal could not be fetched, the list and its other seeds up', async () => {
    // Fetched as a seed is opened onto it, its failure took the Seed page
    // down: the gallery, the other ways to seed and the list with it.
    removalFile.unfetched = true;
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      render(<SeedRunHistory />);
      answer('seed:removal:list', 'seed:removal:list:response', { runs: RUNS });

      fireEvent.click(screen.getByTestId('seed-run-history-toggle-op-2'));

      const failed = await screen.findByTestId('seed-removal-failed');
      expect(failed.textContent).toContain('This part did not load');
      expect(screen.getByTestId('seed-removal-failed-reload')).toBeDefined();
      expect(screen.getByTestId('seed-run-history-op-1')).toBeDefined();
    } finally {
      quiet.mockRestore();
    }
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

  it('marks a seed a rewind took back, and none that ended before the checkpoint was taken', () => {
    render(<SeedRunHistory />);
    // Nothing to mark yet: the rewinds are read once the list holds a run.
    expect(sentAll('checkpoint:rewinds')).toEqual([]);
    answer('seed:removal:list', 'seed:removal:list:response', {
      runs: [
        { ...RUNS[0], objects: ['Account', 'Opportunity'] },
        { ...RUNS[1], objects: ['Account'] },
      ],
    });
    answer('checkpoint:rewinds', 'checkpoint:rewinds:response', {
      rewinds: [
        {
          kind: 'rewind',
          rewindId: 'rw-20261018-120000-aaaa',
          checkpointId: 'ck-20261018-070000-aaaa',
          checkpointName: 'Before UAT',
          organizationId: '00D000000000001AAA',
          mode: 'picked',
          objects: ['Account', 'Contact'],
          readFrom: '2026-10-18T07:00:00.000Z',
          takenAt: '2026-10-18T07:05:00.000Z',
          startedAt: '2026-10-18T12:00:00.000Z',
          endedAt: '2026-10-18T12:10:00.000Z',
          status: 'partial',
          totals: { deleted: 5, restored: 0, undeleted: 0, recreated: 0 },
          orgIds: ['org-dev'],
        },
      ],
    });

    const mark = screen.getByTestId('seed-run-history-rewound-op-2');
    expect(mark.textContent).toContain('to “Before UAT”');
    expect(mark.textContent).toContain('the rewind left some records');
    expect(mark.textContent).toContain('Not rewound: Opportunity, outside the checkpoint');
    // The seed of the day before: the checkpoint holds what it created.
    expect(screen.queryByTestId('seed-run-history-rewound-op-1')).toBeNull();
  });

  it('shows nothing when no seed is kept', () => {
    render(<SeedRunHistory />);
    answer('seed:removal:list', 'seed:removal:list:response', { runs: [] });

    expect(screen.queryByTestId('seed-run-history')).toBeNull();
  });

  it("opens a scenario's run onto its agent's test file, read of the org it wrote to, and no other run", async () => {
    render(<SeedRunHistory />);
    answer('seed:removal:list', 'seed:removal:list:response', {
      runs: [{ ...RUNS[0], scenario: { packId: 'retail-orders' } }, RUNS[1]],
    });
    expect(screen.queryByTestId('seed-run-history-tests-op-1')).toBeNull();

    const toggle = screen.getByTestId('seed-run-history-tests-op-2');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(sentAll('seed:scenario:agents').pop()?.payload).toEqual({ orgId: 'org-dev' }),
    );
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByTestId('scenario-tests-stale')).toBeNull();
  });

  it('says of a removed scenario run that its test file names cases that are gone', async () => {
    render(<SeedRunHistory />);
    answer('seed:removal:list', 'seed:removal:list:response', {
      runs: [{ ...RUNS[1], scenario: { packId: 'retail-orders', agent: 'Retail_Service_Agent' } }],
    });

    fireEvent.click(screen.getByTestId('seed-run-history-tests-op-1'));

    expect((await screen.findByTestId('scenario-tests-stale')).textContent).toContain(
      'its test file names cases that are gone',
    );
  });

  describe('a seed whose removal found its records gone, a rewind having deleted them', () => {
    // The seed of the 17th at 08:00; a checkpoint taken at 07:00; its rewind
    // from 10:00 to 10:10 deleted the seed's account; the seed's removal at
    // 11:00 found it gone.
    const REMOVED: SeedRunRemovalInfo = {
      ...RUNS[1],
      objects: ['Account'],
      removed: {
        removedAt: '2026-10-17T11:00:00.000Z',
        deleted: 0,
        alreadyGone: 1,
        kept: 0,
        refused: 0,
      },
      createdByObject: [{ objectApiName: 'Account', count: 1 }],
    };
    const REWIND = {
      kind: 'rewind',
      rewindId: 'rw-20261017-100000-aaaa',
      checkpointId: 'ck-20261017-070000-aaaa',
      checkpointName: 'Before UAT',
      organizationId: '00D000000000001AAA',
      mode: 'picked',
      objects: ['Account'],
      readFrom: '2026-10-17T07:00:00.000Z',
      takenAt: '2026-10-17T07:05:00.000Z',
      startedAt: '2026-10-17T10:00:00.000Z',
      endedAt: '2026-10-17T10:10:00.000Z',
      status: 'success',
      totals: { deleted: 1, restored: 0, undeleted: 0, recreated: 0 },
      orgIds: ['org-dev'],
    };
    const undoAt = (undoneAt: string) => ({
      kind: 'undo',
      rewindId: REWIND.rewindId,
      checkpointId: REWIND.checkpointId,
      organizationId: REWIND.organizationId,
      status: 'success',
      undoneAt,
      orgIds: ['org-dev'],
    });

    /** The history, the seed and the ledger read, the seed opened onto its removal. */
    async function opened(run: SeedRunRemovalInfo, undoneAt: string): Promise<HTMLElement> {
      render(<SeedRunHistory />);
      answer('seed:removal:list', 'seed:removal:list:response', { runs: [run] });
      answer('checkpoint:rewinds', 'checkpoint:rewinds:response', {
        rewinds: [REWIND, undoAt(undoneAt)],
      });
      fireEvent.click(screen.getByTestId('seed-run-history-toggle-op-1'));
      await waitFor(() => expect(sentAll('seed:removal:info')).toHaveLength(1));
      answer('seed:removal:info', 'seed:removal:info:response', { info: run });
      return screen.getByTestId('seed-run-history-rewound-op-1');
    }

    it('says the undo of the rewind brought its records back after the removal, and offers to remove them again', async () => {
      const mark = await opened(REMOVED, '2026-10-17T12:00:00.000Z');

      // It said "undone on" a date and nothing was left to remove, the
      // account back in the org.
      expect(mark.textContent).toContain('Its records came back with the undo of');
      expect(mark.textContent).not.toContain('undone on');
      const again = await screen.findByTestId('seed-removal-remove-again');
      expect(again.textContent).toBe('Remove again');

      fireEvent.click(again);
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByTestId('seed-removal-again-note').textContent).toContain(
        'Every record this run created is read again',
      );
      expect(within(dialog).getByTestId('forge-removal-plan-Account').textContent).toBe(
        'Account: 1 record',
      );
      // Every record again: no word of what an earlier removal left.
      expect(within(dialog).queryByTestId('forge-removal-left-by')).toBeNull();
      fireEvent.change(screen.getByTestId('danger-input'), { target: { value: DEV.alias } });
      fireEvent.click(screen.getByTestId('danger-confirm-btn'));

      expect(sentAll('seed:remove').pop()?.payload).toEqual({ runId: 'op-1', again: true });
    });

    it('offers nothing again when the undo came before the removal, which then took the records back', async () => {
      const mark = await opened(
        { ...REMOVED, removed: { ...REMOVED.removed!, deleted: 1, alreadyGone: 0 } },
        '2026-10-17T10:30:00.000Z',
      );

      expect(mark.textContent).toContain('undone on');
      expect(mark.textContent).not.toContain('came back');
      await screen.findByTestId('seed-removal');
      expect(screen.queryByTestId('seed-removal-remove-again')).toBeNull();
      expect(screen.queryByTestId('seed-removal-remove')).toBeNull();
    });

    it('offers nothing again when the removal came before the rewind, and deleted the records itself', async () => {
      const mark = await opened(
        {
          ...REMOVED,
          removed: {
            ...REMOVED.removed!,
            removedAt: '2026-10-17T09:00:00.000Z',
            deleted: 1,
            alreadyGone: 0,
          },
        },
        '2026-10-17T12:00:00.000Z',
      );

      expect(mark.textContent).toContain('undone on');
      await screen.findByTestId('seed-removal');
      expect(screen.queryByTestId('seed-removal-remove-again')).toBeNull();
    });
  });
});
