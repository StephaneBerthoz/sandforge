import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { SeedPage } from './SeedPage';

const mockOrgs = [
  { id: 'org-1', alias: 'dev1', username: 'user@dev1.com', instanceUrl: 'https://dev1.salesforce.com', orgType: 'sandbox' as const, status: 'connected' as const, safetyTier: 'low' as const, apiVersion: '59.0', lastConnected: '2024-01-01T00:00:00Z' },
  { id: 'org-2', alias: 'dev2', username: 'user@dev2.com', instanceUrl: 'https://dev2.salesforce.com', orgType: 'sandbox' as const, status: 'connected' as const, safetyTier: 'low' as const, apiVersion: '59.0', lastConnected: '2024-01-01T00:00:00Z' },
];

/* ------------------------------------------------------------------ */
/* Mock bridge hooks                                                   */
/* ------------------------------------------------------------------ */
const mockDescribeGlobalRefetch = vi.fn();
const mockDescribeFieldsMutate = vi.fn();
const mockDescribeFieldsReset = vi.fn();
const mockExecuteSeedMutate = vi.fn();
const mockExecuteSeedReset = vi.fn();

/** Mutable query state for describe-global. */
let mockDescribeGlobalState = {
  data: null as { objects: Array<{ apiName: string; label: string; recordCount: number; dependencies: string[] }> } | null,
  loading: false,
  error: null as string | null,
  refetch: mockDescribeGlobalRefetch,
};

/** Mutable mutation state for describe-fields. */
let mockDescribeFieldsState = {
  mutate: mockDescribeFieldsMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: mockDescribeFieldsReset,
};

/** Mutable mutation state for seed:execute. */
let mockExecuteSeedState = {
  mutate: mockExecuteSeedMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: mockExecuteSeedReset,
};

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => {
    if (type === 'seed:describe-global') {
      return mockDescribeGlobalState;
    }
    return { data: null, loading: false, error: null, refetch: vi.fn() };
  },
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) => {
    if (type === 'seed:describe-object') {
      return mockDescribeFieldsState;
    }
    if (type === 'seed:execute') {
      return mockExecuteSeedState;
    }
    return { mutate: vi.fn(), data: null, loading: false, error: null, reset: vi.fn() };
  },
}));

describe('SeedPage', () => {
  beforeEach(() => {
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
    mockDescribeGlobalRefetch.mockClear();
    mockDescribeFieldsMutate.mockClear();
    mockExecuteSeedMutate.mockClear();
    // Reset to default idle state
    mockDescribeGlobalState = {
      data: null,
      loading: false,
      error: null,
      refetch: mockDescribeGlobalRefetch,
    };
    mockDescribeFieldsState = {
      mutate: mockDescribeFieldsMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockDescribeFieldsReset,
    };
    mockExecuteSeedState = {
      mutate: mockExecuteSeedMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockExecuteSeedReset,
    };
  });

  it('should show empty state when no orgs', () => {
    render(<SeedPage />);
    expect(screen.getByText('No organizations connected')).toBeDefined();
  });

  it('should render seed page with wizard', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);
    expect(screen.getByTestId('seed-page')).toBeDefined();
    expect(screen.getByTestId('seed-wizard')).toBeDefined();
  });

  it('should show title in page header', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);
    expect(screen.getByTestId('page-header')).toBeDefined();
    expect(screen.getByText('Seed Data')).toBeDefined();
  });

  it('should start on step 1 (Select)', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);
    expect(screen.getByTestId('seed-step-select-content')).toBeDefined();
  });

  it('should show 4 step indicators', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);
    expect(screen.getByTestId('seed-step-indicator').children.length).toBe(4);
  });

  it('should disable next when no org or objects selected', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);
    expect(screen.getByTestId('seed-wizard-next')).toHaveProperty('disabled', true);
  });

  it('should show org selector on step 1', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);
    expect(screen.getByTestId('org-selector')).toBeDefined();
  });

  it('should show objects when org is selected and describe-global data is available', () => {
    mockDescribeGlobalState = {
      data: {
        objects: [
          { apiName: 'Account', label: 'Account', recordCount: 0, dependencies: [] },
          { apiName: 'Contact', label: 'Contact', recordCount: 0, dependencies: ['Account'] },
        ],
      },
      loading: false,
      error: null,
      refetch: mockDescribeGlobalRefetch,
    };
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);

    // Select org
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'org-1' } });

    expect(screen.getByTestId('obj-Account')).toBeDefined();
    expect(screen.getByTestId('obj-Contact')).toBeDefined();
  });

  it('should enable next when org and at least one object are selected', () => {
    mockDescribeGlobalState = {
      data: {
        objects: [
          { apiName: 'Account', label: 'Account', recordCount: 0, dependencies: [] },
        ],
      },
      loading: false,
      error: null,
      refetch: mockDescribeGlobalRefetch,
    };
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);

    // Select org
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'org-1' } });

    // Select an object
    fireEvent.click(screen.getByTestId('obj-Account'));

    expect(screen.getByTestId('seed-wizard-next')).toHaveProperty('disabled', false);
  });

  it('should navigate to configure step when clicking next', () => {
    mockDescribeGlobalState = {
      data: {
        objects: [
          { apiName: 'Account', label: 'Account', recordCount: 0, dependencies: [] },
        ],
      },
      loading: false,
      error: null,
      refetch: mockDescribeGlobalRefetch,
    };
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);

    // Select org
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'org-1' } });

    // Select object
    fireEvent.click(screen.getByTestId('obj-Account'));

    // Navigate to step 2
    fireEvent.click(screen.getByTestId('seed-wizard-next'));
    expect(screen.getByTestId('seed-step-configure-content')).toBeDefined();
  });

  it('should show guided first step card on step 0 when idle', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);
    expect(screen.getByTestId('guided-first-step-card')).toBeDefined();
    expect(screen.getByText('Get Started with Seed')).toBeDefined();
  });

  it('should display error from bridge query', () => {
    mockDescribeGlobalState = {
      data: null,
      loading: false,
      error: 'Connection failed',
      refetch: mockDescribeGlobalRefetch,
    };
    useOrgStore.setState({ orgs: mockOrgs });
    render(<SeedPage />);

    expect(screen.getByTestId('seed-error')).toBeDefined();
    expect(screen.getByText('Connection failed')).toBeDefined();
  });
});
