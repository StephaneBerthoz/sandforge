import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useQuickSyncFlow } from './useQuickSyncFlow';

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */
const mockPreviewMutate = vi.fn();
const mockPreviewReset = vi.fn();
const mockExecuteMutate = vi.fn();
const mockExecuteReset = vi.fn();

let mockPreviewState = {
  mutate: mockPreviewMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: mockPreviewReset,
};

let mockExecuteState = {
  mutate: mockExecuteMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: mockExecuteReset,
};

vi.mock('../../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) => {
    if (type === 'quicksync:preview') return mockPreviewState;
    if (type === 'quicksync:execute') return mockExecuteState;
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
    mockExecuteState = {
      mutate: mockExecuteMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockExecuteReset,
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
      quickSyncDraft: {
        sourceOrgId: 'org-1',
        targetOrgId: 'org-2',
        selectedObjects: ['Account'],
        parentObjects: [],
      },
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
  });
});
