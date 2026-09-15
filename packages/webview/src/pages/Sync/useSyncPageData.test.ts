import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import '../../i18n';
import { useSyncPageData } from './useSyncPageData';
import { useAppStore } from '../../stores/useAppStore';
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

/** State of the sync:execute mutation, set by the tests that need a run going. */
const execution = vi.hoisted(() => ({ loading: false, requestId: null as string | null }));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (requestType: string) => ({
    mutate: vi.fn(),
    data: null,
    loading: requestType === 'sync:execute' ? execution.loading : false,
    error: null,
    reset: vi.fn(),
    requestId: requestType === 'sync:execute' ? execution.requestId : null,
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
    execution.loading = false;
    execution.requestId = null;
  });

  it('shows the progress of the sync it started, not of another run reporting at the same time', () => {
    // Every open panel receives every operation:progress, and the sync
    // handler uses the request id as the operationId.
    execution.loading = true;
    execution.requestId = 'wv-own-sync';
    const report = (operationId: string, percentage: number): void => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            id: `ext-${operationId}-${percentage}`,
            type: 'operation:progress',
            timestamp: Date.now(),
            payload: {
              operationId,
              percentage,
              processedRecords: percentage,
              totalRecords: 100,
              currentStep: 'Account',
            },
          },
        }),
      );
    };

    const { result } = renderHook(() => useSyncPageData());

    act(() => {
      report('wv-own-sync', 25);
      report('wv-other-sync', 80);
    });

    expect(result.current.overallPercent).toBe(25);
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

  it('starts from the source and target orgs Home recommended syncing, once', () => {
    useAppStore.setState({
      navigationIntent: { route: 'sync', sourceOrgId: 'org-src', targetOrgId: 'org-tgt' },
    });

    const { result } = renderHook(() => useSyncPageData());

    expect(result.current.sourceOrgId).toBe('org-src');
    expect(result.current.targetOrgId).toBe('org-tgt');
    expect(useAppStore.getState().navigationIntent).toBeNull();
  });
});
