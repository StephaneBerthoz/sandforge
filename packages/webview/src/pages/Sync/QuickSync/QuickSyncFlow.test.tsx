import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../../i18n';
import { QuickSyncFlow } from './QuickSyncFlow';
import { useOrgStore } from '../../../stores/useOrgStore';

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */
const mockOrgs = [
  { id: 'org-1', alias: 'prod', username: 'user@prod.com', instanceUrl: 'https://prod.salesforce.com', orgType: 'production' as const, status: 'connected' as const, safetyTier: 'critical' as const, apiVersion: '59.0', lastConnected: '2024-01-01T00:00:00Z' },
  { id: 'org-2', alias: 'dev1', username: 'user@dev1.com', instanceUrl: 'https://dev1.salesforce.com', orgType: 'sandbox' as const, status: 'connected' as const, safetyTier: 'low' as const, apiVersion: '59.0', lastConnected: '2024-01-01T00:00:00Z' },
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
      return [states[key], (val: unknown) => { states[key] = val; }];
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
