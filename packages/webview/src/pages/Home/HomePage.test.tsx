import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import i18n from '../../i18n';
import en from '../../i18n/locales/en.json';
import fr from '../../i18n/locales/fr.json';
import de from '../../i18n/locales/de.json';
import es from '../../i18n/locales/es.json';
import ptBR from '../../i18n/locales/pt-BR.json';
import ja from '../../i18n/locales/ja.json';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import { useRecentOpsStore } from '../../stores/useRecentOpsStore';
import { HomePage } from './HomePage';
import { OrgSafetyTier } from '@sandforge/shared';
import type { ApiLimit, RecoveryProgress, RecoveryStepId, SalesforceOrg } from '@sandforge/shared';

/* ------------------------------------------------------------------ */
/* Mock bridge hooks                                                   */
/* ------------------------------------------------------------------ */
const mockRefetch = vi.fn();

let mockOrgListState = {
  data: null as { orgs: SalesforceOrg[] } | null,
  loading: false,
  error: null as string | null,
  refetch: mockRefetch,
};

/** Response state for the `monitor:refresh` query used by useOrgHealthSummary. */
let mockMonitorState = {
  data: null as { limits: ApiLimit[]; healthScore: number } | null,
  loading: false,
  error: null as string | null,
  refetch: mockRefetch,
};

/** Response state for the `checkpoint:list` query of the Checkpoints tile. */
let mockCheckpointListState = {
  data: null as { checkpoints: unknown[] } | null,
  loading: false,
  error: null as string | null,
  refetch: mockRefetch,
};

/** Request types seen by useBridgeQuery, in call order. */
const bridgeQueryCalls: Array<{ requestType: string; payload: unknown; skip: boolean }> = [];

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (
    requestType: string,
    payload?: Record<string, unknown>,
    options?: { skip?: boolean },
  ) => {
    bridgeQueryCalls.push({ requestType, payload, skip: options?.skip ?? false });
    if (requestType === 'checkpoint:list') return mockCheckpointListState;
    return requestType === 'monitor:refresh' ? mockMonitorState : mockOrgListState;
  },
}));

/* ------------------------------------------------------------------ */
/* Mock useSmartAction hook                                             */
/* ------------------------------------------------------------------ */
let mockSmartActionState = {
  recommendation: null as import('@sandforge/shared').SmartActionRecommendation | null,
  loading: false,
  error: null as string | null,
  showConfirmation: false,
  requestConfirm: vi.fn(),
  confirm: vi.fn(),
  cancelConfirm: vi.fn(),
};

vi.mock('./useSmartAction', () => ({
  useSmartAction: () => mockSmartActionState,
}));

/* ------------------------------------------------------------------ */
/* Simulated answers of `recovery:status`, as useRecoveryLeads reads them */
/* ------------------------------------------------------------------ */
let mockRecovery = {
  afterRefresh: [] as RecoveryProgress[],
  next: {} as Record<string, RecoveryStepId>,
};
/** The org lists Home asked the refreshes of, in render order. */
const recoveryAskedOf: Array<readonly SalesforceOrg[] | undefined> = [];

vi.mock('./useRecoveryLeads', () => ({
  useRecoveryLeads: (orgs: readonly SalesforceOrg[] | undefined) => {
    recoveryAskedOf.push(orgs);
    return {
      afterRefresh: mockRecovery.afterRefresh,
      nextStepOf: (orgId: string) => mockRecovery.next[orgId],
    };
  },
}));

/** What Home posts to the extension outside its queries: the org it selects. */
const mockSendBridge = vi.fn();
vi.mock('../../bridge/sendBridgeMessage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../bridge/sendBridgeMessage')>()),
  sendBridgeMessage: (...args: unknown[]) => mockSendBridge(...args),
}));

/* ------------------------------------------------------------------ */
/* Mock framer-motion to avoid animation issues in tests               */
/* ------------------------------------------------------------------ */
const MOTION_KEYS = new Set([
  'variants',
  'initial',
  'animate',
  'whileHover',
  'whileTap',
  'transition',
  'exit',
]);

vi.mock('framer-motion', async () => {
  const React = await import('react');
  const makeMotion = <E extends keyof HTMLElementTagNameMap>(tag: E) =>
    React.forwardRef<HTMLElementTagNameMap[E], Record<string, unknown>>((props, ref) => {
      const filtered: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        if (!MOTION_KEYS.has(k)) filtered[k] = v;
      }
      return React.createElement(tag, { ...filtered, ref });
    });
  const mockDiv = makeMotion('div');
  return {
    m: {
      div: mockDiv,
      button: makeMotion('button'),
      tbody: makeMotion('tbody'),
      tr: makeMotion('tr'),
    },
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  };
});

