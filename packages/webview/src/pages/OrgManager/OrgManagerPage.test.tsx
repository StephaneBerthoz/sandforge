import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
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

  it('should not disconnect on the bare card click — it only opens the confirmation', () => {
    useOrgStore.setState({ orgs: [mockOrg] });
    render(<OrgManagerPage />);
    fireEvent.click(screen.getByText('Disconnect'));
    expect(screen.getByTestId('danger-input')).toBeDefined();
    expect(useOrgStore.getState().orgs).toHaveLength(1);
    expect(mockDisconnectMutate).not.toHaveBeenCalled();
  });

  it('should name the org in the confirmation and warn about the lost customisations', () => {
    useOrgStore.setState({ orgs: [mockOrg] });
    render(<OrgManagerPage />);
    fireEvent.click(screen.getByText('Disconnect'));
    // The alias also appears on the card behind the dialog, so scope the query.
    const dialog = screen.getByTestId('danger-title').parentElement as HTMLElement;
    expect(within(dialog).getByText(/Dev Sandbox/).textContent).toContain('safety tier');
  });

  it('should remove org once the disconnect is confirmed', () => {
    useOrgStore.setState({ orgs: [mockOrg] });
    render(<OrgManagerPage />);
    fireEvent.click(screen.getByText('Disconnect'));
    fireEvent.change(screen.getByTestId('danger-input'), { target: { value: 'Disconnect' } });
    fireEvent.click(screen.getByTestId('danger-confirm-btn'));
    expect(useOrgStore.getState().orgs).toHaveLength(0);
    expect(mockDisconnectMutate).toHaveBeenCalledWith({ orgId: 'org-1' });
  });

  it('should keep the org when the confirmation is cancelled', () => {
    useOrgStore.setState({ orgs: [mockOrg] });
    render(<OrgManagerPage />);
    fireEvent.click(screen.getByText('Disconnect'));
    const dialog = screen.getByTestId('danger-title').parentElement as HTMLElement;
    fireEvent.click(within(dialog).getByText('Cancel'));
    expect(useOrgStore.getState().orgs).toHaveLength(1);
    expect(mockDisconnectMutate).not.toHaveBeenCalled();
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

  it('should keep the inline form open, with what was typed, when the connect fails', () => {
    const { rerender } = render(<OrgManagerPage />);
    fireEvent.click(screen.getByTestId('org-auth-usernamePassword'));
    fireEvent.change(screen.getByTestId('inline-alias-input'), {
      target: { value: 'my-sandbox' },
    });
    fireEvent.change(screen.getByTestId('inline-username-input'), {
      target: { value: 'dev@sandbox.com' },
    });
    fireEvent.change(screen.getByTestId('inline-password-input'), {
      target: { value: 'hunter2' },
    });
    fireEvent.click(screen.getByTestId('org-inline-connect'));

    // Mutation in flight
    mockConnectState = { ...mockConnectState, loading: true };
    rerender(<OrgManagerPage />);

    // Host replies on org:error — loading drops and error is set in one batch
    mockConnectState = {
      ...mockConnectState,
      loading: false,
      error: 'INVALID_LOGIN: Invalid username, password, security token or expired password',
    };
    rerender(<OrgManagerPage />);

    expect(screen.getByTestId('org-inline-form')).toBeDefined();
    expect((screen.getByTestId('inline-alias-input') as HTMLInputElement).value).toBe('my-sandbox');
    expect((screen.getByTestId('inline-username-input') as HTMLInputElement).value).toBe(
      'dev@sandbox.com',
    );
    expect((screen.getByTestId('inline-password-input') as HTMLInputElement).value).toBe('hunter2');
  });

  it('should show the connect error message instead of failing silently', () => {
    const { rerender } = render(<OrgManagerPage />);
    fireEvent.click(screen.getByTestId('org-auth-sfdx_import'));

    mockConnectState = { ...mockConnectState, loading: true };
    rerender(<OrgManagerPage />);

    mockConnectState = {
      ...mockConnectState,
      loading: false,
      error: 'sf CLI not found on PATH',
    };
    rerender(<OrgManagerPage />);

    const banner = screen.getByTestId('org-connect-error');
    expect(banner.textContent).toContain('sf CLI not found on PATH');
    expect(banner.textContent).toContain('Connection Error');
  });

  it('should collapse the inline form when the connect succeeds', () => {
    const { rerender } = render(<OrgManagerPage />);
    fireEvent.click(screen.getByTestId('org-auth-usernamePassword'));
    fireEvent.change(screen.getByTestId('inline-alias-input'), {
      target: { value: 'my-sandbox' },
    });

    mockConnectState = { ...mockConnectState, loading: true };
    rerender(<OrgManagerPage />);

    mockConnectState = { ...mockConnectState, loading: false, error: null };
    rerender(<OrgManagerPage />);

    expect(screen.queryByTestId('org-inline-form')).toBeNull();
    expect(screen.queryByTestId('org-connect-error')).toBeNull();
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
