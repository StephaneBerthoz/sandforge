import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { QuickSyncPreview, SyncExecutionResult } from '@sandforge/shared';
import { useQuickSyncFlow } from './useQuickSyncFlow';

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */
const mockPreviewMutate = vi.fn();
const mockPreviewReset = vi.fn();
const mockPrepareMutate = vi.fn();
const mockPrepareReset = vi.fn();
const mockSyncMutate = vi.fn();
const mockSyncReset = vi.fn();

let mockPreviewState = {
  mutate: mockPreviewMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: mockPreviewReset,
};

let mockPrepareState = {
  mutate: mockPrepareMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: mockPrepareReset,
};

let mockSyncState = {
  mutate: mockSyncMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: mockSyncReset,
};

vi.mock('../../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) => {
    if (type === 'quicksync:preview') return mockPreviewState;
    if (type === 'quicksync:execute') return mockPrepareState;
    if (type === 'sync:execute') return mockSyncState;
    return { mutate: vi.fn(), data: null, loading: false, error: null, reset: vi.fn() };
  },
}));

const mockSetDraft = vi.fn();
const mockSetStep = vi.fn();
const mockSetPreview = vi.fn();
const mockSetResult = vi.fn();
const mockSetIsExecuting = vi.fn();
const mockSetError = vi.fn();

let persistedValues: Record<string, unknown> = {};

vi.mock('../../../hooks/useWebviewPersistedState', () => ({
  useWebviewPersistedState: (key: string, initial: unknown) => {
    if (!(key in persistedValues)) {
      persistedValues[key] = initial;
    }
    const setters: Record<string, ReturnType<typeof vi.fn>> = {
      quickSyncDraft: mockSetDraft,
      quickSyncStep: mockSetStep,
      quickSyncPreview: mockSetPreview,
      quickSyncResult: mockSetResult,
      quickSyncExecuting: mockSetIsExecuting,
      quickSyncError: mockSetError,
    };
    const setter = setters[key] ?? vi.fn();
    setter.mockImplementation((val: unknown) => {
      persistedValues[key] = val;
    });
    return [persistedValues[key], setter];
  },
}));

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */
const filledDraft = {
  sourceOrgId: 'org-1',
  targetOrgId: 'org-2',
  selectedObjects: ['Account'],
  parentObjects: [],
};

const fakePreview: QuickSyncPreview = {
  objects: [
    { objectApiName: 'Account', recordCount: 500, estimatedApiCalls: 3, isParentDependency: false },
  ],
  totalRecords: 500,
  totalApiCalls: 3,
  estimatedDurationSec: 6,
};

const fakeSyncConfig = {
  id: 'cfg-1',
  name: 'Quick Sync 2024',
  sourceOrgId: 'org-1',
  targetOrgId: 'org-2',
  direction: 'source_to_target',
  mode: 'full',
  objects: [{ objectApiName: 'Account', operation: 'upsert' }],
  conflictStrategy: 'source_wins',
};

const fakeResult: SyncExecutionResult = {
  configId: 'cfg-1',
  operationId: 'op-1',
  status: 'success',
  objectResults: [
    {
      objectApiName: 'Account',
      operation: 'upsert',
      processed: 500,
      success: 500,
      failed: 0,
      skipped: 0,
      conflictCount: 0,
      errors: [],
    },
  ],
  totalProcessed: 500,
  totalSuccess: 500,
  totalFailed: 0,
  totalSkipped: 0,
  duration: 1200,
  timestamp: '2024-01-01T00:00:00Z',
};

