import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, renderHook, screen, act, within, fireEvent } from '@testing-library/react';
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
  useRemovalSweep,
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

/**
 * What a sweep told the run's ties lists, as the extension classes it: tasks
 * and an asset made for the run, a task on a record it wrote over, one that
 * came late, one tied to nothing, and one someone changed since.
 */
const TOLD: ForgeSweepListing = {
  ...LISTING,
  found: [
    {
      objectApiName: 'Task',
      count: 6,
      names: ['Welcome call'],
      classes: { made: 3, sameSave: 2, madeOver: 1, late: 1, untied: 1, changed: 1 },
    },
    {
      objectApiName: 'Asset',
      count: 1,
      names: ['Insured risk'],
      classes: { made: 1, madeOver: 0, late: 0, untied: 0 },
    },
  ],
  late: [{ objectApiName: 'Task', count: 1 }],
  untied: { objects: [{ objectApiName: 'Task', count: 1 }] },
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

  it('offers the ticks it is handed under the list it read', () => {
    const onTicksChange = vi.fn();
    render(
      <ForgeRemovalSweep
        forgeId="forge-1"
        org="DEV-SANDBOX"
        ticks={{}}
        onTicksChange={onTicksChange}
      />,
    );
    answer('forge:undo-sweep:request', 'forge:undo-sweep:response', {
      forgeId: 'forge-1',
      listing: TOLD,
    });

    fireEvent.click(screen.getByTestId('forge-sweep-late-tick'));
    expect(onTicksChange).toHaveBeenCalledWith({ sweepLate: true });
  });
});

