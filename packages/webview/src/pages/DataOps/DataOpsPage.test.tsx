import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { DataOpsPage } from './DataOpsPage';

const mockOrgs = [
  {
    id: 'org-1',
    alias: 'dev1',
    username: 'user@dev1.com',
    instanceUrl: 'https://dev1.salesforce.com',
    orgType: 'sandbox' as const,
    status: 'connected' as const,
    safetyTier: 'low' as const,
    apiVersion: '59.0',
    lastConnected: '2024-01-01T00:00:00Z',
  },
];

/* ------------------------------------------------------------------ */
/* Mock bridge hooks                                                   */
/* ------------------------------------------------------------------ */
const mockBackupMutate = vi.fn();
const mockBackupReset = vi.fn();
const mockAnonymizeMutate = vi.fn();
const mockAnonymizeReset = vi.fn();

/** Mutable query state for backup:list. */
let mockBackupsQueryState = {
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  refetch: vi.fn(),
};

/** Mutable mutation state for backup:execute. */
let mockBackupMutationState = {
  mutate: mockBackupMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: mockBackupReset,
};

/** Mutable mutation state for dataops:anonymize. */
let mockAnonymizeMutationState = {
  mutate: mockAnonymizeMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: mockAnonymizeReset,
};

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => {
    if (type === 'backup:list') {
      return mockBackupsQueryState;
    }
    if (type === 'dataops:anonymization-templates') {
      return { data: null, loading: false, error: null, refetch: vi.fn() };
    }
    return { data: null, loading: false, error: null, refetch: vi.fn() };
  },
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) => {
    if (type === 'backup:execute') {
      return mockBackupMutationState;
    }
    if (type === 'dataops:anonymize') {
      return mockAnonymizeMutationState;
    }
    return { mutate: vi.fn(), data: null, loading: false, error: null, reset: vi.fn() };
  },
}));

const mockNavigate = vi.fn();
vi.mock('../../stores/useAppStore', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ navigate: mockNavigate, currentRoute: 'dataops' }),
}));

describe('DataOpsPage', () => {
  beforeEach(() => {
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
    mockNavigate.mockClear();
    mockBackupMutate.mockClear();
    mockBackupReset.mockClear();
    mockAnonymizeMutate.mockClear();
    mockAnonymizeReset.mockClear();
    // Reset to default idle state
    mockBackupsQueryState = {
      data: null,
      loading: false,
      error: null,
      refetch: vi.fn(),
    };
    mockBackupMutationState = {
      mutate: mockBackupMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockBackupReset,
    };
    mockAnonymizeMutationState = {
      mutate: mockAnonymizeMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockAnonymizeReset,
    };
  });

  it('should show empty state when no orgs', () => {
    useOrgStore.setState({ orgs: [] });
    render(<DataOpsPage />);
    expect(screen.getByTestId('empty-state')).toBeDefined();
    expect(screen.getByTestId('illustration-dataops')).toBeDefined();
    expect(screen.getByTestId('empty-action-button')).toBeDefined();
  });

  it('should navigate to orgs when empty state CTA clicked', () => {
    useOrgStore.setState({ orgs: [] });
    render(<DataOpsPage />);
    fireEvent.click(screen.getByTestId('empty-action-button'));
    expect(mockNavigate).toHaveBeenCalledWith('orgs');
  });

  it('should render the page', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<DataOpsPage />);
    expect(screen.getByTestId('dataops-page')).toBeDefined();
  });

  it('should show title', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<DataOpsPage />);
    expect(screen.getByTestId('page-header')).toBeDefined();
    expect(screen.getByText('dataops.title')).toBeDefined();
  });

  it('should show tabs', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<DataOpsPage />);
    expect(screen.getByRole('tablist')).toBeDefined();
    expect(screen.getAllByRole('tab').length).toBe(6);
  });

  it('should start on backup tab', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<DataOpsPage />);
    expect(screen.getByTestId('backup-panel')).toBeDefined();
  });

  it('should switch to restore tab', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<DataOpsPage />);
    fireEvent.click(screen.getByText('dataops.restore'));
    expect(screen.getByTestId('restore-panel')).toBeDefined();
  });

  it('should switch to anonymize tab', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<DataOpsPage />);
    fireEvent.click(screen.getByText('dataops.anonymize'));
    expect(screen.getByTestId('anonymize-panel')).toBeDefined();
  });

  it('should switch to cleanup tab', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<DataOpsPage />);
    fireEvent.click(screen.getByText('dataops.cleanup'));
    expect(screen.getByTestId('cleanup-panel')).toBeDefined();
  });

  it('should switch to quality tab', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<DataOpsPage />);
    fireEvent.click(screen.getByText('dataops.quality'));
    expect(screen.getByTestId('quality-dashboard')).toBeDefined();
  });

  it('should display error from bridge hook', () => {
    mockBackupsQueryState = {
      data: null,
      loading: false,
      error: 'Backup failed',
      refetch: vi.fn(),
    };
    useOrgStore.setState({ orgs: mockOrgs });
    render(<DataOpsPage />);

    expect(screen.getByTestId('dataops-error')).toBeDefined();
    expect(screen.getByText('Backup failed')).toBeDefined();
  });

  it('should render KPI summary row', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<DataOpsPage />);
    expect(screen.getByTestId('dataops-kpi-row')).toBeDefined();
    expect(screen.getAllByTestId('kpi-card').length).toBe(3);
  });

  it('should render BentoGrid and BentoTile wrappers', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<DataOpsPage />);
    expect(screen.getByTestId('dataops-kpi-row')).toBeDefined();
    expect(screen.getAllByTestId('bento-tile').length).toBeGreaterThanOrEqual(1);
  });
});
