import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useOrgStore } from '../../stores/useOrgStore';
import { useAppStore } from '../../stores/useAppStore';
import { useSmartAction } from './useSmartAction';
import type { SalesforceOrg, SmartActionRecommendation } from '@sandforge/shared';

const mockRefetch = vi.fn();

let mockQueryState = {
  data: null as { recommendation: SmartActionRecommendation } | null,
  loading: false,
  error: null as string | null,
  refetch: mockRefetch,
};

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: () => mockQueryState,
}));

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

describe('useSmartAction', () => {
  beforeEach(() => {
    useOrgStore.setState({ orgs: [], selectedOrgId: null });
    useAppStore.setState({ currentRoute: 'home' });
    mockQueryState = {
      data: null,
      loading: false,
      error: null,
      refetch: mockRefetch,
    };
  });

  it('should return null recommendation when no orgs connected', () => {
    const { result } = renderHook(() => useSmartAction());
    expect(result.current.recommendation).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('should return recommendation from bridge query', () => {
    useOrgStore.setState({ orgs: [createMockOrg()] });
    mockQueryState.data = {
      recommendation: {
        action: 'quick-seed',
        confidence: 0.9,
        reason: 'Your sandbox is empty',
        reasonKey: 'home.smartAction.reasonEmpty',
        details: {
          targetOrgId: 'org-1',
          recordCounts: { Account: 0, Contact: 0, Opportunity: 0, Case: 0, Lead: 0 },
        },
      },
    };

    const { result } = renderHook(() => useSmartAction());
    expect(result.current.recommendation?.action).toBe('quick-seed');
    expect(result.current.recommendation?.confidence).toBe(0.9);
  });

  it('should manage confirmation flow', () => {
    useOrgStore.setState({ orgs: [createMockOrg()] });
    mockQueryState.data = {
      recommendation: {
        action: 'quick-seed',
        confidence: 0.9,
        reason: 'Empty sandbox',
        reasonKey: 'home.smartAction.reasonEmpty',
        details: {
          targetOrgId: 'org-1',
          recordCounts: { Account: 0, Contact: 0, Opportunity: 0, Case: 0, Lead: 0 },
        },
      },
    };

    const { result } = renderHook(() => useSmartAction());

    expect(result.current.showConfirmation).toBe(false);

    act(() => {
      result.current.requestConfirm();
    });
    expect(result.current.showConfirmation).toBe(true);

    act(() => {
      result.current.cancelConfirm();
    });
    expect(result.current.showConfirmation).toBe(false);
  });

  it('should navigate to seed on confirm for quick-seed action', () => {
    useOrgStore.setState({ orgs: [createMockOrg()] });
    mockQueryState.data = {
      recommendation: {
        action: 'quick-seed',
        confidence: 0.9,
        reason: 'Empty sandbox',
        reasonKey: 'home.smartAction.reasonEmpty',
        details: {
          targetOrgId: 'org-1',
          recordCounts: { Account: 0, Contact: 0, Opportunity: 0, Case: 0, Lead: 0 },
        },
      },
    };

    const { result } = renderHook(() => useSmartAction());

    act(() => {
      result.current.requestConfirm();
    });
    act(() => {
      result.current.confirm();
    });

    expect(result.current.showConfirmation).toBe(false);
    expect(useAppStore.getState().currentRoute).toBe('seed');
  });

  it('should navigate to grappe on confirm for sync action', () => {
    useOrgStore.setState({
      orgs: [
        createMockOrg({ id: 'target-1' }),
        createMockOrg({ id: 'source-1', alias: 'SourceOrg' }),
      ],
    });
    mockQueryState.data = {
      recommendation: {
        action: 'sync',
        confidence: 0.7,
        reason: 'Both have data',
        reasonKey: 'home.smartAction.reasonSync',
        details: {
          targetOrgId: 'target-1',
          sourceOrgId: 'source-1',
          recordCounts: { Account: 50, Contact: 100 },
        },
      },
    };

    const { result } = renderHook(() => useSmartAction());

    act(() => {
      result.current.requestConfirm();
    });
    act(() => {
      result.current.confirm();
    });

    expect(useAppStore.getState().currentRoute).toBe('grappe');
  });
});
