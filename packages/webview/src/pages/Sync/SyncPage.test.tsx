import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, fireEvent, act } from '@testing-library/react';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { useConflictStore } from '../../stores/useConflictStore';
import { useSyncHistoryStore } from '../../stores/useSyncHistoryStore';
import { useNotificationStore } from '../../stores/useNotificationStore';
import { useGrappeStore } from '../../stores/useGrappeStore';
import { SyncPage } from './SyncPage';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg, SyncHistoryEntry, UIConflict } from '@sandforge/shared';

const mockOrgs: SalesforceOrg[] = [
  {
    id: 'org-1',
    alias: 'dev1',
    username: 'user@dev1.com',
    instanceUrl: 'https://dev1.salesforce.com',
    orgId: '00D000000000001',
    orgType: 'Sandbox',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#0070d2', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '59.0', edition: 'Developer Edition', features: [] },
    status: 'connected',
    lastConnected: '2024-01-01T00:00:00Z',
    tags: [],
  },
  {
    id: 'org-2',
    alias: 'dev2',
    username: 'user@dev2.com',
    instanceUrl: 'https://dev2.salesforce.com',
    orgId: '00D000000000002',
    orgType: 'Sandbox',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#0070d2', icon: 'cloud', position: 1 },
    metadata: { apiVersion: '59.0', edition: 'Developer Edition', features: [] },
    status: 'connected',
    lastConnected: '2024-01-01T00:00:00Z',
    tags: [],
  },
];

/** One history row, so the panel renders its export buttons. */
const historyEntry: SyncHistoryEntry = {
  id: 'h-1',
  configSnapshot: {
    id: 'cfg-1',
    name: 'Test Config',
    description: 'Test sync config',
    sourceOrgId: 'org-1',
    targetOrgId: 'org-2',
    direction: 'source_to_target',
    mode: 'full',
    conflictStrategy: 'source_wins',
    objects: [],
    enableRollback: false,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  },
  result: {
    configId: 'cfg-1',
    operationId: 'op-1',
    status: 'success',
    objectResults: [],
    totalProcessed: 1,
    totalSuccess: 1,
    totalFailed: 0,
    totalSkipped: 0,
    duration: 1000,
    timestamp: '2024-01-01T00:05:00Z',
  },
  startTime: '2024-01-01T00:00:00Z',
  endTime: '2024-01-01T00:05:00Z',
  triggeredBy: 'manual',
};

/** Deliver a message from the extension host to the page's window. */
function fromHost(data: Record<string, unknown>): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { timestamp: Date.now(), ...data } }));
  });
}

/* ------------------------------------------------------------------ */
/* Mock bridge hooks                                                   */
/* ------------------------------------------------------------------ */
const mockObjectsRefetch = vi.fn();
const mockFieldsMutate = vi.fn();
const mockFieldsReset = vi.fn();
const mockExecuteMutate = vi.fn();
const mockExecuteReset = vi.fn();
const mockSaveConfigMutate = vi.fn();

/** Mutable query state for sync:describe-global. */
let mockObjectsQueryState = {
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  refetch: mockObjectsRefetch,
};

/** Mutable mutation state for sync:describe-fields. */
let mockFieldsMutationState = {
  mutate: mockFieldsMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: mockFieldsReset,
};

/** Mutable mutation state for sync:execute. */
let mockExecuteMutationState = {
  mutate: mockExecuteMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: mockExecuteReset,
};

/** Mutable mutation state for sync:config:save. */
let mockSaveConfigMutationState = {
  mutate: mockSaveConfigMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: vi.fn(),
};

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => {
    if (type === 'sync:describe-global') {
      return mockObjectsQueryState;
    }
    return { data: null, loading: false, error: null, refetch: vi.fn() };
  },
}));

const mockVSCodeApi = {
  postMessage: vi.fn(),
  getState: () => undefined,
  setState: () => undefined,
};

vi.mock('../../hooks/useVSCodeApi', () => ({
  getVscodeApi: () => mockVSCodeApi,
  useVSCodeApi: () => mockVSCodeApi,
}));

