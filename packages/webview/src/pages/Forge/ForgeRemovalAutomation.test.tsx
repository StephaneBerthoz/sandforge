import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
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
});
