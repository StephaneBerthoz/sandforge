import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import type { BaseMessage, SyncEarlierCopies } from '@sandforge/shared';
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

import { SyncEarlierCopiesNotice } from './SyncEarlierCopies';

/** Every message of `type` the notice sent through the bridge. */
function sentAll(type: string): Array<BaseMessage & { payload: Record<string, unknown> }> {
  return mockPostMessage.mock.calls
    .map(
      (call) =>
        (call[0] as { payload: BaseMessage & { payload: Record<string, unknown> } }).payload,
    )
    .filter((message) => message.type === type);
}

/** Answer the last question the notice asked, correlated to it as the extension does. */
function answer(copies: SyncEarlierCopies): void {
  const request = sentAll('sync:earlier-copies').pop();
  if (!request) throw new Error("no 'sync:earlier-copies' was sent");
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: 'resp-1',
          type: 'sync:earlier-copies:response',
          timestamp: Date.now(),
          correlationId: request.id,
          payload: { copies },
        },
      }),
    );
  });
}

const LAST_RUN: SyncEarlierCopies = {
  leftAsIs: false,
  run: { runId: 'run-1', configName: 'Quick Sync', startedAt: '2026-10-14T08:00:00.000Z' },
  objects: [
    { objectApiName: 'Account', count: 2 },
    { objectApiName: 'Contact', count: 30 },
  ],
};

describe('SyncEarlierCopiesNotice', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
  });

  it('asks what the last run between the orgs left, and says Quick Sync inserts it all again', () => {
    render(
      <SyncEarlierCopiesNotice
        sourceOrgId="org-src"
        targetOrgId="org-tgt"
        objects={['Account', 'Contact']}
        context="quickSync"
        testId="notice"
      />,
    );
    expect(sentAll('sync:earlier-copies').pop()?.payload).toEqual({
      sourceOrgId: 'org-src',
      targetOrgId: 'org-tgt',
      objects: ['Account', 'Contact'],
    });

    answer(LAST_RUN);

    expect(screen.getByTestId('notice').textContent).toMatch(
      /^The last sync between these orgs, on 2026-10-14 \d\d:\d\d, created records still in the target: Account \(2\) and Contact \(30\)\. Quick Sync inserts every record again: remove that run from the Sync history first to leave no second copy\.$/,
    );
  });

  it('sends the user to the Real-Time tab when the last writer between the orgs was a session', () => {
    const { unmount } = render(
      <SyncEarlierCopiesNotice
        sourceOrgId="org-src"
        targetOrgId="org-tgt"
        objects={['Account', 'Contact']}
        context="quickSync"
        testId="notice"
      />,
    );
    const session: SyncEarlierCopies = {
      ...LAST_RUN,
      run: {
        runId: 'session-1',
        configName: '',
        startedAt: LAST_RUN.run?.startedAt ?? '',
        realtime: true,
      },
    };

    answer(session);

    expect(screen.getByTestId('notice').textContent).toMatch(
      /^The last Real-Time session between these orgs, started 2026-10-14 \d\d:\d\d, created records still in the target: Account \(2\) and Contact \(30\)\. Quick Sync inserts every record again: remove that session under Earlier sessions on the Real-Time tab first to leave no second copy\.$/,
    );
    unmount();

    render(
      <SyncEarlierCopiesNotice
        sourceOrgId="org-src"
        targetOrgId="org-tgt"
        objects={['Account']}
        context="runAgain"
        testId="notice"
      />,
    );
    answer(session);

    expect(screen.getByTestId('notice').textContent).toContain(
      'Run again inserts every record again: remove that session under Earlier sessions on the Real-Time tab first',
    );
  });

  it('says before Run again that a saved configuration leaves what its earlier runs copied', () => {
    render(
      <SyncEarlierCopiesNotice
        sourceOrgId="org-src"
        targetOrgId="org-tgt"
        objects={['Account']}
        configId="cfg-1"
        context="runAgain"
        testId="notice"
      />,
    );
    expect(sentAll('sync:earlier-copies').pop()?.payload).toMatchObject({ configId: 'cfg-1' });

    answer({ leftAsIs: true, objects: [] });

    expect(screen.getByTestId('notice').textContent).toBe(
      'A run of this saved configuration leaves as they are the records its earlier runs copied, and inserts the others.',
    );
  });

  it('says what it counted from when the target could not be asked', () => {
    render(
      <SyncEarlierCopiesNotice
        sourceOrgId="org-src"
        targetOrgId="org-tgt"
        objects={['Account']}
        context="runAgain"
        testId="notice"
      />,
    );

    answer({ ...LAST_RUN, unread: 'INVALID_SESSION_ID' });

    expect(screen.getByTestId('notice').textContent).toContain(
      'Run again inserts every record again: remove that run first to leave no second copy.',
    );
    expect(screen.getByTestId('notice').textContent).toContain(
      'Counted from what that run kept: the target org could not be asked (INVALID_SESSION_ID).',
    );
  });

  it('asks nothing and says nothing for a run that inserts nothing without a key', () => {
    const { container } = render(
      <SyncEarlierCopiesNotice
        sourceOrgId="org-src"
        targetOrgId="org-tgt"
        objects={[]}
        context="runAgain"
      />,
    );

    expect(sentAll('sync:earlier-copies')).toEqual([]);
    expect(container.textContent).toBe('');
  });
});
