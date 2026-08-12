import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { DataOpsPage } from './DataOpsPage';

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

  it('should show the data protection journey steps in the empty state', () => {
    useOrgStore.setState({ orgs: [] });
    render(<DataOpsPage />);
    expect(screen.getByText('Protect your org data')).toBeDefined();
    expect(screen.getByTestId('empty-step-0').textContent).toContain(
      'Connect an org via SFDX import',
    );
    expect(screen.getByTestId('empty-step-1').textContent).toContain(
      'Create a backup before any risky operation',
    );
    expect(screen.getByTestId('empty-action-button').textContent).toBe('Connect an Org');
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

  describe('org targeting', () => {
    /** A second org, so "first in the list" and "selected" are different. */
    const secondOrg: SalesforceOrg = { ...mockOrgs[0], id: 'org-2', alias: 'prod-copy' };

    it('should back up the SELECTED org, not the first in the list', () => {
      useOrgStore.setState({ orgs: [mockOrgs[0], secondOrg], selectedOrgId: 'org-2' });
      render(<DataOpsPage />);

      fireEvent.click(screen.getByTestId('create-backup-btn'));

      // Both handlers used to read orgs[0], so a user with several connections
      // backed up and anonymised an org other than the one on screen.
      expect(mockBackupMutate).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'org-2' }));
    });

    it('should not run a backup when no org is selected', () => {
      useOrgStore.setState({ orgs: [mockOrgs[0], secondOrg], selectedOrgId: null });
      render(<DataOpsPage />);

      fireEvent.click(screen.getByTestId('create-backup-btn'));

      expect(mockBackupMutate).not.toHaveBeenCalled();
      expect(screen.getByTestId('dataops-no-org')).toBeDefined();
    });

    it('should name the target org in the header before anything is clicked', () => {
      useOrgStore.setState({ orgs: [mockOrgs[0], secondOrg], selectedOrgId: 'org-2' });
      render(<DataOpsPage />);

      // Writing to an org the page never names is the underlying hazard.
      expect(screen.getByText('prod-copy')).toBeDefined();
    });
  });

  it('should show title', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<DataOpsPage />);
    expect(screen.getByTestId('page-header')).toBeDefined();
    expect(screen.getByText('DataOps')).toBeDefined();
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
    fireEvent.click(screen.getByText('Restore'));
    expect(screen.getByTestId('restore-panel')).toBeDefined();
  });

  it('should switch to anonymize tab', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<DataOpsPage />);
    fireEvent.click(screen.getByText('Anonymize'));
    expect(screen.getByTestId('anonymize-panel')).toBeDefined();
  });

  it('should switch to cleanup tab', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<DataOpsPage />);
    fireEvent.click(screen.getByText('Cleanup'));
    expect(screen.getByTestId('cleanup-panel')).toBeDefined();
  });

  it('should switch to quality tab', () => {
    useOrgStore.setState({ orgs: mockOrgs });
    render(<DataOpsPage />);
    fireEvent.click(screen.getByText('Quality'));
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
