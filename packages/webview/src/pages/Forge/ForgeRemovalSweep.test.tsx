import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, within } from '@testing-library/react';
import type { BaseMessage, ForgeSweepListing, ForgeSweepResult } from '@sandforge/shared';
import '../../i18n';

const mockPostMessage = vi.fn();
const stableApi = {
  postMessage: (...args: unknown[]) => mockPostMessage(...args),
  getState: () => undefined,
  setState: () => undefined,
};
vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => stableApi,
  getVscodeApi: () => stableApi,
}));

import {
  ForgeRemovalSweep,
  ForgeRunSweepMark,
  ForgeRunSweepResult,
  ForgeSweepListingView,
} from './ForgeRemovalSweep';

/** Every message of `type` the component sent through the bridge. */
function sentAll(type: string): Array<BaseMessage & { payload: Record<string, unknown> }> {
  return mockPostMessage.mock.calls
    .map(
      (call) =>
        (call[0] as { payload: BaseMessage & { payload: Record<string, unknown> } }).payload,
    )
    .filter((message) => message.type === type);
}

/** Answer the last `requestType` message on `type`, correlated as the handler does. */
function answer(requestType: string, type: string, payload: unknown): void {
  const request = sentAll(requestType).pop();
  if (!request) throw new Error(`no '${requestType}' was sent`);
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: `resp-${type}`,
          type,
          timestamp: Date.now(),
          correlationId: request.id,
          payload,
        },
      }),
    );
  });
}

/** What a sweep found after a clone: tasks and an asset its automation created. */
const LISTING: ForgeSweepListing = {
  window: { from: '2026-10-15T08:59:59Z', to: '2026-10-15T09:03:00Z' },
  looked: ['Case', 'Task', 'FeedItem', 'Asset'],
  found: [
    { objectApiName: 'Task', count: 35, names: ['Welcome call', 'Follow up', 'Check risk'] },
    { objectApiName: 'Asset', count: 1, names: ['Insured risk'] },
  ],
  unread: [],
  handWork: [],
};

describe('ForgeRemovalSweep', () => {
  beforeEach(() => mockPostMessage.mockClear());

  it('reads, for the run named, what a sweep would take, and lists it per object', () => {
    render(<ForgeRemovalSweep forgeId="forge-1" org="DEV-SANDBOX" />);

    expect(sentAll('forge:undo-sweep:request').map((m) => m.payload)).toEqual([
      { forgeId: 'forge-1' },
    ]);
    expect(screen.getByTestId('forge-sweep-loading').textContent).toBe(
      "Reading what DEV-SANDBOX's automation created during the run…",
    );

    answer('forge:undo-sweep:request', 'forge:undo-sweep:response', {
      forgeId: 'forge-1',
      listing: LISTING,
    });

    expect(screen.getByRole('heading').textContent).toBe('What the sweep takes from DEV-SANDBOX');
    expect(screen.getByTestId('forge-sweep-found-Task').textContent).toContain('Task: 35 records');
    expect(screen.getByTestId('forge-sweep-found-Asset').textContent).toContain('Asset: 1 record');
    // Names on demand, behind a disclosure; more than shown says so.
    const names = within(screen.getByTestId('forge-sweep-found-Task')).getByText(
      'Welcome call, Follow up, Check risk, …',
    );
    expect(names.closest('details')).not.toBeNull();
    expect(screen.getByTestId('forge-sweep-window').textContent).toContain(
      'in: Case, Task, FeedItem, Asset',
    );
  });

  it('says the read failed rather than that nothing would be swept', () => {
    render(<ForgeRemovalSweep forgeId="forge-1" org="DEV-SANDBOX" />);
    const request = sentAll('forge:undo-sweep:request').pop();
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            id: 'err',
            type: 'forge:undo-sweep:error',
            timestamp: Date.now(),
            correlationId: request?.id,
            payload: { message: 'INVALID_SESSION_ID', code: 'SWEEP_ERROR', retryable: true },
          },
        }),
      );
    });

    expect(screen.getByTestId('forge-sweep-error').textContent).toContain('INVALID_SESSION_ID');
    expect(screen.queryByTestId('forge-sweep-none')).toBeNull();
  });

  it('reads nothing while no run is named', () => {
    render(<ForgeRemovalSweep forgeId={undefined} org="DEV-SANDBOX" />);
    expect(sentAll('forge:undo-sweep:request')).toEqual([]);
    expect(screen.queryByTestId('forge-removal-sweep')).toBeNull();
  });
});

