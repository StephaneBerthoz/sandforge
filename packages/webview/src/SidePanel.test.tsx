import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { SidePanel } from './SidePanel';
import { useRecentOpsStore } from './stores/useRecentOpsStore';
import { useOrgStore } from './stores/useOrgStore';
import { useFavoritesStore } from './stores/useFavoritesStore';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';

const mockPostMessage = vi.fn();
const mockSyncLanguage = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: string | Record<string, unknown>) => {
      if (typeof opts === 'string') return opts;
      if (opts && typeof opts === 'object') return key;
      return key;
    },
  }),
}));

vi.mock('./i18n', () => ({
  // Deferred closure: the factory evaluates during import resolution, before
  // the const above is initialized (TDZ) — only calls must see the spy.
  syncLanguageFromSettings: (...args: unknown[]) => mockSyncLanguage(...args),
}));

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
  orgType: 'Sandbox',
  authMethod: 'oauth_web',
  safetyTier: OrgSafetyTier.LOW,
  appearance: { color: '#0000ff', icon: '', position: 0 },
  metadata: { apiVersion: '59.0', edition: 'Developer', features: [] },
  status: 'connected',
  lastConnected: '2026-03-07T00:00:00.000Z',
  tags: [],
};

/** Deliver a message from the extension, as the launcher receives it. */
function fromExtension(data: Record<string, unknown>): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data }));
  });
}

/** The extension's answer with the registered orgs. */
function deliverOrgs(orgs: SalesforceOrg[], selectedOrgId: string | null = null): void {
  fromExtension({ type: 'org:list:response', payload: { orgs, selectedOrgId } });
}

