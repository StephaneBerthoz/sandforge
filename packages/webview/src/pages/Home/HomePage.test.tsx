import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import { useRecentOpsStore } from '../../stores/useRecentOpsStore';
import { HomePage } from './HomePage';
import type { SalesforceOrg } from '@sandforge/shared';

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

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: () => mockOrgListState,
}));

/* ------------------------------------------------------------------ */
/* Mock framer-motion to avoid animation issues in tests               */
/* ------------------------------------------------------------------ */
const MOTION_KEYS = new Set(['variants', 'initial', 'animate', 'whileHover', 'whileTap', 'transition', 'exit']);

vi.mock('framer-motion', async () => {
  const React = await import('react');
  const makeMotion = <E extends keyof HTMLElementTagNameMap>(tag: E) =>
    React.forwardRef<HTMLElementTagNameMap[E], Record<string, unknown>>(
      (props, ref) => {
        const filtered: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(props)) {
          if (!MOTION_KEYS.has(k)) filtered[k] = v;
        }
        return React.createElement(tag, { ...filtered, ref });
      },
    );
  const mockDiv = makeMotion('div');
  return {
    m: { div: mockDiv },
    motion: { div: mockDiv, button: makeMotion('button'), tbody: makeMotion('tbody'), tr: makeMotion('tr') },
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
    authMethod: 'oauth',
    safetyTier: 'low',
    appearance: { color: '#3B82F6', icon: 'cloud' },
    status: 'connected',
    ...overrides,
  };
}

describe('HomePage', () => {
  beforeEach(() => {
    useAppStore.setState({ currentRoute: 'home' });
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
    useRecentOpsStore.setState({ ops: [] });
    mockOrgListState = {
      data: null,
      loading: false,
      error: null,
      refetch: mockRefetch,
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
});
