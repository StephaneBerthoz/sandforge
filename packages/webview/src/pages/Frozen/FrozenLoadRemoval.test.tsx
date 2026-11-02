import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import type {
  BaseMessage,
  ForgeTargetAutomation,
  FrozenLoadRecordsInfo,
  FrozenLoadReportInfo,
  FrozenRemovalResult,
  SalesforceOrg,
} from '@sandforge/shared';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';

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
import { useAppStore } from '../../stores/useAppStore';
import { developerOrg } from '../Checkpoint/testing/checkpointFixtures';
import { useNotificationStore } from '../../stores/useNotificationStore';

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

/** Answer the last `requestType` the card sent, correlated to it as the extension does. */
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
    const { container } = render(<FrozenLoadRemoval records={undefined} onAnswered={vi.fn()} />);
    expect(container.textContent).toBe('');
  });

  it('names the last load and offers to remove what it created', () => {
    render(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} />);

    expect(screen.getByTestId('frozen-removal-loaded').textContent).toMatch(
      /^Loaded into DEV-SANDBOX on 2026-09-24 \d\d:\d\d$/,
    );
    expect(screen.getByTestId('frozen-removal-remove').textContent).toBe(
      'Remove the records this load created',
    );
  });

  it('names the org and the records per object, and keeps the linked ones', () => {
    render(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} />);

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

  it('says, before anything goes, that after a reload it takes what earlier loads created and the reload kept', () => {
    // A reload keeps as its own the records earlier loads created that it
    // finds again, and its removal takes them: the card spoke only of the
    // records "this load created".
    render(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} />);

    fireEvent.click(screen.getByTestId('frozen-removal-remove'));

    expect(screen.getByRole('dialog').textContent).toContain(
      'After a reload, these include the records earlier loads created that the reload found ' +
        'again and kept as its own.',
    );
  });

  it('sends the load, never its records, once the org name is typed', () => {
    render(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} />);

    confirmRemoval();

    expect(sent('frozen:remove')?.payload).toEqual({
      targetOrgId: 'org-dev',
      loadedAt: '2026-09-24T10:05:00.000Z',
    });
  });

  it('offers a sweep never ticked unasked, and lists what it would take once ticked', () => {
    render(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} />);

    fireEvent.click(screen.getByTestId('frozen-removal-remove'));
    const toggle = screen.getByTestId('frozen-removal-sweep-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(sent('frozen:remove:sweep')).toBeUndefined();

    fireEvent.click(toggle);
    expect(sent('frozen:remove:sweep')?.payload).toEqual({
      targetOrgId: 'org-dev',
      loadedAt: '2026-09-24T10:05:00.000Z',
    });
    expect(screen.getByTestId('frozen-sweep-loading').textContent).toBe(
      "Reading what DEV-SANDBOX's automation created during the load…",
    );
    answer('frozen:remove:sweep', 'frozen:remove:sweep:response', {
      loadedAt: '2026-09-24T10:05:00.000Z',
      listing: {
        looked: ['Contact', 'Task'],
        found: [{ objectApiName: 'Task', count: 3, names: ['Call'], overBound: false }],
        unread: [],
        handWork: [],
      },
    });

    expect(screen.getByTestId('forge-sweep-found-Task').textContent).toContain('Task: 3 records');
  });

  describe('what the target runs as the load is taken back', () => {
    const LOADED_AT = '2026-09-24T10:05:00.000Z';
    const AUTOMATION: ForgeTargetAutomation = {
      objectsRead: ['Contact', 'Account', 'Order'],
      objects: [
        {
          objectApiName: 'Order',
          flows: [
            {
              apiName: 'Order_Update',
              label: 'Order update',
              timing: 'afterSave',
              startsOn: 'update',
              condition: 'read',
              permissions: [],
            },
          ],
          triggers: [],
        },
        {
          objectApiName: 'Contact',
          flows: [
            {
              apiName: 'Contact_Audit',
              label: 'Contact audit',
              timing: 'afterSave',
              startsOn: 'delete',
              condition: 'read',
              permissions: [],
            },
          ],
          triggers: [{ name: 'AccountGuard', events: ['beforeDelete'] }],
        },
      ],
      unread: [],
      conditionsNotRead: 0,
      conditionsBound: 25,
      requests: 6,
    } as unknown as ForgeTargetAutomation;
    const STEPS = { setToDraft: ['Order'], delete: ['Contact', 'Account', 'Order'] };
    /** The Flow on the contact goes quiet for the holder of a set the org holds. */
    const MUTABLE = {
      ...AUTOMATION,
      objects: AUTOMATION.objects.map((object) =>
        object.objectApiName === 'Contact'
          ? {
              ...object,
              flows: object.flows.map((flow) => ({
                ...flow,
                permissions: [{ name: 'Skip_Audit', bypass: true, held: false }],
              })),
            }
          : object,
      ),
      bypassGrants: [
        {
          permission: 'Skip_Audit',
          permissionSets: [{ name: 'Audit_Bypass', label: 'Audit bypass', grants: 1 }],
        },
      ],
    } as unknown as ForgeTargetAutomation;
    /** What the sweep would take: a task of the load, and an asset that came late. */
    const LISTING = {
      looked: ['Account', 'Asset', 'Task'],
      found: [
        {
          objectApiName: 'Asset',
          count: 1,
          names: [],
          classes: { made: 0, madeOver: 0, late: 1, untied: 0 },
        },
        {
          objectApiName: 'Task',
          count: 1,
          names: [],
          classes: { made: 1, madeOver: 0, late: 0, untied: 0 },
        },
      ],
      unread: [],
      handWork: [],
      late: [{ objectApiName: 'Asset', count: 1 }],
      untied: { objects: [] },
    };

    it('asks for it by the load alone as the confirmation opens, and lists it step by step before the org name is typed', () => {
      render(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} />);
      expect(sent('frozen:remove:automation')).toBeUndefined();

      fireEvent.click(screen.getByTestId('frozen-removal-remove'));

      expect(sent('frozen:remove:automation')?.payload).toEqual({
        targetOrgId: 'org-dev',
        loadedAt: LOADED_AT,
      });
      expect(screen.getByTestId('frozen-removal-automation-loading').textContent).toBe(
        'Reading what DEV-SANDBOX runs as this load is taken back…',
      );
      answer('frozen:remove:automation', 'frozen:remove:automation:response', {
        loadedAt: LOADED_AT,
        automation: AUTOMATION,
        steps: STEPS,
      });

      const section = screen.getByTestId('frozen-removal-automation');
      expect(within(section).getByRole('heading').textContent).toBe(
        'What DEV-SANDBOX runs as this load is taken back',
      );
      expect(
        within(section)
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual([
        'Order: Flow: Order update · as the removal sets it back to Draft to delete it',
        'Contact: Apex trigger: AccountGuard · before delete',
        'Contact: Flow: Contact audit · after delete',
      ]);
      expect(sent('frozen:remove')).toBeUndefined();
    });

    it('says when nothing fires, and offers no box', () => {
      render(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} />);
      fireEvent.click(screen.getByTestId('frozen-removal-remove'));

      answer('frozen:remove:automation', 'frozen:remove:automation:response', {
        loadedAt: LOADED_AT,
        automation: { ...AUTOMATION, objects: [] },
        steps: STEPS,
      });

      expect(screen.getByTestId('frozen-removal-automation-none').textContent).toBe(
        'Nothing DEV-SANDBOX automates runs as this load is taken back.',
      );
      expect(screen.queryByTestId('frozen-removal-automation-mute')).toBeNull();
    });

    it('says a read that failed, and reads again when asked', () => {
      render(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} />);
      fireEvent.click(screen.getByTestId('frozen-removal-remove'));

      answer('frozen:remove:automation', 'frozen:remove:automation:error', {
        message: 'REQUEST_LIMIT_EXCEEDED',
        code: 'AUTOMATION_ERROR',
        retryable: true,
      });

      expect(screen.getByTestId('frozen-removal-automation-error').textContent).toBe(
        'What DEV-SANDBOX runs as this load is taken back could not be read: REQUEST_LIMIT_EXCEEDED',
      );
      const first = sent('frozen:remove:automation')?.id;
      fireEvent.click(screen.getByTestId('frozen-removal-automation-read-again'));
      expect(sent('frozen:remove:automation')?.id).not.toBe(first);
    });

    it('reads what fires on what the sweep’s list takes, what is ticked under it, and on the load’s objects alone once it is unticked', () => {
      render(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} />);
      fireEvent.click(screen.getByTestId('frozen-removal-remove'));
      fireEvent.click(screen.getByTestId('frozen-removal-sweep-toggle'));
      answer('frozen:remove:sweep', 'frozen:remove:sweep:response', {
        loadedAt: LOADED_AT,
        listing: LISTING,
      });

      expect(sent('frozen:remove:automation')?.payload).toEqual({
        targetOrgId: 'org-dev',
        loadedAt: LOADED_AT,
        sweptObjects: ['Task'],
      });

      fireEvent.click(screen.getByTestId('forge-sweep-late-tick'));
      expect(sent('frozen:remove:automation')?.payload).toMatchObject({
        sweptObjects: ['Asset', 'Task'],
      });

      fireEvent.click(screen.getByTestId('frozen-removal-sweep-toggle'));
      expect(sent('frozen:remove:automation')?.payload).toEqual({
        targetOrgId: 'org-dev',
        loadedAt: LOADED_AT,
      });
    });

    it('offers the box that mutes it once a set silences something, and says what still runs', () => {
      render(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} />);
      fireEvent.click(screen.getByTestId('frozen-removal-remove'));
      answer('frozen:remove:automation', 'frozen:remove:automation:response', {
        loadedAt: LOADED_AT,
        automation: MUTABLE,
        steps: STEPS,
      });

      expect(
        screen.getByTestId('frozen-removal-automation-mute-silenced-Contact').textContent,
      ).toBe('Contact: Flow: Contact audit · bypass Skip_Audit');
      expect(screen.getByTestId('frozen-removal-automation-mute-still-runs').textContent).toContain(
        'Contact: Apex trigger: AccountGuard',
      );
    });

    it('sends the removal muted once ticked, and takes the box back at the next confirmation', () => {
      render(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} />);
      fireEvent.click(screen.getByTestId('frozen-removal-remove'));
      answer('frozen:remove:automation', 'frozen:remove:automation:response', {
        loadedAt: LOADED_AT,
        automation: MUTABLE,
        steps: STEPS,
      });
      fireEvent.click(screen.getByTestId('frozen-removal-automation-mute-toggle'));

      fireEvent.change(screen.getByTestId('danger-input'), { target: { value: DEV.alias } });
      fireEvent.click(screen.getByTestId('danger-confirm-btn'));

      expect(sent('frozen:remove')?.payload).toEqual({
        targetOrgId: 'org-dev',
        loadedAt: LOADED_AT,
        muteAutomation: true,
      });

      answerRemoval('frozen:remove:response', { result: PARTIAL, operationId: 'op-1' });
      fireEvent.click(screen.getByTestId('frozen-removal-remove'));
      answer('frozen:remove:automation', 'frozen:remove:automation:response', {
        loadedAt: LOADED_AT,
        automation: MUTABLE,
        steps: STEPS,
      });
      expect(
        (screen.getByTestId('frozen-removal-automation-mute-toggle') as HTMLInputElement).checked,
      ).toBe(false);
    });

    it('shows what the removal muted, under its result', () => {
      render(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} />);
      confirmRemoval();

      answerRemoval('frozen:remove:response', {
        result: {
          ...PARTIAL,
          mutedAutomation: {
            state: 'muted',
            assigned: ['Audit_Bypass'],
            held: [],
            permissions: ['Skip_Audit'],
            silenced: [],
            stillRan: [],
            released: true,
          },
        },
        operationId: 'op-1',
      });

      expect(screen.getByTestId('forge-removal-result-muted')).toBeTruthy();
    });
  });

  it('does not present as a success a removal whose sweep failed, the load’s records gone', () => {
    render(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} />);
    confirmRemoval();

    answerRemoval('frozen:remove:response', {
      result: {
        status: 'partial',
        includeChanged: false,
        finishedAt: '2026-09-24T11:00:00.000Z',
        objects: [
          {
            objectApiName: 'Contact',
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
        sweep: {
          status: 'failure',
          objects: [
            {
              objectApiName: 'Asset',
              found: 1,
              deleted: 0,
              alreadyGone: 0,
              keptChanged: 0,
              refused: 1,
              reasons: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: no'],
            },
          ],
          unread: [],
          handWork: [],
        },
      },
      operationId: 'op-1',
    });

    const result = screen.getByTestId('forge-removal-result');
    expect(within(result).getAllByRole('heading')[0]?.textContent).toBe(
      'No record this load created is left in DEV-SANDBOX, but the sweep did not take all it was asked to, as listed below.',
    );
    expect(within(result).getAllByRole('heading')[0]?.className).toContain('text-status-warning');
    expect(screen.getByTestId('forge-sweep-result').textContent).toContain(
      'FIELD_CUSTOM_VALIDATION_EXCEPTION',
    );
  });

  /** What the sweep lists of the load: what it takes, what came late, what is tied to nothing. */
  const TOLD_LISTING = {
    looked: ['Contact', 'Task'],
    found: [
      {
        objectApiName: 'Task',
        count: 3,
        names: ['Welcome call'],
        classes: { made: 1, madeOver: 0, late: 1, untied: 1 },
      },
    ],
    unread: [],
    handWork: [],
    late: [{ objectApiName: 'Task', count: 1 }],
    untied: { objects: [{ objectApiName: 'Task', count: 1 }] },
  };

  it('shows the classes of what it found, and sends what is ticked under the list', () => {
    render(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} />);
    fireEvent.click(screen.getByTestId('frozen-removal-remove'));
    expect(screen.getByTestId('danger-confirm-btn').textContent).toBe('Remove 3 records');
    fireEvent.click(screen.getByTestId('frozen-removal-sweep-toggle'));
    answer('frozen:remove:sweep', 'frozen:remove:sweep:response', {
      loadedAt: LOADED.loadedAt,
      listing: TOLD_LISTING,
    });

    expect(screen.getByTestId('forge-sweep-takes').textContent).toContain('takes 1 record');
    expect(screen.getByTestId('forge-sweep-stays')).toBeTruthy();
    fireEvent.click(screen.getByTestId('forge-sweep-untied-tick'));
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: DEV.alias } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));

    expect(sent('frozen:remove')?.payload).toEqual({
      targetOrgId: 'org-dev',
      loadedAt: LOADED.loadedAt,
      sweep: true,
      sweepUntied: true,
    });
  });

  it('keeps what is tied to nothing, with the extension’s words, when taking it is refused', () => {
    render(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} />);
    fireEvent.click(screen.getByTestId('frozen-removal-remove'));
    fireEvent.click(screen.getByTestId('frozen-removal-sweep-toggle'));
    answer('frozen:remove:sweep', 'frozen:remove:sweep:response', {
      loadedAt: LOADED.loadedAt,
      listing: {
        ...TOLD_LISTING,
        untied: { ...TOLD_LISTING.untied, refusal: 'Another run of this machine wrote.' },
      },
    });

    expect((screen.getByTestId('forge-sweep-untied-tick') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId('forge-sweep-untied-refused').textContent).toContain(
      'Another run of this machine wrote.',
    );
  });

  describe('a removal that left records for what the automation made', () => {
    const HELD: FrozenRemovalResult = {
      ...PARTIAL,
      objects: [
        {
          ...PARTIAL.objects[1]!,
          heldBy: ['FeedItem'],
          heldByAutomation: 1,
          automationHolders: ['FeedItem'],
        },
      ],
    };

    it('names it in a load’s words, and proposes the sweep ticked by that gesture', () => {
      render(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} />);
      confirmRemoval();
      answerRemoval('frozen:remove:response', { result: HELD, operationId: 'req' });

      expect(screen.getByTestId('forge-removal-held-by-automation').textContent).toContain(
        '1 record of this load was kept for records created under it during the load',
      );
      expect(sent('frozen:remove:sweep')).toBeUndefined();
      fireEvent.click(screen.getByTestId('forge-removal-take-back-made'));

      expect((screen.getByTestId('frozen-removal-sweep-toggle') as HTMLInputElement).checked).toBe(
        true,
      );
      expect(sent('frozen:remove:sweep')?.payload).toEqual({
        targetOrgId: 'org-dev',
        loadedAt: LOADED.loadedAt,
      });
      fireEvent.change(screen.getByTestId('danger-input'), { target: { value: DEV.alias } });
      fireEvent.click(screen.getByTestId('danger-confirm-btn'));
      expect(sent('frozen:remove')?.payload).toEqual({
        targetOrgId: 'org-dev',
        loadedAt: LOADED.loadedAt,
        sweep: true,
      });
    });

    it('proposes no sweep while a load runs from the page', () => {
      const { rerender } = render(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} />);
      confirmRemoval();
      answerRemoval('frozen:remove:response', { result: HELD, operationId: 'req' });

      rerender(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} busy />);

      expect(screen.getByTestId('forge-removal-held-by-automation')).toBeTruthy();
      expect(screen.queryByTestId('forge-removal-take-back-made')).toBeNull();
    });
  });

  it('asks for the sweep with the removal when it is ticked', () => {
    render(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} />);

    fireEvent.click(screen.getByTestId('frozen-removal-remove'));
    fireEvent.click(screen.getByTestId('frozen-removal-sweep-toggle'));
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: DEV.alias } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));

    expect(sent('frozen:remove')?.payload).toMatchObject({ sweep: true });
  });

  it('asks for the records changed since the load too when the box is ticked', () => {
    render(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} />);

    confirmRemoval({ includeChanged: true });

    expect(sent('frozen:remove')?.payload).toMatchObject({ includeChanged: true });
  });

  it('shows what the removal did per object, and reads the status again once', () => {
    const onAnswered = vi.fn();
    const { rerender } = render(<FrozenLoadRemoval records={LOADED} onAnswered={onAnswered} />);
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
    rerender(<FrozenLoadRemoval records={LOADED} onAnswered={() => onAnswered()} />);
    rerender(<FrozenLoadRemoval records={LOADED} onAnswered={() => onAnswered()} />);
    expect(onAnswered).toHaveBeenCalledTimes(1);
  });

  it('shows a refusal of the whole removal under the load', () => {
    render(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} />);
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

  it('says a refusal of its own in the panel’s language, what it asks of the host’s English gone', async () => {
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await i18n.changeLanguage('fr');
    try {
      render(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} />);
      confirmRemoval();

      answerRemoval('frozen:remove:error', {
        message: 'Another load was recorded since this one was shown, and nothing was removed.',
        code: 'LOAD_CHANGED',
        retryable: false,
      });

      expect(screen.getByTestId('frozen-removal-error').textContent).toContain(
        fr.frozen.refusal.loadChanged.explanation,
      );
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('keeps what the org answered, which is not the panel’s to say', () => {
    render(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} />);
    confirmRemoval();

    answerRemoval('frozen:remove:error', {
      message: 'INVALID_SESSION_ID: Session expired or invalid',
      code: 'REMOVE_ERROR',
      retryable: true,
    });

    expect(screen.getByTestId('frozen-removal-error').textContent).toContain('INVALID_SESSION_ID');
  });

  it('says a removal Production Guard refused in the panel’s language, with the guard’s reason, not the English sentence', async () => {
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await act(async () => {
      await i18n.changeLanguage('fr');
    });
    try {
      render(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} />);
      confirmRemoval();

      answerRemoval('frozen:remove:error', {
        message: 'Operation blocked by Production Guard: delete is not allowed on production',
        code: 'GUARD_BLOCKED',
        retryable: false,
      });

      const banner = screen.getByTestId('frozen-removal-error').textContent ?? '';
      expect(banner).toContain(
        "Production Guard a refusé cette opération, et rien n'a été modifié dans l'org.",
      );
      expect(banner).toContain('delete is not allowed on production');
      expect(banner).not.toContain('Operation blocked by Production Guard');
    } finally {
      await act(async () => {
        await i18n.changeLanguage('en');
      });
    }
  });

  it('reads the status again once when a removal is refused', () => {
    // Refused for a load recorded since it was shown, the card went on
    // offering the one it showed, and nothing read the status again.
    const onAnswered = vi.fn();
    const { rerender } = render(<FrozenLoadRemoval records={LOADED} onAnswered={onAnswered} />);
    confirmRemoval();

    answerRemoval('frozen:remove:error', {
      message: 'Another load was recorded since this one was shown, and nothing was removed.',
      code: 'LOAD_CHANGED',
      retryable: false,
    });

    rerender(<FrozenLoadRemoval records={LOADED} onAnswered={() => onAnswered()} />);
    expect(onAnswered).toHaveBeenCalledTimes(1);
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
        onAnswered={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('frozen-removal-remove')).toBeNull();
    expect(screen.getByTestId('forge-removal-mark').textContent).toMatch(
      /^Records removed on 2026-09-24 \d\d:\d\d: 3 deleted$/,
    );
  });

  describe('a load whose records all went', () => {
    const LOADED_AT = '2026-09-24T10:05:00.000Z';
    const GONE: FrozenLoadRecordsInfo = {
      ...LOADED,
      created: [],
      removed: {
        removedAt: '2026-09-24T11:00:00.000Z',
        deleted: 3,
        alreadyGone: 0,
        kept: 0,
        refused: 0,
      },
    };
    /** What the sweep's list answers: what the automation made, by object. */
    const listing = (objectApiName: string) => ({
      loadedAt: LOADED_AT,
      listing: {
        looked: [objectApiName],
        found: [
          {
            objectApiName,
            count: 1,
            names: ['Risk'],
            classes: { made: 1, madeOver: 0, late: 0, untied: 0 },
          },
        ],
        unread: [],
        handWork: [],
      },
    });

    it('offers the sweep alone, ticked by that gesture, and sends it once the org name is typed', () => {
      render(<FrozenLoadRemoval records={GONE} onAnswered={vi.fn()} />);

      fireEvent.click(screen.getByTestId('frozen-removal-sweep-alone'));
      expect(screen.queryByTestId('frozen-removal-sweep-toggle')).toBeNull();
      expect(sent('frozen:remove:sweep')?.payload).toEqual({
        targetOrgId: 'org-dev',
        loadedAt: LOADED_AT,
      });
      answer('frozen:remove:sweep', 'frozen:remove:sweep:response', listing('Asset'));
      expect(screen.getByTestId('danger-confirm-btn').textContent).toContain(
        'Delete what the sweep takes',
      );
      fireEvent.change(screen.getByTestId('danger-input'), { target: { value: DEV.alias } });
      fireEvent.click(screen.getByTestId('danger-confirm-btn'));

      expect(sent('frozen:remove')?.payload).toEqual({
        targetOrgId: 'org-dev',
        loadedAt: LOADED_AT,
        sweep: true,
      });
    });

    it('reads what fires on what the sweep’s list takes alone, never on the load, whose records went', () => {
      render(<FrozenLoadRemoval records={GONE} onAnswered={vi.fn()} />);

      fireEvent.click(screen.getByTestId('frozen-removal-sweep-alone'));
      expect(sent('frozen:remove:automation')).toBeUndefined();
      answer('frozen:remove:sweep', 'frozen:remove:sweep:response', listing('Asset'));

      expect(sent('frozen:remove:automation')?.payload).toEqual({
        targetOrgId: 'org-dev',
        loadedAt: LOADED_AT,
        sweptObjects: ['Asset'],
      });
    });

    it('offers no sweep of a load that created nothing, of an org gone, or while a load runs', () => {
      const { rerender } = render(
        <FrozenLoadRemoval records={{ ...LOADED, created: [] }} onAnswered={vi.fn()} />,
      );
      expect(screen.queryByTestId('frozen-removal-sweep-alone')).toBeNull();

      rerender(<FrozenLoadRemoval records={GONE} onAnswered={vi.fn()} busy />);
      expect((screen.getByTestId('frozen-removal-sweep-alone') as HTMLButtonElement).disabled).toBe(
        true,
      );

      useOrgStore.setState({ orgs: [] });
      rerender(<FrozenLoadRemoval records={GONE} onAnswered={vi.fn()} />);
      expect(screen.queryByTestId('frozen-removal-sweep-alone')).toBeNull();
    });
  });

  describe('once a removal left records in the org', () => {
    /** The first removal deleted a contact, and kept the other, changed since, and its account. */
    const PARTLY_REMOVED: FrozenLoadRecordsInfo = {
      ...LOADED,
      created: [
        { objectApiName: 'Contact', count: 1 },
        { objectApiName: 'Account', count: 1 },
      ],
      removed: {
        removedAt: '2026-09-24T11:00:00.000Z',
        deleted: 1,
        alreadyGone: 0,
        kept: 2,
        refused: 0,
      },
    };

    it('says what that removal did, and offers to remove what it left', () => {
      render(<FrozenLoadRemoval records={PARTLY_REMOVED} onAnswered={vi.fn()} />);

      expect(screen.getByTestId('forge-removal-mark').textContent).toMatch(
        /^Records removed on 2026-09-24 \d\d:\d\d: 1 deleted · 2 kept$/,
      );
      expect(screen.getByTestId('frozen-removal-remove').textContent).toBe(
        "Remove what is left of this load's records",
      );
    });

    it('names only what is left in its confirmation, and which removal left it', () => {
      render(<FrozenLoadRemoval records={PARTLY_REMOVED} onAnswered={vi.fn()} />);

      fireEvent.click(screen.getByTestId('frozen-removal-remove'));

      expect(screen.getByTestId('forge-removal-left-by').textContent).toMatch(
        /^The removal of 2026-09-24 \d\d:\d\d left these records:$/,
      );
      expect(
        within(screen.getByTestId('forge-removal-plan'))
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual(['Contact: 1 record', 'Account: 1 record']);
    });

    it('sends the load, and says of the answer that it picked up where that removal left off', () => {
      render(<FrozenLoadRemoval records={PARTLY_REMOVED} onAnswered={vi.fn()} />);
      confirmRemoval({ includeChanged: true });

      expect(sent('frozen:remove')?.payload).toEqual({
        targetOrgId: 'org-dev',
        loadedAt: '2026-09-24T10:05:00.000Z',
        includeChanged: true,
      });
      answerRemoval('frozen:remove:response', {
        operationId: 'frozen-remove-8',
        result: {
          ...PARTIAL,
          status: 'success',
          includeChanged: true,
          leftBy: '2026-09-24T11:00:00.000Z',
          objects: [
            { ...PARTIAL.objects[0], planned: 1, deleted: 1, keptChanged: 0 },
            { ...PARTIAL.objects[1], deleted: 1, keptDependents: 0, heldBy: [] },
          ],
        },
      });

      expect(screen.getByTestId('forge-removal-result-left-by').textContent).toMatch(
        /^Picked up where the removal of 2026-09-24 \d\d:\d\d left off\.$/,
      );
    });
  });

  it('says why a load recorded before loads kept what they created can neither be removed nor reloaded', () => {
    render(
      <FrozenLoadRemoval
        records={{ ...LOADED, created: [], linked: 0, recorded: false }}
        onAnswered={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('frozen-removal-remove')).toBeNull();
    // A reload replaces the loads before it, and is refused for this one.
    expect(screen.getByTestId('frozen-removal-not-recorded').textContent).toContain(
      'nor replaced by a reload, which would delete what someone changed since.',
    );
  });

  describe('a reload refused for the records it would leave', () => {
    const refusal = (onDismiss = vi.fn()) => ({
      message: 'A removal of the loads this reload replaces would leave 1 of their records.',
      onDismiss,
    });

    it('says so above what the card offers, and opens the removal from it with the records changed since ticked', () => {
      const onDismiss = vi.fn();
      render(
        <FrozenLoadRemoval
          records={LOADED}
          onAnswered={vi.fn()}
          reloadRefusal={refusal(onDismiss)}
        />,
      );

      fireEvent.click(screen.getByTestId('frozen-reload-take-back'));
      const dialog = screen.getByRole('dialog');
      expect(
        (within(dialog).getByTestId('frozen-removal-include-changed') as HTMLInputElement).checked,
      ).toBe(true);
      expect(onDismiss).not.toHaveBeenCalled();
      fireEvent.change(screen.getByTestId('danger-input'), { target: { value: DEV.alias } });
      fireEvent.click(screen.getByTestId('danger-confirm-btn'));

      expect(sent('frozen:remove')?.payload).toEqual({
        targetOrgId: 'org-dev',
        loadedAt: LOADED.loadedAt,
        includeChanged: true,
      });
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('keeps the records changed since out of a removal asked from its own button', () => {
      render(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} reloadRefusal={refusal()} />);

      fireEvent.click(screen.getByTestId('frozen-reload-take-back'));
      fireEvent.click(screen.getByTestId('danger-dismiss-btn'));
      fireEvent.click(screen.getByTestId('frozen-removal-remove'));

      expect(
        (screen.getByTestId('frozen-removal-include-changed') as HTMLInputElement).checked,
      ).toBe(false);
    });

    it('offers no take-back while a load runs, or for a load it cannot remove', () => {
      const { rerender } = render(
        <FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} busy reloadRefusal={refusal()} />,
      );
      expect(screen.queryByTestId('frozen-reload-take-back')).toBeNull();

      rerender(
        <FrozenLoadRemoval
          records={{ ...LOADED, created: [], recorded: false }}
          onAnswered={vi.fn()}
          reloadRefusal={refusal()}
        />,
      );
      expect(screen.queryByTestId('frozen-reload-take-back')).toBeNull();
      expect(screen.getByTestId('frozen-reload-cancel')).toBeTruthy();
    });
  });

  it('names a load before the last one as such, and offers to remove what it created', () => {
    render(<FrozenLoadRemoval records={{ ...LOADED, earlier: true }} onAnswered={vi.fn()} />);

    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Earlier load');
    expect(screen.getByTestId('frozen-removal-earlier').textContent).toBe(
      'A load before the last one: the loads after it left its records in DEV-SANDBOX.',
    );
    confirmRemoval();
    expect(sent('frozen:remove')?.payload).toEqual({
      targetOrgId: 'org-dev',
      loadedAt: '2026-09-24T10:05:00.000Z',
    });
  });

  it('names the last load as the last one', () => {
    render(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} />);

    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Last load');
    expect(screen.queryByTestId('frozen-removal-earlier')).toBeNull();
  });

  it('says so when the org the load wrote to is no longer registered', () => {
    useOrgStore.setState({ orgs: [] });
    render(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} />);

    expect(screen.queryByTestId('frozen-removal-remove')).toBeNull();
    expect(screen.getByTestId('frozen-removal-org-gone')).toBeDefined();
  });

  it('says a load that created nothing has nothing to remove', () => {
    render(<FrozenLoadRemoval records={{ ...LOADED, created: [] }} onAnswered={vi.fn()} />);

    expect(screen.queryByTestId('frozen-removal-remove')).toBeNull();
    expect(screen.getByTestId('frozen-removal-nothing')).toBeDefined();
  });

  it('says which records the load created that no removal takes, the platform deleting none', () => {
    render(
      <FrozenLoadRemoval
        records={{ ...LOADED, keptByThePlatform: [{ objectApiName: 'BusinessHours', count: 1 }] }}
        onAnswered={vi.fn()}
      />,
    );

    expect(screen.getByTestId('frozen-removal-kept').textContent).toBe(
      'Kept in DEV-SANDBOX by any removal — the platform does not delete these records the load created: BusinessHours (1)',
    );
    // What a removal takes is still offered.
    expect(screen.getByTestId('frozen-removal-remove')).toBeDefined();
  });

  it('says it keeps them rather than that the load created nothing, when they are all it created', () => {
    render(
      <FrozenLoadRemoval
        records={{
          ...LOADED,
          created: [],
          keptByThePlatform: [{ objectApiName: 'BusinessHours', count: 1 }],
        }}
        onAnswered={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('frozen-removal-nothing')).toBeNull();
    expect(screen.queryByTestId('frozen-removal-remove')).toBeNull();
    expect(screen.getByTestId('frozen-removal-kept')).toBeDefined();
  });

  it('removes nothing while a load runs from the page', () => {
    render(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} busy />);

    expect((screen.getByTestId('frozen-removal-remove') as HTMLButtonElement).disabled).toBe(true);
  });

  describe('cancelling the removal under way', () => {
    // Only Live Operations could stop a removal: the card said it was
    // removing, and offered nothing to stop it.

    /** A removal stopped after the contacts went: the account was not reached. */
    const CANCELLED: FrozenRemovalResult = {
      status: 'cancelled',
      includeChanged: false,
      finishedAt: '2026-09-24T11:00:00.000Z',
      objects: [
        {
          objectApiName: 'Contact',
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

    beforeEach(() => {
      useNotificationStore.setState({ notifications: [] });
    });

    it('offers no cancel while no removal runs', () => {
      render(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} />);

      expect(screen.queryByTestId('frozen-removal-cancel')).toBeNull();
    });

    it('sends execution:abort with the id of the removal, says it is stopping, and is not offered twice', () => {
      render(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} />);
      confirmRemoval();
      const removalId = sent('frozen:remove')?.id;

      const cancel = screen.getByTestId('frozen-removal-cancel');
      expect(cancel.textContent).toBe('Stop the removal');
      fireEvent.click(cancel);

      expect(sent('execution:abort')?.payload).toEqual({ operationId: removalId });
      expect(screen.getByTestId('frozen-removal-cancel').getAttribute('aria-disabled')).toBe(
        'true',
      );
      expect(screen.getByTestId('frozen-removal-removing').textContent).toBe(
        'Stopping: the removal ends once the call under way is answered. What it removed by then is listed; the rest stays in the org, and a removal takes it later.',
      );
      fireEvent.click(screen.getByTestId('frozen-removal-cancel'));
      const aborts = mockPostMessage.mock.calls.filter(
        (call) => (call[0] as { payload: BaseMessage }).payload.type === 'execution:abort',
      );
      expect(aborts).toHaveLength(1);
    });

    it('says what went and what stays once the removal stopped, and reads the status again', () => {
      const onAnswered = vi.fn();
      render(<FrozenLoadRemoval records={LOADED} onAnswered={onAnswered} />);
      confirmRemoval();
      fireEvent.click(screen.getByTestId('frozen-removal-cancel'));
      answer('execution:abort', 'execution:abort:response', { success: true });

      answer('frozen:remove', 'frozen:remove:response', {
        result: CANCELLED,
        operationId: sent('frozen:remove')?.id,
      });

      const result = screen.getByTestId('forge-removal-result');
      expect(within(result).getByRole('heading').textContent).toBe(
        'Stopped before the end: what was done by then is listed, and the rest is still in DEV-SANDBOX.',
      );
      expect(screen.getByTestId('forge-removal-result-Contact').textContent).toBe(
        'Contact: 2 deleted',
      );
      expect(screen.queryByTestId('frozen-removal-cancel')).toBeNull();
      expect(onAnswered).toHaveBeenCalledTimes(1);
    });

    it('says so when the extension refuses the cancel, and offers it again', () => {
      render(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} />);
      confirmRemoval();
      fireEvent.click(screen.getByTestId('frozen-removal-cancel'));

      answer('execution:abort', 'execution:abort:response', {
        success: false,
        error: 'Operation not found',
      });

      expect(useNotificationStore.getState().notifications).toEqual([
        expect.objectContaining({
          level: 'warning',
          title: 'Could not stop the removal',
          // A Cancel sent before the removal started is taken now: a refused
          // one is of a removal that is over.
          message: 'The removal is no longer in progress, or it was not started from this window.',
        }),
      ]);
      expect(screen.getByTestId('frozen-removal-cancel').getAttribute('aria-disabled')).toBeNull();
      expect(screen.getByTestId('frozen-removal-removing').textContent).toBe(
        'Removing the records this load created…',
      );
    });

    it('says it in the language the panel is set to', async () => {
      i18n.addResourceBundle('fr', 'translation', fr, true, true);
      await i18n.changeLanguage('fr');
      try {
        render(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} />);
        confirmRemoval();
        expect(screen.getByTestId('frozen-removal-cancel').textContent).toBe(
          fr.frozen.removal.cancel,
        );
        fireEvent.click(screen.getByTestId('frozen-removal-cancel'));
        expect(screen.getByTestId('frozen-removal-removing').textContent).toBe(
          fr.frozen.removal.stopping,
        );
      } finally {
        await i18n.changeLanguage('en');
      }
    });
  });

  describe('the load’s checkpoint and the rewinds of it', () => {
    /** The report of the load the card shows, as this tab heard it. */
    const REPORT = {
      status: 'completed',
      orgId: 'org-dev',
      mode: { pilot: false, reload: false },
      startedAt: '2026-09-24T10:00:00.000Z',
      durationMs: 300_000,
      perObject: [{ objectApiName: 'Account' }, { objectApiName: 'Contact' }],
      checkpoint: {
        state: 'taken',
        checkpointId: 'ck-20260924-100000-a1b2',
        name: 'Before Frozen load 2026-09-24 10:00 UTC',
        takenAt: '2026-09-24T10:00:30.000Z',
        expiresAt: '2026-10-01T10:00:30.000Z',
        objects: ['Account', 'Contact'],
        records: 3,
        bytes: 2_048,
        requests: 8,
        added: [],
        notHeld: [],
      },
    } as unknown as FrozenLoadReportInfo;

    beforeEach(() => {
      mockPostMessage.mockClear();
      useOrgStore.setState({ orgs: [developerOrg({ id: 'org-dev', alias: 'DEV-SANDBOX' })] });
    });

    it('leaves the rewind to the report until a removal ended, then offers it under it', () => {
      const { rerender } = render(
        <FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} lastReport={REPORT} />,
      );
      expect(screen.queryByTestId('frozen-removal-checkpoint')).toBeNull();

      rerender(
        <FrozenLoadRemoval
          records={{
            ...LOADED,
            removed: {
              removedAt: '2026-09-24T11:00:00.000Z',
              deleted: 1,
              alreadyGone: 0,
              kept: 2,
              refused: 0,
            },
          }}
          onAnswered={vi.fn()}
          lastReport={REPORT}
        />,
      );
      expect(screen.getByTestId('frozen-removal-checkpoint-after-removal').textContent).toBe(
        'What the removal kept, a rewind to this checkpoint takes back.',
      );
      expect(screen.getByTestId('frozen-removal-checkpoint-action').textContent).toBe(
        'Rewind to before this load…',
      );
    });

    it('opens the preview of a rewind to it with its mute ticked when the load muted', () => {
      useAppStore.setState({ currentRoute: 'frozen', navigationIntent: null });
      render(
        <FrozenLoadRemoval
          records={{
            ...LOADED,
            removed: {
              removedAt: '2026-09-24T11:00:00.000Z',
              deleted: 1,
              alreadyGone: 0,
              kept: 2,
              refused: 0,
            },
          }}
          onAnswered={vi.fn()}
          lastReport={{
            ...REPORT,
            mutedAutomation: {
              state: 'muted',
              assigned: ['Data_Load'],
              held: [],
              permissions: ['Load_Data'],
              silenced: [],
              stillRan: [],
              released: true,
            },
          }}
        />,
      );
      fireEvent.click(screen.getByTestId('frozen-removal-checkpoint-action'));
      expect(useAppStore.getState().navigationIntent).toEqual(
        expect.objectContaining({
          previewCheckpointId: 'ck-20260924-100000-a1b2',
          previewMuted: true,
        }),
      );
    });

    it('holds nothing of a report of another load: the mapping keeps no checkpoint', () => {
      render(
        <FrozenLoadRemoval
          records={{
            ...LOADED,
            loadedAt: '2026-09-23T10:05:00.000Z',
            removed: {
              removedAt: '2026-09-24T11:00:00.000Z',
              deleted: 1,
              alreadyGone: 0,
              kept: 0,
              refused: 0,
            },
          }}
          onAnswered={vi.fn()}
          lastReport={REPORT}
        />,
      );
      expect(screen.queryByTestId('frozen-removal-checkpoint')).toBeNull();
    });

    it('marks the load a rewind to its own checkpoint took back', () => {
      render(<FrozenLoadRemoval records={LOADED} onAnswered={vi.fn()} lastReport={REPORT} />);
      const asked = mockPostMessage.mock.calls
        .map((call) => (call[0] as { payload: BaseMessage }).payload)
        .find((message) => message.type === 'checkpoint:rewinds');
      if (!asked) throw new Error('the rewinds were not read');
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: {
              id: 'resp-rewinds',
              type: 'checkpoint:rewinds:response',
              timestamp: Date.now(),
              correlationId: asked.id,
              payload: {
                rewinds: [
                  {
                    kind: 'rewind',
                    rewindId: 'rw-20260924-120000-aaaa',
                    checkpointId: 'ck-20260924-100000-a1b2',
                    checkpointName: 'Before Frozen load 2026-09-24 10:00 UTC',
                    organizationId: '00D000000000001AAA',
                    mode: 'picked',
                    objects: ['Account', 'Contact'],
                    readFrom: '2026-09-24T10:00:10.000Z',
                    takenAt: '2026-09-24T10:00:30.000Z',
                    startedAt: '2026-09-24T12:00:00.000Z',
                    endedAt: '2026-09-24T12:05:00.000Z',
                    status: 'success',
                    totals: { deleted: 3, restored: 0, undeleted: 0, recreated: 0 },
                    orgIds: ['org-dev'],
                  },
                ],
              },
            },
          }),
        );
      });
      expect(screen.getByTestId('frozen-removal-rewound').getAttribute('data-kind')).toBe(
        'rewound',
      );
    });
  });
});
