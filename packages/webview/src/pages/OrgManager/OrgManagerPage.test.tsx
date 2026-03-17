import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { OrgManagerPage } from './OrgManagerPage';

/**
 * Mock the bridge hooks so tests do not depend on the real VSCode API.
 */
const mockRefetch = vi.fn();
const mockConnectMutate = vi.fn();
const mockConnectReset = vi.fn();
const mockDisconnectMutate = vi.fn();
const mockDisconnectReset = vi.fn();

let mockQueryState = {
  data: null as { orgs: SalesforceOrg[] } | null,
  loading: false,
  error: null as string | null,
  refetch: mockRefetch,
};

let mockConnectState = {
  mutate: mockConnectMutate,
  data: null as { orgId: string; status: string } | null,
  loading: false,
  error: null as string | null,
  reset: mockConnectReset,
};

let mockDisconnectState = {
  mutate: mockDisconnectMutate,
  data: null as { orgId: string; status: string } | null,
  loading: false,
  error: null as string | null,
  reset: mockDisconnectReset,
};

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: () => mockQueryState,
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) => {
    if (type === 'org:connect') {
      return mockConnectState;
    }
    if (type === 'org:disconnect') {
      return mockDisconnectState;
    }
    return {
      mutate: vi.fn(),
      data: null,
      loading: false,
      error: null,
      reset: vi.fn(),
    };
  },
}));

const mockOrg: SalesforceOrg = {
  id: 'org-1',
  alias: 'Dev Sandbox',
  username: 'dev@sandbox.com',
  instanceUrl: 'https://dev.my.salesforce.com',
  orgId: '00Dxx0000001gEQ',
  orgType: 'Sandbox',
  authMethod: 'oauth_web',
  safetyTier: OrgSafetyTier.LOW,
  appearance: { color: '#10B981', icon: 'cloud', position: 0 },
  metadata: { apiVersion: '59.0', edition: 'Developer', features: [] },
  status: 'connected',
  lastConnected: '2024-01-01T00:00:00Z',
  tags: [],
};

// jsdom doesn't implement dialog.showModal/close natively
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  });
});

describe('OrgManagerPage', () => {
  beforeEach(() => {
    useOrgStore.setState({ orgs: [], selectedOrgId: null, isConnecting: false });
    vi.clearAllMocks();

    // Reset mock states
    mockQueryState = {
      data: null,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    mockConnectState = {
      mutate: mockConnectMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockConnectReset,
    };
    mockDisconnectState = {
      mutate: mockDisconnectMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockDisconnectReset,
    };
  });

  it('should render the page title', () => {
    render(<OrgManagerPage />);
    expect(screen.getByText('Organizations')).toBeDefined();
  });

  it('should show empty state when no orgs', () => {
    render(<OrgManagerPage />);
    expect(screen.getByText('No organizations connected')).toBeDefined();
  });

  it('should render org cards when orgs exist', () => {
    useOrgStore.setState({ orgs: [mockOrg] });
    render(<OrgManagerPage />);
    expect(screen.getByText('Dev Sandbox')).toBeDefined();
    expect(screen.getByText('dev@sandbox.com')).toBeDefined();
  });

  it('should show auth method buttons in the connect banner', () => {
    render(<OrgManagerPage />);
    // The banner shows inline auth method buttons instead of a dialog
    expect(screen.getByTestId('org-auth-sfdx_import')).toBeDefined();
    expect(screen.getByTestId('org-auth-oauth_web')).toBeDefined();
  });

  it('should select an org when card is clicked', () => {
    useOrgStore.setState({ orgs: [mockOrg] });
    render(<OrgManagerPage />);
    fireEvent.click(screen.getByTestId('org-card-org-1'));
    expect(useOrgStore.getState().selectedOrgId).toBe('org-1');
  });

  it('should remove org on disconnect', () => {
    useOrgStore.setState({ orgs: [mockOrg] });
    render(<OrgManagerPage />);
    fireEvent.click(screen.getByText('Disconnect'));
    expect(useOrgStore.getState().orgs).toHaveLength(0);
    expect(mockDisconnectMutate).toHaveBeenCalledWith({ orgId: 'org-1' });
  });

  it('should render the connect banner with auth methods', () => {
    render(<OrgManagerPage />);
    expect(screen.getByTestId('org-connect-banner')).toBeDefined();
    expect(screen.getByTestId('org-auth-methods')).toBeDefined();
  });

  it('should display error when org list query fails', () => {
    mockQueryState = {
      ...mockQueryState,
      error: 'Bridge query timed out',
    };
    render(<OrgManagerPage />);
    expect(screen.getByTestId('org-list-error')).toBeDefined();
    expect(screen.getByText('Bridge query timed out')).toBeDefined();
  });

  it('should call connectMutation.mutate when sfdx_import button is clicked', () => {
    render(<OrgManagerPage />);
    // The sfdx_import method triggers immediately on click
    fireEvent.click(screen.getByTestId('org-auth-sfdx_import'));

    expect(mockConnectMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: '',
        authMethod: 'sfdx_import',
      }),
    );
  });

  it('should populate store when query data arrives', () => {
    mockQueryState = {
      ...mockQueryState,
      data: { orgs: [mockOrg] },
    };
    render(<OrgManagerPage />);
    expect(useOrgStore.getState().orgs).toHaveLength(1);
    expect(useOrgStore.getState().orgs[0].alias).toBe('Dev Sandbox');
  });
});
