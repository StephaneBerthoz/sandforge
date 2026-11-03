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
import type { ApiLimit, SalesforceOrg } from '@sandforge/shared';

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

  it('leads with Forge once two orgs are connected, or one that is not to fill', () => {
    connectTwoOrgs();
    const { unmount } = render(<HomePage />);
    expect(screen.getByTestId('forge-hero-card')).toBeDefined();
    expect(screen.queryByTestId('fill-hero-card')).toBeNull();
    unmount();

    useOrgStore.setState({ orgs: [createMockOrg(PRODUCTION)], selectedOrgId: 'org-1' });
    render(<HomePage />);
    expect(screen.getByTestId('forge-hero-card')).toBeDefined();
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
    const skeletons = screen.getAllByTestId('skeleton');
    expect(skeletons.length).toBeGreaterThanOrEqual(4);
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

  it('should show health summary when orgs are connected', () => {
    useOrgStore.setState({ orgs: [createMockOrg()] });
    render(<HomePage />);
    expect(screen.getByTestId('health-summary')).toBeDefined();
  });

  it('counts the orgs and the active jobs once, in the KPI row, not again under it', () => {
    // The health row repeated both under labels French and German wrote the same.
    useOrgStore.setState({ orgs: [createMockOrg()], selectedOrgId: 'org-1' });
    render(<HomePage />);
    const summary = screen.getByTestId('health-summary');
    expect(within(summary).getAllByTestId('kpi-card')).toHaveLength(2);
    expect(summary.textContent).toContain('Health score');
    expect(summary.textContent).toContain('API usage');
    expect(summary.textContent).not.toContain('Active jobs');
    expect(summary.textContent).not.toContain('Connected orgs');
  });

  it('should not show getting started when orgs are connected', () => {
    useOrgStore.setState({ orgs: [createMockOrg()] });
    render(<HomePage />);
    expect(screen.queryByTestId('getting-started-card')).toBeNull();
  });

  /* ---------------------------------------------------------------- */
  /* Quick actions                                                     */
  /* ---------------------------------------------------------------- */

  it('names each quick action by the page it opens, since none does more', () => {
    // Quick Forge, Refresh Monitor and Open Pipelines opened Forge, Monitor
    // and Automation: Refresh refreshed nothing, Pipelines named no page.
    render(<HomePage />);
    const quick = screen.getByTestId('quick-actions-card');
    const buttons = within(quick).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Open Forge',
      'Open Monitor',
      'Open Automation',
    ]);

    fireEvent.click(screen.getByTestId('open-forge-btn'));
    expect(useAppStore.getState().currentRoute).toBe('forge');
    fireEvent.click(screen.getByTestId('open-monitor-btn'));
    expect(useAppStore.getState().currentRoute).toBe('monitor');
    fireEvent.click(screen.getByTestId('open-automation-btn'));
    expect(useAppStore.getState().currentRoute).toBe('automation');
  });

  it('offers Grappe only while sandforge.grappe.enabled is on: off, its page is empty', () => {
    useAppStore.setState({ grappeEnabled: false });
    const { unmount } = render(<HomePage />);
    expect(screen.queryByTestId('quick-grappe-btn')).toBeNull();
    unmount();

    useAppStore.setState({ grappeEnabled: true });
    render(<HomePage />);
    expect(screen.getByTestId('quick-grappe-btn')).toBeDefined();
  });

  it('should navigate to grappe on quick grappe click', () => {
    useAppStore.setState({ grappeEnabled: true });
    render(<HomePage />);
    fireEvent.click(screen.getByTestId('quick-grappe-btn'));
    expect(useAppStore.getState().currentRoute).toBe('grappe');
  });

  it('names the fill quick action as the side panel and Organizations do, with the org it fills', () => {
    // It read "Populate Sandbox", for a scratch org or a Developer Edition too.
    const prod = createMockOrg({ ...PRODUCTION, id: 'prod', alias: 'Live' });
    const sandbox = createMockOrg({ orgType: 'Sandbox', id: 'sbx', alias: 'UAT' });
    useOrgStore.setState({ orgs: [prod, sandbox], selectedOrgId: 'prod' });
    render(<HomePage />);

    const fill = screen.getByTestId('fill-org-btn');
    expect(fill.textContent).toBe('Fill UAT with demo data');
    expect(screen.queryByText('Populate Sandbox')).toBeNull();
    fireEvent.click(fill);
    expect(useAppStore.getState().navigationIntent).toMatchObject({
      route: 'seed',
      seedMode: 'quick-seed',
      targetOrgId: 'sbx',
    });
  });

  it('offers to fill a Developer Edition org, as a sandbox', () => {
    // A Trailhead playground is one: it was taken for a production org, and
    // the Home page offered nothing to fill it with.
    useOrgStore.setState({
      orgs: [
        createMockOrg({ ...PRODUCTION, id: 'prod' }),
        createMockOrg({
          id: 'de',
          alias: 'Playground',
          orgType: 'Developer',
          metadata: { apiVersion: '59.0', edition: 'Developer Edition', features: [] },
        }),
      ],
    });
    render(<HomePage />);
    expect(screen.getByTestId('fill-org-btn').textContent).toBe('Fill Playground with demo data');
  });

  it('offers to fill no production org', () => {
    useOrgStore.setState({ orgs: [createMockOrg(PRODUCTION)] });
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

    const row = screen.getByRole('button', { name: /Sync Contacts/ });
    expect(row).toBe(screen.getByTestId('recent-op-item'));
    expect(row.getAttribute('title')).toBe('Open Sync');
    fireEvent.click(row);
    expect(useAppStore.getState().currentRoute).toBe('sync');
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
    expect(screen.getByTestId('forge-hero-card')).toBeDefined();
    expect(screen.getByText('Forge a sandbox')).toBeDefined();
    expect(
      screen.getByText('Copy a real record and everything around it into another org'),
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

  it('should render the quick actions tile', () => {
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

  /** Reads the value of the KPI card whose text contains `label`. */
  function kpiValue(label: string): string {
    const card = screen.getAllByTestId('kpi-card').find((c) => c.textContent?.includes(label));
    return card?.querySelector('[data-testid="kpi-value"]')?.textContent ?? '';
  }

  it('should skip the health query and show a dash when no org is selected', () => {
    useOrgStore.setState({ orgs: [createMockOrg()], selectedOrgId: null });
    render(<HomePage />);

    const monitorCall = bridgeQueryCalls.find((c) => c.requestType === 'monitor:refresh');
    expect(monitorCall?.skip).toBe(true);
    expect(kpiValue('Limit warnings')).toBe('—');
    expect(kpiValue('Health score')).toBe('—');
    expect(kpiValue('API usage')).toBe('—');
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
    expect(kpiValue('Limit warnings')).toBe('2');
    expect(kpiValue('Health score')).toBe('72%');
    expect(kpiValue('API usage')).toBe('75%');
  });

  it('should show a skeleton instead of a health number while the query is in flight', () => {
    useOrgStore.setState({ orgs: [createMockOrg()], selectedOrgId: 'org-1' });
    mockMonitorState.loading = true;
    render(<HomePage />);

    expect(screen.queryByText('Limit warnings')).toBeNull();
    expect(screen.getAllByTestId('skeleton').length).toBeGreaterThan(0);
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
    expect(screen.getByText('Seed Accounts')).toBeDefined();
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
