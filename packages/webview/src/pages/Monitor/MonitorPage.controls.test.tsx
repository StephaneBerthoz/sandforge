import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';
import { useOrgStore } from '../../stores/useOrgStore';
import { MonitorPage } from './MonitorPage';

/*
 * The two header controls are icon-only, so their accessible name can only
 * come from aria-label. Kept out of MonitorPage.test.tsx, which covers the
 * panels' behaviour.
 */

vi.mock('../../stores/useAppStore', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ navigate: vi.fn(), currentRoute: 'monitor' }),
}));

vi.mock('recharts', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div style={{ width: 400, height: 200 }}>{children}</div>
    ),
  };
});

const monitorPayload = {
  limits: [{ name: 'DailyApiRequests', max: 15000, remaining: 2550, usedPercent: 83 }],
  jobs: [],
  healthScore: 78,
  lastUpdated: new Date().toISOString(),
};

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: (type: string) => {
    if (type === 'monitor:refresh') {
      return { data: monitorPayload, loading: false, error: null, refetch: vi.fn() };
    }
    if (type === 'monitor:alerts') {
      return { data: { alerts: [] }, loading: false, error: null, refetch: vi.fn() };
    }
    return { data: null, loading: false, error: null, refetch: vi.fn() };
  },
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: () => ({
    mutate: vi.fn(),
    data: null,
    loading: false,
    error: null,
    reset: vi.fn(),
  }),
}));

/** Connected org so the dashboard branch renders instead of an empty state. */
const mockOrg: SalesforceOrg = {
  id: 'org-1',
  alias: 'DevSandbox',
  username: 'admin@dev.sandbox',
  instanceUrl: 'https://dev-sandbox.salesforce.com',
  orgId: '00D000000000001',
  orgType: 'Sandbox',
  authMethod: 'oauth_web',
  safetyTier: OrgSafetyTier.LOW,
  appearance: { color: '#3B82F6', icon: 'cloud', position: 0 },
  metadata: { apiVersion: '59.0', edition: 'Developer', features: [] },
  status: 'connected',
  lastConnected: '2024-01-01T00:00:00Z',
  tags: [],
};

describe('MonitorPage header controls — accessible names', () => {
  beforeEach(() => {
    useOrgStore.setState({ selectedOrgId: 'org-1', orgs: [mockOrg] });
  });

  it('should give the refresh button an accessible name', () => {
    render(<MonitorPage />);
    expect(screen.getByTestId('refresh-btn').getAttribute('aria-label')).toBe('Refresh');
  });

  it('should give the auto-refresh toggle an accessible name and a pressed state', () => {
    render(<MonitorPage />);
    const toggle = screen.getByTestId('auto-refresh-toggle');
    expect(toggle.getAttribute('aria-label')).toBe('Auto-refresh');
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
  });

  it('should expose both controls by their accessible name', () => {
    render(<MonitorPage />);
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Auto-refresh' })).toBeDefined();
  });
});
