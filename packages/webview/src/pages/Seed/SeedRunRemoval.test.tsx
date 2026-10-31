import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import type {
  BaseMessage,
  SalesforceOrg,
  SeedRemovalResult,
  SeedRunRemovalInfo,
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

import { SeedRunRemoval } from './SeedRunRemoval';
import { useOrgStore } from '../../stores/useOrgStore';

const DEV = {
  id: 'org-dev',
  alias: 'DEV-SANDBOX',
  status: 'connected',
} as unknown as SalesforceOrg;

/** A seed that wrote an account and two contacts in the sandbox. */
const KEPT: SeedRunRemovalInfo = {
  runId: 'op-1',
  targetOrgId: 'org-dev',
  startedAt: '2026-10-17T08:00:00.000Z',
  endedAt: '2026-10-17T08:01:00.000Z',
  created: 3,
  left: [
    { objectApiName: 'Contact', count: 2 },
    { objectApiName: 'Account', count: 1 },
  ],
};

const object = (objectApiName: string, deleted: number) => ({
  objectApiName,
  planned: deleted,
  deleted,
  alreadyGone: 0,
  keptChanged: 0,
  keptDependents: 0,
  refused: 0,
  heldBy: [],
  unchecked: [],
  reasons: [],
});

const DONE: SeedRemovalResult = {
  runId: 'op-1',
  status: 'success',
  includeChanged: false,
  finishedAt: '2026-10-17T09:00:00.000Z',
  objects: [object('Contact', 2), object('Account', 1)],
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

function confirmRemoval(options: { includeChanged?: boolean } = {}): void {
  fireEvent.click(screen.getByTestId('seed-removal-remove'));
  if (options.includeChanged) fireEvent.click(screen.getByTestId('seed-removal-include-changed'));
  fireEvent.change(screen.getByTestId('danger-input'), { target: { value: DEV.alias } });
  fireEvent.click(screen.getByTestId('danger-confirm-btn'));
}

describe('SeedRunRemoval', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    useOrgStore.setState({ orgs: [DEV] });
  });

  it('asks what the run kept, by its id, and says what it created and where', () => {
    render(<SeedRunRemoval runId="op-1" />);
    expect(sentAll('seed:removal:info').pop()?.payload).toEqual({ runId: 'op-1' });

    answer('seed:removal:info', 'seed:removal:info:response', { info: KEPT });

    expect(screen.getByTestId('seed-removal-created').textContent).toBe(
      '3 records created in DEV-SANDBOX',
    );
    expect(screen.getByTestId('seed-removal-remove').textContent).toBe(
      'Remove what this run created',
    );
  });

  it('lists what the removal takes and asks for the org by name before it sends anything', () => {
    render(<SeedRunRemoval runId="op-1" />);
    answer('seed:removal:info', 'seed:removal:info:response', { info: KEPT });

    fireEvent.click(screen.getByTestId('seed-removal-remove'));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/Contact/)).toBeDefined();
    expect(within(dialog).getByText(/Account/)).toBeDefined();
    expect(within(dialog).getByText(/the records this seed inserted/)).toBeDefined();
    expect(sentAll('seed:remove')).toEqual([]);

    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: DEV.alias } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));

    expect(sentAll('seed:remove').pop()?.payload).toEqual({ runId: 'op-1' });
  });

  it('asks for the records changed since the run only when told to', () => {
    render(<SeedRunRemoval runId="op-1" />);
    answer('seed:removal:info', 'seed:removal:info:response', { info: KEPT });

    confirmRemoval({ includeChanged: true });

    expect(sentAll('seed:remove').pop()?.payload).toEqual({ runId: 'op-1', includeChanged: true });
  });

  it('offers in the confirmation the box that mutes what the deletes fire, read as the removal starts, off', () => {
    render(<SeedRunRemoval runId="op-1" />);
    answer('seed:removal:info', 'seed:removal:info:response', { info: KEPT });
    fireEvent.click(screen.getByTestId('seed-removal-remove'));

    expect((screen.getByTestId('seed-removal-mute-toggle') as HTMLInputElement).checked).toBe(
      false,
    );
    expect(screen.getByTestId('seed-removal-mute-at-start').textContent).toMatch(
      /^What it silences is read from DEV-SANDBOX as the run starts/,
    );
    fireEvent.click(screen.getByTestId('seed-removal-mute-toggle'));
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: DEV.alias } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));

    expect(sentAll('seed:remove').pop()?.payload).toEqual({ runId: 'op-1', muteAutomation: true });
  });

  it('says a mute refused on a production org in the interface language', () => {
    render(<SeedRunRemoval runId="op-1" />);
    answer('seed:removal:info', 'seed:removal:info:response', { info: KEPT });
    confirmRemoval();

    answer('seed:remove', 'seed:remove:error', {
      message:
        'The target is a production org: its automation is never muted there, whatever the setting says. Nothing was assigned; run without the option.',
      code: 'MUTE_PRODUCTION',
      retryable: false,
    });

    expect(screen.getByTestId('seed-removal-error').textContent).toContain(
      "The target's automation is never muted on a production org",
    );
  });

  it('says what the removal took, and reads again what the run kept', () => {
    render(<SeedRunRemoval runId="op-1" />);
    answer('seed:removal:info', 'seed:removal:info:response', { info: KEPT });
    confirmRemoval();
    expect(screen.getByTestId('seed-removal-removing').getAttribute('role')).toBe('status');

    answer('seed:remove', 'seed:remove:response', { result: DONE, operationId: 'req' });

    expect(screen.queryByTestId('seed-removal-removing')).toBeNull();
    expect(sentAll('seed:removal:info')).toHaveLength(2);
    answer('seed:removal:info', 'seed:removal:info:response', {
      info: {
        ...KEPT,
        left: [],
        removed: {
          removedAt: '2026-10-17T09:00:00.000Z',
          status: 'success',
          deleted: 3,
          left: 0,
        },
      },
    });
    expect(screen.queryByTestId('seed-removal-remove')).toBeNull();
  });

  it('offers nothing on an org Production Guard allows no delete in, and says why', () => {
    render(<SeedRunRemoval runId="op-1" />);
    answer('seed:removal:info', 'seed:removal:info:response', {
      info: {
        ...KEPT,
        refusal: { code: 'GUARD_BLOCKED', message: 'delete is not allowed on production org' },
      },
    });

    expect(screen.queryByTestId('seed-removal-remove')).toBeNull();
    expect(screen.getByTestId('seed-removal-refused').textContent).toContain(
      'Production Guard allows no delete in DEV-SANDBOX',
    );
  });

  it('says so when nothing of the run is kept any more', () => {
    render(<SeedRunRemoval runId="op-1" />);
    answer('seed:removal:info', 'seed:removal:info:response', { info: null });

    expect(screen.getByTestId('seed-removal-not-kept').textContent).toContain('is no longer kept');
  });

  it('shows a refused removal in the card', () => {
    render(<SeedRunRemoval runId="op-1" />);
    answer('seed:removal:info', 'seed:removal:info:response', { info: KEPT });
    confirmRemoval();

    answer('seed:remove', 'seed:remove:error', {
      message: 'What this run created is being removed already.',
      code: 'DUPLICATE',
      retryable: false,
    });

    expect(screen.getByTestId('seed-removal-error').textContent).toContain('removed already');
  });

  it('lists what a sweep would take once asked, and sends the removal with it', () => {
    const answered = vi.fn();
    render(<SeedRunRemoval runId="op-1" onAnswered={answered} />);
    answer('seed:removal:info', 'seed:removal:info:response', { info: KEPT });

    fireEvent.click(screen.getByTestId('seed-removal-remove'));
    // Nothing is read of the org until the sweep is ticked.
    expect(sentAll('seed:remove:sweep')).toEqual([]);
    fireEvent.click(screen.getByTestId('seed-removal-sweep-toggle'));
    expect(sentAll('seed:remove:sweep').pop()?.payload).toEqual({ runId: 'op-1' });
    answer('seed:remove:sweep', 'seed:remove:sweep:response', {
      runId: 'op-1',
      listing: {
        looked: ['Account', 'Contact', 'Task'],
        found: [{ objectApiName: 'Task', count: 2, names: ['Welcome call'] }],
        unread: [],
        handWork: [],
        window: { from: '2026-10-17T07:59:59Z', to: '2026-10-17T08:02:00Z' },
      },
    });
    expect(screen.getByTestId('seed-removal-sweep').textContent).toContain('Welcome call');

    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: DEV.alias } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));
    expect(sentAll('seed:remove').pop()?.payload).toEqual({ runId: 'op-1', sweep: true });

    answer('seed:remove', 'seed:remove:response', { result: DONE, operationId: 'req' });
    expect(answered).toHaveBeenCalledTimes(1);
  });
});
