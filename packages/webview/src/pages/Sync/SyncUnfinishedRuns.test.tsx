import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import type { BaseMessage, SyncRunRemovalInfo } from '@sandforge/shared';
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

import { SyncUnfinishedRuns } from './SyncUnfinishedRuns';

/** The last message of `type` the panel sent. */
function sent(type: string): (BaseMessage & { payload?: Record<string, unknown> }) | undefined {
  return mockPostMessage.mock.calls
    .map(
      (call) =>
        (call[0] as { payload: BaseMessage & { payload?: Record<string, unknown> } }).payload,
    )
    .filter((message) => message.type === type)
    .pop();
}

function answer(requestType: string, type: string, payload: unknown): void {
  const request = sent(requestType);
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

const STOPPED: SyncRunRemovalInfo = {
  runId: 'run-9',
  configId: 'cfg-1',
  configName: 'Accounts',
  sourceOrgId: 'org-source',
  targetOrgId: 'org-dev',
  startedAt: '2026-10-14T08:00:00.000Z',
  created: 2,
  left: [{ objectApiName: 'Account', count: 2 }],
};

describe('SyncUnfinishedRuns', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
  });

  it('shows nothing while no run a closed window stopped is kept', () => {
    const { container } = render(<SyncUnfinishedRuns />);

    answer('sync:removal:list', 'sync:removal:list:response', { runs: [] });

    expect(container.textContent).toBe('');
  });

  it('lists each run no history entry holds, with its removal', () => {
    render(<SyncUnfinishedRuns />);

    answer('sync:removal:list', 'sync:removal:list:response', { runs: [STOPPED] });

    expect(screen.getByRole('heading', { name: 'Runs that never ended' })).toBeTruthy();
    expect(screen.getByTestId('sync-unfinished-run-9').textContent).toMatch(
      /^Accounts, started 2026-10-14 \d\d:\d\d$/,
    );
    // Its card asks what the run kept, by its id.
    expect(sent('sync:removal:info')?.payload).toEqual({ runId: 'run-9' });
  });

  it('says what is kept of such a run is what the target had answered, not everything it wrote', () => {
    render(<SyncUnfinishedRuns />);

    answer('sync:removal:list', 'sync:removal:list:response', { runs: [STOPPED] });

    const note = screen.getByTestId('sync-unfinished-runs').textContent ?? '';
    expect(note).not.toContain('What they created is kept, and can be removed.');
    expect(note).toContain('as each call to the target answered');
    expect(screen.queryByTestId('sync-unfinished-in-flight-run-9')).toBeNull();
  });

  it('says a run another window is writing is running there, and offers no removal of it', () => {
    render(<SyncUnfinishedRuns />);

    answer('sync:removal:list', 'sync:removal:list:response', {
      runs: [
        {
          ...STOPPED,
          runningElsewhere: true,
          inFlight: { objectApiName: 'Contact', rows: 12_000 },
          refusal: { code: 'RUNNING', message: 'The run is still writing in another window.' },
        },
      ],
    });

    expect(screen.getByTestId('sync-unfinished-elsewhere-run-9').textContent).toBe(
      'Still writing in another window: what it creates can be removed once it has ended there.',
    );
    // Not one a closed window stopped: no call said cut short, no card asked.
    expect(screen.queryByTestId('sync-unfinished-in-flight-run-9')).toBeNull();
    expect(screen.queryByTestId('sync-unfinished-removal-run-9')).toBeNull();
    expect(sent('sync:removal:info')).toBeUndefined();
  });

  it('names the call a run had under way when its window closed, whose rows the list may lack', () => {
    render(<SyncUnfinishedRuns />);

    answer('sync:removal:list', 'sync:removal:list:response', {
      runs: [{ ...STOPPED, inFlight: { objectApiName: 'Contact', rows: 12_000 } }],
    });

    expect(screen.getByTestId('sync-unfinished-in-flight-run-9').textContent).toBe(
      'It stopped while it was writing 12,000 Contact rows: those the target took are in the org but not listed here, and its removal does not take them.',
    );
  });
});
