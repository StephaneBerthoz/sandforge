import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useOrgStore } from '../../stores/useOrgStore';
import { useSeedWizardState } from './useSeedWizardState';

/* ------------------------------------------------------------------ */
/* Mock bridge hooks                                                   */
/* ------------------------------------------------------------------ */
const mockMutate = vi.fn();

vi.mock('../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: () => ({
    data: null,
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: () => ({
    mutate: mockMutate,
    data: null,
    loading: false,
    error: null,
    reset: vi.fn(),
  }),
}));

vi.mock('../../hooks/useAIFeatures', () => ({
  useNL2SOQL: () => ({
    mutate: vi.fn(),
    data: null,
    loading: false,
    error: null,
  }),
}));

vi.mock('../../stores/useNotificationStore', () => ({
  useNotificationStore: () => vi.fn(),
}));

const mockT = (key: string) => key;

const mockOrgs = [
  {
    id: 'org-1',
    alias: 'dev1',
    username: 'user@dev1.com',
    instanceUrl: 'https://dev1.salesforce.com',
    orgType: 'sandbox' as const,
    status: 'connected' as const,
    safetyTier: 'low' as const,
    apiVersion: '59.0',
    lastConnected: '2024-01-01T00:00:00Z',
  },
];

describe('useSeedWizardState', () => {
  beforeEach(() => {
    useOrgStore.setState({ orgs: mockOrgs, selectedOrgId: null });
    mockMutate.mockClear();
  });

  it('should initialize with step 0 and empty selections', () => {
    const { result } = renderHook(() => useSeedWizardState(mockT));

    expect(result.current.currentStep).toBe(0);
    expect(result.current.selectedOrgId).toBe('');
    expect(result.current.selectedObjects).toEqual([]);
    expect(result.current.canGoNext).toBe(false);
  });

  it('should update selectedOrgId when handleOrgSelect is called', () => {
    const { result } = renderHook(() => useSeedWizardState(mockT));

    act(() => {
      result.current.handleOrgSelect('org-1');
    });

    expect(result.current.selectedOrgId).toBe('org-1');
  });

  it('should toggle objects in selectedObjects', () => {
    const { result } = renderHook(() => useSeedWizardState(mockT));

    act(() => {
      result.current.handleToggleObject('Account');
    });
    expect(result.current.selectedObjects).toEqual(['Account']);

    act(() => {
      result.current.handleToggleObject('Contact');
    });
    expect(result.current.selectedObjects).toEqual(['Account', 'Contact']);

    act(() => {
      result.current.handleToggleObject('Account');
    });
    expect(result.current.selectedObjects).toEqual(['Contact']);
  });

  it('should require org and objects to enable next on step 0', () => {
    const { result } = renderHook(() => useSeedWizardState(mockT));

    expect(result.current.canGoNext).toBe(false);

    act(() => {
      result.current.handleOrgSelect('org-1');
    });
    expect(result.current.canGoNext).toBe(false);

    act(() => {
      result.current.handleToggleObject('Account');
    });
    expect(result.current.canGoNext).toBe(true);
  });

  it('should update volumes when handleChangeVolume is called', () => {
    const { result } = renderHook(() => useSeedWizardState(mockT));

    act(() => {
      result.current.handleChangeVolume('Account', 500);
    });

    expect(result.current.volumes['Account']?.count).toBe(500);
    expect(result.current.volumes['Account']?.batchSize).toBe(200);
  });

  it('should update batch size when handleChangeBatchSize is called', () => {
    const { result } = renderHook(() => useSeedWizardState(mockT));

    act(() => {
      result.current.handleChangeBatchSize('Account', 500);
    });

    expect(result.current.volumes['Account']?.batchSize).toBe(500);
  });

  it('should add and remove relations', () => {
    const { result } = renderHook(() => useSeedWizardState(mockT));

    act(() => {
      result.current.handleAddRelation();
    });
    expect(result.current.relations).toHaveLength(1);
    expect(result.current.relations[0].parentField).toBe('Id');

    act(() => {
      result.current.handleRemoveRelation(0);
    });
    expect(result.current.relations).toHaveLength(0);
  });

  it('should update step via setCurrentStep', () => {
    const { result } = renderHook(() => useSeedWizardState(mockT));

    act(() => {
      result.current.setCurrentStep(2);
    });
    expect(result.current.currentStep).toBe(2);
  });

  it('should manage error state', () => {
    const { result } = renderHook(() => useSeedWizardState(mockT));

    act(() => {
      result.current.setError('Something went wrong');
    });
    expect(result.current.error).toBe('Something went wrong');

    act(() => {
      result.current.setError(null);
    });
    expect(result.current.error).toBeNull();
  });

  it('should not be finished on step 3 without execution result', () => {
    const { result } = renderHook(() => useSeedWizardState(mockT));

    act(() => {
      result.current.setCurrentStep(3);
    });
    expect(result.current.isFinished).toBe(false);
  });

  it('should initialize with no selected persona', () => {
    const { result } = renderHook(() => useSeedWizardState(mockT));
    expect(result.current.selectedPersona).toBeNull();
    expect(result.current.personaMatchedFields).toBe(0);
  });

  it('should set selected persona via setSelectedPersona', () => {
    const { result } = renderHook(() => useSeedWizardState(mockT));

    const persona = {
      id: 'test-persona',
      name: 'Test',
      description: 'Test persona',
      industry: 'tech',
      locale: 'en_US',
      dataPatterns: {},
    };

    act(() => {
      result.current.setSelectedPersona(persona);
    });

    expect(result.current.selectedPersona).toEqual(persona);
  });

  it('should expose applySelectedPersona that returns 0 when no persona set', () => {
    const { result } = renderHook(() => useSeedWizardState(mockT));

    let count = 0;
    act(() => {
      count = result.current.applySelectedPersona();
    });

    expect(count).toBe(0);
  });
});
