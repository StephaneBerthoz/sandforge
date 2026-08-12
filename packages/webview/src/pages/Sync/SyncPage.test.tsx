import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { useConflictStore } from '../../stores/useConflictStore';
import { SyncPage } from './SyncPage';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg, UIConflict } from '@sandforge/shared';

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

/* ------------------------------------------------------------------ */
/* Mock bridge hooks                                                   */
/* ------------------------------------------------------------------ */
const mockObjectsRefetch = vi.fn();
const mockFieldsMutate = vi.fn();
const mockFieldsReset = vi.fn();
const mockExecuteMutate = vi.fn();
const mockExecuteReset = vi.fn();

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

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) => {
    if (type === 'sync:describe-fields') {
      return mockFieldsMutationState;
    }
    if (type === 'sync:execute') {
      return mockExecuteMutationState;
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

  it('should render realtime tab in tab bar', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SyncPage />);
    expect(screen.getByTestId('tab-realtime')).toBeDefined();
  });

  it('should render RealTimeSyncPanel when realtime tab is clicked', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SyncPage />);
    const realtimeTab = screen.getByTestId('tab-realtime');
    fireEvent.click(realtimeTab);
    expect(screen.getByTestId('realtime-sync-panel')).toBeDefined();
  });

  it('should render conflicts tab in tab bar', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SyncPage />);
    expect(screen.getByTestId('tab-conflicts')).toBeDefined();
  });

  it('should show conflict list when conflicts tab is clicked', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SyncPage />);
    const conflictsTab = screen.getByTestId('tab-conflicts');
    fireEvent.click(conflictsTab);
    expect(screen.getByTestId('splitview')).toBeDefined();
    expect(screen.getByTestId('conflict-list-panel')).toBeDefined();
  });

  it('should show unresolved count badge when conflicts exist', () => {
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

    // The badge should show "1"
    const badge = screen.getByTestId('tab-conflicts');
    expect(badge.textContent).toContain('1');
  });

  it('should show placeholder when no conflict is selected on conflicts tab', () => {
    useOrgStore.setState({ orgs: mockOrgs });
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
    render(<SyncPage />);
    fireEvent.click(screen.getByTestId('tab-conflicts'));

    expect(screen.getByTestId('conflict-placeholder')).toBeDefined();
  });

  it('should show ConflictResolutionPanel when a conflict is selected', () => {
    useOrgStore.setState({ orgs: mockOrgs });
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
    useConflictStore.setState({ conflicts: [conflict], selectedConflictId: 'Account:001:1' });
    render(<SyncPage />);
    fireEvent.click(screen.getByTestId('tab-conflicts'));

    expect(screen.getByTestId('conflict-resolution-panel')).toBeDefined();
  });
});
