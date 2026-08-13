import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import { useRecentOpsStore } from '../../stores/useRecentOpsStore';
import { useForgeStore } from '../../stores/useForgeStore';
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

/** Request types seen by useBridgeQuery, in call order. */
const bridgeQueryCalls: Array<{ requestType: string; payload: unknown; skip: boolean }> = [];

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (
    requestType: string,
    payload?: Record<string, unknown>,
    options?: { skip?: boolean },
  ) => {
    bridgeQueryCalls.push({ requestType, payload, skip: options?.skip ?? false });
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

describe('HomePage', () => {
  beforeEach(() => {
    useAppStore.setState({ currentRoute: 'home' });
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
    useRecentOpsStore.setState({ ops: [] });
    useForgeStore.setState({ config: null });
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

  it('should render the home page', () => {
    render(<HomePage />);
    expect(screen.getByTestId('home-page')).toBeDefined();
  });

  it('should show getting started when no orgs connected', () => {
    render(<HomePage />);
    expect(screen.getByText('Getting Started')).toBeDefined();
    expect(screen.getByText('Connect your first Salesforce org')).toBeDefined();
  });

  it('should show connect org button in getting started', () => {
    render(<HomePage />);
    const btn = screen.getByTestId('connect-org-btn');
    expect(btn).toBeDefined();
    fireEvent.click(btn);
    expect(useAppStore.getState().currentRoute).toBe('orgs');
  });

  it('should show skeleton loading when orgs are loading', () => {
    mockOrgListState.loading = true;
    render(<HomePage />);
    expect(screen.getByTestId('home-loading')).toBeDefined();
    const skeletons = screen.getAllByTestId('skeleton');
    expect(skeletons.length).toBeGreaterThanOrEqual(4);
  });

  it('should show connected orgs in health tile when available', () => {
    const mockOrg = createMockOrg();
    useOrgStore.setState({ orgs: [mockOrg] });
    render(<HomePage />);
    expect(screen.getByTestId('connected-orgs-card')).toBeDefined();
    expect(screen.getByText('DevSandbox')).toBeDefined();
  });

  it('should show health summary when orgs are connected', () => {
    useOrgStore.setState({ orgs: [createMockOrg()] });
    render(<HomePage />);
    expect(screen.getByTestId('health-summary')).toBeDefined();
  });

  it('should not show getting started when orgs are connected', () => {
    useOrgStore.setState({ orgs: [createMockOrg()] });
    render(<HomePage />);
    expect(screen.queryByText('Getting Started')).toBeNull();
  });

  it('should render quick actions', () => {
    render(<HomePage />);
    expect(screen.getByTestId('quick-actions-card')).toBeDefined();
    expect(screen.getByTestId('quick-forge-btn')).toBeDefined();
    expect(screen.getByTestId('quick-grappe-btn')).toBeDefined();
    expect(screen.getByTestId('refresh-monitor-btn')).toBeDefined();
    expect(screen.getByTestId('run-pipeline-btn')).toBeDefined();
  });

  it('should navigate to forge on quick forge click', () => {
    render(<HomePage />);
    fireEvent.click(screen.getByTestId('quick-forge-btn'));
    expect(useAppStore.getState().currentRoute).toBe('forge');
  });

  it('should navigate to grappe on quick grappe click', () => {
    render(<HomePage />);
    fireEvent.click(screen.getByTestId('quick-grappe-btn'));
    expect(useAppStore.getState().currentRoute).toBe('grappe');
  });

  it('should navigate to monitor on refresh monitor click', () => {
    render(<HomePage />);
    fireEvent.click(screen.getByTestId('refresh-monitor-btn'));
    expect(useAppStore.getState().currentRoute).toBe('monitor');
  });

  it('should navigate to automation on run pipeline click', () => {
    render(<HomePage />);
    fireEvent.click(screen.getByTestId('run-pipeline-btn'));
    expect(useAppStore.getState().currentRoute).toBe('automation');
  });

  it('should render recent operations section', () => {
    render(<HomePage />);
    expect(screen.getByTestId('recent-ops-card')).toBeDefined();
  });

  it('should show empty state for recent operations when none exist', () => {
    render(<HomePage />);
    expect(screen.getByText('No recent operations')).toBeDefined();
  });

  it('should use bridge data when store is empty', () => {
    mockOrgListState.data = {
      orgs: [createMockOrg({ id: 'bridge-org', alias: 'BridgeOrg' })],
    };
    render(<HomePage />);
    expect(screen.getByText('BridgeOrg')).toBeDefined();
  });

  /* ---------------------------------------------------------------- */
  /* New bento layout tests                                            */
  /* ---------------------------------------------------------------- */

  it('should render the KPI row', () => {
    render(<HomePage />);
    expect(screen.getByTestId('home-kpi-row')).toBeDefined();
  });

  it('should render the forge hero card', () => {
    render(<HomePage />);
    expect(screen.getByTestId('forge-hero-card')).toBeDefined();
    expect(screen.getByText('Forge a Sandbox')).toBeDefined();
    expect(screen.getByText('Clone records with full dependency resolution')).toBeDefined();
  });

  it('should navigate to forge on Start Forge click', () => {
    render(<HomePage />);
    const startBtn = screen.getByTestId('start-forge-btn');
    expect(startBtn).toBeDefined();
    fireEvent.click(startBtn);
    expect(useAppStore.getState().currentRoute).toBe('forge');
    // Empty field -- the button is a plain CTA, it must not seed a config.
    expect(useForgeStore.getState().config).toBeNull();
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
    render(<HomePage />);
    expect(screen.getByTestId('forge-record-input')).toBeDefined();
  });

  /* ---------------------------------------------------------------- */
  /* Hero record-id wiring                                             */
  /* ---------------------------------------------------------------- */

  it('should seed the forge config with the typed record id before navigating', () => {
    useOrgStore.setState({ orgs: [createMockOrg()], selectedOrgId: 'org-1' });
    render(<HomePage />);
    fireEvent.change(screen.getByTestId('forge-record-input'), {
      target: { value: '0015g00000ABCDEAA3' },
    });
    fireEvent.click(screen.getByTestId('start-forge-btn'));

    expect(useForgeStore.getState().config).toMatchObject({
      inputMode: 'record',
      recordId: '0015g00000ABCDEAA3',
      sourceOrgId: 'org-1',
    });
    expect(useAppStore.getState().currentRoute).toBe('forge');
  });

  it('should extract the record id from a pasted Salesforce URL', () => {
    render(<HomePage />);
    fireEvent.change(screen.getByTestId('forge-record-input'), {
      target: {
        value: 'https://acme.lightning.force.com/lightning/r/Account/0015g00000ABCDEAA3/view',
      },
    });
    fireEvent.click(screen.getByTestId('start-forge-btn'));

    expect(useForgeStore.getState().config?.recordId).toBe('0015g00000ABCDEAA3');
  });

  it('should seed the forge config when Enter is pressed in the record input', () => {
    render(<HomePage />);
    const input = screen.getByTestId('forge-record-input');
    fireEvent.change(input, { target: { value: '0015g00000ABCDEAA3' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(useForgeStore.getState().config?.recordId).toBe('0015g00000ABCDEAA3');
    expect(useAppStore.getState().currentRoute).toBe('forge');
  });

  it('should keep focus in the field and not navigate when the record id is unparseable', () => {
    render(<HomePage />);
    const input = screen.getByTestId('forge-record-input');
    fireEvent.change(input, { target: { value: 'not-an-id' } });
    fireEvent.click(screen.getByTestId('start-forge-btn'));

    expect(useAppStore.getState().currentRoute).toBe('home');
    expect(useForgeStore.getState().config).toBeNull();
    expect(document.activeElement).toBe(input);
    expect(screen.getByTestId('forge-record-error')).toBeDefined();
  });

  it('should size the forge hero tile to its content rather than spanning two rows', () => {
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
    expect(kpiValue('Limit Warnings')).toBe('—');
    expect(kpiValue('Health Score')).toBe('—');
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
    expect(kpiValue('Limit Warnings')).toBe('2');
    expect(kpiValue('Health Score')).toBe('72%');
    expect(kpiValue('API usage')).toBe('75%');
  });

  it('should show a skeleton instead of a health number while the query is in flight', () => {
    useOrgStore.setState({ orgs: [createMockOrg()], selectedOrgId: 'org-1' });
    mockMonitorState.loading = true;
    render(<HomePage />);

    expect(screen.queryByText('Limit Warnings')).toBeNull();
    expect(screen.getAllByTestId('skeleton').length).toBeGreaterThan(0);
  });

  it('should show sandbox banner when sandbox org exists', () => {
    useOrgStore.setState({ orgs: [createMockOrg({ orgType: 'Sandbox' })] });
    render(<HomePage />);
    expect(screen.getByTestId('sandbox-banner')).toBeDefined();
  });

  it('should not show sandbox banner when no sandbox org', () => {
    useOrgStore.setState({ orgs: [createMockOrg({ orgType: 'Production' })] });
    render(<HomePage />);
    expect(screen.queryByTestId('sandbox-banner')).toBeNull();
  });

  it('should show populate sandbox button when sandbox org exists', () => {
    useOrgStore.setState({ orgs: [createMockOrg({ orgType: 'Sandbox' })] });
    render(<HomePage />);
    expect(screen.getByTestId('populate-sandbox-btn')).toBeDefined();
  });

  it('should not show populate sandbox button when no sandbox org', () => {
    useOrgStore.setState({ orgs: [createMockOrg({ orgType: 'Production' })] });
    render(<HomePage />);
    expect(screen.queryByTestId('populate-sandbox-btn')).toBeNull();
  });

  it('should navigate to seed when populate sandbox is clicked', () => {
    useOrgStore.setState({ orgs: [createMockOrg({ orgType: 'Sandbox' })] });
    render(<HomePage />);
    fireEvent.click(screen.getByTestId('populate-sandbox-btn'));
    expect(useAppStore.getState().currentRoute).toBe('seed');
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

  /* ---------------------------------------------------------------- */
  /* Smart Action card tests                                           */
  /* ---------------------------------------------------------------- */

  it('should show SmartActionCard when recommendation is available and orgs connected', () => {
    useOrgStore.setState({ orgs: [createMockOrg()] });
    mockSmartActionState.recommendation = {
      action: 'quick-seed',
      confidence: 0.9,
      reason: 'Your sandbox is empty',
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
      confidence: 0,
      reason: '',
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
      confidence: 0.9,
      reason: 'Empty sandbox',
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
