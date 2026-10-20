import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, fireEvent, act } from '@testing-library/react';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
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

const mockSimulateMutate = vi.fn();
const mockLoadConfigMutate = vi.fn();

/** Mutable mutation state for sync:config:load. */
let mockLoadConfigMutationState = {
  mutate: mockLoadConfigMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: vi.fn(),
};

/** Mutable mutation state for sync:simulate. */
let mockSimulateMutationState = {
  mutate: mockSimulateMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: vi.fn(),
  requestId: null as string | null,
};

/** Mutable mutation state for sync:config:save. */
let mockSaveConfigMutationState = {
  mutate: mockSaveConfigMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: vi.fn(),
};

/** The saved configurations `sync:config:list` answers with. */
const savedConfigList = vi.hoisted(() => ({
  value: [] as Array<{ id: string; name: string; description: string; updatedAt: string }>,
}));

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => {
    if (type === 'sync:describe-global') {
      return mockObjectsQueryState;
    }
    if (type === 'sync:config:list') {
      return {
        data: { configs: savedConfigList.value },
        loading: false,
        error: null,
        refetch: vi.fn(),
      };
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
    if (type === 'sync:simulate') {
      return mockSimulateMutationState;
    }
    if (type === 'sync:config:load') {
      return mockLoadConfigMutationState;
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
    mockSimulateMutate.mockClear();
    mockSimulateMutationState = {
      mutate: mockSimulateMutate,
      data: null,
      loading: false,
      error: null,
      reset: vi.fn(),
      requestId: null,
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
      'Connect a second org (sign in with your browser)',
    );
  });

  it('should prompt for two orgs when none exist', () => {
    useOrgStore.setState({ orgs: [] });
    render(<SyncPage />);
    expect(screen.getByTestId('empty-step-0').textContent).toContain(
      'Connect two orgs, a source and a target (sign in with your browser)',
    );
    // Nothing to fill yet: no Seed link.
    expect(screen.queryByTestId('empty-tour-link')).toBeNull();
  });

  it('offers Seed on the one org there is, which Sync cannot copy from or to', () => {
    useOrgStore.setState({ orgs: [mockOrgs[0]], selectedOrgId: null });
    render(<SyncPage />);

    const link = screen.getByTestId('empty-tour-link');
    expect(link.textContent).toBe('Only one org? Generate realistic data with Seed');
    fireEvent.click(link);

    expect(useAppStore.getState().currentRoute).toBe('seed');
    expect(useAppStore.getState().navigationIntent).toMatchObject({
      seedMode: 'quick-seed',
      targetOrgId: mockOrgs[0].id,
    });
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
    expect(screen.getByTestId('sync-wizard-next').getAttribute('aria-disabled')).toBe('true');
  });

  it('should show direction and conflict selectors', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SyncPage />);
    expect(screen.getByText('Direction')).toBeDefined();
    expect(screen.getByText('Conflict Strategy')).toBeDefined();
  });

  it('offers full or delta, never the modes no run performs', () => {
    // "incremental" and "cdc" changed nothing and every run was a full sync:
    // the dropdown that offered them is gone, and delta is a switch with what
    // it needs said beside it.
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SyncPage />);
    expect(screen.queryByText('Mode')).toBeNull();
    expect(screen.queryByText('Incremental')).toBeNull();
    expect(screen.queryByText('CDC')).toBeNull();
    const toggle = screen.getByTestId('sync-delta-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.getByText(/starting five minutes earlier/)).toBeDefined();
  });

  it('maps fields in one editor, and says what an object with no mapping gets', () => {
    // Two editors edited the same list, and a single object's empty list read
    // "Unmapped" with nothing to say that its fields are copied all the same.
    draft.value = {
      currentStep: 1,
      direction: 'source_to_target',
      mode: 'full',
      conflictStrategy: 'source_wins',
      sourceOrgId: 'org-1',
      targetOrgId: 'org-2',
      objectEntries: [{ objectApiName: 'Account', operation: 'insert', batchSize: 200, where: '' }],
      mappingsByObject: {},
      transforms: [],
    };
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SyncPage />);

    expect(screen.getAllByTestId('field-mapping-canvas')).toHaveLength(1);
    expect(screen.queryByTestId('field-mapper')).toBeNull();
    expect(screen.getByTestId('field-mapping-none').textContent).toBe(
      'No custom mapping: fields with the same API name are copied.',
    );
  });

  it('marks Field Mapping and Transforms as steps that ask nothing to go on', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SyncPage />);

    expect(screen.getByTestId('sync-optional-field-mapping').textContent).toBe('Optional');
    expect(screen.getByTestId('sync-optional-transforms').textContent).toBe('Optional');
    expect(screen.queryByTestId('sync-optional-review')).toBeNull();
  });

  it('says what each toggle does in one sentence, the rest one click away', () => {
    // The hints ran to 770 characters at ten pixels, all of it read by a
    // screen reader on every focus.
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SyncPage />);
    for (const [toggleId, detailsId, short, detail] of [
      [
        'sync-delta-toggle',
        'sync-delta-details',
        "Reads only the records changed since this saved configuration's last good run.",
        /starting five minutes earlier/,
      ],
      [
        'sync-delta-deletes',
        'sync-delta-deletes-details',
        'Also deletes in the target the records deleted in the source since that run.',
        /recycle bin/,
      ],
      [
        'sync-contact-points-toggle',
        'sync-contact-points-details',
        "Writes every email under .invalid and every phone number as a fictional one, so the target's automation reaches no one.",
        /flows can email and text real people/,
      ],
      [
        'sync-files-toggle',
        'sync-files-details',
        'Also copies the Salesforce Files and attachments of the records it writes.',
        /never as a second file/,
      ],
    ] as const) {
      const described = screen.getByTestId(toggleId).getAttribute('aria-describedby') ?? '';
      const sentence = document.getElementById(described);
      expect({ toggleId, said: sentence?.textContent }).toEqual({ toggleId, said: short });
      expect(sentence?.className).toContain('text-xs');
      const details = screen.getByTestId(detailsId) as HTMLDetailsElement;
      expect(details.tagName).toBe('DETAILS');
      expect(details.open).toBe(false);
      expect(details.textContent).toMatch(detail);
      expect(sentence?.textContent).not.toMatch(detail);
    }
  });

  describe('delta', () => {
    const upsertEntry = {
      objectApiName: 'Account',
      operation: 'upsert',
      externalIdField: 'Ext_Id__c',
      batchSize: 200,
      where: '',
    };

    it('offers deletions only on a delta configuration, and turns them off with it', () => {
      draft.value = {
        currentStep: 0,
        direction: 'source_to_target',
        mode: 'full',
        conflictStrategy: 'source_wins',
        sourceOrgId: 'org-1',
        targetOrgId: 'org-2',
        objectEntries: [upsertEntry],
        mappingsByObject: {},
        transforms: [],
      };
      useOrgStore.setState({ orgs: mockOrgs });
      render(<SyncPage />);
      const deletes = screen.getByTestId('sync-delta-deletes') as HTMLInputElement;
      expect(deletes.disabled).toBe(true);

      fireEvent.click(screen.getByTestId('sync-delta-toggle'));
      expect(deletes.disabled).toBe(false);
      fireEvent.click(deletes);
      expect(deletes.checked).toBe(true);

      fireEvent.click(screen.getByTestId('sync-delta-toggle'));
      expect(deletes.checked).toBe(false);
      expect(deletes.disabled).toBe(true);
    });

    it('names the objects a delta run cannot write, and goes no further while one is listed', () => {
      draft.value = {
        currentStep: 0,
        direction: 'source_to_target',
        mode: 'delta',
        conflictStrategy: 'source_wins',
        sourceOrgId: 'org-1',
        targetOrgId: 'org-2',
        objectEntries: [
          upsertEntry,
          { ...upsertEntry, objectApiName: 'Contact', operation: 'insert' },
        ],
        mappingsByObject: {},
        transforms: [],
      };
      useOrgStore.setState({ orgs: mockOrgs });
      render(<SyncPage />);

      expect(screen.getByTestId('sync-delta-blockers').textContent).toContain('Contact');
      expect(screen.getByTestId('sync-delta-blockers').textContent).not.toContain('Account');
      expect(screen.getByTestId('sync-wizard-next').getAttribute('aria-disabled')).toBe('true');
    });

    it('saves a delta configuration with its deletions, and runs it under the id it was saved under', () => {
      draft.value = {
        currentStep: 3,
        direction: 'source_to_target',
        mode: 'delta',
        propagateDeletes: true,
        conflictStrategy: 'source_wins',
        sourceOrgId: 'org-1',
        targetOrgId: 'org-2',
        objectEntries: [upsertEntry],
        mappingsByObject: {},
        transforms: [],
      };
      useOrgStore.setState({ orgs: mockOrgs });
      const { rerender } = render(<SyncPage />);
      expect(screen.getByTestId('sync-review-delta').textContent).toBe('Delta, deletions carried');

      fireEvent.click(screen.getByTestId('sync-save-config'));
      const saved = (
        mockSaveConfigMutate.mock.calls[0][0] as {
          config: { id: string; mode: string; propagateDeletes?: boolean };
        }
      ).config;
      expect(saved).toMatchObject({ mode: 'delta', propagateDeletes: true });
      mockSaveConfigMutationState.data = { success: true, id: saved.id };
      rerender(<SyncPage />);

      fireEvent.click(screen.getByTestId('sync-wizard-next'));
      fireEvent.click(screen.getByTestId('sync-run'));

      // Its watermarks are kept under that id: a fresh one reads all again.
      const ran = (mockExecuteMutate.mock.calls[0][0] as { config: { id: string } }).config;
      expect(ran.id).toBe(saved.id);
    });

    it('runs a configuration that is not the one saved under a fresh id', () => {
      draft.value = {
        currentStep: 4,
        direction: 'source_to_target',
        mode: 'delta',
        conflictStrategy: 'source_wins',
        sourceOrgId: 'org-1',
        targetOrgId: 'org-2',
        objectEntries: [upsertEntry],
        mappingsByObject: {},
        transforms: [],
      };
      mockSaveConfigMutationState.data = { success: true, id: 'cfg-saved-elsewhere' };
      useOrgStore.setState({ orgs: mockOrgs });
      render(<SyncPage />);

      fireEvent.click(screen.getByTestId('sync-run'));

      const ran = (
        mockExecuteMutate.mock.calls[0][0] as { config: { id: string; propagateDeletes?: boolean } }
      ).config;
      expect(ran.id).not.toBe('cfg-saved-elsewhere');
      expect(ran.propagateDeletes).toBeUndefined();
    });

    it('says on the results how many files a run copied, and what the caps skipped', () => {
      draft.value = {
        currentStep: 5,
        direction: 'source_to_target',
        mode: 'full',
        conflictStrategy: 'source_wins',
        sourceOrgId: 'org-1',
        targetOrgId: 'org-2',
        objectEntries: [upsertEntry],
        mappingsByObject: {},
        transforms: [],
        files: { maxFileSizeMB: 10, maxRunMB: 100 },
      };
      const files = {
        copied: 2,
        versions: 1,
        bytes: 3 * 1_048_576,
        links: 1,
        unchanged: 0,
        tooLarge: 1,
        pastRunCap: 0,
        external: 0,
        recordNotWritten: 0,
        failed: 0,
      };
      mockExecuteMutationState.data = {
        configId: 'cfg',
        operationId: 'op',
        status: 'success',
        objectResults: [
          {
            objectApiName: 'Account',
            operation: 'upsert',
            processed: 3,
            success: 3,
            failed: 0,
            skipped: 0,
            conflictCount: 0,
            errors: [],
            files,
          },
        ],
        totalProcessed: 3,
        totalSuccess: 3,
        totalFailed: 0,
        totalSkipped: 0,
        duration: 1,
        timestamp: '2026-10-13T10:00:01.000Z',
      };
      useOrgStore.setState({ orgs: mockOrgs });
      render(<SyncPage />);

      expect(screen.getByTestId('sync-result-files').textContent).toBe(
        '3 files, 3 MB copied, 1 skipped past the caps',
      );
      expect(screen.getByTestId('sync-result-files-Account').textContent).toContain(
        '1 skipped: larger than the largest file',
      );
    });

    it('says how many files and how much a run would copy', () => {
      draft.value = {
        currentStep: 3,
        direction: 'source_to_target',
        mode: 'full',
        conflictStrategy: 'source_wins',
        sourceOrgId: 'org-1',
        targetOrgId: 'org-2',
        objectEntries: [upsertEntry],
        mappingsByObject: {},
        transforms: [],
        files: { maxFileSizeMB: 10, maxRunMB: 100 },
      };
      useOrgStore.setState({ orgs: mockOrgs });
      const { rerender } = render(<SyncPage />);
      // Files are simulated for a saved configuration only.
      fireEvent.click(screen.getByTestId('sync-save-config'));
      const saved = (mockSaveConfigMutate.mock.calls[0][0] as { config: { id: string } }).config;
      mockSaveConfigMutationState.data = { success: true, id: saved.id };
      rerender(<SyncPage />);
      fireEvent.click(screen.getByTestId('sync-wizard-next'));
      fireEvent.click(screen.getByTestId('sync-simulate'));
      mockSimulateMutationState.data = {
        configId: 'cfg',
        operationId: 'sim',
        direction: 'source_to_target',
        conflictStrategy: 'source_wins',
        objects: [
          {
            objectApiName: 'Account',
            operation: 'upsert',
            read: 3,
            insert: 3,
            update: 0,
            delete: 0,
            skipped: 0,
            refused: 0,
            conflicts: 0,
            conflictFields: [],
            notes: [],
            files: {
              copied: 3,
              versions: 0,
              bytes: 52,
              links: 0,
              unchanged: 0,
              tooLarge: 0,
              pastRunCap: 0,
              external: 0,
              recordNotWritten: 0,
              failed: 0,
            },
          },
        ],
        files: { remainingBytes: 20 * 1_048_576, plannedBytes: 52 },
        duration: 1,
        timestamp: '2026-10-13T10:00:01.000Z',
      };
      rerender(<SyncPage />);

      expect(screen.getByTestId('sync-simulation-files-Account').textContent).toBe(
        '3 files would be copied · 52 B',
      );
      expect(screen.getByTestId('sync-simulation-files-storage').textContent).toBe(
        'These files take 52 B of the 20 MB of file storage the target has left.',
      );
    });

    it('says the configuration must be saved before a run copies its files', () => {
      draft.value = {
        currentStep: 4,
        direction: 'source_to_target',
        mode: 'full',
        conflictStrategy: 'source_wins',
        sourceOrgId: 'org-1',
        targetOrgId: 'org-2',
        objectEntries: [upsertEntry],
        mappingsByObject: {},
        transforms: [],
        files: { maxFileSizeMB: 10, maxRunMB: 100 },
      };
      useOrgStore.setState({ orgs: mockOrgs });
      render(<SyncPage />);

      expect(screen.getByTestId('sync-files-needs-save').textContent).toContain(
        'This configuration copies files: save it first.',
      );
    });

    it('saves the configuration from beside Run, which then runs it as saved', () => {
      draft.value = {
        currentStep: 4,
        direction: 'source_to_target',
        mode: 'full',
        conflictStrategy: 'source_wins',
        sourceOrgId: 'org-1',
        targetOrgId: 'org-2',
        objectEntries: [upsertEntry],
        mappingsByObject: {},
        transforms: [],
        files: { maxFileSizeMB: 10, maxRunMB: 100 },
      };
      useOrgStore.setState({ orgs: mockOrgs });
      const { rerender } = render(<SyncPage />);

      // The reason sent the user back to the Review step to save.
      const why = screen.getByTestId('sync-files-needs-save');
      const save = screen.getByTestId('sync-files-save');
      expect(save.getAttribute('aria-describedby')).toBe(why.id);
      expect((screen.getByTestId('sync-run') as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(save);
      expect(mockSaveConfigMutate).toHaveBeenCalledTimes(1);
      const saved = (mockSaveConfigMutate.mock.calls[0][0] as { config: { id: string } }).config;
      mockSaveConfigMutationState.data = { success: true, id: saved.id };
      rerender(<SyncPage />);

      expect(screen.queryByTestId('sync-files-needs-save')).toBeNull();
      expect(screen.queryByTestId('sync-files-save')).toBeNull();
      const run = screen.getByTestId('sync-run') as HTMLButtonElement;
      expect(run.disabled).toBe(false);
      fireEvent.click(run);
      expect((mockExecuteMutate.mock.calls[0][0] as { config: { id: string } }).config.id).toBe(
        saved.id,
      );
    });

    it('keeps Run and Simulate from a configuration copying files until it is saved, and says why beside them', () => {
      draft.value = {
        currentStep: 3,
        direction: 'source_to_target',
        mode: 'full',
        conflictStrategy: 'source_wins',
        sourceOrgId: 'org-1',
        targetOrgId: 'org-2',
        objectEntries: [upsertEntry],
        mappingsByObject: {},
        transforms: [],
        files: { maxFileSizeMB: 10, maxRunMB: 100 },
      };
      useOrgStore.setState({ orgs: mockOrgs });
      const { rerender } = render(<SyncPage />);
      fireEvent.click(screen.getByTestId('sync-wizard-next'));

      // The extension refuses both for a configuration that is not saved: the
      // page let Run through, to be refused once the execute step had started.
      const run = screen.getByTestId('sync-run') as HTMLButtonElement;
      const simulate = screen.getByTestId('sync-simulate') as HTMLButtonElement;
      const why = screen.getByTestId('sync-files-needs-save');
      expect(run.disabled).toBe(true);
      expect(simulate.disabled).toBe(true);
      expect(run.getAttribute('aria-describedby')).toBe(why.id);
      expect(simulate.getAttribute('aria-describedby')).toBe(why.id);
      fireEvent.click(run);
      fireEvent.click(simulate);
      expect(mockExecuteMutate).not.toHaveBeenCalled();
      expect(mockSimulateMutate).not.toHaveBeenCalled();

      // Saved on the Review step, it runs.
      fireEvent.click(screen.getByTestId('sync-wizard-back'));
      fireEvent.click(screen.getByTestId('sync-save-config'));
      const saved = (mockSaveConfigMutate.mock.calls[0][0] as { config: { id: string } }).config;
      mockSaveConfigMutationState.data = { success: true, id: saved.id };
      rerender(<SyncPage />);
      fireEvent.click(screen.getByTestId('sync-wizard-next'));

      expect(screen.queryByTestId('sync-files-needs-save')).toBeNull();
      const enabled = screen.getByTestId('sync-run') as HTMLButtonElement;
      expect(enabled.disabled).toBe(false);
      expect(enabled.hasAttribute('aria-describedby')).toBe(false);
      fireEvent.click(enabled);
      expect(mockExecuteMutate).toHaveBeenCalledTimes(1);
      expect((mockExecuteMutate.mock.calls[0][0] as { config: { id: string } }).config.id).toBe(
        saved.id,
      );
    });

    it('neutralizes emails and phone numbers by default, and sends the choice to keep them only once unticked', () => {
      const atConfigure = {
        currentStep: 0,
        direction: 'source_to_target',
        mode: 'full',
        conflictStrategy: 'source_wins',
        sourceOrgId: 'org-1',
        targetOrgId: 'org-2',
        objectEntries: [upsertEntry],
        mappingsByObject: {},
        transforms: [],
      };
      draft.value = atConfigure;
      useOrgStore.setState({ orgs: mockOrgs });
      const { unmount } = render(<SyncPage />);
      const toggle = screen.getByTestId('sync-contact-points-toggle') as HTMLInputElement;
      expect(toggle.checked).toBe(true);
      fireEvent.click(toggle);
      expect(toggle.checked).toBe(false);
      unmount();

      // A run: nothing in its configuration asks to keep them.
      draft.value = { ...atConfigure, currentStep: 4 };
      const run = render(<SyncPage />);
      fireEvent.click(screen.getByTestId('sync-run'));
      const neutralizing = (
        mockExecuteMutate.mock.calls[0][0] as { config: { keepContactPoints?: boolean } }
      ).config;
      expect(neutralizing.keepContactPoints).toBeUndefined();
      run.unmount();

      // Unticked, as a draft keeps it: the run is asked to keep them.
      draft.value = { ...atConfigure, currentStep: 4, keepContactPoints: true };
      render(<SyncPage />);
      fireEvent.click(screen.getByTestId('sync-run'));
      const keeping = (
        mockExecuteMutate.mock.calls[1][0] as { config: { keepContactPoints?: boolean } }
      ).config;
      expect(keeping.keepContactPoints).toBe(true);
    });

    it('offers the files off by default, and their two caps once turned on', () => {
      draft.value = {
        currentStep: 0,
        direction: 'source_to_target',
        mode: 'full',
        conflictStrategy: 'source_wins',
        sourceOrgId: 'org-1',
        targetOrgId: 'org-2',
        objectEntries: [upsertEntry],
        mappingsByObject: {},
        transforms: [],
      };
      useOrgStore.setState({ orgs: mockOrgs });
      render(<SyncPage />);
      const toggle = screen.getByTestId('sync-files-toggle') as HTMLInputElement;
      expect(toggle.checked).toBe(false);
      expect(screen.queryByTestId('sync-files-max-file')).toBeNull();

      fireEvent.click(toggle);

      expect((screen.getByTestId('sync-files-max-file') as HTMLInputElement).value).toBe('10');
      expect((screen.getByTestId('sync-files-max-run') as HTMLInputElement).value).toBe('100');
      expect(screen.getByText(/never as a second file/)).toBeDefined();
    });

    it('says on the results how each object was read and what it deleted', () => {
      draft.value = {
        currentStep: 5,
        direction: 'source_to_target',
        mode: 'delta',
        conflictStrategy: 'source_wins',
        sourceOrgId: 'org-1',
        targetOrgId: 'org-2',
        objectEntries: [upsertEntry],
        mappingsByObject: {},
        transforms: [],
      };
      mockExecuteMutationState.data = {
        configId: 'cfg',
        operationId: 'op',
        status: 'success',
        objectResults: [
          {
            objectApiName: 'Account',
            operation: 'upsert',
            processed: 3,
            success: 3,
            failed: 0,
            skipped: 0,
            conflictCount: 0,
            errors: [],
            delta: {
              read: 'delta',
              since: '2026-10-13T09:00:00.000Z',
              changed: 3,
              deletionsChecked: true,
              deleted: 1,
              deleteFailed: 0,
              recorded: '2026-10-13T10:00:00.000Z',
            },
          },
        ],
        totalProcessed: 3,
        totalSuccess: 3,
        totalFailed: 0,
        totalSkipped: 0,
        duration: 1,
        timestamp: '2026-10-13T10:00:01.000Z',
      };
      useOrgStore.setState({ orgs: mockOrgs });
      render(<SyncPage />);

      const line = screen.getByTestId('sync-result-delta-Account').textContent ?? '';
      expect(line).toMatch(/^Delta since 2026-10-13 \d\d:00:00 · 3 changed · 1 deleted/);
      expect(line).toContain('The next run reads the changes since');
    });
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

  it('offers the Real-Time tab and the Conflicts tab its sessions feed', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SyncPage />);

    const tabs = within(screen.getByTestId('sync-tabs'))
      .getAllByRole('tab')
      .map((tab) => tab.getAttribute('data-testid'));
    expect(tabs).toEqual([
      'tab-sync',
      'tab-history',
      'tab-schedules',
      'tab-realtime',
      'tab-conflicts',
    ]);

    fireEvent.click(screen.getByTestId('tab-realtime'));
    expect(screen.getByTestId('realtime-sync-panel')).toBeDefined();
  });

  it('counts the changes held for a decision on the Conflicts tab', () => {
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

    expect(
      within(screen.getByTestId('tab-conflicts')).getByTestId('conflict-count-badge').textContent,
    ).toBe('1');
    fireEvent.click(screen.getByTestId('tab-conflicts'));
    expect(screen.getByTestId('conflict-list-panel')).toBeDefined();
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

  describe('once a run a cancel stopped answers', () => {
    const idle = mockExecuteMutationState;
    afterEach(() => {
      mockExecuteMutationState = idle;
    });

    it('calls it cancelled on the results step, not partial', () => {
      mockExecuteMutationState = {
        ...idle,
        data: {
          ...historyEntry.result,
          status: 'partial',
          cancelled: true,
          error: 'Cancelled before Contact was synced.',
        },
      };
      render(<SyncPage />);

      const summary = screen.getByTestId('sync-result-summary');
      expect(summary.textContent).toContain('Cancelled');
      expect(summary.textContent).not.toContain('Partially Complete');
    });
  });
});

describe('SyncPage simulation, pause and cancel', () => {
  const idleExecute = mockExecuteMutationState;
  const idleSimulate = mockSimulateMutationState;

  /** A draft on the execute step, two orgs and one object picked. */
  const onExecuteStep = (): Record<string, unknown> => ({
    currentStep: 4,
    direction: 'source_to_target',
    mode: 'full',
    conflictStrategy: 'source_wins',
    sourceOrgId: 'org-1',
    targetOrgId: 'org-2',
    objectEntries: [
      { objectApiName: 'Account', operation: 'insert', externalIdField: '', batchSize: 200 },
    ],
    mappingsByObject: {},
    transforms: [],
  });

  beforeEach(() => {
    useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: null });
    draft.value = onExecuteStep();
    mockExecuteMutate.mockClear();
    mockSimulateMutate.mockClear();
  });
  afterEach(() => {
    mockExecuteMutationState = idleExecute;
    mockSimulateMutationState = idleSimulate;
  });

  it('offers to simulate before running, and a simulation is not a run', () => {
    render(<SyncPage />);

    fireEvent.click(screen.getByTestId('sync-simulate'));

    expect(mockSimulateMutate).toHaveBeenCalledTimes(1);
    expect(mockExecuteMutate).not.toHaveBeenCalled();
    // Nothing to show on the results step until one of them answers.
    expect(screen.getByTestId('sync-wizard-next').getAttribute('aria-disabled')).toBe('true');
  });

  it('starts the run from the step that shows its progress', () => {
    render(<SyncPage />);

    fireEvent.click(screen.getByTestId('sync-run'));

    expect(mockExecuteMutate).toHaveBeenCalledTimes(1);
    expect(mockSimulateMutate).not.toHaveBeenCalled();
  });

  it('offers pause and cancel on the page while the run writes', () => {
    mockExecuteMutationState = { ...idleExecute, loading: true, requestId: 'sync-run-1' } as never;

    render(<SyncPage />);

    expect(screen.getByTestId('sync-run-controls')).toBeDefined();
    expect(screen.getByTestId('sync-pause')).toBeDefined();
    expect(screen.getByTestId('sync-cancel').textContent).toBe('Cancel run');
    // No second run while this one goes.
    expect(screen.queryByTestId('sync-run')).toBeNull();
    expect(screen.queryByTestId('sync-simulate')).toBeNull();
  });

  it('offers only a cancel while a simulation reads', () => {
    mockSimulateMutationState = { ...idleSimulate, loading: true, requestId: 'sync-sim-1' };

    render(<SyncPage />);

    expect(screen.queryByTestId('sync-pause')).toBeNull();
    expect(screen.getByTestId('sync-cancel').textContent).toBe('Cancel simulation');
    expect(screen.getByText('Simulating...')).toBeDefined();
  });

  it('shows the results step in its simulation state once a simulation answers', () => {
    const { rerender } = render(<SyncPage />);
    fireEvent.click(screen.getByTestId('sync-simulate'));
    mockSimulateMutationState = {
      ...idleSimulate,
      data: {
        configId: 'c',
        operationId: 'sync-sim-1',
        direction: 'source_to_target',
        conflictStrategy: 'source_wins',
        objects: [
          {
            objectApiName: 'Account',
            operation: 'insert',
            read: 2,
            insert: 2,
            update: 0,
            delete: 0,
            skipped: 0,
            refused: 0,
            conflicts: 0,
            conflictFields: [],
            notes: [],
          },
        ],
        duration: 3,
        timestamp: '2026-10-06T00:00:00.000Z',
      },
    };
    rerender(<SyncPage />);

    expect(screen.getByTestId('sync-simulation-results')).toBeDefined();
    expect(screen.queryByTestId('sync-result-summary')).toBeNull();

    fireEvent.click(screen.getByTestId('sync-run-after-simulation'));
    expect(mockExecuteMutate).toHaveBeenCalledTimes(1);
  });

  it('says a draft that asked for manual review now keeps the target values', () => {
    draft.value = { ...onExecuteStep(), currentStep: 0, conflictStrategy: 'manual' };

    render(<SyncPage />);

    const notice = screen.getByTestId('sync-strategy-notice');
    expect(notice.getAttribute('role')).toBe('status');
    expect(notice.textContent).toContain('It now uses Target Wins');
    expect((screen.getByLabelText('Conflict Strategy') as HTMLSelectElement).value).toBe(
      'target_wins',
    );

    fireEvent.click(screen.getByTestId('sync-strategy-notice-dismiss'));
    expect(screen.queryByTestId('sync-strategy-notice')).toBeNull();
  });
});

