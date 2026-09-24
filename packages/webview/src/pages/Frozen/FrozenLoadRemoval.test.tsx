import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import type {
  BaseMessage,
  FrozenLoadRecordsInfo,
  FrozenRemovalResult,
  SalesforceOrg,
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

import { FrozenLoadRemoval } from './FrozenLoadRemoval';
import { useOrgStore } from '../../stores/useOrgStore';

const DEV = {
  id: 'org-dev',
  alias: 'DEV-SANDBOX',
  status: 'connected',
} as unknown as SalesforceOrg;

/** A load that created an account and two contacts, and matched the standard book. */
const LOADED: FrozenLoadRecordsInfo = {
  orgId: 'org-dev',
  loadedAt: '2026-09-24T10:05:00.000Z',
  created: [
    { objectApiName: 'Contact', count: 2 },
    { objectApiName: 'Account', count: 1 },
  ],
  linked: 1,
  recorded: true,
};

const PARTIAL: FrozenRemovalResult = {
  status: 'partial',
  includeChanged: false,
  finishedAt: '2026-09-24T11:00:00.000Z',
  objects: [
    {
      objectApiName: 'Contact',
      planned: 2,
      deleted: 1,
      alreadyGone: 0,
      keptChanged: 1,
      keptDependents: 0,
      refused: 0,
      heldBy: [],
      unchecked: [],
      reasons: [],
    },
    {
      objectApiName: 'Account',
      planned: 1,
      deleted: 0,
      alreadyGone: 0,
      keptChanged: 0,
      keptDependents: 1,
      refused: 0,
      heldBy: ['Contact'],
      unchecked: [],
      reasons: [],
    },
  ],
};

/** The last message of `type` the card sent through the bridge. */
function sent(type: string): (BaseMessage & { payload: Record<string, unknown> }) | undefined {
  return mockPostMessage.mock.calls
    .map(
      (call) =>
        (call[0] as { payload: BaseMessage & { payload: Record<string, unknown> } }).payload,
    )
    .filter((message) => message.type === type)
    .pop();
}

/** Answer the card's `frozen:remove`, correlated to it as the handler does. */
function answerRemoval(type: string, payload: unknown): void {
  const request = sent('frozen:remove');
  if (!request) throw new Error("no 'frozen:remove' was sent");
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

/** Open the confirmation and type the org's name into it. */
function confirmRemoval(options: { includeChanged?: boolean } = {}): void {
  fireEvent.click(screen.getByTestId('frozen-removal-remove'));
  if (options.includeChanged) {
    fireEvent.click(screen.getByTestId('frozen-removal-include-changed'));
  }
  fireEvent.change(screen.getByTestId('danger-input'), { target: { value: DEV.alias } });
  fireEvent.click(screen.getByTestId('danger-confirm-btn'));
}

describe('FrozenLoadRemoval', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    useOrgStore.setState({ orgs: [DEV] });
  });

  it('shows nothing when no load wrote a mapping', () => {
    const { container } = render(<FrozenLoadRemoval records={undefined} onRemoved={vi.fn()} />);
    expect(container.textContent).toBe('');
  });

  it('names the last load and offers to remove what it created', () => {
    render(<FrozenLoadRemoval records={LOADED} onRemoved={vi.fn()} />);

    expect(screen.getByTestId('frozen-removal-loaded').textContent).toMatch(
      /^Loaded into DEV-SANDBOX on 2026-09-24 \d\d:\d\d$/,
    );
    expect(screen.getByTestId('frozen-removal-remove').textContent).toBe(
      'Remove the records this load created',
    );
  });

  it('names the org and the records per object, and keeps the linked ones', () => {
    render(<FrozenLoadRemoval records={LOADED} onRemoved={vi.fn()} />);

    fireEvent.click(screen.getByTestId('frozen-removal-remove'));

    const dialog = screen.getByRole('dialog');
    expect(screen.getByTestId('danger-title').textContent).toBe(
      "Remove this load's records from DEV-SANDBOX",
    );
    expect(dialog.textContent).toContain(
      'Records the load linked to or reused, which DEV-SANDBOX already held, are kept',
    );
    expect(
      within(screen.getByTestId('forge-removal-plan'))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Contact: 2 records', 'Account: 1 record']);
    expect(screen.getByTestId('forge-removal-linked').textContent).toBe('1 linked record is kept.');
    // Nothing leaves before the org's name is typed.
    expect(sent('frozen:remove')).toBeUndefined();
  });

  it('sends the load, never its records, once the org name is typed', () => {
    render(<FrozenLoadRemoval records={LOADED} onRemoved={vi.fn()} />);

    confirmRemoval();

    expect(sent('frozen:remove')?.payload).toEqual({
      targetOrgId: 'org-dev',
      loadedAt: '2026-09-24T10:05:00.000Z',
    });
  });

  it('asks for the records changed since the load too when the box is ticked', () => {
    render(<FrozenLoadRemoval records={LOADED} onRemoved={vi.fn()} />);

    confirmRemoval({ includeChanged: true });

    expect(sent('frozen:remove')?.payload).toMatchObject({ includeChanged: true });
  });

  it('shows what the removal did per object, and reads the status again once', () => {
    const onRemoved = vi.fn();
    const { rerender } = render(<FrozenLoadRemoval records={LOADED} onRemoved={onRemoved} />);
    confirmRemoval();

    answerRemoval('frozen:remove:response', { result: PARTIAL, operationId: 'frozen-remove-7' });

    const result = screen.getByTestId('forge-removal-result');
    expect(within(result).getByRole('heading').textContent).toBe(
      'Records this load created were removed from DEV-SANDBOX; the others stay, as listed.',
    );
    expect(screen.getByTestId('forge-removal-result-Contact').textContent).toBe(
      'Contact: 1 deleted · 1 kept, changed since the load',
    );
    // A page that hands a new callback on every render is still asked once.
    rerender(<FrozenLoadRemoval records={LOADED} onRemoved={() => onRemoved()} />);
    rerender(<FrozenLoadRemoval records={LOADED} onRemoved={() => onRemoved()} />);
    expect(onRemoved).toHaveBeenCalledTimes(1);
  });

  it('shows a refusal of the whole removal under the load', () => {
    render(<FrozenLoadRemoval records={LOADED} onRemoved={vi.fn()} />);
    confirmRemoval();

    answerRemoval('frozen:remove:error', {
      message: 'The target org was refreshed after the load',
      code: 'TARGET_REFRESHED',
      retryable: false,
    });

    expect(screen.getByTestId('frozen-removal-error').textContent).toContain(
      'refreshed after the load',
    );
  });

  it('does not offer it twice: a load whose records were removed says when', () => {
    render(
      <FrozenLoadRemoval
        records={{
          ...LOADED,
          created: [],
          removed: {
            removedAt: '2026-09-24T11:00:00.000Z',
            deleted: 3,
            alreadyGone: 0,
            kept: 0,
            refused: 0,
          },
        }}
        onRemoved={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('frozen-removal-remove')).toBeNull();
    expect(screen.getByTestId('forge-removal-mark').textContent).toMatch(
      /^Records removed on 2026-09-24 \d\d:\d\d: 3 deleted$/,
    );
  });

  it('says why a load recorded before loads kept what they created cannot be removed', () => {
    render(
      <FrozenLoadRemoval
        records={{ ...LOADED, created: [], linked: 0, recorded: false }}
        onRemoved={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('frozen-removal-remove')).toBeNull();
    expect(screen.getByTestId('frozen-removal-not-recorded').textContent).toContain(
      'A reload purges them.',
    );
  });

  it('says so when the org the load wrote to is no longer registered', () => {
    useOrgStore.setState({ orgs: [] });
    render(<FrozenLoadRemoval records={LOADED} onRemoved={vi.fn()} />);

    expect(screen.queryByTestId('frozen-removal-remove')).toBeNull();
    expect(screen.getByTestId('frozen-removal-org-gone')).toBeDefined();
  });

  it('says a load that created nothing has nothing to remove', () => {
    render(<FrozenLoadRemoval records={{ ...LOADED, created: [] }} onRemoved={vi.fn()} />);

    expect(screen.queryByTestId('frozen-removal-remove')).toBeNull();
    expect(screen.getByTestId('frozen-removal-nothing')).toBeDefined();
  });

  it('removes nothing while a load runs from the page', () => {
    render(<FrozenLoadRemoval records={LOADED} onRemoved={vi.fn()} busy />);

    expect((screen.getByTestId('frozen-removal-remove') as HTMLButtonElement).disabled).toBe(true);
  });
});
