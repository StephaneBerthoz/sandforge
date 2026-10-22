import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import type {
  BaseMessage,
  SalesforceOrg,
  SyncRemovalResult,
  SyncRunRemovalInfo,
} from '@sandforge/shared';
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

import { SyncRunRemoval } from './SyncRunRemoval';
import { useOrgStore } from '../../stores/useOrgStore';

const DEV = {
  id: 'org-dev',
  alias: 'DEV-SANDBOX',
  status: 'connected',
} as unknown as SalesforceOrg;

/** A run that created a file and two accounts in the sandbox. */
const KEPT: SyncRunRemovalInfo = {
  runId: 'run-1',
  configId: 'cfg-1',
  configName: 'Accounts',
  sourceOrgId: 'org-source',
  targetOrgId: 'org-dev',
  startedAt: '2026-10-14T08:00:00.000Z',
  endedAt: '2026-10-14T08:01:00.000Z',
  created: 3,
  left: [
    { objectApiName: 'ContentDocument', count: 1 },
    { objectApiName: 'Account', count: 2 },
  ],
};

const DONE: SyncRemovalResult = {
  runId: 'run-1',
  status: 'success',
  includeChanged: false,
  finishedAt: '2026-10-14T09:00:00.000Z',
  readWhole: ['Account'],
  filesForgotten: 1,
  objects: [
    {
      objectApiName: 'ContentDocument',
      planned: 1,
      deleted: 1,
      alreadyGone: 0,
      keptChanged: 0,
      keptDependents: 0,
      refused: 0,
      heldBy: [],
      unchecked: [],
      reasons: [],
    },
    {
      objectApiName: 'Account',
      planned: 2,
      deleted: 2,
      alreadyGone: 0,
      keptChanged: 0,
      keptDependents: 0,
      refused: 0,
      heldBy: [],
      unchecked: [],
      reasons: [],
    },
  ],
};

/** Every message of `type` the card sent through the bridge. */
function sentAll(type: string): Array<BaseMessage & { payload: Record<string, unknown> }> {
  return mockPostMessage.mock.calls
    .map(
      (call) =>
        (call[0] as { payload: BaseMessage & { payload: Record<string, unknown> } }).payload,
    )
    .filter((message) => message.type === type);
}

/** Answer the last `requestType` the card sent, correlated to it as the extension does. */
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

function confirmRemoval(options: { includeChanged?: boolean } = {}): void {
  fireEvent.click(screen.getByTestId('sync-removal-remove'));
  if (options.includeChanged) fireEvent.click(screen.getByTestId('sync-removal-include-changed'));
  fireEvent.change(screen.getByTestId('danger-input'), { target: { value: DEV.alias } });
  fireEvent.click(screen.getByTestId('danger-confirm-btn'));
}