/** Helper to create a mock SalesforceOrg. */
function createMockOrg(overrides: Partial<SalesforceOrg> = {}): SalesforceOrg {
  return {
    id: 'org-1',
    alias: 'DevSandbox',
    username: 'admin@dev.sandbox',
    instanceUrl: 'https://dev-sandbox.salesforce.com',
    orgId: '00D000000000001',
    orgType: 'Sandbox',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#3B82F6', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '59.0', edition: 'Developer Edition', features: [] },
    status: 'connected',
    lastConnected: '2024-01-01T00:00:00Z',
    tags: [],
    ...overrides,
  };
}

/** A production org of a paid edition: the fixture's default edition is a Developer Edition's. */
const PRODUCTION = {
  orgType: 'Production' as const,
  metadata: { apiVersion: '59.0', edition: 'Enterprise Edition', features: [] },
};

describe('HomePage', () => {
  beforeEach(() => {
    useAppStore.setState({ currentRoute: 'home', grappeEnabled: false, navigationIntent: null });
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
    useRecentOpsStore.setState({ ops: [] });
    bridgeQueryCalls.length = 0;
    mockOrgListState = {
      data: null,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    mockMonitorState = {
      data: null,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    mockCheckpointListState = {
      data: null,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
    mockSmartActionState = {
      recommendation: null,
      loading: false,
      error: null,
      showConfirmation: false,
      requestConfirm: vi.fn(),
      confirm: vi.fn(),
      cancelConfirm: vi.fn(),
    };
    mockRecovery = { afterRefresh: [], next: {} };
    recoveryAskedOf.length = 0;
    mockSendBridge.mockClear();
  });

  it('offers a checkpoint of the selected org, and none of a production org', () => {
    mockCheckpointListState.data = { checkpoints: [] };
    useOrgStore.setState({ orgs: [createMockOrg()], selectedOrgId: 'org-1' });
    const { unmount } = render(<HomePage />);
    expect(screen.getByTestId('checkpoint-tile-none').textContent).toBe(
      'Take a checkpoint of DevSandbox before your next test session',
    );
    expect(bridgeQueryCalls).toContainEqual({
      requestType: 'checkpoint:list',
      payload: { orgId: 'org-1' },
      skip: false,
    });
    unmount();

    useOrgStore.setState({ orgs: [createMockOrg(PRODUCTION)], selectedOrgId: 'org-1' });
    render(<HomePage />);
    expect(screen.queryByTestId('checkpoint-tile')).toBeNull();
  });

  /** Two connected orgs to copy between: what Forge needs, so Home leads with it. */
  function connectTwoOrgs(): void {
    useOrgStore.setState({
      orgs: [createMockOrg(), createMockOrg({ id: 'org-2', alias: 'QASandbox' })],
      selectedOrgId: 'org-1',
    });
  }

  it('should render the home page', () => {
    render(<HomePage />);
    expect(screen.getByTestId('home-page')).toBeDefined();
  });

  /* ---------------------------------------------------------------- */
  /* The hero, chosen by the orgs connected                            */
  /* ---------------------------------------------------------------- */

  it('leads with Getting started and its heading when no org is connected, not with Forge', () => {
    // Forge, which copies from one org into another, held the hero and the
    // page's only h1 with no org at all; the card that connects one was last.
    render(<HomePage />);

    const hero = screen.getByTestId('getting-started-card');
    expect(within(hero).getByRole('heading', { level: 1 }).textContent).toBe('Getting started');
    expect(screen.getByText('Connect your first Salesforce org')).toBeDefined();
    expect(screen.queryByTestId('forge-hero-card')).toBeNull();
    expect(hero.parentElement?.className).toContain('col-span-2');
  });

  it('offers the two ways to connect by the names Organizations gives them, each starting there', () => {
    render(<HomePage />);

    const importButton = screen.getByTestId('home-import-cli-btn');
    expect(importButton.textContent).toBe('Import from Salesforce CLI');
    fireEvent.click(importButton);
    expect(useAppStore.getState().navigationIntent).toEqual({
      route: 'orgs',
      orgAction: 'import-cli',
    });

    fireEvent.click(screen.getByTestId('home-login-web-btn'));
    expect(screen.getByTestId('home-login-web-btn').textContent).toBe('Log in with your browser');
    expect(useAppStore.getState().navigationIntent).toEqual({
      route: 'orgs',
      orgAction: 'login-web',
    });
  });

  it('leads with filling the one org connected, as the side panel does, when it is one to fill', () => {
    useOrgStore.setState({
      orgs: [createMockOrg({ orgType: 'Developer' })],
      selectedOrgId: 'org-1',
    });
    render(<HomePage />);

    const hero = screen.getByTestId('fill-hero-card');
    expect(within(hero).getByRole('heading', { level: 1 }).textContent).toBe(
      'Fill DevSandbox with demo data',
    );
    expect(screen.queryByTestId('forge-hero-card')).toBeNull();
    expect(screen.queryByTestId('getting-started-card')).toBeNull();
    // The hero offers the fill: the quick action does not say it twice.
    expect(screen.queryByTestId('fill-org-btn')).toBeNull();

    fireEvent.click(screen.getByTestId('fill-hero-btn'));
    expect(useAppStore.getState().navigationIntent).toEqual({
      route: 'seed',
      seedMode: 'quick-seed',
      targetOrgId: 'org-1',
    });
  });

  it('leads with Forge once two orgs are connected, one of them to fill', () => {
    connectTwoOrgs();
    render(<HomePage />);
    expect(screen.getByTestId('forge-hero-card')).toBeDefined();
    expect(screen.queryByTestId('fill-hero-card')).toBeNull();
  });

  it('leads a production org alone to the sandbox to add, not to a Forge that could only refuse', () => {
    // Forge copies from the production org into a sandbox, and there was none
    // to copy into: the hero offered it all the same.
    useOrgStore.setState({
      orgs: [createMockOrg({ ...PRODUCTION, alias: 'Live' })],
      selectedOrgId: 'org-1',
    });
    render(<HomePage />);

    expect(screen.queryByTestId('forge-hero-card')).toBeNull();
    const hero = screen.getByTestId('home-add-sandbox-hero');
    expect(within(hero).getByRole('heading', { level: 1 }).textContent).toBe(
      'Add the sandbox to fill',
    );
    expect(hero.textContent).toContain('Forge copies real records from Live into it');

    fireEvent.click(within(hero).getByRole('button', { name: 'Log in with your browser' }));
    expect(useAppStore.getState().navigationIntent).toEqual({
      route: 'orgs',
      orgAction: 'login-web',
    });
    fireEvent.click(within(hero).getByRole('button', { name: 'Import from Salesforce CLI' }));
    expect(useAppStore.getState().navigationIntent).toEqual({
      route: 'orgs',
      orgAction: 'import-cli',
    });
  });

  it('asks to reconnect the org whose session ended, rather than to connect a first one', () => {
    // Every session expired: Home said "Connect your first org" to a person
    // with two orgs registered, while the launcher offered Forge.
    useOrgStore.setState({
      orgs: [
        createMockOrg({ status: 'expired' }),
        createMockOrg({ id: 'org-2', alias: 'QASandbox', status: 'expired' }),
      ],
      selectedOrgId: 'org-2',
    });
    render(<HomePage />);

    expect(screen.queryByTestId('getting-started-card')).toBeNull();
    const hero = screen.getByTestId('home-reconnect-hero');
    expect(within(hero).getByRole('heading', { level: 1 }).textContent).toBe('Reconnect QASandbox');
    expect(hero.textContent).toContain('Its session has ended: sign in again from Organizations');
    fireEvent.click(within(hero).getByRole('button', { name: 'Open Organizations' }));
    expect(useAppStore.getState().currentRoute).toBe('orgs');
  });

  it('asks where every registered org stands after a refresh once the list is in, and not before', () => {
    mockOrgListState.loading = true;
    const { unmount } = render(<HomePage />);
    expect(recoveryAskedOf.at(-1)).toBeUndefined();
    unmount();

    mockOrgListState.loading = false;
    connectTwoOrgs();
    render(<HomePage />);
    expect(recoveryAskedOf.at(-1)?.map((org) => org.id)).toEqual(['org-1', 'org-2']);
  });

  describe('after a sandbox refresh', () => {
    const REFRESHED: RecoveryProgress = {
      orgId: 'org-2',
      alias: 'QASandbox',
      detectedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      done: 3,
      total: 9,
    };

    it('leads with bringing the sandbox back into service, how far it is and its next step', () => {
      connectTwoOrgs();
      mockRecovery = { afterRefresh: [REFRESHED], next: { 'org-2': 'masking' } };
      render(<HomePage />);

      expect(screen.queryByTestId('forge-hero-card')).toBeNull();
      const hero = screen.getByTestId('home-after-refresh-hero');
      expect(within(hero).getByRole('heading', { level: 1 }).textContent).toBe(
        'Bring QASandbox back into service',
      );
      expect(screen.getByTestId('home-after-refresh-progress').textContent).toBe(
        'Refreshed 2 hours ago · 3/9 steps',
      );
      expect(screen.getByTestId('home-after-refresh-bar').style.width).toBe(`${(3 / 9) * 100}%`);
      expect(screen.getByTestId('home-after-refresh-next').textContent).toBe(
        'Next step: Mask the data copied from production',
      );
    });

    it('opens Back into service on the sandbox refreshed, selected here and in the extension', () => {
      connectTwoOrgs();
      mockRecovery = { afterRefresh: [REFRESHED], next: { 'org-2': 'users' } };
      render(<HomePage />);

      fireEvent.click(screen.getByRole('button', { name: 'Open Back into service' }));
      expect(useOrgStore.getState().selectedOrgId).toBe('org-2');
      expect(mockSendBridge).toHaveBeenCalledWith('org:select', { orgId: 'org-2' });
      expect(useAppStore.getState().currentRoute).toBe('recovery');
    });

    it('says no next step when every step left is done', () => {
      connectTwoOrgs();
      mockRecovery = { afterRefresh: [REFRESHED], next: {} };
      render(<HomePage />);
      expect(screen.getByTestId('home-after-refresh-hero')).toBeDefined();
      expect(screen.queryByTestId('home-after-refresh-next')).toBeNull();
    });

    it('leads with Forge again once the recovery is through', () => {
      connectTwoOrgs();
      mockRecovery = { afterRefresh: [{ ...REFRESHED, done: 9 }], next: {} };
      render(<HomePage />);
      expect(screen.queryByTestId('home-after-refresh-hero')).toBeNull();
      expect(screen.getByTestId('forge-hero-card')).toBeDefined();
    });
  });

  it('holds the hero while the org list is in flight, rather than calling the panel empty', () => {
    mockOrgListState.loading = true;
    render(<HomePage />);
    expect(screen.getByTestId('home-hero-loading')).toBeDefined();
    expect(screen.queryByTestId('getting-started-card')).toBeNull();
  });

  it('should show skeleton loading when orgs are loading', () => {
    mockOrgListState.loading = true;
    render(<HomePage />);
    expect(screen.getByTestId('home-loading')).toBeDefined();
    const skeletons = within(screen.getByTestId('home-loading')).getAllByTestId('skeleton');
    expect(skeletons).toHaveLength(2);
  });

  /* ---------------------------------------------------------------- */
  /* Connected orgs                                                    */
  /* ---------------------------------------------------------------- */

  it('should show connected orgs in health tile when available', () => {
    const mockOrg = createMockOrg();
    useOrgStore.setState({ orgs: [mockOrg] });
    render(<HomePage />);
    expect(screen.getByTestId('connected-orgs-card')).toBeDefined();
    expect(screen.getAllByText('DevSandbox').length).toBeGreaterThan(0);
  });

  it('names the org tile for what it lists, not a health it does not measure', () => {
    render(<HomePage />);
    const tile = screen.getByTestId('health-tile');
    expect(within(tile).getAllByRole('heading', { level: 3 })[0].textContent).toBe(
      'Connected orgs',
    );
    expect(screen.queryByText('Sandbox Health')).toBeNull();
  });

  it('gives the empty org tile a way to connect one', () => {
    render(<HomePage />);
    const tile = screen.getByTestId('health-tile');
    const action = within(tile).getByRole('button', { name: 'Connect an org' });
    fireEvent.click(action);
    expect(useAppStore.getState().currentRoute).toBe('orgs');
  });

  it('keeps the org health in the KPI row, beside the runs of the week, and opens the Monitor from it', () => {
    // The score and the API usage sat in a row of their own at the foot of the
    // page, under a "Health summary" that said nothing, apart from the limit
    // warnings at its head; none of them led to the Monitor.
    useOrgStore.setState({ orgs: [createMockOrg()], selectedOrgId: 'org-1' });
    render(<HomePage />);
    const row = screen.getByTestId('home-kpi-row');
    expect(row.children).toHaveLength(2);
    expect(within(row).getByTestId('kpi-card').textContent).toContain('Ops (7 days)');
    const health = within(row).getByTestId('home-org-health');
    expect(health.textContent).toContain('Org health');
    expect(screen.queryByTestId('health-summary')).toBeNull();

    fireEvent.click(health);
    expect(useAppStore.getState().currentRoute).toBe('monitor');
  });

  it('counts neither the orgs, listed beside the hero, nor the jobs, which only the runs seen here fed', () => {
    useOrgStore.setState({ orgs: [createMockOrg()], selectedOrgId: 'org-1' });
    render(<HomePage />);
    const row = screen.getByTestId('home-kpi-row');
    expect(row.textContent).not.toContain('Orgs connected');
    expect(row.textContent).not.toContain('Active jobs');
  });

  it('shows no org health while no org is connected, nothing being there to measure', () => {
    render(<HomePage />);
    expect(screen.getByTestId('home-kpi-row').children).toHaveLength(1);
    expect(screen.queryByTestId('home-org-health')).toBeNull();
  });

  it('should not show getting started when orgs are connected', () => {
    useOrgStore.setState({ orgs: [createMockOrg()] });
    render(<HomePage />);
    expect(screen.queryByTestId('getting-started-card')).toBeNull();
  });

  /* ---------------------------------------------------------------- */
  /* All modules                                                       */
  /* ---------------------------------------------------------------- */

  it('lists every module by the launcher’s groups where three quick actions stood', () => {
    // Quick actions opened Forge, Monitor and Automation, and nothing else:
    // the page the launcher's Home button opens listed fewer modules than it.
    connectTwoOrgs();
    render(<HomePage />);
    const tile = screen.getByTestId('quick-actions-tile');
    expect(within(tile).getByRole('heading', { level: 3 }).textContent).toBe('All modules');
    expect(within(tile).getAllByRole('group')).toHaveLength(5);
    expect(screen.getByTestId('open-recovery-btn')).toBeDefined();
    expect(screen.queryByText('Open Automation')).toBeNull();

    fireEvent.click(screen.getByTestId('open-forge-btn'));
    expect(useAppStore.getState().currentRoute).toBe('forge');
  });

  it('lists Back into service once a sandbox is registered, as the launcher does', () => {
    useOrgStore.setState({
      orgs: [createMockOrg({ orgType: 'Developer' }), createMockOrg({ ...PRODUCTION, id: 'p' })],
    });
    render(<HomePage />);
    expect(screen.queryByTestId('open-recovery-btn')).toBeNull();
  });

  it('offers no Grappe, whose page is retired, whatever its setting says', () => {
    useAppStore.setState({ grappeEnabled: true });
    render(<HomePage />);
    expect(screen.queryByTestId('quick-grappe-btn')).toBeNull();
    expect(screen.queryByTestId('open-grappe-btn')).toBeNull();
  });

  it('says the fill once, in the hero, rather than again among the modules', () => {
    // "Fill DevSandbox with demo data" stood among the quick actions under a
    // hero that already offered it, or offered Forge.
    connectTwoOrgs();
    render(<HomePage />);
    expect(screen.queryByTestId('fill-org-btn')).toBeNull();
  });

  it('says nothing is empty that nothing measured: no banner over the page', () => {
    // "Your sandbox is empty" showed for any sandbox, a full copy marked
    // Staging included, beside the recommendation that did count.
    useOrgStore.setState({ orgs: [createMockOrg({ orgType: 'Sandbox', staging: true })] });
    render(<HomePage />);
    expect(screen.queryByTestId('sandbox-banner')).toBeNull();
    expect(screen.getByTestId('home-page').textContent).not.toContain('Your org is empty');
  });

  /* ---------------------------------------------------------------- */
  /* Recent operations                                                 */
  /* ---------------------------------------------------------------- */

  it('should render recent operations section', () => {
    render(<HomePage />);
    expect(screen.getByTestId('recent-ops-card')).toBeDefined();
  });

  it('should show empty state for recent operations when none exist', () => {
    render(<HomePage />);
    expect(screen.getByText('No recent operations')).toBeDefined();
  });

  it('says an operation whose time is not a number happened at an unknown time', () => {
    // Every sum on it was NaN: the row read "NaN h ago".
    useRecentOpsStore.setState({
      ops: [
        {
          id: 'op-1',
          type: 'sync',
          label: 'Sync Accounts',
          status: 'success',
          timestamp: '2026-09-23T10:00:00Z' as unknown as number,
        },
      ],
    });
    render(<HomePage />);

    const row = screen.getByTestId('recent-op-item');
    expect(row.textContent).toContain('unknown');
    expect(row.textContent).not.toContain('NaN');
  });

  it('opens the page of the module that ran an operation when its row is clicked', () => {
    // A "Failed — Sync Contacts" row led nowhere: it was a plain line.
    useRecentOpsStore.setState({
      ops: [
        {
          id: 'op-1',
          type: 'sync',
          label: 'Sync Contacts',
          status: 'failed',
          timestamp: Date.now() - 60_000,
        },
      ],
    });
    render(<HomePage />);

    const row = within(screen.getByTestId('recent-ops-card')).getByRole('button', {
      name: /Sync/,
    });
    expect(row).toBe(screen.getByTestId('recent-op-item'));
    expect(row.getAttribute('title')).toBe('Open Sync');
    fireEvent.click(row);
    expect(useAppStore.getState().currentRoute).toBe('sync');
  });

  it('names a run by its module and its status in the panel’s language, not by the extension’s English', async () => {
    // "Succeeded · Executing forge operation": the extension's phrase, in
    // English and in the present, for a run that had ended.
    useRecentOpsStore.setState({
      ops: [
        {
          id: 'op-1',
          type: 'forge',
          label: 'Executing forge operation',
          status: 'success',
          timestamp: Date.now() - 60_000,
        },
      ],
    });
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await i18n.changeLanguage('fr');
    try {
      render(<HomePage />);
      const row = screen.getByTestId('recent-op-item');
      expect(within(row).getByTestId('recent-op-module').textContent).toBe('Forge');
      expect(row.textContent).toContain('Réussie');
      expect(row.textContent).not.toContain('Executing');
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('should use bridge data when store is empty', () => {
    mockOrgListState.data = {
      orgs: [createMockOrg({ id: 'bridge-org', alias: 'BridgeOrg' })],
    };
    render(<HomePage />);
    expect(screen.getAllByText(/BridgeOrg/).length).toBeGreaterThan(0);
  });

  /* ---------------------------------------------------------------- */
  /* New bento layout tests                                            */
  /* ---------------------------------------------------------------- */

  it('should render the KPI row', () => {
    render(<HomePage />);
    expect(screen.getByTestId('home-kpi-row')).toBeDefined();
  });

  it('should render the forge hero card', () => {
    connectTwoOrgs();
    render(<HomePage />);
    const hero = screen.getByTestId('forge-hero-card');
    expect(within(hero).getByText('Forge a sandbox')).toBeDefined();
    expect(
      within(hero).getByText('Copy a real record and everything around it into another org'),
    ).toBeDefined();
  });

  it('should navigate to forge on Start Forge click', () => {
    connectTwoOrgs();
    useOrgStore.setState({ selectedOrgId: null });
    render(<HomePage />);
    const startBtn = screen.getByTestId('start-forge-btn');
    expect(startBtn).toBeDefined();
    fireEvent.click(startBtn);
    expect(useAppStore.getState().currentRoute).toBe('forge');
    // Empty field -- the button is a plain CTA, it must not hand over a record.
    expect(useAppStore.getState().navigationIntent).toBeNull();
  });

  it('should render the health tile', () => {
    render(<HomePage />);
    expect(screen.getByTestId('health-tile')).toBeDefined();
  });

  it('should render the recent ops tile', () => {
    render(<HomePage />);
    expect(screen.getByTestId('recent-ops-tile')).toBeDefined();
  });

  it('should render the all modules tile', () => {
    render(<HomePage />);
    expect(screen.getByTestId('quick-actions-tile')).toBeDefined();
  });

  it('should render the forge record input', () => {
    connectTwoOrgs();
    render(<HomePage />);
    expect(screen.getByTestId('forge-record-input')).toBeDefined();
  });

  /* ---------------------------------------------------------------- */
  /* Hero record-id wiring                                             */
  /* ---------------------------------------------------------------- */

  it('hands the typed record id and the selected org over to Forge with the navigation', () => {
    connectTwoOrgs();
    render(<HomePage />);
    fireEvent.change(screen.getByTestId('forge-record-input'), {
      target: { value: '0015g00000ABCDEAA3' },
    });
    fireEvent.click(screen.getByTestId('start-forge-btn'));

    expect(useAppStore.getState().navigationIntent).toEqual({
      route: 'forge',
      recordId: '0015g00000ABCDEAA3',
      sourceOrgId: 'org-1',
    });
    expect(useAppStore.getState().currentRoute).toBe('forge');
  });

  it('should extract the record id from a pasted Salesforce URL', () => {
    connectTwoOrgs();
    render(<HomePage />);
    fireEvent.change(screen.getByTestId('forge-record-input'), {
      target: {
        value: 'https://acme.lightning.force.com/lightning/r/Account/0015g00000ABCDEAA3/view',
      },
    });
    fireEvent.click(screen.getByTestId('start-forge-btn'));

    expect(useAppStore.getState().navigationIntent?.recordId).toBe('0015g00000ABCDEAA3');
  });

  it('hands the record id over when Enter is pressed in the record input', () => {
    connectTwoOrgs();
    render(<HomePage />);
    const input = screen.getByTestId('forge-record-input');
    fireEvent.change(input, { target: { value: '0015g00000ABCDEAA3' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(useAppStore.getState().navigationIntent?.recordId).toBe('0015g00000ABCDEAA3');
    expect(useAppStore.getState().currentRoute).toBe('forge');
  });

  it('should keep focus in the field and not navigate when the record id is unparseable', () => {
    connectTwoOrgs();
    render(<HomePage />);
    const input = screen.getByTestId('forge-record-input');
    fireEvent.change(input, { target: { value: 'not-an-id' } });
    fireEvent.click(screen.getByTestId('start-forge-btn'));

    expect(useAppStore.getState().currentRoute).toBe('home');
    expect(useAppStore.getState().navigationIntent).toBeNull();
    expect(document.activeElement).toBe(input);
    expect(screen.getByTestId('forge-record-error')).toBeDefined();
  });

  it('should size the forge hero tile to its content rather than spanning two rows', () => {
    connectTwoOrgs();
    render(<HomePage />);
    const tile = screen.getByTestId('forge-hero-card').parentElement;
    expect(tile?.className).toContain('col-span-2');
    expect(tile?.className).not.toContain('row-span-2');
  });

  /* ---------------------------------------------------------------- */
  /* Org health summary (sourced, never invented)                      */
  /* ---------------------------------------------------------------- */

  /** Reads the value of the org health figure `testId`. */
  function kpiValue(testId: string): string {
    return screen.getByTestId(testId).querySelector('[data-testid="kpi-value"]')?.textContent ?? '';
  }

  it('should skip the health query and show a dash when no org is selected', () => {
    useOrgStore.setState({ orgs: [createMockOrg()], selectedOrgId: null });
    render(<HomePage />);

    const monitorCall = bridgeQueryCalls.find((c) => c.requestType === 'monitor:refresh');
    expect(monitorCall?.skip).toBe(true);
    expect(kpiValue('home-limit-warnings')).toBe('—');
    expect(kpiValue('home-health-score')).toBe('—');
    expect(kpiValue('home-api-usage')).toBe('—');
  });

  it('should render limit warnings, health score and api usage from monitor data', () => {
    useOrgStore.setState({ orgs: [createMockOrg()], selectedOrgId: 'org-1' });
    mockMonitorState.data = {
      healthScore: 72,
      limits: [
        { name: 'DailyApiRequests', max: 100, remaining: 25, usedPercent: 75 },
        { name: 'DataStorageMB', max: 100, remaining: 38, usedPercent: 62 },
        { name: 'FileStorageMB', max: 100, remaining: 90, usedPercent: 10 },
      ],
    };
    render(<HomePage />);

    const monitorCall = bridgeQueryCalls.find((c) => c.requestType === 'monitor:refresh');
    expect(monitorCall?.payload).toEqual({ orgId: 'org-1' });
    expect(monitorCall?.skip).toBe(false);
    expect(kpiValue('home-limit-warnings')).toBe('2');
    expect(kpiValue('home-health-score')).toBe('72%');
    expect(kpiValue('home-api-usage')).toBe('75%');
  });

  it('should show a skeleton instead of a health number while the query is in flight', () => {
    useOrgStore.setState({ orgs: [createMockOrg()], selectedOrgId: 'org-1' });
    mockMonitorState.loading = true;
    render(<HomePage />);

    const health = screen.getByTestId('home-org-health');
    expect(within(health).queryByTestId('kpi-value')).toBeNull();
    expect(within(health).getAllByTestId('skeleton')).toHaveLength(3);
  });

  it('should display recent ops from the store', () => {
    useRecentOpsStore.setState({
      ops: [
        {
          id: 'op-1',
          type: 'seed',
          label: 'Seed Accounts',
          status: 'success',
          timestamp: Date.now() - 120000,
          recordCount: 100,
        },
      ],
    });
    render(<HomePage />);
    expect(screen.getByTestId('recent-op-module').textContent).toBe('Seed');
    expect(screen.queryByText('Seed Accounts')).toBeNull();
    expect(screen.getAllByTestId('recent-op-item').length).toBe(1);
  });

  it('says a partial op was partial, and not a success', () => {
    useRecentOpsStore.setState({
      ops: [
        {
          id: 'op-1',
          type: 'seed',
          label: 'Seed Accounts',
          status: 'partial',
          timestamp: Date.now() - 60000,
        },
      ],
    });

    render(<HomePage />);

    const badge = within(screen.getByTestId('recent-op-item')).getByText('Partial');
    expect(badge.className).toContain('bg-status-warning');
  });

  it('says a cancelled op was cancelled, in the panel’s language and not as a success', async () => {
    // A cancelled backup or Forge discovery used to read as a success here,
    // and every status was printed as stored, in English.
    useRecentOpsStore.setState({
      ops: [
        {
          id: 'op-2',
          type: 'dataops',
          label: 'Backup 3 object(s)',
          status: 'cancelled',
          timestamp: Date.now() - 60000,
        },
        {
          id: 'op-1',
          type: 'seed',
          label: 'Seed Accounts',
          status: 'success',
          timestamp: Date.now() - 120000,
        },
      ],
    });
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await i18n.changeLanguage('fr');
    try {
      render(<HomePage />);

      const [cancelled, succeeded] = screen.getAllByTestId('recent-op-item');
      const cancelledBadge = within(cancelled).getByText('Annulée');
      expect(cancelledBadge.className).not.toContain('bg-status-success');
      expect(within(succeeded).getByText('Réussie').className).toContain('bg-status-success');
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  /* ---------------------------------------------------------------- */
  /* Smart Action card tests                                           */
  /* ---------------------------------------------------------------- */

  it('should show SmartActionCard when recommendation is available and orgs connected', () => {
    useOrgStore.setState({ orgs: [createMockOrg()] });
    mockSmartActionState.recommendation = {
      action: 'quick-seed',
      reasonKey: 'home.smartAction.reasonEmpty',
      details: {
        targetOrgId: 'org-1',
        recordCounts: { Account: 0, Contact: 0, Opportunity: 0, Case: 0, Lead: 0 },
      },
    };
    render(<HomePage />);
    expect(screen.getByTestId('smart-action-card')).toBeDefined();
  });

  it('should not show SmartActionCard when recommendation is none', () => {
    useOrgStore.setState({ orgs: [createMockOrg()] });
    mockSmartActionState.recommendation = {
      action: 'none',
      reasonKey: '',
      details: {
        targetOrgId: 'org-1',
        recordCounts: { Account: 50, Contact: 100 },
      },
    };
    render(<HomePage />);
    expect(screen.queryByTestId('smart-action-card')).toBeNull();
  });

  it('should not show SmartActionCard when no orgs connected', () => {
    mockSmartActionState.recommendation = {
      action: 'quick-seed',
      reasonKey: 'home.smartAction.reasonEmpty',
      details: {
        targetOrgId: 'org-1',
        recordCounts: { Account: 0, Contact: 0 },
      },
    };
    render(<HomePage />);
    expect(screen.queryByTestId('smart-action-card')).toBeNull();
  });
});

/*
 * Home words the side panel's and Organizations' acts from its own namespace,
 * since a page loads no other page's English: the same words, kept the same
 * in every language, so one act keeps one name.
 */
describe('Home and the side panel say one act in one set of words', () => {
  const LOCALES = { en, fr, de, es, 'pt-BR': ptBR, ja } as const;

  it.each(Object.entries(LOCALES))('in %s', (_locale, catalogue) => {
    expect(catalogue.home.fillOrg).toBe(catalogue.sidePanel.fillOrg);
    expect(catalogue.home.fillOrgAction).toBe(catalogue.sidePanel.fillOrgAction);
    expect(catalogue.home.fillOrgDesc).toBe(catalogue.sidePanel.fillOrgDesc);
    expect(catalogue.home.importFromCli).toBe(catalogue.auth.sfdxImport);
    expect(catalogue.home.importFromCli).toBe(catalogue.sidePanel.firstOrg.import);
    expect(catalogue.home.loginWeb).toBe(catalogue.auth.oauthWeb);
    expect(catalogue.home.loginWeb).toBe(catalogue.sidePanel.firstOrg.loginWeb);
  });
});
