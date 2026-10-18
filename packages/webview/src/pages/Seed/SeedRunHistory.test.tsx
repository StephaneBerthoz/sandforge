import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
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

  it('opens a seed onto its removal, which reads what the run kept', () => {
    render(<SeedRunHistory />);
    answer('seed:removal:list', 'seed:removal:list:response', { runs: RUNS });

    const toggle = screen.getByTestId('seed-run-history-toggle-op-2');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(sentAll('seed:removal:info').pop()?.payload).toEqual({ runId: 'op-2' });
  });

  it('shows nothing when no seed is kept', () => {
    render(<SeedRunHistory />);
    answer('seed:removal:list', 'seed:removal:list:response', { runs: [] });

    expect(screen.queryByTestId('seed-run-history')).toBeNull();
  });
});
