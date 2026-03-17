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
    const org2: SalesforceOrg = { ...mockOrg, id: 'org-2', alias: 'QA Sandbox', username: 'qa@test.com' };
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
});