const qaSandbox: SalesforceOrg = { ...mockOrg, id: 'org-2', alias: 'QASandbox' };

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

  it('says it is loading until the extension has answered', () => {
    // The view is recreated every time VS Code hides and shows the panel, so
    // the list starts empty each time. "No org connected" then stated
    // something false, several times a session, to a user whose orgs were all
    // connected.
    render(<SidePanel />);
    expect(screen.getByTestId('sidepanel-org')).toHaveTextContent('Loading orgs');
    expect(screen.getByTestId('sidepanel-org')).not.toHaveTextContent('No org connected');
  });

  it('renders no org connected once the answer is an empty list', () => {
    render(<SidePanel />);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', { data: { type: 'org:list:response', payload: { orgs: [] } } }),
      );
    });
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

  it('renders forge hero button once two orgs are connected', () => {
    render(<SidePanel />);
    deliverOrgs([mockOrg, qaSandbox]);
    expect(screen.getByTestId('sidepanel-forge')).toBeInTheDocument();
    expect(screen.queryByTestId('sidepanel-seed-hero')).toBeNull();
  });

  it('describes Forge as the clone it opens, not as seeding, syncing and transforming', () => {
    render(<SidePanel />);
    deliverOrgs([mockOrg, qaSandbox]);
    expect(screen.getByTestId('sidepanel-forge')).toHaveTextContent('sidePanel.forgeDesc');
  });

  it('leads with filling the one org connected, not with Forge, which needs a second', () => {
    useOrgStore.setState({ selectedOrgId: null });
    render(<SidePanel />);
    deliverOrgs([mockOrg]);

    expect(screen.queryByTestId('sidepanel-forge')).toBeNull();
    const hero = screen.getByTestId('sidepanel-seed-hero');
    expect(hero).toHaveTextContent('sidePanel.fillOrg');

    fireEvent.click(hero);
    // The org is selected everywhere, so Seed opens on it.
    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'sidebar:selectOrg',
      payload: { orgId: 'org-1' },
    });
    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'sidebar:navigate',
      payload: { route: 'seed' },
    });
  });

  it('offers no seed of a production org connected alone', () => {
    render(<SidePanel />);
    deliverOrgs([
      {
        ...mockOrg,
        orgType: 'Production',
        metadata: { apiVersion: '59.0', edition: 'Enterprise Edition', features: [] },
      },
    ]);

    expect(screen.queryByTestId('sidepanel-seed-hero')).toBeNull();
    expect(screen.getByTestId('sidepanel-forge')).toBeInTheDocument();
  });

  describe('with no org registered', () => {
    it('leads with a card to connect the first org, in place of the counters and the hero', () => {
      render(<SidePanel />);
      deliverOrgs([]);

      expect(screen.getByTestId('sidepanel-first-org')).toBeInTheDocument();
      expect(screen.queryByTestId('sidepanel-metrics')).toBeNull();
      expect(screen.queryByTestId('sidepanel-forge')).toBeNull();
    });

    it('offers the orgs the CLI holds first, and opens Organizations on their import', () => {
      render(<SidePanel />);
      deliverOrgs([]);
      fromExtension({ type: 'sidebar:cliOrgs', payload: { count: 4 } });

      const card = screen.getByTestId('sidepanel-first-org');
      const buttons = card.querySelectorAll('button');
      expect(buttons[0]).toHaveAttribute('data-testid', 'sidepanel-first-org-import');
      expect(buttons[0]).toHaveTextContent('sidePanel.firstOrg.importCount');

      fireEvent.click(screen.getByTestId('sidepanel-first-org-import'));
      expect(mockPostMessage).toHaveBeenCalledWith({
        type: 'sidebar:navigate',
        payload: { route: 'orgs', intent: { orgAction: 'import-cli' } },
      });
    });

    it('leads with the browser sign-in when the CLI holds no org', () => {
      render(<SidePanel />);
      deliverOrgs([]);
      fromExtension({ type: 'sidebar:cliOrgs', payload: { count: 0 } });

      const buttons = screen.getByTestId('sidepanel-first-org').querySelectorAll('button');
      expect(buttons[0]).toHaveAttribute('data-testid', 'sidepanel-first-org-login');
      fireEvent.click(buttons[0]);
      expect(mockPostMessage).toHaveBeenCalledWith({
        type: 'sidebar:navigate',
        payload: { route: 'orgs', intent: { orgAction: 'login-web' } },
      });
    });

    it('is not shown while orgs are registered, even when none is connected', () => {
      render(<SidePanel />);
      deliverOrgs([{ ...mockOrg, status: 'expired' }]);
      expect(screen.queryByTestId('sidepanel-first-org')).toBeNull();
    });
  });

  it('renders module navigation items, Seed, Forge and Monitor first', () => {
    render(<SidePanel />);
    const modules = screen.getByTestId('sidepanel-modules');
    const routes = [...modules.querySelectorAll('[data-testid^="sidepanel-nav-"]')].map((el) =>
      el.getAttribute('data-testid'),
    );
    expect(routes).toEqual([
      'sidepanel-nav-seed',
      'sidepanel-nav-forge',
      'sidepanel-nav-monitor',
      'sidepanel-nav-sync',
      'sidepanel-nav-autopilot',
      'sidepanel-nav-frozen',
    ]);
  });

  it('folds Compare, DataOps, Automation, Migration and AI under Advanced until opened', () => {
    render(<SidePanel />);
    const toggle = screen.getByTestId('sidepanel-advanced-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('sidepanel-nav-compare')).toBeNull();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    for (const route of ['compare', 'dataops', 'automation', 'migration', 'ai']) {
      expect(screen.getByTestId(`sidepanel-nav-${route}`)).toBeInTheDocument();
    }
  });

  it('lists Grappe only while sandforge.grappe.enabled is on', () => {
    render(<SidePanel />);
    fireEvent.click(screen.getByTestId('sidepanel-advanced-toggle'));
    expect(screen.queryByTestId('sidepanel-nav-grappe')).toBeNull();

    fromExtension({ type: 'settings:response', payload: { settings: {}, grappeEnabled: true } });

    fireEvent.click(screen.getByTestId('sidepanel-nav-grappe'));
    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'sidebar:navigate',
      payload: { route: 'grappe' },
    });
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

  it('requests orgs and settings on mount', () => {
    render(<SidePanel />);
    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'sidebar:requestOrgs' });
    expect(mockPostMessage).toHaveBeenCalledWith({ type: 'sidebar:requestSettings' });
  });

  it('syncs the UI language when a settings:response message arrives', () => {
    render(<SidePanel />);
    fireEvent(
      window,
      new MessageEvent('message', {
        data: {
          type: 'settings:response',
          payload: { settings: { settings: { language: 'fr' } } },
        },
      }),
    );
    expect(mockSyncLanguage).toHaveBeenCalledWith({ settings: { language: 'fr' } });
  });

  it('adopts org:selected broadcasts into the org store', () => {
    useOrgStore.setState({ orgs: [mockOrg], selectedOrgId: null });
    render(<SidePanel />);
    fireEvent(
      window,
      new MessageEvent('message', {
        data: { type: 'org:selected', payload: { orgId: 'org-1' } },
      }),
    );
    expect(useOrgStore.getState().selectedOrgId).toBe('org-1');
  });

  it('posts sidebar:openOrgInBrowser from the dropdown globe icon without selecting the org', () => {
    useOrgStore.setState({ orgs: [mockOrg], selectedOrgId: null });
    render(<SidePanel />);
    fireEvent.click(screen.getByTestId('sidepanel-org'));
    fireEvent.click(screen.getByTestId('sidepanel-org-open-org-1'));
    expect(mockPostMessage).toHaveBeenCalledWith({
      type: 'sidebar:openOrgInBrowser',
      payload: { orgId: 'org-1' },
    });
    // The icon must not trigger org selection
    expect(mockPostMessage).not.toHaveBeenCalledWith({
      type: 'sidebar:selectOrg',
      payload: { orgId: 'org-1' },
    });
    expect(useOrgStore.getState().selectedOrgId).toBeNull();
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

  it('says the last operation happened at an unknown time when its time is not a number', () => {
    // Every sum on it was NaN: the panel read "NaN h ago".
    useRecentOpsStore.setState({
      ops: [
        {
          id: 'op-1',
          type: 'forge',
          label: 'Clone Accounts',
          status: 'success',
          timestamp: undefined as unknown as number,
        },
      ],
    });
    render(<SidePanel />);

    const lastOp = screen.getByTestId('sidepanel-last-op');
    expect(lastOp).toHaveTextContent('common.dateUnknown');
    expect(lastOp).not.toHaveTextContent('NaN');
  });

  it('shows a cancelled last operation with its own icon, not the success tick', () => {
    useRecentOpsStore.setState({
      ops: [
        {
          id: 'op-1',
          type: 'forge',
          label: 'Discovering object graph',
          status: 'cancelled',
          timestamp: Date.now() - 60000,
        },
      ],
    });
    render(<SidePanel />);
    const lastOp = screen.getByTestId('sidepanel-last-op');
    expect(lastOp.querySelector('[data-testid="op-status-cancelled"]')).not.toBeNull();
    expect(lastOp.querySelector('[data-testid="op-status-success"]')).toBeNull();
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

  it('posts sidebar:navigate for seed, forge, sync and autopilot entries', () => {
    render(<SidePanel />);
    for (const route of ['seed', 'forge', 'sync', 'autopilot']) {
      fireEvent.click(screen.getByTestId(`sidepanel-nav-${route}`));
      expect(mockPostMessage).toHaveBeenCalledWith({
        type: 'sidebar:navigate',
        payload: { route },
      });
    }
  });

  // Org switcher sorts connected first
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

  // Status dot reflects selected org status
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
    // The severity token, not a raw palette hue: the hardcoded one did not
    // follow a light theme and the design system has a scale for this.
    expect(dot?.className).toContain('bg-status-error');
    expect(dot?.className).not.toContain('bg-status-success');
  });

  // Collapsible Quick Metrics
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

  // Favorite stars always visible
  it('renders favorite stars with visible opacity (not hidden)', () => {
    render(<SidePanel />);
    const starBtn = screen.getByTestId('sidepanel-star-monitor');
    // Should NOT have opacity-0 (hidden)
    expect(starBtn.className).not.toContain('opacity-0');
  });

  it('draws an unstarred favorite star in the description colour, never the disabled one', () => {
    render(<SidePanel />);
    const starBtn = screen.getByTestId('sidepanel-star-monitor');
    // The disabled foreground reads 2.1:1 on light themes: it is for disabled controls only.
    expect(starBtn.className).toContain('text-text-secondary');
    expect(starBtn.className).not.toContain('text-text-muted');
    expect(starBtn.className).not.toMatch(/(^|\s)opacity-(0|[1-9]0)(\s|$)/);
  });

  describe('compact mode on a short viewport', () => {
    const REAL_INNER_HEIGHT = window.innerHeight;

    function setViewportHeight(height: number): void {
      Object.defineProperty(window, 'innerHeight', {
        value: height,
        configurable: true,
        writable: true,
      });
    }

    afterEach(() => {
      setViewportHeight(REAL_INNER_HEIGHT);
    });

    it('draws the tall Forge hero in a panel with room for it', () => {
      setViewportHeight(800);
      render(<SidePanel />);
      deliverOrgs([mockOrg, qaSandbox]);

      expect(screen.getByTestId('sidepanel-forge')).toBeInTheDocument();
      expect(screen.queryByTestId('sidepanel-forge-compact')).not.toBeInTheDocument();
      // Quick metrics stay open: there is height to show them.
      expect(screen.getByTestId('sidepanel-metrics')).toBeInTheDocument();
    });

    it('swaps in the one-line Forge button and folds the metrics on a short panel', () => {
      // A docked sidebar in a split editor is this short, and the tall hero
      // pushed the module list below the fold.
      setViewportHeight(600);
      render(<SidePanel />);
      deliverOrgs([mockOrg, qaSandbox]);

      expect(screen.getByTestId('sidepanel-forge-compact')).toBeInTheDocument();
      expect(screen.queryByTestId('sidepanel-forge')).not.toBeInTheDocument();
      expect(screen.queryByTestId('sidepanel-metrics')).not.toBeInTheDocument();
    });

    it('switches to compact when the panel is dragged shorter', () => {
      setViewportHeight(800);
      render(<SidePanel />);
      deliverOrgs([mockOrg, qaSandbox]);
      expect(screen.getByTestId('sidepanel-forge')).toBeInTheDocument();

      setViewportHeight(600);
      fireEvent(window, new Event('resize'));

      expect(screen.getByTestId('sidepanel-forge-compact')).toBeInTheDocument();
      expect(screen.queryByTestId('sidepanel-forge')).not.toBeInTheDocument();
    });

    it('keeps the one-org Seed hero, on one line, on a short panel', () => {
      setViewportHeight(600);
      render(<SidePanel />);
      deliverOrgs([mockOrg]);

      expect(screen.getByTestId('sidepanel-seed-hero-compact')).toBeInTheDocument();
      expect(screen.queryByTestId('sidepanel-seed-hero')).not.toBeInTheDocument();
    });
  });

  // No version badge in header
  it('does not render version badge in branding header', () => {
    render(<SidePanel />);
    const root = screen.getByTestId('sidepanel-root');
    // v1.0 text should not appear in the branding area
    const brandingArea = root.querySelector('.border-b');
    expect(brandingArea?.textContent).not.toContain('v1.0');
  });
});
