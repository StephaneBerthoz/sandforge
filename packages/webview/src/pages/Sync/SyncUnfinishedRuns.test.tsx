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
});
