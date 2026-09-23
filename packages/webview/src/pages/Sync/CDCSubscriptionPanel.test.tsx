import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { RealTimePublishingObject } from '@sandforge/shared';
import '../../i18n';
import { CDCSubscriptionPanel, defaultMatch } from './CDCSubscriptionPanel';
import { useCDCLiveStore } from '../../stores/useCDCLiveStore';

const mockPostMessage = vi.fn();

vi.mock('../../hooks/useVSCodeApi', () => ({
  getVscodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

function published(
  objectApiName: string,
  overrides: Partial<RealTimePublishingObject> = {},
): RealTimePublishingObject {
  return {
    objectApiName,
    channel: 'ChangeEvents',
    inTarget: true,
    externalIdFields: [],
    syncConfigs: [],
    ...overrides,
  };
}

const OBJECTS = [
  published('Lead', {
    channel: 'ActivityEngagementVirtualChannel',
    externalIdFields: ['Ext__c'],
    syncConfigs: [{ id: 'cfg-1', name: 'Leads nightly' }],
  }),
  published('Contact'),
  published('ListEmailSentResult', { inTarget: false }),
];

/** The application message of the last post, unwrapped from its envelope. */
function lastSent(): { type: string; payload: Record<string, unknown> } {
  const calls = mockPostMessage.mock.calls;
  return (
    calls[calls.length - 1][0] as { payload: { type: string; payload: Record<string, unknown> } }
  ).payload;
}

describe('CDCSubscriptionPanel', () => {
  beforeEach(() => {
    useCDCLiveStore.getState().reset();
    mockPostMessage.mockClear();
  });

  it('shows the session status on its badge', () => {
    const { rerender } = render(<CDCSubscriptionPanel objects={OBJECTS} />);
    expect(screen.getByTestId('cdc-status-badge').textContent).toContain('Disconnected');

    useCDCLiveStore.getState().setStatus('syncing');
    rerender(<CDCSubscriptionPanel objects={OBJECTS} />);
    expect(screen.getByTestId('cdc-status-badge').textContent).toContain('Syncing');

    useCDCLiveStore.getState().setStatus('error');
    rerender(<CDCSubscriptionPanel objects={OBJECTS} />);
    expect(screen.getByTestId('cdc-status-badge').textContent).toContain('Error');
  });

  it('lists only the objects the source publishes, with the channel it lists them on', () => {
    render(<CDCSubscriptionPanel objects={OBJECTS} />);

    expect(screen.getByTestId('cdc-object-checkbox-Lead')).toBeDefined();
    expect(screen.getByTestId('cdc-object-checkbox-Contact')).toBeDefined();
    expect(screen.queryByTestId('cdc-object-checkbox-Account')).toBeNull();
    expect(screen.getByTestId('cdc-object-picker').textContent).toContain(
      '(ActivityEngagementVirtualChannel)',
    );
    // How to get an object that is not listed.
    expect(screen.getByTestId('cdc-how-to-enable').textContent).toContain(
      'Setup → Change Data Capture',
    );
  });

  it('ticks an object into the watched set, labelled by its name', () => {
    render(<CDCSubscriptionPanel objects={OBJECTS} />);

    fireEvent.click(screen.getByRole('checkbox', { name: /Lead/ }));

    expect(useCDCLiveStore.getState().watchedObjects).toEqual(['Lead']);
  });

  it('writes an applied object through its first external id until another match is picked', () => {
    useCDCLiveStore.getState().setWatchedObjects(['Lead']);
    render(<CDCSubscriptionPanel objects={OBJECTS} />);

    fireEvent.click(screen.getByTestId('cdc-autosync-toggle-Lead'));

    expect(useCDCLiveStore.getState().autoSyncObjects['Lead']).toEqual({
      enabled: true,
      conflictStrategy: 'source_wins',
      match: { kind: 'externalId', field: 'Ext__c' },
      applyDeletes: false,
    });
    const match = screen.getByRole('combobox', {
      name: 'How Lead records are found in the target',
    });
    expect([...match.querySelectorAll('option')].map((o) => o.textContent)).toEqual([
      'External id Ext__c',
      'Mapping of saved sync “Leads nightly”',
      'Record Id (orgs copied from the same production)',
    ]);

    fireEvent.change(match, { target: { value: 'syncConfig:cfg-1' } });
    expect(useCDCLiveStore.getState().autoSyncObjects['Lead'].match).toEqual({
      kind: 'syncConfig',
      configId: 'cfg-1',
    });
  });

  it('leaves deletions alone until they are asked for', () => {
    useCDCLiveStore.getState().setWatchedObjects(['Lead']);
    render(<CDCSubscriptionPanel objects={OBJECTS} />);
    fireEvent.click(screen.getByTestId('cdc-autosync-toggle-Lead'));

    const deletes = screen.getByRole('checkbox', { name: 'Apply deletions' }) as HTMLInputElement;
    expect(deletes.checked).toBe(false);
    fireEvent.click(deletes);

    expect(useCDCLiveStore.getState().autoSyncObjects['Lead'].applyDeletes).toBe(true);
  });

  it('names each strategy select after its object', () => {
    useCDCLiveStore.getState().setWatchedObjects(['Lead']);
    render(<CDCSubscriptionPanel objects={OBJECTS} />);
    fireEvent.click(screen.getByTestId('cdc-autosync-toggle-Lead'));

    expect(
      screen.getByRole('combobox', {
        name: 'Lead: when the target record was edited after the change',
      }),
    ).toBeDefined();
  });

  it('cannot write an object the target org does not have', () => {
    useCDCLiveStore.getState().setWatchedObjects(['ListEmailSentResult']);
    render(<CDCSubscriptionPanel objects={OBJECTS} />);

    const toggle = screen.getByTestId(
      'cdc-autosync-toggle-ListEmailSentResult',
    ) as HTMLInputElement;
    expect(toggle.disabled).toBe(true);
    expect(screen.getByTestId('cdc-autosync-row-ListEmailSentResult').textContent).toContain(
      'not in the target org',
    );
  });

  it('starts a session carrying what is applied and how', () => {
    useCDCLiveStore.getState().setOrgs('org-src', 'org-tgt');
    useCDCLiveStore.getState().setWatchedObjects(['Lead', 'Contact']);
    render(<CDCSubscriptionPanel objects={OBJECTS} />);
    fireEvent.click(screen.getByTestId('cdc-autosync-toggle-Lead'));

    fireEvent.click(screen.getByTestId('cdc-start-btn'));

    const sent = lastSent();
    expect(sent.type).toBe('realtime:start');
    expect(sent.payload).toMatchObject({
      sourceOrgId: 'org-src',
      targetOrgId: 'org-tgt',
      watchedObjects: ['Lead', 'Contact'],
      apply: [
        {
          objectApiName: 'Lead',
          match: { kind: 'externalId', field: 'Ext__c' },
          applyDeletes: false,
        },
      ],
    });
  });

  it('stops the session it runs', () => {
    useCDCLiveStore.getState().setStatus('syncing');
    render(<CDCSubscriptionPanel objects={OBJECTS} />);

    fireEvent.click(screen.getByTestId('cdc-stop-btn'));

    expect(lastSent().type).toBe('realtime:stop');
  });

  it('freezes what a session watches and writes while it runs', () => {
    useCDCLiveStore.getState().setWatchedObjects(['Lead']);
    useCDCLiveStore.getState().toggleAutoSync('Lead', { kind: 'id' });
    useCDCLiveStore.getState().setStatus('connecting');
    render(<CDCSubscriptionPanel objects={OBJECTS} />);

    expect((screen.getByTestId('cdc-object-checkbox-Lead') as HTMLInputElement).disabled).toBe(
      true,
    );
    expect((screen.getByTestId('cdc-autosync-toggle-Lead') as HTMLInputElement).disabled).toBe(
      true,
    );
    expect((screen.getByTestId('cdc-match-select-Lead') as HTMLSelectElement).disabled).toBe(true);
  });
});

describe('defaultMatch', () => {
  it('matches on the first external id, and on the record Id when there is none', () => {
    expect(defaultMatch(published('Lead', { externalIdFields: ['A__c', 'B__c'] }))).toEqual({
      kind: 'externalId',
      field: 'A__c',
    });
    expect(defaultMatch(published('Contact'))).toEqual({ kind: 'id' });
  });
});