describe('SyncRunRemoval', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    useOrgStore.setState({ orgs: [DEV] });
  });

  it('asks what the run kept, by its id, and says what it created and where', () => {
    render(<SyncRunRemoval runId="run-1" />);
    expect(sentAll('sync:removal:info').pop()?.payload).toEqual({ runId: 'run-1' });

    answer('sync:removal:info', 'sync:removal:info:response', { info: KEPT });

    expect(screen.getByTestId('sync-removal-created').textContent).toBe(
      '3 records and files created in DEV-SANDBOX',
    );
    expect(screen.getByTestId('sync-removal-remove').textContent).toBe(
      'Remove what this run created',
    );
  });

  it('names the org and what goes per object, files first, before anything leaves', () => {
    render(<SyncRunRemoval runId="run-1" />);
    answer('sync:removal:info', 'sync:removal:info:response', { info: KEPT });

    fireEvent.click(screen.getByTestId('sync-removal-remove'));

    expect(screen.getByTestId('danger-title').textContent).toBe(
      'Remove what this run created from DEV-SANDBOX',
    );
    expect(screen.getByRole('dialog').textContent).toContain(
      'The records it updated were in DEV-SANDBOX before and keep their new values.',
    );
    expect(
      within(screen.getByTestId('forge-removal-plan'))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['ContentDocument: 1 file', 'Account: 2 records']);
    expect(sentAll('sync:remove')).toEqual([]);
  });

  it('sends the run, never its records, once the org name is typed, with the changed ones when ticked', () => {
    render(<SyncRunRemoval runId="run-1" />);
    answer('sync:removal:info', 'sync:removal:info:response', { info: KEPT });

    confirmRemoval({ includeChanged: true });

    expect(sentAll('sync:remove').pop()?.payload).toEqual({ runId: 'run-1', includeChanged: true });
  });

  it('lists what a sweep would take once asked, sends the removal with it, and says what it swept', () => {
    render(<SyncRunRemoval runId="run-1" />);
    answer('sync:removal:info', 'sync:removal:info:response', { info: KEPT });

    fireEvent.click(screen.getByTestId('sync-removal-remove'));
    // Nothing is read of the org until the sweep is ticked.
    expect(sentAll('sync:remove:sweep')).toEqual([]);
    fireEvent.click(screen.getByTestId('sync-removal-sweep-toggle'));
    expect(sentAll('sync:remove:sweep').pop()?.payload).toEqual({ runId: 'run-1' });
    expect(screen.getByTestId('sync-sweep-loading')).toBeTruthy();
    answer('sync:remove:sweep', 'sync:remove:sweep:response', {
      runId: 'run-1',
      listing: {
        looked: ['Account', 'Task'],
        found: [{ objectApiName: 'Task', count: 2, names: ['Follow up'] }],
        unread: [],
        handWork: [],
        window: { from: '2026-10-14T07:59:59Z', to: '2026-10-14T08:02:00Z' },
      },
    });
    expect(screen.getByTestId('sync-removal-sweep').textContent).toContain('Follow up');

    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: DEV.alias } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));
    expect(sentAll('sync:remove').pop()?.payload).toEqual({ runId: 'run-1', sweep: true });

    answer('sync:remove', 'sync:remove:response', {
      result: {
        ...DONE,
        sweep: {
          status: 'success',
          objects: [
            {
              objectApiName: 'Task',
              found: 2,
              deleted: 2,
              alreadyGone: 0,
              keptChanged: 0,
              refused: 0,
              reasons: [],
            },
          ],
          unread: [],
          handWork: [],
        },
      },
      operationId: 'req-1',
    });
    expect(screen.getByTestId('forge-sweep-result')).toBeTruthy();
  });

  it('sends no sweep unless it is ticked, and reads nothing of the org for one', () => {
    render(<SyncRunRemoval runId="run-1" />);
    answer('sync:removal:info', 'sync:removal:info:response', { info: KEPT });

    confirmRemoval();

    expect(sentAll('sync:remove:sweep')).toEqual([]);
    expect(sentAll('sync:remove').pop()?.payload).toEqual({ runId: 'run-1' });
  });

  it('shows what the removal did, what the configuration forgets, and reads the run again', () => {
    render(<SyncRunRemoval runId="run-1" />);
    answer('sync:removal:info', 'sync:removal:info:response', { info: KEPT });
    confirmRemoval();
    const asked = sentAll('sync:removal:info').length;

    answer('sync:remove', 'sync:remove:response', { result: DONE, operationId: 'req-1' });

    expect(
      within(screen.getByTestId('forge-removal-result')).getByRole('heading').textContent,
    ).toBe('No record this run created is left in DEV-SANDBOX.');
    expect(screen.getByTestId('sync-removal-read-whole').textContent).toBe(
      'The next run of Accounts reads Account whole: the copies its watermark counted on are gone.',
    );
    expect(screen.getByTestId('sync-removal-files-forgotten').textContent).toBe(
      'Accounts no longer counts 1 file as copied: its next full read copies it again.',
    );
    expect(sentAll('sync:removal:info').length).toBe(asked + 1);
  });

  it('offers a Cancel while the removal runs, sent to the registry under the request id', () => {
    render(<SyncRunRemoval runId="run-1" />);
    answer('sync:removal:info', 'sync:removal:info:response', { info: KEPT });
    confirmRemoval();

    fireEvent.click(screen.getByTestId('sync-removal-cancel'));

    expect(sentAll('execution:abort').pop()?.payload).toEqual({
      operationId: sentAll('sync:remove').pop()?.id,
    });
    expect(screen.getByTestId('sync-removal-removing').textContent).toContain('Stopping');
  });

  it('offers nothing where Production Guard allows no delete, and says why with its reason', () => {
    render(<SyncRunRemoval runId="run-1" />);

    answer('sync:removal:info', 'sync:removal:info:response', {
      info: {
        ...KEPT,
        refusal: {
          code: 'GUARD_BLOCKED',
          message: 'delete is not allowed on production org org-dev',
        },
      },
    });

    expect(screen.queryByTestId('sync-removal-remove')).toBeNull();
    expect(screen.getByTestId('sync-removal-refused').textContent).toContain(
      'Production Guard allows no delete in DEV-SANDBOX, a production org: what this run created stays there.',
    );
    expect(screen.getByTestId('sync-removal-refused').textContent).toContain(
      'delete is not allowed on production org org-dev',
    );
  });

  it('offers what is left after a removal that left some, with its mark', () => {
    render(<SyncRunRemoval runId="run-1" />);

    answer('sync:removal:info', 'sync:removal:info:response', {
      info: {
        ...KEPT,
        left: [{ objectApiName: 'Account', count: 1 }],
        removed: {
          removedAt: '2026-10-14T09:00:00.000Z',
          deleted: 2,
          alreadyGone: 0,
          kept: 1,
          refused: 0,
        },
      },
    });

    expect(screen.getByTestId('forge-removal-mark').textContent).toContain('2 deleted');
    expect(screen.getByTestId('sync-removal-remove').textContent).toBe(
      'Remove what is left of what this run created',
    );
  });

  it('says so when nothing the run created is kept any more', () => {
    render(<SyncRunRemoval runId="run-1" />);

    answer('sync:removal:info', 'sync:removal:info:response', { info: null });

    expect(screen.getByTestId('sync-removal-not-kept').textContent).toContain('is no longer kept');
  });

  describe('a run that wrote over records of the target', () => {
    /** An upsert that matched three accounts and created nothing. */
    const OVER: SyncRunRemovalInfo = {
      ...KEPT,
      created: 0,
      left: [],
      overwritten: 3,
      putBack: [{ objectApiName: 'Account', count: 3 }],
    };

    it('says what it wrote over, offers its removal, and names what goes back before anything is deleted', () => {
      render(<SyncRunRemoval runId="run-1" />);
      answer('sync:removal:info', 'sync:removal:info:response', { info: OVER });

      expect(screen.queryByTestId('sync-removal-created')).toBeNull();
      expect(screen.getByTestId('sync-removal-overwritten').textContent).toBe(
        '3 records of DEV-SANDBOX written over, their values from before kept on this machine',
      );
      fireEvent.click(screen.getByTestId('sync-removal-remove'));

      expect(screen.getByRole('dialog').textContent).toContain(
        'First gives the records this run wrote over in DEV-SANDBOX',
      );
      expect(screen.getByRole('dialog').textContent).not.toContain('keep their new values');
      expect(screen.getByTestId('sync-removal-put-back-Account').textContent).toBe(
        'Account: 3 records to be given back their values from before the run',
      );
      expect(screen.queryByTestId('forge-removal-plan')).toBeNull();
    });

    it('shows what the removal gave back, and what it left with why', () => {
      render(<SyncRunRemoval runId="run-1" />);
      answer('sync:removal:info', 'sync:removal:info:response', { info: OVER });
      confirmRemoval();

      answer('sync:remove', 'sync:remove:response', {
        result: {
          runId: 'run-1',
          status: 'partial',
          includeChanged: false,
          finishedAt: '2026-10-14T09:00:00.000Z',
          objects: [],
          restored: [
            {
              objectApiName: 'Account',
              planned: 3,
              restored: 2,
              keptChanged: 1,
              alreadyGone: 0,
              refused: 0,
              notKept: 0,
              reasons: [],
            },
          ],
        },
        operationId: 'req-1',
      });

      // Nothing deleted, nothing said of deletes.
      expect(screen.queryByTestId('forge-removal-result')).toBeNull();
      expect(screen.getByTestId('sync-removal-restored-Account').textContent).toBe(
        'Account: 2 of 3 given back their values from before the run · changed since the run, ' +
          'left as they are: 1',
      );
    });
  });
});
