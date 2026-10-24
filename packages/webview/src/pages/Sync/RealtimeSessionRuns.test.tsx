import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import type { BaseMessage, SyncRunRemovalInfo } from '@sandforge/shared';
import '../../i18n';
import { useCDCLiveStore } from '../../stores/useCDCLiveStore';

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

import { RealtimeSessionRuns } from './RealtimeSessionRuns';

type Sent = BaseMessage & { payload?: Record<string, unknown> };

/** Every message of `type` the list sent, oldest first. */
function sentAll(type: string): Sent[] {
  return mockPostMessage.mock.calls
    .map((call) => (call[0] as { payload: Sent }).payload)
    .filter((message) => message.type === type);
}

function answer(requestType: string, type: string, payload: unknown): void {
  const request = sentAll(requestType).pop();
  if (!request) throw new Error(`no '${requestType}' was sent`);
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: `resp-${type}-${request.id}`,
          type,
          timestamp: Date.now(),
          correlationId: request.id,
          payload,
        },
      }),
    );
  });
}

const SESSION: SyncRunRemovalInfo = {
  runId: 'session-1',
  configId: 'realtime:session-1',
  configName: '',
  sourceOrgId: 'org-source',
  targetOrgId: 'org-dev',
  startedAt: '2026-10-24T08:00:00.000Z',
  endedAt: '2026-10-24T09:30:00.000Z',
  realtime: true,
  created: 2,
  left: [{ objectApiName: 'Lead', count: 2 }],
  overwritten: 1,
  putBack: [{ objectApiName: 'Lead', count: 1 }],
};

describe('RealtimeSessionRuns', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    useCDCLiveStore.setState({ status: 'disconnected' });
  });

  it('asks for the sessions of the Real-Time tab, not the runs that never ended', () => {
    render(<RealtimeSessionRuns />);

    expect(sentAll('sync:removal:list').map((message) => message.payload)).toEqual([
      { realtime: true },
    ]);
  });

  it('shows nothing while no session that wrote is kept', () => {
    const { container } = render(<RealtimeSessionRuns />);

    answer('sync:removal:list', 'sync:removal:list:response', { runs: [] });

    expect(container.textContent).toBe('');
  });

  it('lists each session that wrote, its orgs and its hours, with the removal card of a run', () => {
    render(<RealtimeSessionRuns />);

    answer('sync:removal:list', 'sync:removal:list:response', { runs: [SESSION] });

    expect(screen.getByRole('heading', { name: 'Earlier sessions' })).toBeTruthy();
    expect(screen.getByTestId('realtime-session-session-1').textContent).toMatch(
      /^org-source → org-dev, 2026-10-24 \d\d:\d\d to 2026-10-24 \d\d:\d\d$/,
    );
    // Its card asks what the session kept, by its id, as a run's does.
    expect(sentAll('sync:removal:info').pop()?.payload).toEqual({ runId: 'session-1' });
  });

  it('says a session a closed window cut short never stopped, and the call it had under way', () => {
    render(<RealtimeSessionRuns />);

    answer('sync:removal:list', 'sync:removal:list:response', {
      runs: [
        {
          ...SESSION,
          endedAt: undefined,
          inFlight: { objectApiName: 'Lead', rows: 3 },
        },
      ],
    });

    expect(screen.getByTestId('realtime-session-session-1').textContent).toMatch(
      /^org-source → org-dev, started 2026-10-24 \d\d:\d\d: the window closed before it stopped$/,
    );
    expect(screen.getByTestId('realtime-session-in-flight-session-1').textContent).toBe(
      'It stopped while it was writing 3 Lead rows: those the target took are in the org but not listed here, and its removal does not take them.',
    );
  });

  it('offers no removal of a session another window is writing', () => {
    render(<RealtimeSessionRuns />);

    answer('sync:removal:list', 'sync:removal:list:response', {
      runs: [{ ...SESSION, endedAt: undefined, runningElsewhere: true }],
    });

    expect(screen.getByTestId('realtime-session-elsewhere-session-1').textContent).toBe(
      'Still writing in another window: it can be taken back once it has stopped there.',
    );
    expect(screen.queryByTestId('realtime-session-removal-session-1')).toBeNull();
    expect(sentAll('sync:removal:info')).toEqual([]);
  });

  it('reads the sessions again as the tab hears the one it ran stop, and only then', () => {
    useCDCLiveStore.setState({ status: 'syncing' });
    render(<RealtimeSessionRuns />);
    expect(sentAll('sync:removal:list')).toHaveLength(1);

    act(() => useCDCLiveStore.setState({ status: 'disconnected' }));
    expect(sentAll('sync:removal:list')).toHaveLength(2);

    // Nothing ran meanwhile: no read.
    act(() => useCDCLiveStore.setState({ status: 'error' }));
    expect(sentAll('sync:removal:list')).toHaveLength(2);

    act(() => useCDCLiveStore.setState({ status: 'syncing' }));
    act(() => useCDCLiveStore.setState({ status: 'error' }));
    expect(sentAll('sync:removal:list')).toHaveLength(3);
  });
});
