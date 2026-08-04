import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../../i18n';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';
import { QuickSyncFlow } from './QuickSyncFlow';
import { useOrgStore } from '../../../stores/useOrgStore';

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */
const mockOrgs: SalesforceOrg[] = [
  {
    id: 'org-1',
    alias: 'prod',
    username: 'user@prod.com',
    instanceUrl: 'https://prod.salesforce.com',
    orgId: '00D000000000001',
    orgType: 'Production',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.CRITICAL,
    appearance: { color: '#c23934', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '59.0', edition: 'Enterprise Edition', features: [] },
    status: 'connected',
    lastConnected: '2024-01-01T00:00:00Z',
    tags: [],
  },
  {
    id: 'org-2',
    alias: 'dev1',
    username: 'user@dev1.com',
    instanceUrl: 'https://dev1.salesforce.com',
    orgId: '00D000000000002',
    orgType: 'Sandbox',
    authMethod: 'oauth_web',
    safetyTier: OrgSafetyTier.LOW,
    appearance: { color: '#0070d2', icon: 'cloud', position: 1 },
    metadata: { apiVersion: '59.0', edition: 'Developer Edition', features: [] },
    status: 'connected',
    lastConnected: '2024-01-01T00:00:00Z',
    tags: [],
  },
];

vi.mock('../../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: () => ({
    mutate: vi.fn(),
    data: null,
    loading: false,
    error: null,
    reset: vi.fn(),
  }),
}));

vi.mock('../../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: () => ({
    data: [],
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock('../../../hooks/useWebviewPersistedState', () => {
  const states: Record<string, unknown> = {};
  return {
    useWebviewPersistedState: (key: string, initial: unknown) => {
      if (!(key in states)) {
        states[key] = initial;
      }
      return [
        states[key],
        (val: unknown) => {
          states[key] = val;
        },
      ];
    },
  };
});

describe('QuickSyncFlow', () => {
  beforeEach(() => {
    useOrgStore.setState({ orgs: mockOrgs });
  });

  it('renders OrgStep as first screen', () => {
    render(<QuickSyncFlow onBack={vi.fn()} />);

    expect(screen.getByTestId('quick-sync-flow')).toBeDefined();
    expect(screen.getByTestId('quick-sync-org-step')).toBeDefined();
  });

  it('renders "Back to full wizard" link', () => {
    render(<QuickSyncFlow onBack={vi.fn()} />);

    expect(screen.getByTestId('quick-sync-back-to-wizard')).toBeDefined();
    expect(screen.getByText('Back to full wizard')).toBeDefined();
  });

  it('calls onBack when "Back to full wizard" link is clicked', () => {
    const onBack = vi.fn();
    render(<QuickSyncFlow onBack={onBack} />);

    fireEvent.click(screen.getByTestId('quick-sync-back-to-wizard'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('renders step indicator with 3 steps', () => {
    render(<QuickSyncFlow onBack={vi.fn()} />);

    const indicator = screen.getByTestId('quick-sync-step-indicator');
    expect(indicator).toBeDefined();
    expect(screen.getByText('Orgs')).toBeDefined();
    expect(screen.getByText('Objects')).toBeDefined();
    expect(screen.getByText('Preview')).toBeDefined();
  });
});
