import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, within } from '@testing-library/react';
import type { BaseMessage, ForgeTargetAutomation, SalesforceOrg } from '@sandforge/shared';
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

import { ForgeRemovalAutomation } from './ForgeRemovalAutomation';
import { ForgeRunRemovalConfirm } from './ForgeRunRemovalView';
import { useOrgStore } from '../../stores/useOrgStore';

/** The sandbox the run wrote to, as the org store knows it. */
const DEV = { id: 'org-dev', alias: 'DEV-SANDBOX', username: 'dev@example.com' } as SalesforceOrg;

/** Every message of `type` the component sent through the bridge. */
function sentAll(type: string): Array<BaseMessage & { payload: Record<string, unknown> }> {
  return mockPostMessage.mock.calls
    .map(
      (call) =>
        (call[0] as { payload: BaseMessage & { payload: Record<string, unknown> } }).payload,
    )
    .filter((message) => message.type === type);
}

/** Answer the last read the component asked for, on `type`. */
function answer(type: string, payload: unknown): void {
  const request = sentAll('forge:undo-automation:request').pop();
  if (!request) throw new Error('no read was asked for');
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

/**
 * What the target runs on the run's objects: a flow on an order's update, a
 * trigger before an account goes, a flow after a contact goes unless its
 * writer holds a bypass no permission set holds.
 */
const AUTOMATION: ForgeTargetAutomation = {
  objectsRead: ['Order', 'Contact', 'Account'],
  objects: [
    {
      objectApiName: 'Order',
      flows: [
        {
          apiName: 'Order_Sync',
          label: 'Order sync',
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
          apiName: 'Contact_Gone',
          label: 'Contact gone',
          timing: 'beforeSave',
          startsOn: 'delete',
          condition: 'read',
          permissions: [{ name: 'Skip_Delete', bypass: true, held: false }],
        },
      ],
      triggers: [],
    },
    {
      objectApiName: 'Account',
      flows: [],
      triggers: [{ name: 'AccountCleanup', events: ['beforeDelete', 'afterDelete'] }],
    },
  ],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  bypassGrants: [{ permission: 'Skip_Delete', permissionSets: [] }],
  requests: 7,
};

describe('ForgeRunRemovalConfirm', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    useOrgStore.setState({ orgs: [DEV] });
  });

  const RUN = {
    forgeId: 'forge-1',
    targetOrgId: DEV.id,
    idRemapTable: { '001000000000001SRC': '001000000000001AAA' },
    idRemapExisting: [],
    idRemapCreated: [{ objectApiName: 'Account', sourceIds: ['001000000000001SRC'] }],
    idRemapWithTheirRecord: [],
    removalLeft: undefined,
    undo: undefined,
  };

  /** What the sweep's list reads: an asset made for the run, a task late, a note tied to nothing. */
  const LISTING = {
    looked: ['Account', 'Asset', 'Task', 'Note'],
    found: [
      {
        objectApiName: 'Asset',
        count: 1,
        names: [],
        classes: { made: 1, madeOver: 0, late: 0, untied: 0 },
      },
      {
        objectApiName: 'Task',
        count: 1,
        names: [],
        classes: { made: 0, madeOver: 0, late: 1, untied: 0 },
      },
    ],
    unread: [],
    handWork: [],
    late: [{ objectApiName: 'Task', count: 1 }],
    untied: { objects: [] },
  };

  const swept = (): unknown[] =>
    sentAll('forge:undo-automation:request').map((m) => m.payload['sweptObjects']);

  function answerSweep(): void {
    const request = sentAll('forge:undo-sweep:request').pop();
    if (!request) throw new Error('no read of the sweep was asked for');
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            id: 'resp-sweep',
            type: 'forge:undo-sweep:response',
            timestamp: Date.now(),
            correlationId: request.id,
            payload: { forgeId: 'forge-1', listing: LISTING },
          },
        }),
      );
    });
  }

  it('reads what fires on what the sweep’s list takes, as ticked, and on the run’s objects alone once it is unticked', () => {
    const shown = (sweep: boolean, sweepTicks: { sweepLate?: true } = {}) => (
      <ForgeRunRemovalConfirm
        run={RUN as never}
        org="DEV-SANDBOX"
        includeChanged={false}
        onIncludeChangedChange={() => undefined}
        sweep={sweep}
        onSweepChange={() => undefined}
        sweepTicks={sweepTicks}
        onSweepTicksChange={() => undefined}
        onClose={() => undefined}
        onConfirm={() => undefined}
      />
    );
    const { rerender } = render(shown(false));
    expect(swept()).toEqual([undefined]);

    rerender(shown(true));
    answerSweep();
    expect(swept()).toEqual([undefined, ['Asset']]);

    rerender(shown(true, { sweepLate: true }));
    expect(swept()).toEqual([undefined, ['Asset'], ['Asset', 'Task']]);

    rerender(shown(false));
    expect(swept()).toEqual([undefined, ['Asset'], ['Asset', 'Task'], undefined]);
  });
});