vi.mock('../../components/ui/VirtualList', () => ({
  VirtualList: <T,>({
    items,
    renderItem,
    keyExtractor,
    emptyMessage,
  }: {
    items: T[];
    renderItem: (item: T, index: number) => React.ReactNode;
    keyExtractor: (item: T, index: number) => string;
    emptyMessage?: string;
  }) => {
    if (items.length === 0) {
      return <div data-testid="virtual-list">{emptyMessage ?? 'No items'}</div>;
    }
    return (
      <div data-testid="virtual-list" role="list">
        {items.map((item, index) => (
          <div key={keyExtractor(item, index)} role="listitem">
            {renderItem(item, index)}
          </div>
        ))}
      </div>
    );
  },
}));

/** The draft the page reopens on; a test that needs a wizard step sets it. */
const draft = vi.hoisted(() => ({ value: null as Record<string, unknown> | null }));

vi.mock('../../hooks/useWebviewPersistedState', () => ({
  useWebviewPersistedState: (_key: string, defaultValue: unknown) => [
    draft.value ?? defaultValue,
    vi.fn(),
  ],
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) => {
    if (type === 'sync:describe-fields') {
      return mockFieldsMutationState;
    }
    if (type === 'sync:execute') {
      return mockExecuteMutationState;
    }
    if (type === 'sync:config:save') {
      return mockSaveConfigMutationState;
    }
    return { mutate: vi.fn(), data: null, loading: false, error: null, reset: vi.fn() };
  },
}));