describe('useQuickSyncFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    persistedValues = {};
    mockPreviewState = {
      mutate: mockPreviewMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockPreviewReset,
    };
    mockPrepareState = {
      mutate: mockPrepareMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockPrepareReset,
    };
    mockSyncState = {
      mutate: mockSyncMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockSyncReset,
    };
  });

  it('has initial state with step=orgs and empty selections', () => {
    const { result } = renderHook(() => useQuickSyncFlow());

    expect(result.current.state.step).toBe('orgs');
    expect(result.current.state.sourceOrgId).toBe('');
    expect(result.current.state.targetOrgId).toBe('');
    expect(result.current.state.selectedObjects).toEqual([]);
    expect(result.current.state.parentObjects).toEqual([]);
    expect(result.current.state.preview).toBeNull();
    expect(result.current.state.result).toBeNull();
    expect(result.current.state.isExecuting).toBe(false);
    expect(result.current.state.error).toBeNull();
  });

  it('setSourceOrg and setTargetOrg update state correctly', () => {
    const { result } = renderHook(() => useQuickSyncFlow());

    act(() => {
      result.current.setSourceOrg('org-1');
    });

    expect(mockSetDraft).toHaveBeenCalledWith(expect.objectContaining({ sourceOrgId: 'org-1' }));

    act(() => {
      result.current.setTargetOrg('org-2');
    });

    expect(mockSetDraft).toHaveBeenCalledWith(expect.objectContaining({ targetOrgId: 'org-2' }));
  });

  it('canGoToObjects is true when both orgs selected and different', () => {
    persistedValues = {
      quickSyncDraft: {
        sourceOrgId: 'org-1',
        targetOrgId: 'org-2',
        selectedObjects: [],
        parentObjects: [],
      },
      quickSyncStep: 'orgs',
    };

    const { result } = renderHook(() => useQuickSyncFlow());

    expect(result.current.canGoToObjects).toBe(true);
  });

  it('canGoToObjects is false when orgs are the same', () => {
    persistedValues = {
      quickSyncDraft: {
        sourceOrgId: 'org-1',
        targetOrgId: 'org-1',
        selectedObjects: [],
        parentObjects: [],
      },
      quickSyncStep: 'orgs',
    };

    const { result } = renderHook(() => useQuickSyncFlow());

    expect(result.current.canGoToObjects).toBe(false);
  });

  it('addObject and removeObject manage selectedObjects array', () => {
    const { result } = renderHook(() => useQuickSyncFlow());

    act(() => {
      result.current.addObject('Account');
    });

    expect(mockSetDraft).toHaveBeenCalledWith(
      expect.objectContaining({ selectedObjects: ['Account'] }),
    );

    // Simulate the updated state
    persistedValues['quickSyncDraft'] = {
      sourceOrgId: '',
      targetOrgId: '',
      selectedObjects: ['Account'],
      parentObjects: [],
    };

    const { result: result2 } = renderHook(() => useQuickSyncFlow());

    act(() => {
      result2.current.removeObject('Account');
    });

    expect(mockSetDraft).toHaveBeenCalledWith(expect.objectContaining({ selectedObjects: [] }));
  });

  it('canGoToPreview is true when at least 1 object selected', () => {
    persistedValues = {
      quickSyncDraft: filledDraft,
      quickSyncStep: 'objects',
    };

    const { result } = renderHook(() => useQuickSyncFlow());

    expect(result.current.canGoToPreview).toBe(true);
  });

  it('reset clears all state back to initial', () => {
    persistedValues = {
      quickSyncDraft: {
        sourceOrgId: 'org-1',
        targetOrgId: 'org-2',
        selectedObjects: ['Account'],
        parentObjects: ['Contact'],
      },
      quickSyncStep: 'preview',
      quickSyncPreview: {
        objects: [],
        totalRecords: 100,
        totalApiCalls: 5,
        estimatedDurationSec: 10,
      },
      quickSyncResult: null,
      quickSyncExecuting: false,
      quickSyncError: null,
    };

    const { result } = renderHook(() => useQuickSyncFlow());

    act(() => {
      result.current.reset();
    });

    expect(mockSetDraft).toHaveBeenCalledWith({
      sourceOrgId: '',
      targetOrgId: '',
      selectedObjects: [],
      parentObjects: [],
    });
    expect(mockSetStep).toHaveBeenCalledWith('orgs');
    expect(mockSetPreview).toHaveBeenCalledWith(null);
    expect(mockSetResult).toHaveBeenCalledWith(null);
    expect(mockSetIsExecuting).toHaveBeenCalledWith(false);
    expect(mockSetError).toHaveBeenCalledWith(null);
    expect(mockPreviewReset).toHaveBeenCalledTimes(1);
    expect(mockPrepareReset).toHaveBeenCalledTimes(1);
    expect(mockSyncReset).toHaveBeenCalledTimes(1);
  });

  /* ---------------------------------------------------------------- */
  /* Bridge contract: payloads sent and responses consumed             */
  /* ---------------------------------------------------------------- */

  it('goToPreview posts the canonical quicksync:preview payload', () => {
    persistedValues = { quickSyncDraft: filledDraft, quickSyncStep: 'objects' };
    const { result } = renderHook(() => useQuickSyncFlow());

    act(() => {
      result.current.goToPreview();
    });

    expect(mockPreviewMutate).toHaveBeenCalledWith({
      sourceOrgId: 'org-1',
      targetOrgId: 'org-2',
      selectedObjects: ['Account'],
      parentObjects: [],
    });
    expect(mockSetStep).toHaveBeenCalledWith('preview');
  });

  it('unwraps the { preview } response envelope into state', () => {
    mockPreviewState.data = { preview: fakePreview as unknown as Record<string, unknown> };
    renderHook(() => useQuickSyncFlow());

    expect(mockSetPreview).toHaveBeenCalledWith(fakePreview);
  });

  it('execute posts quicksync:execute with a nested { config } payload', () => {
    persistedValues = { quickSyncDraft: filledDraft, quickSyncStep: 'preview' };
    const { result } = renderHook(() => useQuickSyncFlow());

    act(() => {
      result.current.execute();
    });

    expect(mockPrepareMutate).toHaveBeenCalledWith({
      config: {
        sourceOrgId: 'org-1',
        targetOrgId: 'org-2',
        selectedObjects: ['Account'],
        parentObjects: [],
      },
    });
    expect(mockSetIsExecuting).toHaveBeenCalledWith(true);
    expect(mockSetStep).toHaveBeenCalledWith('executing');
  });

  it('relays the prepared syncConfig to sync:execute', () => {
    mockPrepareState.data = {
      syncConfig: fakeSyncConfig,
      objectCount: 1,
    };
    renderHook(() => useQuickSyncFlow());

    expect(mockSyncMutate).toHaveBeenCalledWith({ config: fakeSyncConfig });
  });

  it('completes the flow when sync:execute returns the execution result', () => {
    mockSyncState.data = fakeResult as unknown as Record<string, unknown>;
    renderHook(() => useQuickSyncFlow());

    expect(mockSetResult).toHaveBeenCalledWith(fakeResult);
    expect(mockSetIsExecuting).toHaveBeenCalledWith(false);
    expect(mockSetStep).toHaveBeenCalledWith('results');
  });

  it('surfaces a prepare-step error and stops executing', () => {
    mockPrepareState.error = 'Quick Sync failed';
    renderHook(() => useQuickSyncFlow());

    expect(mockSetError).toHaveBeenCalledWith('Quick Sync failed');
    expect(mockSetIsExecuting).toHaveBeenCalledWith(false);
  });

  it('surfaces a sync execution error and stops executing', () => {
    mockSyncState.error = 'sync timed out';
    renderHook(() => useQuickSyncFlow());

    expect(mockSetError).toHaveBeenCalledWith('sync timed out');
    expect(mockSetIsExecuting).toHaveBeenCalledWith(false);
  });

  it('walks the whole wizard chain: preview → execute → relay → result', () => {
    persistedValues = { quickSyncDraft: filledDraft, quickSyncStep: 'objects' };
    const { result, rerender } = renderHook(() => useQuickSyncFlow());

    // 1. Objects step → preview request
    act(() => {
      result.current.goToPreview();
    });
    expect(mockPreviewMutate).toHaveBeenCalledWith(
      expect.objectContaining({ sourceOrgId: 'org-1', selectedObjects: ['Account'] }),
    );

    // 2. Preview response arrives → stored
    mockPreviewState.data = { preview: fakePreview as unknown as Record<string, unknown> };
    rerender();
    expect(mockSetPreview).toHaveBeenCalledWith(fakePreview);

    // 3. User clicks "Sync Now" → prepare request with nested config
    act(() => {
      result.current.execute();
    });
    expect(mockPrepareMutate).toHaveBeenCalledWith({ config: { ...filledDraft } });

    // 4. Prepared config arrives → relayed to the real execution flow once
    mockPrepareState.data = { syncConfig: fakeSyncConfig, objectCount: 1 };
    rerender();
    expect(mockSyncMutate).toHaveBeenCalledTimes(1);
    expect(mockSyncMutate).toHaveBeenCalledWith({ config: fakeSyncConfig });

    // 5. Execution result arrives → results step
    mockSyncState.data = fakeResult as unknown as Record<string, unknown>;
    rerender();
    expect(mockSetResult).toHaveBeenCalledWith(fakeResult);
    expect(mockSetStep).toHaveBeenCalledWith('results');
    // The relay must not fire again for an unchanged prepared config
    expect(mockSyncMutate).toHaveBeenCalledTimes(1);
  });
});