describe('SyncPage Run now on a saved configuration', () => {
  const idleExecute = mockExecuteMutationState;

  /** A configuration as `sync:config:load` reads it back from the store. */
  const savedConfig = {
    id: 'cfg-saved',
    name: 'Nightly accounts',
    description: 'Saved from Migration',
    sourceOrgId: 'org-1',
    targetOrgId: 'org-2',
    direction: 'source_to_target',
    mode: 'full',
    conflictStrategy: 'source_wins',
    objects: [
      {
        objectApiName: 'Account',
        operation: 'insert',
        externalIdField: '',
        batchSize: 200,
        fieldMappings: [],
        // A transform of this object alone, which the wizard cannot show.
        transformRules: [{ type: 'prefix', config: { prefix: 'QA-' } }],
        excludedFields: [],
        addOnFields: [],
        insertOrder: 0,
      },
    ],
    enableRollback: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  };

  beforeEach(() => {
    useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: null });
    draft.value = null;
    savedConfigList.value = [
      {
        id: 'cfg-saved',
        name: 'Nightly accounts',
        description: 'Saved from Migration',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
    ];
    mockExecuteMutate.mockClear();
    mockSimulateMutate.mockClear();
    mockLoadConfigMutate.mockClear();
    mockLoadConfigMutationState = {
      mutate: mockLoadConfigMutate,
      data: null,
      loading: false,
      error: null,
      reset: vi.fn(),
    };
  });
  afterEach(() => {
    mockExecuteMutationState = idleExecute;
    savedConfigList.value = [];
  });

  /** Open the Schedules tab and click Run now on the saved configuration. */
  function runSaved(): ReturnType<typeof render> {
    const view = render(<SyncPage />);
    fireEvent.click(screen.getByTestId('tab-schedules'));
    fireEvent.click(screen.getByTestId('run-saved-config-cfg-saved'));
    return view;
  }

  it('reads it back and sends it to the run as saved, on the request the wizard runs with', () => {
    const { rerender } = runSaved();

    expect(mockLoadConfigMutate).toHaveBeenCalledWith({ id: 'cfg-saved' });
    // Shown where a run of the wizard is: the execute step of the Sync tab.
    expect(screen.getByTestId('tab-sync').getAttribute('aria-selected')).toBe('true');
    // The wizard's step button shares the testid: the panel is the div.
    expect(
      screen.getAllByTestId('sync-step-execute').some((element) => element.tagName === 'DIV'),
    ).toBe(true);
    expect(mockExecuteMutate).not.toHaveBeenCalled();

    mockLoadConfigMutationState = { ...mockLoadConfigMutationState, data: { config: savedConfig } };
    rerender(<SyncPage />);

    // Exactly what was saved, on sync:execute: the host checks it and asks
    // Production Guard as it does for the wizard's own run. No simulation
    // comes first, as none does before the wizard's Run.
    expect(mockExecuteMutate).toHaveBeenCalledTimes(1);
    expect(mockExecuteMutate).toHaveBeenCalledWith({ config: savedConfig });
    expect(mockSimulateMutate).not.toHaveBeenCalled();

    // Sent once per answer, however often the page renders.
    rerender(<SyncPage />);
    expect(mockExecuteMutate).toHaveBeenCalledTimes(1);
  });

  it('says which saved configuration the run on the execute step is', () => {
    const { rerender } = runSaved();
    mockLoadConfigMutationState = { ...mockLoadConfigMutationState, data: { config: savedConfig } };
    mockExecuteMutationState = { ...idleExecute, loading: true, requestId: 'sync-run-1' } as never;
    rerender(<SyncPage />);

    expect(screen.getByTestId('sync-saved-run').textContent).toMatch(
      /^Saved configuration: Nightly accounts · /,
    );
    // Its Pause and Cancel are the page's, as for the wizard's own run.
    expect(screen.getByTestId('sync-cancel')).toBeDefined();
  });

  it("offers no Run of the wizard's while the saved configuration is read back", () => {
    const { rerender } = runSaved();
    mockLoadConfigMutationState = { ...mockLoadConfigMutationState, loading: true };
    rerender(<SyncPage />);

    expect(screen.queryByTestId('sync-run')).toBeNull();
    expect(screen.queryByTestId('sync-simulate')).toBeNull();
    expect(screen.getByTestId('sync-saved-run').textContent).toMatch(
      /^Saved configuration: Nightly accounts · /,
    );
  });

  it('runs nothing, and says so, when the configuration is no longer saved', () => {
    const { rerender } = runSaved();
    mockLoadConfigMutationState = { ...mockLoadConfigMutationState, data: { config: null } };
    rerender(<SyncPage />);

    expect(mockExecuteMutate).not.toHaveBeenCalled();
    expect(screen.getByTestId('sync-error').textContent).toContain(
      'This configuration is no longer saved: nothing was run.',
    );
  });

  it('offers no Run now while a run is under way on the page', () => {
    mockExecuteMutationState = { ...idleExecute, loading: true, requestId: 'sync-run-1' } as never;
    render(<SyncPage />);
    fireEvent.click(screen.getByTestId('tab-schedules'));

    expect(screen.getByTestId('run-saved-config-cfg-saved')).toHaveProperty('disabled', true);
  });
});
