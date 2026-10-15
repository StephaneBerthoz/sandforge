import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import type {
  BaseMessage,
  ForgeExecutionResult,
  ForgeUndoResult,
  SalesforceOrg,
} from '@sandforge/shared';
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

import { ForgeResultsRemoval } from './ForgeResultsRemoval';
import { useOrgStore } from '../../stores/useOrgStore';

/*
 * The removal of the run on screen, from its results: the removal and the
 * confirmation the history of runs offers, and what it did said in place.
 */

/** A fake record id: the object's prefix, then a counter. */
const rid = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;
const sid = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}SRC`;

/** The sandbox the run wrote to, as the org store knows it. */
const DEV = { id: 'org-dev', alias: 'DEV-SANDBOX', username: 'dev@example.com' } as SalesforceOrg;

/** The run on screen: an account and two contacts created, an account linked to. */
const RUN: ForgeExecutionResult = {
  forgeId: 'forge-on-screen',
  status: 'success',
  graph: { nodes: [], edges: [], totalRecords: 0, estimatedSizeMB: 0, estimatedDurationSeconds: 0 },
  duration: 1000,
  timestamp: '2026-10-01T08:00:00.000Z',
  idRemapCount: 4,
  createdCount: 3,
  linkedExistingCount: 1,
  idRemapTable: {
    [sid('001', 1)]: rid('001', 1),
    [sid('001', 2)]: rid('001', 9),
    [sid('003', 1)]: rid('003', 1),
    [sid('003', 2)]: rid('003', 2),
  },
  idRemapExisting: [sid('001', 2)],
  idRemapCreated: [
    { objectApiName: 'Account', sourceIds: [sid('001', 1)] },
    { objectApiName: 'Contact', sourceIds: [sid('003', 1), sid('003', 2)] },
  ],
};

/** What the extension answers once a contact was removed and the rest kept. */
const PARTIAL_ANSWER: ForgeUndoResult = {
  forgeId: 'forge-on-screen',
  status: 'partial',
  includeChanged: false,
  finishedAt: '2026-10-01T09:00:00.000Z',
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

/** The run as the history holds it after that removal: what it left, and when. */
const RUN_AFTER: ForgeExecutionResult = {
  ...RUN,
  targetOrgId: DEV.id,
  undo: { removedAt: '2026-10-01T09:00:00.000Z', deleted: 1, alreadyGone: 0, kept: 2, refused: 0 },
  removalLeft: [rid('003', 1), rid('001', 1)],
};

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

/** Open the confirmation and type the org's name into it. */
function confirmRemoval(options: { includeChanged?: boolean } = {}): void {
  fireEvent.click(screen.getByTestId('forge-results-remove'));
  if (options.includeChanged) fireEvent.click(screen.getByTestId('forge-removal-include-changed'));
  fireEvent.change(screen.getByTestId('danger-input'), { target: { value: DEV.alias } });
  fireEvent.click(screen.getByTestId('danger-confirm-btn'));
}

describe('ForgeResultsRemoval', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    useOrgStore.setState({ orgs: [DEV] });
  });

  it('offers the removal of the records the run created', () => {
    render(<ForgeResultsRemoval run={RUN} targetOrgId={DEV.id} />);

    expect(screen.getByTestId('forge-results-remove').textContent).toBe(
      'Remove the records this run created',
    );
  });

  it('confirms it as the history does: the org named and typed, the records per object, the linked ones kept', () => {
    render(<ForgeResultsRemoval run={RUN} targetOrgId={DEV.id} />);

    fireEvent.click(screen.getByTestId('forge-results-remove'));

    expect(screen.getByTestId('danger-title').textContent).toBe(
      "Remove this run's records from DEV-SANDBOX",
    );
    expect(
      within(screen.getByTestId('forge-removal-plan'))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Contact: 2 records', 'Account: 1 record']);
    expect(screen.getByTestId('forge-removal-linked').textContent).toBe('1 linked record is kept.');
    expect(sentAll('forge:undo')).toEqual([]);
  });

  it('lists in the confirmation what the target runs as the records go, read for the run on screen', () => {
    render(<ForgeResultsRemoval run={RUN} targetOrgId={DEV.id} />);

    fireEvent.click(screen.getByTestId('forge-results-remove'));
    expect(sentAll('forge:undo-automation:request').map((message) => message.payload)).toEqual([
      { forgeId: 'forge-on-screen' },
    ]);
    answer('forge:undo-automation:request', 'forge:undo-automation:response', {
      forgeId: 'forge-on-screen',
      automation: {
        objectsRead: ['Contact', 'Account'],
        objects: [
          {
            objectApiName: 'Account',
            flows: [],
            triggers: [{ name: 'AccountCleanup', events: ['afterDelete'] }],
          },
        ],
        unread: [],
        conditionsNotRead: 0,
        conditionsBound: 25,
        requests: 5,
      },
      drafted: [],
    });

    expect(screen.getByTestId('forge-removal-automation-delete-Account').textContent).toBe(
      'Account: Apex trigger: AccountCleanup · after delete',
    );
    expect(sentAll('forge:undo')).toEqual([]);
  });

  it('sends the run, never its records, once the org name is typed', () => {
    render(<ForgeResultsRemoval run={RUN} targetOrgId={DEV.id} />);

    confirmRemoval({ includeChanged: true });

    expect(sentAll('forge:undo').map((message) => message.payload)).toEqual([
      { forgeId: 'forge-on-screen', includeChanged: true },
    ]);
    expect(screen.getByTestId('forge-results-removing').textContent).toBe(
      'Removing the records this run created…',
    );
  });

  it('shows what the removal did in place, then offers to remove what it left', () => {
    const onRemoved = vi.fn();
    render(<ForgeResultsRemoval run={RUN} targetOrgId={DEV.id} onRemoved={onRemoved} />);
    confirmRemoval();

    answer('forge:undo', 'forge:undo:response', {
      result: PARTIAL_ANSWER,
      operationId: 'forge-undo-1',
    });

    expect(screen.getByTestId('forge-removal-result').textContent).toContain(
      'Records this run created were removed from DEV-SANDBOX; the others stay, as listed.',
    );
    expect(screen.getByTestId('forge-removal-result-Contact').textContent).toBe(
      'Contact: 1 deleted · 1 kept, changed since the run',
    );
    // Nothing more is offered until the history says what the removal left.
    expect(screen.queryByTestId('forge-results-remove')).toBeNull();
    expect(sentAll('forge:history:list')).toHaveLength(1);
    expect(onRemoved).not.toHaveBeenCalled();

    answer('forge:history:list', 'forge:history:list:response', { history: [RUN_AFTER] });

    expect(screen.getByTestId('forge-results-remove').textContent).toBe(
      "Remove what is left of this run's records",
    );
    expect(screen.getByTestId('forge-removal-mark').textContent).toContain('1 deleted · 2 kept');
    expect(onRemoved).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('forge-results-remove'));
    expect(
      within(screen.getByTestId('forge-removal-plan'))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Contact: 1 record', 'Account: 1 record']);
    expect(screen.getByTestId('forge-removal-left-by')).toBeDefined();
  });

  it('offers nothing more once a removal took every record the run created', () => {
    render(<ForgeResultsRemoval run={RUN} targetOrgId={DEV.id} />);
    confirmRemoval();
    answer('forge:undo', 'forge:undo:response', {
      result: { ...PARTIAL_ANSWER, status: 'success' },
      operationId: 'forge-undo-2',
    });

    answer('forge:history:list', 'forge:history:list:response', {
      history: [
        {
          ...RUN_AFTER,
          undo: {
            removedAt: '2026-10-01T09:00:00.000Z',
            deleted: 3,
            alreadyGone: 0,
            kept: 0,
            refused: 0,
          },
          removalLeft: [],
        },
      ],
    });

    expect(screen.queryByTestId('forge-results-remove')).toBeNull();
    expect(screen.getByTestId('forge-removal-mark').textContent).toContain('3 deleted');
  });

  it('says why the extension refused the removal, and offers it again', () => {
    render(<ForgeResultsRemoval run={RUN} targetOrgId={DEV.id} />);
    confirmRemoval();

    answer('forge:undo', 'forge:undo:error', {
      message: 'This run is no longer in the Forge history.',
      code: 'NOT_FOUND',
      retryable: false,
    });

    expect(screen.getByTestId('forge-results-remove-error').textContent).toContain(
      'This run is no longer in the Forge history.',
    );
    expect(screen.getByTestId('forge-results-remove')).toBeDefined();
  });

  it('offers no removal when the org the run wrote to is no longer registered, and says so', () => {
    useOrgStore.setState({ orgs: [] });
    render(<ForgeResultsRemoval run={RUN} targetOrgId={DEV.id} />);

    expect(screen.queryByTestId('forge-results-remove')).toBeNull();
    expect(screen.getByTestId('forge-results-remove-org-gone').textContent).toBe(
      'The org this run wrote to is no longer registered: its records cannot be removed from here.',
    );
  });

  it('shows nothing for a run that created no record', () => {
    render(
      <ForgeResultsRemoval
        run={{ ...RUN, idRemapCreated: [], createdCount: 0 }}
        targetOrgId={DEV.id}
      />,
    );

    expect(screen.queryByTestId('forge-results-removal')).toBeNull();
  });

  describe('the sweep beside the removal', () => {
    /** The run as the history holds it once every record it created is gone. */
    const REMOVED: ForgeExecutionResult = {
      ...RUN,
      targetOrgId: DEV.id,
      writtenBetween: { first: '2026-10-01T07:59:00.000Z', last: '2026-10-01T08:00:00.000Z' },
      undo: {
        removedAt: '2026-10-01T09:00:00.000Z',
        deleted: 3,
        alreadyGone: 0,
        kept: 0,
        refused: 0,
      },
      removalLeft: [],
    };

    it('is offered unticked, lists what it would take once ticked, and goes with the removal', () => {
      render(<ForgeResultsRemoval run={RUN} targetOrgId={DEV.id} />);
      fireEvent.click(screen.getByTestId('forge-results-remove'));

      const toggle = screen.getByTestId('forge-removal-sweep-toggle') as HTMLInputElement;
      expect(toggle.checked).toBe(false);
      expect(sentAll('forge:undo-sweep:request')).toEqual([]);

      fireEvent.click(toggle);
      expect(sentAll('forge:undo-sweep:request').map((m) => m.payload)).toEqual([
        { forgeId: 'forge-on-screen' },
      ]);
      answer('forge:undo-sweep:request', 'forge:undo-sweep:response', {
        forgeId: 'forge-on-screen',
        listing: {
          looked: ['Contact', 'Account', 'Task'],
          found: [{ objectApiName: 'Task', count: 2, names: ['Welcome call'] }],
          unread: [],
          handWork: [],
        },
      });
      expect(screen.getByTestId('forge-sweep-found-Task').textContent).toContain('Task: 2 records');

      fireEvent.change(screen.getByTestId('danger-input'), { target: { value: DEV.alias } });
      fireEvent.click(screen.getByTestId('danger-confirm-btn'));
      expect(sentAll('forge:undo').map((message) => message.payload)).toEqual([
        { forgeId: 'forge-on-screen', includeChanged: false, sweep: true },
      ]);
    });

    it('shows what the sweep did after what the removal did', () => {
      render(<ForgeResultsRemoval run={RUN} targetOrgId={DEV.id} />);
      confirmRemoval();
      answer('forge:undo', 'forge:undo:response', {
        result: {
          ...PARTIAL_ANSWER,
          status: 'success',
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
        operationId: 'forge-undo-3',
      });

      expect(screen.getByTestId('forge-removal-result-Contact')).toBeDefined();
      expect(screen.getByTestId('forge-sweep-result-Task').textContent).toBe('Task: 2 deleted');
    });

    it('is offered alone for a run whose records are all removed, when the target dated its writes', () => {
      render(<ForgeResultsRemoval run={REMOVED} targetOrgId={DEV.id} />);

      expect(screen.queryByTestId('forge-results-remove')).toBeNull();
      fireEvent.click(screen.getByTestId('forge-results-sweep'));
      expect((screen.getByTestId('forge-removal-sweep-toggle') as HTMLInputElement).checked).toBe(
        true,
      );
      fireEvent.change(screen.getByTestId('danger-input'), { target: { value: DEV.alias } });
      fireEvent.click(screen.getByTestId('danger-confirm-btn'));

      expect(sentAll('forge:undo').map((message) => message.payload)).toEqual([
        { forgeId: 'forge-on-screen', includeChanged: false, sweep: true },
      ]);
    });

    it('is not offered alone for a run whose writes the target did not date', () => {
      render(
        <ForgeResultsRemoval
          run={{ ...REMOVED, writtenBetween: undefined }}
          targetOrgId={DEV.id}
        />,
      );
      expect(screen.queryByTestId('forge-results-sweep')).toBeNull();
    });

    it('shows what every sweep of the run took', () => {
      render(
        <ForgeResultsRemoval
          run={{
            ...REMOVED,
            sweep: { sweptAt: '2026-10-01T09:05:00.000Z', deleted: 2, keptChanged: 0, refused: 0 },
          }}
          targetOrgId={DEV.id}
        />,
      );
      expect(screen.getByTestId('forge-sweep-mark').textContent).toContain('2 deleted');
    });
  });
});
