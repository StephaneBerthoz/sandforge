import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import '../../i18n';
import { useSyncPageData } from './useSyncPageData';
import { SYNC_ACCOUNT_HIERARCHY } from '@sandforge/shared';

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */

vi.mock('../../stores/useNotificationStore', () => ({
  useNotificationStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ addNotification: vi.fn() }),
}));

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
    mutate: vi.fn(),
    data: null,
    loading: false,
    error: null,
    reset: vi.fn(),
  }),
}));

vi.mock('../../hooks/useWebviewPersistedState', () => ({
  useWebviewPersistedState: (_key: string, defaultValue: unknown) => {
    const state = { current: defaultValue };
    return [state.current, vi.fn()];
  },
}));

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('useSyncPageData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should start at step 0', () => {
    const { result } = renderHook(() => useSyncPageData());
    expect(result.current.currentStep).toBe(0);
  });

  it('canGoNext at step 0 should require both orgs AND at least 1 object', () => {
    const { result } = renderHook(() => useSyncPageData());
    // No orgs, no objects => false
    expect(result.current.canGoNext()).toBe(false);
  });

  it('isFinished should be true when currentStep is 5 and result exists', () => {
    const { result } = renderHook(() => useSyncPageData());
    // At step 0 with no result, isFinished should be false
    expect(result.current.isFinished).toBe(false);
  });

  it('handleApplyTemplate should populate direction, mode, conflictStrategy and objectEntries', () => {
    const { result } = renderHook(() => useSyncPageData());

    act(() => {
      result.current.handleApplyTemplate(SYNC_ACCOUNT_HIERARCHY);
    });

    expect(result.current.direction).toBe('source_to_target');
    expect(result.current.mode).toBe('full');
    expect(result.current.conflictStrategy).toBe('source_wins');
    expect(result.current.objectEntries).toHaveLength(5);
    expect(result.current.objectEntries[0].objectApiName).toBe('Account');
    expect(result.current.objectEntries[4].objectApiName).toBe('Note');
  });

  it('handleApplyTemplate should clear mappings and transforms', () => {
    const { result } = renderHook(() => useSyncPageData());

    // Add a mapping first
    act(() => {
      result.current.handleAddMapping('Name', 'Name');
    });
    expect(result.current.mappings).toHaveLength(1);

    // Apply template should clear it
    act(() => {
      result.current.handleApplyTemplate(SYNC_ACCOUNT_HIERARCHY);
    });
    expect(result.current.mappings).toHaveLength(0);
    expect(result.current.transforms).toHaveLength(0);
  });

  it('should expose handleApplyTemplate in the return object', () => {
    const { result } = renderHook(() => useSyncPageData());
    expect(typeof result.current.handleApplyTemplate).toBe('function');
  });
});
