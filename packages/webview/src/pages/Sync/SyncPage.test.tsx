import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { SyncPage } from './SyncPage';

const mockOrgs = [
  { id: 'org-1', alias: 'dev1', username: 'user@dev1.com', instanceUrl: 'https://dev1.salesforce.com', orgType: 'sandbox' as const, status: 'connected' as const, safetyTier: 'low' as const, apiVersion: '59.0', lastConnected: '2024-01-01T00:00:00Z' },
  { id: 'org-2', alias: 'dev2', username: 'user@dev2.com', instanceUrl: 'https://dev2.salesforce.com', orgType: 'sandbox' as const, status: 'connected' as const, safetyTier: 'low' as const, apiVersion: '59.0', lastConnected: '2024-01-01T00:00:00Z' },
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
    expect(screen.getByText('Choose source and target orgs')).toBeDefined();
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

  it('should show direction, mode, and conflict selectors', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SyncPage />);
    expect(screen.getByText('Direction')).toBeDefined();
    expect(screen.getByText('Mode')).toBeDefined();
    expect(screen.getByText('Conflict Strategy')).toBeDefined();
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
});