describe('SyncPage', () => {
  beforeEach(() => {
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
    useConflictStore.setState({
      conflicts: [],
      selectedConflictId: null,
      filterObject: null,
      filterType: null,
    });
    draft.value = null;
    mockObjectsRefetch.mockClear();
    mockFieldsMutate.mockClear();
    mockFieldsReset.mockClear();
    mockExecuteMutate.mockClear();
    mockExecuteReset.mockClear();
    // Reset to default idle state
    mockObjectsQueryState = {
      data: null,
      loading: false,
      error: null,
      refetch: mockObjectsRefetch,
    };
    mockFieldsMutationState = {
      mutate: mockFieldsMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockFieldsReset,
    };
    mockExecuteMutationState = {
      mutate: mockExecuteMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockExecuteReset,
    };
    mockSaveConfigMutate.mockClear();
    mockSaveConfigMutationState = {
      mutate: mockSaveConfigMutate,
      data: null,
      loading: false,
      error: null,
      reset: vi.fn(),
    };
  });

  it('should show empty state when less than 2 orgs', () => {
    useOrgStore.setState({ orgs: [mockOrgs[0]] });
    render(<SyncPage />);
    expect(screen.getByTestId('empty-state')).toBeDefined();
    expect(screen.getByTestId('illustration-sync')).toBeDefined();
    expect(screen.getByText('Keep two orgs in sync')).toBeDefined();
    expect(screen.getByTestId('empty-action-button').textContent).toBe('Connect an Org');
  });

  it('should prompt for a second org when exactly one org exists', () => {
    useOrgStore.setState({ orgs: [mockOrgs[0]] });
    render(<SyncPage />);
    expect(screen.getByTestId('empty-step-0').textContent).toContain(
      'Connect a second org via SFDX import',
    );
  });

  it('should prompt for two orgs when none exist', () => {
    useOrgStore.setState({ orgs: [] });
    render(<SyncPage />);
    expect(screen.getByTestId('empty-step-0').textContent).toContain(
      'Connect two orgs via SFDX import',
    );
  });

  it('should render sync page with wizard', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SyncPage />);
    expect(screen.getByTestId('sync-page')).toBeDefined();
    expect(screen.getByTestId('sync-wizard')).toBeDefined();
  });

  it('should show title', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SyncPage />);
    expect(screen.getByTestId('page-header')).toBeDefined();
    expect(screen.getByText('Sync Data')).toBeDefined();
  });

  it('should start on step 0 (Select Orgs)', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SyncPage />);
    expect(screen.getByTestId('sync-step-orgs')).toBeDefined();
  });

  it('offers each org under the type the org badges give it, a scratch org as one', () => {
    // Every org but a production one used to be offered as [SBX].
    const scratch: SalesforceOrg = {
      ...mockOrgs[1],
      id: 'org-3',
      alias: 'feature',
      orgType: 'Scratch',
    };
    useOrgStore.setState({ orgs: [...mockOrgs, scratch] });
    render(<SyncPage />);

    const step = screen.getByTestId('sync-step-orgs');
    const labels = Array.from(step.querySelectorAll('option')).map((o) => o.textContent);
    expect(labels).toEqual(expect.arrayContaining(['dev1 [SANDBOX]', 'feature [SCRATCH]']));
    expect(labels.some((label) => label?.includes('[SBX]'))).toBe(false);
  });

  it('should disable next when no orgs selected', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SyncPage />);
    expect(screen.getByTestId('sync-wizard-next')).toHaveProperty('disabled', true);
  });

  it('should show direction and conflict selectors', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SyncPage />);
    expect(screen.getByText('Direction')).toBeDefined();
    expect(screen.getByText('Conflict Strategy')).toBeDefined();
  });

  it('should not offer a Mode selector the extension cannot honour', () => {
    // SyncMode had zero occurrences in packages/extension/src: picking
    // "incremental", "delta" or "cdc" changed nothing and every run was a full
    // sync. The control is gone until the modes exist.
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SyncPage />);
    expect(screen.queryByText('Mode')).toBeNull();
  });

  it('should show 6 step indicators', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SyncPage />);
    expect(screen.getByTestId('sync-step-indicator').children.length).toBeGreaterThanOrEqual(6);
  });

  it('should show guided first step card on initial state with 2 orgs', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SyncPage />);
    expect(screen.getByTestId('guided-first-step-card')).toBeDefined();
    expect(screen.getByText('Get Started with Sync')).toBeDefined();
  });

  it('should display error from bridge hook', () => {
    mockObjectsQueryState = {
      data: null,
      loading: false,
      error: 'Sync failed',
      refetch: mockObjectsRefetch,
    };
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SyncPage />);

    expect(screen.getByTestId('sync-error')).toBeDefined();
    expect(screen.getByText('Sync failed')).toBeDefined();
  });

  it('offers only the tabs whose backend exists: no Real-Time, no Conflicts', () => {
    // Every realtime:* channel is answered by the no-op handler, and the
    // Conflicts tab lists what that stream would have pushed — so both tabs
    // could only ever show an error badge or an empty list.
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SyncPage />);

    const tabs = within(screen.getByTestId('sync-tabs'))
      .getAllByRole('tab')
      .map((tab) => tab.getAttribute('data-testid'));
    expect(tabs).toEqual(['tab-sync', 'tab-history', 'tab-schedules']);
    expect(screen.queryByTestId('tab-realtime')).toBeNull();
    expect(screen.queryByTestId('tab-conflicts')).toBeNull();
  });

  it('keeps the conflict count off the page while conflicts cannot be resolved', () => {
    const conflict: UIConflict = {
      id: 'Account:001:1',
      objectApiName: 'Account',
      recordId: '001',
      conflictType: 'edit/edit',
      sourceValues: { Name: 'Source' },
      targetValues: { Name: 'Target' },
      conflictFields: ['Name'],
      timestamp: '2026-03-27T00:00:00Z',
      resolved: false,
    };
    useConflictStore.setState({ conflicts: [conflict] });
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SyncPage />);

    expect(screen.queryByTestId('conflict-count-badge')).toBeNull();
  });

  it('announces a history export whose save is answered after the History tab is left', () => {
    // The export's content and the save dialog's answer both come back as host
    // messages. Subscribed from the History panel, they were lost as soon as
    // the user switched tab and the panel unmounted: the file was written and
    // nothing said so.
    useOrgStore.setState({ orgs: mockOrgs });
    useSyncHistoryStore.setState({ entries: [historyEntry], loading: false, pendingSaveId: null });
    useNotificationStore.setState({ notifications: [] });
    render(<SyncPage />);

    fireEvent.click(screen.getByTestId('tab-history'));
    fireEvent.click(screen.getByTestId('export-csv-btn'));
    fireEvent.click(screen.getByTestId('tab-sync'));
    expect(screen.queryByTestId('sync-history-panel')).toBeNull();
    mockVSCodeApi.postMessage.mockClear();

    fromHost({
      id: 'host-export',
      type: 'sync:history:export:response',
      payload: { data: 'id\n1', format: 'csv' },
    });

    const save = mockVSCodeApi.postMessage.mock.calls
      .map((call) => (call[0] as { payload: { id: string; type: string } }).payload)
      .find((message) => message.type === 'file:save');
    expect(save).toBeDefined();

    fromHost({
      id: 'host-save',
      type: 'file:save:response',
      correlationId: save?.id,
      payload: { status: 'saved', path: '/home/user/sync-history.csv' },
    });

    const [notification] = useNotificationStore.getState().notifications;
    expect(notification?.level).toBe('success');
    expect(notification?.message).toContain('/home/user/sync-history.csv');
  });

  it('keeps the length typed into a truncate rule', () => {
    // TransformBuilder's settings were wired to a no-op, so the boxes cleared
    // themselves on every keystroke and the rule went out with no length.
    draft.value = {
      currentStep: 2,
      direction: 'source_to_target',
      mode: 'full',
      conflictStrategy: 'source_wins',
      sourceOrgId: 'org-1',
      targetOrgId: 'org-2',
      objectEntries: [],
      mappings: [],
      transforms: [{ type: 'truncate', config: {} }],
    };
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SyncPage />);

    const length = within(screen.getByTestId('transform-0')).getByPlaceholderText(
      'length',
    ) as HTMLInputElement;
    fireEvent.change(length, { target: { value: '5' } });

    expect(length.value).toBe('5');
  });

  it('empties the truncate box as soon as its text stops being a whole number', () => {
    // The box reads back the length held in the rule, and only digits make a
    // length: a '.' keystroke drops the setting, and the box goes with it.
    draft.value = {
      currentStep: 2,
      direction: 'source_to_target',
      mode: 'full',
      conflictStrategy: 'source_wins',
      sourceOrgId: 'org-1',
      targetOrgId: 'org-2',
      objectEntries: [],
      mappings: [],
      transforms: [{ type: 'truncate', config: {} }],
    };
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SyncPage />);

    const length = within(screen.getByTestId('transform-0')).getByPlaceholderText(
      'length',
    ) as HTMLInputElement;
    fireEvent.change(length, { target: { value: '5' } });
    fireEvent.change(length, { target: { value: '5.' } });

    expect(length.value).toBe('');
  });

  it('offers only the conflict strategies the resolver acts on, never manual', () => {
    // 'manual' resolved to the source values and wrote them, exactly like
    // source wins: the option named a review the page never showed.
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SyncPage />);

    const strategy = screen.getByLabelText('Conflict Strategy') as HTMLSelectElement;
    expect(Array.from(strategy.options).map((o) => o.value)).toEqual([
      'source_wins',
      'target_wins',
      'newest_wins',
      'merge',
    ]);
  });

  it('saves the reviewed configuration under the two orgs it runs between', () => {
    // A schedule runs a *saved* configuration by id. With nothing able to save
    // one, the schedule builder had no configuration to offer and the
    // persistence routes answered nobody.
    draft.value = {
      currentStep: 3,
      direction: 'source_to_target',
      mode: 'full',
      conflictStrategy: 'newest_wins',
      sourceOrgId: 'org-1',
      targetOrgId: 'org-2',
      objectEntries: [
        {
          objectApiName: 'Account',
          operation: 'upsert',
          externalIdField: 'Id',
          batchSize: 200,
          where: '',
        },
      ],
      mappings: [],
      transforms: [],
    };
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SyncPage />);

    fireEvent.click(screen.getByTestId('sync-save-config'));

    expect(mockSaveConfigMutate).toHaveBeenCalledTimes(1);
    const config = (mockSaveConfigMutate.mock.calls[0][0] as { config: Record<string, unknown> })
      .config;
    expect(config.name).toBe('dev1 → dev2');
    expect(config.sourceOrgId).toBe('org-1');
    expect(config.targetOrgId).toBe('org-2');
    expect(config.conflictStrategy).toBe('newest_wins');
    expect((config.objects as Array<{ objectApiName: string }>)[0].objectApiName).toBe('Account');
  });

  it('offers no save while the configuration has no target org', () => {
    draft.value = {
      currentStep: 3,
      direction: 'source_to_target',
      mode: 'full',
      conflictStrategy: 'source_wins',
      sourceOrgId: 'org-1',
      targetOrgId: '',
      objectEntries: [],
      mappings: [],
      transforms: [],
    };
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SyncPage />);

    const save = screen.getByTestId('sync-save-config') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(mockSaveConfigMutate).not.toHaveBeenCalled();
  });

  it('says the configuration was saved once the host confirms it', () => {
    draft.value = {
      currentStep: 3,
      direction: 'source_to_target',
      mode: 'full',
      conflictStrategy: 'source_wins',
      sourceOrgId: 'org-1',
      targetOrgId: 'org-2',
      objectEntries: [],
      mappings: [],
      transforms: [],
    };
    useOrgStore.setState({ orgs: mockOrgs });
    const { rerender } = render(<SyncPage />);
    expect(screen.queryByTestId('sync-config-saved')).toBeNull();

    fireEvent.click(screen.getByTestId('sync-save-config'));
    const saved = (mockSaveConfigMutate.mock.calls[0][0] as { config: { id: string } }).config;
    mockSaveConfigMutationState.data = { success: true, id: saved.id };
    rerender(<SyncPage />);

    expect(screen.getByTestId('sync-config-saved').textContent).toContain('saved');
  });

  it('saves a changed configuration under a new id, and no longer says it is saved', () => {
    // A schedule runs whatever is stored under its configuration id. Saving a
    // different pair or strategy under the id already saved would silently
    // point that schedule at the new target.
    draft.value = {
      currentStep: 3,
      direction: 'source_to_target',
      mode: 'full',
      conflictStrategy: 'source_wins',
      sourceOrgId: 'org-1',
      targetOrgId: 'org-2',
      objectEntries: [
        {
          objectApiName: 'Account',
          operation: 'upsert',
          externalIdField: 'Id',
          batchSize: 200,
          where: '',
        },
      ],
      mappings: [],
      transforms: [],
    };
    useOrgStore.setState({ orgs: mockOrgs });
    const { rerender } = render(<SyncPage />);

    fireEvent.click(screen.getByTestId('sync-save-config'));
    const first = (mockSaveConfigMutate.mock.calls[0][0] as { config: { id: string } }).config;
    mockSaveConfigMutationState.data = { success: true, id: first.id };
    rerender(<SyncPage />);
    expect(screen.getByTestId('sync-config-saved')).toBeDefined();

    // Saving the same configuration again keeps its id.
    fireEvent.click(screen.getByTestId('sync-save-config'));
    const again = (mockSaveConfigMutate.mock.calls[1][0] as { config: { id: string } }).config;
    expect(again.id).toBe(first.id);

    // Back to the first step, another strategy, forward to the review again.
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByTestId('sync-wizard-back'));
    fireEvent.change(screen.getByLabelText('Conflict Strategy'), {
      target: { value: 'target_wins' },
    });
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByTestId('sync-wizard-next'));
    expect(screen.getByTestId('sync-save-config')).toBeDefined();
    expect(screen.queryByTestId('sync-config-saved')).toBeNull();

    fireEvent.click(screen.getByTestId('sync-save-config'));
    const changed = (
      mockSaveConfigMutate.mock.calls[2][0] as { config: { id: string; conflictStrategy: string } }
    ).config;
    expect(changed.conflictStrategy).toBe('target_wins');
    expect(changed.id).not.toBe(first.id);
  });

  it('offers the two directions a sync performs, never target to source', () => {
    // The orchestrator branches on `bidirectional` only; `target_to_source`
    // wrote source to target, the opposite of what the option said.
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SyncPage />);

    const direction = screen.getByLabelText('Direction') as HTMLSelectElement;
    expect(Array.from(direction.options).map((o) => o.value)).toEqual([
      'source_to_target',
      'bidirectional',
    ]);
  });
});