describe('ForgeSweepListingView', () => {
  it('says the refusal and the hand work behind it, and lists nothing to delete', () => {
    render(
      <ForgeSweepListingView
        listing={{
          ...LISTING,
          found: [],
          handWork: [{ objectApiName: 'Opportunity', count: 2 }],
          refusal: 'hand work, likely',
        }}
      />,
    );

    expect(screen.getByTestId('forge-sweep-hand-work-Opportunity').textContent).toContain(
      'Opportunity: 2 records',
    );
    expect(screen.getByTestId('forge-sweep-refusal').textContent).toBe(
      'The sweep is refused, and deletes nothing: hand work, likely',
    );
    expect(screen.queryByTestId('forge-sweep-none')).toBeNull();
  });

  it('says what of the automation it could not read, and the objects it could not look at', () => {
    render(
      <ForgeSweepListingView
        listing={{
          ...LISTING,
          found: [],
          unread: [{ objectApiName: 'ContentDocumentLink', reason: 'It keeps no creator.' }],
          automationGaps: { flowsNotRead: 3, triggers: 1, error: 'INSUFFICIENT_ACCESS' },
        }}
      />,
    );

    expect(screen.getByTestId('forge-sweep-none').textContent).toBe('Nothing found to sweep.');
    expect(screen.getByTestId('forge-sweep-flows-not-read').textContent).toBe(
      "3 Flows on the run's objects were not read: what they create is not looked at.",
    );
    expect(screen.getByTestId('forge-sweep-triggers').textContent).toBe(
      "1 Apex trigger on the run's objects: no metadata says what it creates.",
    );
    expect(screen.getByTestId('forge-sweep-automation-error').textContent).toContain(
      'INSUFFICIENT_ACCESS',
    );
    expect(screen.getByTestId('forge-sweep-unread-ContentDocumentLink').textContent).toBe(
      'Not looked at, ContentDocumentLink: It keeps no creator.',
    );
  });

  it('says an object over the bound is not swept', () => {
    render(
      <ForgeSweepListingView
        listing={{
          ...LISTING,
          found: [{ objectApiName: 'FeedItem', count: 10_000, names: [], overBound: true }],
        }}
      />,
    );
    expect(screen.getByTestId('forge-sweep-found-FeedItem').textContent).toBe(
      'FeedItem: more than 10,000 records, none swept',
    );
  });
});

describe('ForgeRunSweepResult', () => {
  const RESULT: ForgeSweepResult = {
    status: 'partial',
    objects: [
      {
        objectApiName: 'Task',
        found: 3,
        deleted: 2,
        alreadyGone: 0,
        keptChanged: 1,
        refused: 0,
        reasons: [],
      },
      {
        objectApiName: 'Asset',
        found: 1,
        deleted: 0,
        alreadyGone: 0,
        keptChanged: 0,
        refused: 1,
        reasons: ['DELETE_FAILED: held'],
      },
    ],
    unread: [],
    handWork: [],
  };

  it('says how it ended, and per object what became of what it found', () => {
    render(<ForgeRunSweepResult result={RESULT} org="DEV-SANDBOX" />);

    expect(screen.getByRole('heading').textContent).toBe(
      'The sweep deleted records from DEV-SANDBOX; the others stay, as listed.',
    );
    expect(screen.getByTestId('forge-sweep-result-Task').textContent).toBe(
      'Task: 2 deleted · 1 kept, changed since the run',
    );
    expect(screen.getByTestId('forge-sweep-result-Asset').textContent).toBe(
      'Asset: 1 refusedDELETE_FAILED: held',
    );
  });

  it('says a refused sweep deleted nothing, and why', () => {
    render(
      <ForgeRunSweepResult
        result={{ ...RESULT, status: 'refused', objects: [], refusal: 'hand work, likely' }}
        org="DEV-SANDBOX"
      />,
    );
    expect(screen.getByRole('heading').textContent).toBe(
      'The sweep was refused, and deleted nothing.',
    );
    expect(screen.getByTestId('forge-sweep-refusal').textContent).toContain('hand work, likely');
  });
});

describe('ForgeRunSweepMark', () => {
  it('says when the run was swept and what every sweep deleted', () => {
    render(
      <ForgeRunSweepMark
        mark={{ sweptAt: '2026-10-15T09:30:00.000Z', deleted: 36, keptChanged: 0, refused: 1 }}
      />,
    );
    expect(screen.getByTestId('forge-sweep-mark').textContent).toMatch(
      /^Swept on 2026-10-15 \d\d:30: 36 deleted · 1 refused$/,
    );
  });
});