describe('ForgeRemovalAutomation', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
    useOrgStore.setState({ orgs: [DEV] });
  });

  it('asks the extension what the target runs on the run it is shown for, by the run alone', () => {
    render(<ForgeRemovalAutomation forgeId="forge-1" org="DEV-SANDBOX" targetOrgId={DEV.id} />);

    expect(sentAll('forge:undo-automation:request').map((m) => m.payload)).toEqual([
      { forgeId: 'forge-1' },
    ]);
    expect(screen.getByTestId('forge-removal-automation-loading').textContent).toBe(
      'Reading what DEV-SANDBOX runs as these records are deleted…',
    );
  });

  it('reads what a sweep deletes with the run’s objects, again as they change, the last read shown meanwhile', () => {
    const shown = (sweptObjects: readonly string[]) => (
      <ForgeRemovalAutomation
        forgeId="forge-1"
        org="DEV-SANDBOX"
        targetOrgId={DEV.id}
        sweptObjects={sweptObjects}
      />
    );
    const { rerender } = render(shown([]));
    answer('forge:undo-automation:response', {
      forgeId: 'forge-1',
      automation: AUTOMATION,
      drafted: ['Order'],
    });

    rerender(shown(['Asset', 'Task']));
    // A new list of the same objects reads nothing again.
    rerender(shown(['Asset', 'Task']));

    expect(sentAll('forge:undo-automation:request').map((m) => m.payload)).toEqual([
      { forgeId: 'forge-1' },
      { forgeId: 'forge-1', sweptObjects: ['Asset', 'Task'] },
    ]);
    expect(screen.queryByTestId('forge-removal-automation-loading')).toBeNull();
    expect(screen.getByTestId('forge-removal-automation-delete-Account')).toBeDefined();

    rerender(shown([]));
    expect(
      sentAll('forge:undo-automation:request')
        .map((m) => m.payload)
        .at(-1),
    ).toEqual({
      forgeId: 'forge-1',
    });
  });

  it('lists what fires on each delete, before or after, and as an order is set back to Draft', () => {
    render(<ForgeRemovalAutomation forgeId="forge-1" org="DEV-SANDBOX" targetOrgId={DEV.id} />);
    answer('forge:undo-automation:response', {
      forgeId: 'forge-1',
      automation: AUTOMATION,
      drafted: ['Order'],
    });

    expect(screen.getByTestId('forge-removal-automation-update-Order').textContent).toBe(
      'Order: Flow: Order sync · as the removal sets it back to Draft to delete it',
    );
    expect(screen.getByTestId('forge-removal-automation-delete-Contact').textContent).toBe(
      'Contact: Flow: Contact gone · before delete',
    );
    expect(screen.getByTestId('forge-removal-automation-delete-Account').textContent).toBe(
      'Account: Apex trigger: AccountCleanup · before and after delete',
    );
    // The bypass of the delete flow no permission set holds.
    expect(screen.getByTestId('forge-removal-automation-bypass').textContent).toContain(
      'No permission set of the target org holds Skip_Delete',
    );
  });

  it('says nothing fires when nothing does, and lists no update of an object it sets nothing back for', () => {
    render(<ForgeRemovalAutomation forgeId="forge-1" org="DEV-SANDBOX" targetOrgId={DEV.id} />);
    answer('forge:undo-automation:response', {
      forgeId: 'forge-1',
      automation: { ...AUTOMATION, objects: [AUTOMATION.objects[0]] },
      drafted: [],
    });

    expect(screen.getByTestId('forge-removal-automation-none').textContent).toBe(
      'Nothing DEV-SANDBOX automates runs as these records are deleted.',
    );
  });

  it('says what could not be read rather than that nothing fires', () => {
    render(<ForgeRemovalAutomation forgeId="forge-1" org="DEV-SANDBOX" targetOrgId={DEV.id} />);
    answer('forge:undo-automation:response', {
      forgeId: 'forge-1',
      automation: {
        ...AUTOMATION,
        objects: [],
        unread: [{ part: 'triggers', reason: 'INSUFFICIENT_ACCESS' }],
      },
      drafted: [],
    });

    expect(screen.queryByTestId('forge-removal-automation-none')).toBeNull();
    expect(screen.getByTestId('forge-removal-automation-unread-triggers').textContent).toBe(
      'The Apex triggers of the target org could not be read: INSUFFICIENT_ACCESS',
    );
  });

  it('says the read failed when it did', () => {
    render(<ForgeRemovalAutomation forgeId="forge-1" org="DEV-SANDBOX" targetOrgId={DEV.id} />);
    answer('forge:undo-automation:error', {
      message: 'INVALID_SESSION_ID',
      code: 'AUTOMATION_ERROR',
      retryable: false,
    });

    expect(screen.getByTestId('forge-removal-automation-error').textContent).toBe(
      'What DEV-SANDBOX runs as these records go could not be read: INVALID_SESSION_ID',
    );
  });

  it('reads nothing and shows nothing while no removal is being confirmed', () => {
    const { container } = render(
      <ForgeRemovalAutomation forgeId={undefined} org="DEV-SANDBOX" targetOrgId={DEV.id} />,
    );

    expect(sentAll('forge:undo-automation:request')).toEqual([]);
    expect(container.textContent).toBe('');
  });

  describe('reading the target again', () => {
    // The confirmation showed what it read as it opened: a bypass assigned
    // with the command it copied showed as not held until it was opened again.

    /** The delete flow's bypass, held by a permission set the command assigns. */
    const assignable = (held: boolean): ForgeTargetAutomation => ({
      ...AUTOMATION,
      objects: AUTOMATION.objects.map((object) =>
        object.objectApiName === 'Contact'
          ? {
              ...object,
              flows: object.flows.map((flow) => ({
                ...flow,
                permissions: [{ name: 'Skip_Delete', bypass: true, held }],
              })),
            }
          : object,
      ),
      bypassGrants: [
        {
          permission: 'Skip_Delete',
          permissionSets: [{ name: 'Bypass_Deletes', label: 'Bypass deletes', grants: 1 }],
        },
      ],
    });

    it('asks for it under the command, keeps the read shown meanwhile, and shows the bypass held once it lands', () => {
      render(<ForgeRemovalAutomation forgeId="forge-1" org="DEV-SANDBOX" targetOrgId={DEV.id} />);
      answer('forge:undo-automation:response', {
        forgeId: 'forge-1',
        automation: assignable(false),
        drafted: ['Order'],
      });
      const bypass = screen.getByTestId('forge-removal-automation-bypass');
      expect(within(bypass).getByTestId('bypass-assistant-command').textContent).toContain(
        '--name Bypass_Deletes --target-org DEV-SANDBOX',
      );

      fireEvent.click(within(bypass).getByTestId('bypass-assistant-read-again'));

      expect(sentAll('forge:undo-automation:request').map((m) => m.payload)).toEqual([
        { forgeId: 'forge-1' },
        { forgeId: 'forge-1' },
      ]);
      expect(screen.queryByTestId('forge-removal-automation-loading')).toBeNull();
      expect(screen.getByTestId('bypass-assistant-read-again').textContent).toBe('Reading again…');
      expect(screen.getByTestId('forge-removal-automation-delete-Contact')).toBeDefined();

      answer('forge:undo-automation:response', {
        forgeId: 'forge-1',
        automation: assignable(true),
        drafted: ['Order'],
      });

      // Held, the bypass keeps the delete flow quiet: neither it nor its command is listed.
      expect(screen.queryByTestId('forge-removal-automation-bypass')).toBeNull();
      expect(screen.queryByTestId('forge-removal-automation-delete-Contact')).toBeNull();
      expect(screen.getByTestId('forge-removal-automation-delete-Account')).toBeDefined();
    });

    it('offers it after a read that could not run', () => {
      render(<ForgeRemovalAutomation forgeId="forge-1" org="DEV-SANDBOX" targetOrgId={DEV.id} />);
      answer('forge:undo-automation:error', {
        message: 'INVALID_SESSION_ID',
        code: 'AUTOMATION_ERROR',
        retryable: false,
      });

      fireEvent.click(screen.getByTestId('forge-removal-automation-read-again'));
      expect(sentAll('forge:undo-automation:request')).toHaveLength(2);
      answer('forge:undo-automation:response', {
        forgeId: 'forge-1',
        automation: AUTOMATION,
        drafted: ['Order'],
      });

      expect(screen.queryByTestId('forge-removal-automation-error')).toBeNull();
      expect(screen.getByTestId('forge-removal-automation-delete-Account')).toBeDefined();
    });

    it('shows the read of another run as on its way, never the last run’s', () => {
      const { rerender } = render(
        <ForgeRemovalAutomation forgeId="forge-1" org="DEV-SANDBOX" targetOrgId={DEV.id} />,
      );
      answer('forge:undo-automation:response', {
        forgeId: 'forge-1',
        automation: AUTOMATION,
        drafted: [],
      });

      rerender(
        <ForgeRemovalAutomation forgeId={undefined} org="DEV-SANDBOX" targetOrgId={DEV.id} />,
      );
      rerender(<ForgeRemovalAutomation forgeId="forge-1" org="DEV-SANDBOX" targetOrgId={DEV.id} />);

      expect(screen.getByTestId('forge-removal-automation-loading')).toBeDefined();
      expect(screen.queryByTestId('forge-removal-automation-delete-Account')).toBeNull();
    });
  });
});