describe('SyncPage execute step for assistive technology', () => {
  beforeEach(() => {
    useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: null });
    draft.value = {
      currentStep: 4,
      direction: 'source_to_target',
      mode: 'full',
      conflictStrategy: 'source_wins',
      sourceOrgId: 'org-1',
      targetOrgId: 'org-2',
      objectEntries: [],
      mappings: [],
      transforms: [],
    };
  });

  describe('while a run is underway', () => {
    const idle = mockExecuteMutationState;

    beforeEach(() => {
      const running = { ...idle, loading: true, requestId: 'sync-run-1' };
      mockExecuteMutationState = running;
    });
    afterEach(() => {
      mockExecuteMutationState = idle;
      vi.useRealTimers();
    });

    /** The host reports the run's progress, keyed by the request that started it. */
    function progress(percentage: number): void {
      fromHost({
        type: 'operation:progress',
        id: `progress-${percentage}`,
        payload: {
          operationId: 'sync-run-1',
          percentage,
          processedRecords: percentage,
          totalRecords: 100,
          currentStep: '',
        },
      });
    }

    it('announces the run progress in a polite status region', () => {
      vi.useFakeTimers();
      render(<SyncPage />);
      const region = screen.getByTestId('sync-progress-status');
      expect(region.getAttribute('role')).toBe('status');
      expect(region.getAttribute('aria-live')).toBe('polite');
      expect(region.textContent).toBe('Sync progress: 0%');

      progress(40);
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(region.textContent).toBe('Sync progress: 40%');
    });

    it('says 100% as soon as the run reaches it, without waiting for the interval', () => {
      vi.useFakeTimers();
      render(<SyncPage />);
      const region = screen.getByTestId('sync-progress-status');
      progress(40);
      // Mid-run values wait for the interval.
      expect(region.textContent).toBe('Sync progress: 0%');

      progress(100);
      expect(region.textContent).toBe('Sync progress: 100%');
    });

    it('says where a run that stopped short ended, as soon as it stops', () => {
      vi.useFakeTimers();
      const { rerender } = render(<SyncPage />);
      const region = screen.getByTestId('sync-progress-status');
      progress(40);
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(region.textContent).toBe('Sync progress: 40%');

      // Mid-run values wait for the interval.
      progress(70);
      expect(region.textContent).toBe('Sync progress: 40%');

      // The run stops short of 100%: the last word follows at once, with no timer.
      mockExecuteMutationState = { ...mockExecuteMutationState, loading: false };
      rerender(<SyncPage />);
      // The wizard's step button shares the testid: the panel is the div.
      const panel = screen
        .getAllByTestId('sync-step-execute')
        .find((element) => element.tagName === 'DIV') as HTMLElement;
      const bar = within(panel).getByRole('progressbar');
      expect(region.textContent).toBe(`Sync progress: ${bar.getAttribute('aria-valuenow') ?? ''}%`);
      expect(region.textContent).not.toBe('Sync progress: 40%');
    });

    it('keeps a single progress announcement when the run is partitioned', () => {
      useGrappeStore.getState().start('op-1', 4, 6000);
      try {
        render(<SyncPage />);
        expect(screen.getByTestId('grappe-panel')).toBeDefined();
        expect(screen.queryByTestId('grappe-progress-status')).toBeNull();
        expect(screen.getByTestId('sync-progress-status')).toBeDefined();
      } finally {
        useGrappeStore.getState().reset();
      }
    });
  });
});
