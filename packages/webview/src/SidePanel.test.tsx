import { describe, it, expect, vi, beforeEach } from 'vitest';
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { SidePanel } from './SidePanel';
import { useRecentOpsStore } from './stores/useRecentOpsStore';
import { useOrgStore } from './stores/useOrgStore';
import { useFavoritesStore } from './stores/useFavoritesStore';
import type { SalesforceOrg } from '@sandforge/shared';

const mockPostMessage = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: string | Record<string, unknown>) => {
      if (typeof opts === 'string') return opts;
      if (opts && typeof opts === 'object') return key;
      return key;
    },
  }),
}));

vi.mock('./i18n', () => ({}));

vi.mock('./hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

const mockOrg: SalesforceOrg = {
  id: 'org-1',
  alias: 'DevSandbox',
  username: 'dev@test.com',
  instanceUrl: 'https://test.salesforce.com',
  orgId: '00D000000000001',
  orgType: 'sandbox',
  authMethod: 'oauth2',
  safetyTier: 'development',
  appearance: { color: '#0000ff', emoji: '' },
  metadata: { apiVersion: '59.0', edition: 'Developer', features: [] },
  status: 'connected',
  lastConnected: '2026-03-07T00:00:00.000Z',
  tags: [],
};

describe('SidePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useRecentOpsStore.setState({ ops: [] });
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
    useFavoritesStore.setState({ favorites: [] });
  });

  it('renders the sidepanel root container', () => {
    render(<SidePanel />);
    expect(screen.getByTestId('sidepanel-root')).toBeInTheDocument();
  });

  it('renders no org connected when no orgs', () => {
    render(<SidePanel />);
    expect(screen.getByTestId('sidepanel-org')).toHaveTextContent('No org connected');
  });

  it('renders selected org alias when org is selected', () => {
    useOrgStore.setState({ orgs: [mockOrg], selectedOrgId: 'org-1' });
    render(<SidePanel />);
    expect(screen.getByTestId('sidepanel-org')).toHaveTextContent('DevSandbox');
  });

  it('renders quick metrics with org and ops counts', () => {
    useOrgStore.setState({ orgs: [mockOrg] });
    render(<SidePanel />);
    const metrics = screen.getByTestId('sidepanel-metrics');
    expect(metrics).toHaveTextContent('Orgs');
    expect(metrics).toHaveTextContent('1');
  });

  it('renders forge hero button', () => {
    render(<SidePanel />);
    expect(screen.getByTestId('sidepanel-forge')).toBeInTheDocument();
  });

  it('renders module navigation items', () => {
    render(<SidePanel />);
    expect(screen.getByTestId('sidepanel-nav-monitor')).toBeInTheDocument();
    expect(screen.getByTestId('sidepanel-nav-compare')).toBeInTheDocument();
    expect(screen.getByTestId('sidepanel-nav-dataops')).toBeInTheDocument();
    expect(screen.getByTestId('sidepanel-nav-automation')).toBeInTheDocument();
  });

  it('renders tool navigation items', () => {
    render(<SidePanel />);
    expect(screen.getByTestId('sidepanel-nav-orgs')).toBeInTheDocument();
    expect(screen.getByTestId('sidepanel-nav-settings')).toBeInTheDocument();
    expect(screen.getByTestId('sidepanel-nav-help')).toBeInTheDocument();
  });

  it('renders open full UI button', () => {
    render(<SidePanel />);
    expect(screen.getByTestId('sidepanel-open-full')).toBeInTheDocument();
  });

  it('posts sidebar:navigate on module click', () => {
    render(<SidePanel />);
    fireEvent.click(screen.getByTestId('sidepanel-nav-monitor'));
    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'sidebar:navigate',
      payload: { route: 'monitor' },
    });
  });

  it('posts sidebar:openFull on open full UI click', () => {
    render(<SidePanel />);
    fireEvent.click(screen.getByTestId('sidepanel-open-full'));
    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'sidebar:openFull' });
  });

  it('renders last operation when ops exist', () => {
    useRecentOpsStore.setState({
      ops: [
        {
          id: 'op-1',
          type: 'forge',
          label: 'Clone Accounts',
          status: 'success',
          timestamp: Date.now() - 120000,
        },
      ],
    });
    render(<SidePanel />);
    expect(screen.getByTestId('sidepanel-last-op')).toHaveTextContent('Clone Accounts');
  });

  it('renders running operation indicator when an op is running', () => {
    useRecentOpsStore.setState({
      ops: [
        {
          id: 'op-run',
          type: 'forge',
          label: 'Syncing Contacts',
          status: 'running',
          timestamp: Date.now(),
        },
      ],
    });
    render(<SidePanel />);
    expect(screen.getByTestId('sidepanel-running-op')).toHaveTextContent('Syncing Contacts');
  });

  it('opens dropdown with new org option when clicking org badge with no orgs', () => {
    render(<SidePanel />);
    fireEvent.click(screen.getByTestId('sidepanel-org'));
    expect(screen.getByTestId('sidepanel-org-dropdown')).toBeInTheDocument();
    expect(screen.getByTestId('sidepanel-org-new')).toBeInTheDocument();
  });

  it('navigates to orgs when clicking new org option', () => {
    render(<SidePanel />);
    fireEvent.click(screen.getByTestId('sidepanel-org'));
    fireEvent.click(screen.getByTestId('sidepanel-org-new'));
    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'sidebar:navigate',
      payload: { route: 'orgs' },
    });
  });

  it('opens org dropdown when clicking org badge with connected orgs', () => {
    const org2: SalesforceOrg = {
      ...mockOrg,
      id: 'org-2',
      alias: 'QA Sandbox',
      username: 'qa@test.com',
    };
    useOrgStore.setState({ orgs: [mockOrg, org2], selectedOrgId: 'org-1' });
    render(<SidePanel />);
    fireEvent.click(screen.getByTestId('sidepanel-org'));
    expect(screen.getByTestId('sidepanel-org-dropdown')).toBeInTheDocument();
  });

  it('renders favorite modules section when favorites exist', () => {
    useFavoritesStore.setState({ favorites: ['monitor'] });
    render(<SidePanel />);
    expect(screen.getByTestId('sidepanel-favorites')).toBeInTheDocument();
    expect(screen.getByTestId('sidepanel-fav-monitor')).toBeInTheDocument();
  });

  it('toggles favorite on star click', () => {
    render(<SidePanel />);
    fireEvent.click(screen.getByTestId('sidepanel-star-monitor'));
    expect(useFavoritesStore.getState().favorites).toContain('monitor');
  });

  it('does not render grappe hero button', () => {
    render(<SidePanel />);
    expect(screen.queryByTestId('sidepanel-grappe')).toBeNull();
  });

  // SP-01: Org switcher sorts connected first
  it('sorts connected orgs before disconnected in dropdown', () => {
    const disconnectedOrg: SalesforceOrg = {
      ...mockOrg,
      id: 'org-expired',
      alias: 'AAA-Expired',
      username: 'expired@test.com',
      status: 'expired',
    };
    const connectedOrg2: SalesforceOrg = {
      ...mockOrg,
      id: 'org-2',
      alias: 'ZZZ-Connected',
      username: 'connected2@test.com',
      status: 'connected',
    };
    useOrgStore.setState({ orgs: [disconnectedOrg, connectedOrg2], selectedOrgId: null });
    render(<SidePanel />);
    fireEvent.click(screen.getByTestId('sidepanel-org'));
    const dropdown = screen.getByTestId('sidepanel-org-dropdown');
    const buttons = dropdown.querySelectorAll('button[data-testid^="sidepanel-org-option"]');
    // Connected org should be first despite being alphabetically last
    expect(buttons[0]?.getAttribute('data-testid')).toBe('sidepanel-org-option-org-2');
    expect(buttons[1]?.getAttribute('data-testid')).toBe('sidepanel-org-option-org-expired');
  });

  // SP-01: Status dot reflects selected org status
  it('shows red status dot when selected org is expired', () => {
    const expiredOrg: SalesforceOrg = {
      ...mockOrg,
      id: 'org-exp',
      status: 'expired',
    };
    useOrgStore.setState({ orgs: [expiredOrg], selectedOrgId: 'org-exp' });
    render(<SidePanel />);
    const orgButton = screen.getByTestId('sidepanel-org');
    const dot = orgButton.querySelector('span.rounded-full');
    // Should have red indicator classes, not green
    expect(dot?.className).toContain('bg-red-500');
    expect(dot?.className).not.toContain('bg-green-500');
  });

  // SP-03: Collapsible Quick Metrics
  it('toggles Quick Metrics visibility when clicking the toggle', () => {
    useOrgStore.setState({ orgs: [mockOrg] });
    render(<SidePanel />);
    // Metrics should be visible by default
    expect(screen.getByTestId('sidepanel-metrics')).toBeInTheDocument();
    // Click toggle to collapse
    fireEvent.click(screen.getByTestId('sidepanel-metrics-toggle'));
    expect(screen.queryByTestId('sidepanel-metrics')).toBeNull();
    // Click again to expand
    fireEvent.click(screen.getByTestId('sidepanel-metrics-toggle'));
    expect(screen.getByTestId('sidepanel-metrics')).toBeInTheDocument();
  });

  // SP-04: Favorite stars always visible
  it('renders favorite stars with visible opacity (not hidden)', () => {
    render(<SidePanel />);
    const starBtn = screen.getByTestId('sidepanel-star-monitor');
    // Should NOT have opacity-0 (hidden)
    expect(starBtn.className).not.toContain('opacity-0');
  });

  // SP-06: No version badge in header
  it('does not render version badge in branding header', () => {
    render(<SidePanel />);
    const root = screen.getByTestId('sidepanel-root');
    // v1.0 text should not appear in the branding area
    const brandingArea = root.querySelector('.border-b');
    expect(brandingArea?.textContent).not.toContain('v1.0');
  });
});