describe('useRemovalSweep', () => {
  it('asks nothing of a sweep that is not ticked, a tick left under it included', () => {
    const { result } = renderHook(() => useRemovalSweep());
    expect(result.current.sweep).toBe(false);
    expect(result.current.asked).toEqual({});

    act(() => result.current.setTicks({ sweepLate: true }));
    expect(result.current.asked).toEqual({});
  });

  it('asks the sweep with its ticks once it is ticked', () => {
    const { result } = renderHook(() => useRemovalSweep());
    act(() => result.current.setSweep(true));
    expect(result.current.asked).toEqual({ sweep: true });

    act(() => result.current.setTicks({ sweepLate: true, sweepUntied: true }));
    expect(result.current.asked).toEqual({ sweep: true, sweepLate: true, sweepUntied: true });
  });

  // A tick answers the list read for this opening: left on for the next, it
  // deleted what nobody had looked at.
  it('sets both ticks back whenever the sweep is ticked or unticked', () => {
    const { result } = renderHook(() => useRemovalSweep());
    act(() => result.current.setSweep(true));
    act(() => result.current.setTicks({ sweepUntied: true }));

    act(() => result.current.setSweep(false));
    expect(result.current.ticks).toEqual({});
    act(() => result.current.setSweep(true));
    expect(result.current.asked).toEqual({ sweep: true });
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

  it('says what it takes with no more asked, as the extension classed the records', () => {
    render(<ForgeSweepListingView listing={TOLD} />);

    // Made and made on what it wrote over, in every object: nothing late, nothing untied.
    expect(screen.getByTestId('forge-sweep-takes').textContent).toBe(
      'With no more asked, the sweep takes 5 records it ties to the run.',
    );
    expect(screen.getByTestId('forge-sweep-classes-Task').textContent).toBe(
      [
        '3 made for the run',
        '2 of them within two seconds of their record, the surest',
        '1 made on a record it wrote over',
        '1 came late, kept unless asked',
        '1 tied to nothing of the run, kept unless asked',
        // Said of a task the run's own user edited after the run as much as a colleague's.
        '1 changed since the run, kept unless you include what changed',
      ].join(' · '),
    );
    expect(screen.getByTestId('forge-sweep-classes-Asset').textContent).toBe('1 made for the run');
  });

  it('counts out of what it takes with no more asked what changed since the run, which it keeps', () => {
    // Run for real on the trap org: a list counted among what the sweep took a
    // task changed since the run, which the sweep then kept.
    const changedOne: ForgeSweepListing = {
      ...TOLD,
      found: [
        {
          objectApiName: 'Task',
          count: 4,
          names: [],
          classes: { made: 3, madeOver: 1, late: 0, untied: 0, changed: 1, changedIn: { made: 1 } },
        },
        TOLD.found[1],
      ],
    };
    render(<ForgeSweepListingView listing={changedOne} />);

    expect(screen.getByTestId('forge-sweep-takes').textContent).toBe(
      'With no more asked, the sweep takes 4 records it ties to the run.',
    );
  });

  it('says it takes nothing when all it ties to the run changed since, and still has the names checked', () => {
    render(
      <ForgeSweepListingView
        listing={{
          ...TOLD,
          found: [
            {
              objectApiName: 'Task',
              count: 1,
              names: ['Welcome call'],
              classes: {
                made: 1,
                madeOver: 0,
                late: 0,
                untied: 0,
                changed: 1,
                changedIn: { made: 1 },
              },
            },
          ],
        }}
      />,
    );

    expect(screen.getByTestId('forge-sweep-takes').textContent).toBe(
      'With no more asked, the sweep takes nothing: what it ties to the run changed since, and ' +
        'stays unless you include what changed.',
    );
    expect(screen.getByTestId('forge-sweep-own-work')).toBeTruthy();
  });

  it('counts no record past the bound among what it takes', () => {
    render(
      <ForgeSweepListingView
        listing={{
          ...TOLD,
          found: [
            ...TOLD.found,
            {
              objectApiName: 'FeedItem',
              count: 10_000,
              names: [],
              overBound: true,
              classes: { made: 10_000, madeOver: 0, late: 0, untied: 0 },
            },
          ],
        }}
      />,
    );
    expect(screen.getByTestId('forge-sweep-takes').textContent).toContain('takes 5 records');
  });

  it('says it takes nothing when it ties none of what it found to the run', () => {
    render(
      <ForgeSweepListingView
        listing={{
          ...TOLD,
          found: [
            {
              objectApiName: 'Task',
              count: 1,
              names: [],
              classes: { made: 0, madeOver: 0, late: 0, untied: 1 },
            },
          ],
        }}
      />,
    );
    expect(screen.getByTestId('forge-sweep-takes').textContent).toBe(
      'With no more asked, the sweep takes nothing: it ties none of these records to the run.',
    );
    expect(screen.queryByTestId('forge-sweep-own-work')).toBeNull();
  });

  it('warns that a record made by hand under the run reads as the automation’s, and shows names, never ids', () => {
    const { container } = render(<ForgeSweepListingView listing={TOLD} />);

    expect(screen.getByTestId('forge-sweep-own-work').textContent).toContain(
      'check the names before you confirm',
    );
    expect(screen.getByTestId('forge-sweep-found-Task').textContent).toContain('Welcome call');
    expect(container.textContent).not.toMatch(/\b[a-zA-Z0-9]{5}0[a-zA-Z0-9]{9,12}\b/);
  });

  it('offers both ticks unticked, and says what each takes', () => {
    render(<ForgeSweepListingView listing={TOLD} ticks={{}} onTicksChange={vi.fn()} />);

    const late = screen.getByTestId('forge-sweep-late-tick') as HTMLInputElement;
    const untied = screen.getByTestId('forge-sweep-untied-tick') as HTMLInputElement;
    expect(late.checked).toBe(false);
    expect(untied.checked).toBe(false);
    expect(late.closest('label')?.textContent).toBe(
      "Also delete 1 record that came late (Task (1)): tied to the run's records, but created more than a minute after them, or by the org's Automated Process user",
    );
    expect(untied.closest('label')?.textContent).toBe(
      "Also delete 1 record tied to nothing of the run (Task (1)): the run's user created it during the run, and nothing links it to the run's records",
    );
  });

  it('hands each tick on with the other as it stands', () => {
    const onTicksChange = vi.fn();
    const { rerender } = render(
      <ForgeSweepListingView listing={TOLD} ticks={{}} onTicksChange={onTicksChange} />,
    );
    fireEvent.click(screen.getByTestId('forge-sweep-untied-tick'));
    expect(onTicksChange).toHaveBeenLastCalledWith({ sweepUntied: true });

    rerender(
      <ForgeSweepListingView
        listing={TOLD}
        ticks={{ sweepUntied: true }}
        onTicksChange={onTicksChange}
      />,
    );
    fireEvent.click(screen.getByTestId('forge-sweep-late-tick'));
    expect(onTicksChange).toHaveBeenLastCalledWith({ sweepLate: true, sweepUntied: true });

    rerender(
      <ForgeSweepListingView
        listing={TOLD}
        ticks={{ sweepLate: true, sweepUntied: true }}
        onTicksChange={onTicksChange}
      />,
    );
    fireEvent.click(screen.getByTestId('forge-sweep-untied-tick'));
    expect(onTicksChange).toHaveBeenLastCalledWith({ sweepLate: true });
  });

  it('refuses what is tied to nothing in the extension’s words: the box stays, off, and says why', () => {
    const refusal = 'Another run of this machine wrote to the target in this run’s window.';
    const onTicksChange = vi.fn();
    render(
      <ForgeSweepListingView
        listing={{ ...TOLD, untied: { ...TOLD.untied!, refusal } }}
        ticks={{ sweepUntied: true }}
        onTicksChange={onTicksChange}
      />,
    );

    const tick = screen.getByTestId('forge-sweep-untied-tick') as HTMLInputElement;
    expect(tick.disabled).toBe(true);
    expect(tick.checked).toBe(false);
    const reason = screen.getByTestId('forge-sweep-untied-refused');
    expect(reason.textContent).toBe(`This cannot be asked for: ${refusal}`);
    expect(tick.getAttribute('aria-describedby')).toBe(reason.id);
    // What came late is not refused for it.
    expect((screen.getByTestId('forge-sweep-late-tick') as HTMLInputElement).disabled).toBe(false);
  });

  it('offers no tick for what it does not keep, nor under a sweep refused whole', () => {
    const { rerender } = render(
      <ForgeSweepListingView
        listing={{ ...TOLD, late: [], untied: { objects: [] } }}
        ticks={{}}
        onTicksChange={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('forge-sweep-late-tick')).toBeNull();
    expect(screen.queryByTestId('forge-sweep-untied-tick')).toBeNull();

    rerender(
      <ForgeSweepListingView
        listing={{ ...TOLD, refusal: 'The run’s user could not be told.' }}
        ticks={{}}
        onTicksChange={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('forge-sweep-late-tick')).toBeNull();
    expect(screen.queryByTestId('forge-sweep-takes')).toBeNull();
  });

  it('says what stays whatever is ticked, and why, on demand', () => {
    render(<ForgeSweepListingView listing={TOLD} />);

    const stays = screen.getByTestId('forge-sweep-stays');
    expect(stays.tagName).toBe('DETAILS');
    expect(stays.querySelector('summary')?.textContent).toBe('What stays, and why');
    const lines = within(stays)
      .getAllByRole('listitem', { hidden: true })
      .map((item) => item.textContent);
    expect(lines).toHaveLength(10);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringContaining('What another user created'),
        expect.stringContaining('tied to nothing the run created or wrote over'),
        expect.stringContaining('more than 15 minutes after its record'),
        // The run's own user's change is kept as a colleague's is.
        expect.stringContaining("What was changed after the run's last write, by anyone"),
        expect.stringContaining('cannot read or delete'),
        expect.stringContaining('What the org refuses'),
        expect.stringContaining('changed or deleted rather than created'),
        expect.stringContaining('What left the org'),
        expect.stringContaining('More than 10,000 records of one object'),
        expect.stringContaining('another machine or a CI'),
      ]),
    );
  });

  it('names a dozen objects at most, and how many more', () => {
    const many = Array.from({ length: 300 }, (_, at) => `Object${at}__c`);
    render(<ForgeSweepListingView listing={{ ...TOLD, looked: many, notLooked: many }} />);

    expect(screen.getByTestId('forge-sweep-window').textContent).toContain(
      'Object11__c and 288 more',
    );
    expect(screen.getByTestId('forge-sweep-window').textContent).not.toContain('Object12__c');
    expect(screen.getByTestId('forge-sweep-not-looked').textContent).toBe(
      `Not looked at, past the most objects a sweep counts: ${many.slice(0, 12).join(', ')} and 288 more`,
    );
  });

  it('says what the run’s mute kept quiet, what still ran, and what no bypass silences', () => {
    render(
      <ForgeSweepListingView
        listing={{
          ...TOLD,
          muted: {
            silenced: [
              { objectApiName: 'Contact', kind: 'flow', name: 'Welcome', permission: 'Skip_Flows' },
            ],
            stillRan: [
              { objectApiName: 'Case', kind: 'trigger', name: 'CaseAudit', why: 'noBypass' },
            ],
          },
        }}
      />,
    );

    expect(screen.getByTestId('forge-sweep-muted-silenced-Contact').textContent).toContain(
      'Welcome',
    );
    expect(screen.getByTestId('forge-sweep-muted-still-ran-Case').textContent).toContain(
      'CaseAudit',
    );
    expect(screen.getByTestId('forge-sweep-muted').textContent).toContain(
      'No bypass keeps quiet the lines the platform copies onto a synced quote',
    );
  });

  it('says nothing of what a sweep keeps when it does not tell the records apart: it takes them all', () => {
    render(<ForgeSweepListingView listing={LISTING} ticks={{}} onTicksChange={vi.fn()} />);

    expect(screen.queryByTestId('forge-sweep-takes')).toBeNull();
    expect(screen.queryByTestId('forge-sweep-classes-Task')).toBeNull();
    expect(screen.queryByTestId('forge-sweep-stays')).toBeNull();
    expect(screen.queryByTestId('forge-sweep-own-work')).toBeNull();
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

  it('says what it found and left, by class, and what takes it: a success that leaves records says so first', () => {
    render(
      <ForgeRunSweepResult
        result={{
          status: 'success',
          objects: [],
          unread: [],
          handWork: [],
          left: [
            {
              class: 'late',
              objects: [{ objectApiName: 'Task', count: 1 }],
              option: '--sweep-late',
            },
            {
              class: 'untied',
              objects: [
                { objectApiName: 'Task', count: 5 },
                { objectApiName: 'Note', count: 2 },
              ],
              option: '--sweep-untied',
            },
          ],
        }}
        org="DEV-SANDBOX"
      />,
    );

    expect(screen.getByRole('heading').textContent).toBe(
      'What the sweep took is gone from DEV-SANDBOX; what it left stays, as said below.',
    );
    expect(screen.getByTestId('forge-sweep-left-late').textContent).toBe(
      "1 record that came late stays (Task (1)).A tick under the sweep's list takes them.",
    );
    expect(screen.getByTestId('forge-sweep-left-untied').textContent).toBe(
      "7 records tied to nothing of the run stay (Task (5), Note (2)).A tick under the sweep's list takes them.",
    );
  });

  it('says what it found and kept that went with the run’s records, no longer in the org', () => {
    // Run for real on the trap org: 25 duplicate record items the sweep kept
    // as made late went with their contacts, which the command line said and
    // the page did not.
    render(
      <ForgeRunSweepResult
        result={{
          status: 'success',
          objects: [],
          unread: [],
          handWork: [],
          goneAlong: [
            { class: 'late', objects: [{ objectApiName: 'DuplicateRecordItem', count: 25 }] },
          ],
        }}
        org="DEV-SANDBOX"
      />,
    );

    expect(screen.getByTestId('forge-sweep-gone-along-late').textContent).toBe(
      "25 records that came late went with the run's records: they are no longer in DEV-SANDBOX " +
        '(DuplicateRecordItem (25)).',
    );
    expect(screen.queryByTestId('forge-sweep-left-late')).toBeNull();
    expect(screen.getByRole('heading').textContent).toBe(
      'Nothing the sweep found is left in DEV-SANDBOX.',
    );
  });

  it('says why what is tied to nothing cannot be asked for, when it cannot', () => {
    render(
      <ForgeRunSweepResult
        result={{
          status: 'success',
          objects: [],
          unread: [],
          handWork: [],
          left: [
            {
              class: 'untied',
              objects: [{ objectApiName: 'Task', count: 1 }],
              option: '--sweep-untied',
              refusal: 'Hand work, likely.',
            },
          ],
        }}
        org="DEV-SANDBOX"
      />,
    );

    expect(screen.getByTestId('forge-sweep-left-untied').textContent).toBe(
      '1 record tied to nothing of the run stays (Task (1)).This cannot be asked for: Hand work, likely.',
    );
  });

  it('says nothing the sweep found is left only when nothing is', () => {
    render(
      <ForgeRunSweepResult
        result={{ status: 'success', objects: [], unread: [], handWork: [] }}
        org="DEV-SANDBOX"
      />,
    );

    expect(screen.getByRole('heading').textContent).toBe(
      'Nothing the sweep found is left in DEV-SANDBOX.',
    );
    expect(screen.queryByTestId('forge-sweep-left-untied')).toBeNull();
  });

  it('says of what it deleted what waited for the records of the run that point at it', () => {
    render(
      <ForgeRunSweepResult
        result={{
          ...RESULT,
          objects: [
            {
              objectApiName: 'Asset',
              found: 2,
              deleted: 2,
              alreadyGone: 0,
              keptChanged: 0,
              refused: 0,
              reasons: [],
              afterRemoval: 1,
            },
          ],
        }}
        org="DEV-SANDBOX"
      />,
    );
    expect(screen.getByTestId('forge-sweep-result-Asset').textContent).toBe(
      'Asset: 2 deleted · 1 of them once the records of the run that point at it were gone',
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
