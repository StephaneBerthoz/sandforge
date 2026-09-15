import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useClone } from './useClone';

/* ------------------------------------------------------------------ */
/* Mocks                                                               */
/* ------------------------------------------------------------------ */

const mockDescribeMutate = vi.fn();
const mockDescribeReset = vi.fn();
const mockPreviewMutate = vi.fn();
const mockPreviewReset = vi.fn();
const mockExecuteMutate = vi.fn();
const mockExecuteReset = vi.fn();

let mockDescribeState = {
  mutate: mockDescribeMutate,
  data: null as Record<string, unknown> | null,
  loading: false,
  error: null as string | null,
  reset: mockDescribeReset,
};

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
  requestId: null as string | null,
};

/** Every mutation the hook creates, with the error channel it asked for. */
const mutationCalls: Array<{ type: string; errorType?: string }> = [];

vi.mock('../../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string, options?: { errorType?: string }) => {
    mutationCalls.push({ type, errorType: options?.errorType });
    if (type === 'seed:clone:describe-source') return mockDescribeState;
    if (type === 'seed:clone:preview') return mockPreviewState;
    if (type === 'seed:clone:execute') return mockExecuteState;
    return { mutate: vi.fn(), data: null, loading: false, error: null, reset: vi.fn() };
  },
}));

/** Deliver an `operation:failed` the way the extension posts it. */
function operationFailed(operationId: string, error: string): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: 'host-failed',
          type: 'operation:failed',
          timestamp: Date.now(),
          payload: { operationId, error, retryable: false },
        },
      }),
    );
  });
}

describe('useClone', () => {
  beforeEach(() => {
    mockDescribeMutate.mockClear();
    mutationCalls.length = 0;
    mockDescribeReset.mockClear();
    mockPreviewMutate.mockClear();
    mockPreviewReset.mockClear();
    mockExecuteMutate.mockClear();
    mockExecuteReset.mockClear();

    mockDescribeState = {
      mutate: mockDescribeMutate,
      data: null,
      loading: false,
      error: null,
      reset: mockDescribeReset,
    };
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
      requestId: null,
    };
  });

  it('should initialize with default state', () => {
    const { result } = renderHook(() => useClone('target-1'));

    expect(result.current.sourceOrgId).toBe('');
    expect(result.current.targetOrgId).toBe('target-1');
    expect(result.current.sourceObjects).toEqual([]);
    expect(result.current.selectedObjects).toEqual([]);
    expect(result.current.previewResult).toBeNull();
    expect(result.current.executionStatus).toBe('idle');
    expect(result.current.executionResult).toBeNull();
    expect(result.current.step).toBe('source');
    expect(result.current.error).toBeNull();
  });

  it('should set sourceOrgId and send describe-source message on handleSourceOrgSelected', () => {
    const { result } = renderHook(() => useClone('target-1'));

    act(() => {
      result.current.handleSourceOrgSelected('source-1');
    });

    expect(result.current.sourceOrgId).toBe('source-1');
    expect(mockDescribeMutate).toHaveBeenCalledWith({ sourceOrgId: 'source-1' });
  });

  it('should add and remove objects via handleObjectToggle', () => {
    const { result } = renderHook(() => useClone('target-1'));

    act(() => {
      result.current.handleObjectToggle('Account');
    });
    expect(result.current.selectedObjects).toHaveLength(1);
    expect(result.current.selectedObjects[0].objectApiName).toBe('Account');

    act(() => {
      result.current.handleObjectToggle('Contact');
    });
    expect(result.current.selectedObjects).toHaveLength(2);

    // Toggle off Account
    act(() => {
      result.current.handleObjectToggle('Account');
    });
    expect(result.current.selectedObjects).toHaveLength(1);
    expect(result.current.selectedObjects[0].objectApiName).toBe('Contact');
  });

  it('should update WHERE clause via handleWhereClauseChange', () => {
    const { result } = renderHook(() => useClone('target-1'));

    act(() => {
      result.current.handleObjectToggle('Account');
    });
    act(() => {
      result.current.handleWhereClauseChange('Account', "Industry = 'Technology'");
    });

    expect(result.current.selectedObjects[0].whereClause).toBe("Industry = 'Technology'");
  });

  it('should clear WHERE clause when set to empty string', () => {
    const { result } = renderHook(() => useClone('target-1'));

    act(() => {
      result.current.handleObjectToggle('Account');
    });
    act(() => {
      result.current.handleWhereClauseChange('Account', "Industry = 'Tech'");
    });
    act(() => {
      result.current.handleWhereClauseChange('Account', '');
    });

    expect(result.current.selectedObjects[0].whereClause).toBeUndefined();
  });

  it('should send preview mutation on handlePreview', () => {
    const { result } = renderHook(() => useClone('target-1'));

    act(() => {
      result.current.handleSourceOrgSelected('source-1');
    });
    act(() => {
      result.current.handleObjectToggle('Account');
    });
    act(() => {
      result.current.handlePreview();
    });

    expect(result.current.executionStatus).toBe('previewing');
    expect(mockPreviewMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceOrgId: 'source-1',
        targetOrgId: 'target-1',
        objects: [{ objectApiName: 'Account' }],
      }),
    );
  });

  it('should send execute mutation on handleExecute', () => {
    const { result } = renderHook(() => useClone('target-1'));

    act(() => {
      result.current.handleSourceOrgSelected('source-1');
    });
    act(() => {
      result.current.handleObjectToggle('Account');
    });
    act(() => {
      result.current.handleExecute();
    });

    expect(result.current.executionStatus).toBe('executing');
    expect(mockExecuteMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceOrgId: 'source-1',
        targetOrgId: 'target-1',
      }),
    );
  });

  it('should reset all state on reset()', () => {
    const { result } = renderHook(() => useClone('target-1'));

    act(() => {
      result.current.handleSourceOrgSelected('source-1');
    });
    act(() => {
      result.current.handleObjectToggle('Account');
    });
    act(() => {
      result.current.reset();
    });

    expect(result.current.sourceOrgId).toBe('');
    expect(result.current.selectedObjects).toEqual([]);
    expect(result.current.step).toBe('source');
    expect(result.current.executionStatus).toBe('idle');
    expect(mockDescribeReset).toHaveBeenCalled();
    expect(mockPreviewReset).toHaveBeenCalled();
    expect(mockExecuteReset).toHaveBeenCalled();
  });

  it('should allow manual step navigation via setStep', () => {
    const { result } = renderHook(() => useClone('target-1'));

    act(() => {
      result.current.setStep('objects');
    });
    expect(result.current.step).toBe('objects');

    act(() => {
      result.current.setStep('preview');
    });
    expect(result.current.step).toBe('preview');
  });

  /* ------------------------------------------------------------------ */
  /* seed:clone:error channel (fail fast, no 30 s timeout)               */
  /* ------------------------------------------------------------------ */

  it('listens for describe, preview and execute failures on seed:clone:error', () => {
    // The handler posts its failures on this channel, correlated to the
    // request, and the mutations listen there themselves. A separate
    // type-only listener used to catch them instead and hand each one to
    // whichever mutation happened to be loading.
    renderHook(() => useClone('target-1'));

    expect(mutationCalls).toEqual(
      expect.arrayContaining([
        { type: 'seed:clone:describe-source', errorType: 'seed:clone:error' },
        { type: 'seed:clone:preview', errorType: 'seed:clone:error' },
        { type: 'seed:clone:execute', errorType: 'seed:clone:error' },
      ]),
    );
  });

  it('unsticks the executing status when the execute mutation errors', () => {
    const { result, rerender } = renderHook(() => useClone('target-1'));

    act(() => {
      result.current.handleExecute();
    });
    expect(result.current.executionStatus).toBe('executing');

    mockExecuteState = { ...mockExecuteState, loading: false, error: 'Execute exploded' };
    act(() => {
      rerender();
    });

    expect(result.current.executionStatus).toBe('error');
    expect(result.current.error).toBe('Execute exploded');
  });

  it('surfaces a describe-source failure without touching the status', () => {
    mockDescribeState = { ...mockDescribeState, loading: false, error: 'Describe exploded' };
    const { result } = renderHook(() => useClone('target-1'));

    expect(result.current.error).toBe('Describe exploded');
    expect(result.current.executionStatus).toBe('idle');
  });

  /* ------------------------------------------------------------------ */
  /* Execute failures arrive on operation:failed                         */
  /* ------------------------------------------------------------------ */

  it('ends the run as soon as the extension reports its clone failed, without waiting out the timeout', () => {
    // The execute handler reports a failure — a declined production
    // confirmation included — only on operation:failed, which nothing here
    // listened to: the wizard sat on "executing" for 120 s, then showed a raw
    // timeout.
    const { result, rerender } = renderHook(() => useClone('target-1'));
    act(() => {
      result.current.handleExecute();
    });
    mockExecuteState = { ...mockExecuteState, loading: true, requestId: 'wv-clone-run' };
    rerender();
    mockExecuteReset.mockClear();

    operationFailed(
      'wv-clone-run',
      'Operation cancelled by user (production confirmation declined).',
    );

    expect(result.current.executionStatus).toBe('error');
    expect(result.current.error).toBe(
      'Operation cancelled by user (production confirmation declined).',
    );
    expect(mockExecuteReset).toHaveBeenCalled();
  });

  it('ignores a failure reported for another operation', () => {
    const { result, rerender } = renderHook(() => useClone('target-1'));
    act(() => {
      result.current.handleExecute();
    });
    mockExecuteState = { ...mockExecuteState, loading: true, requestId: 'wv-clone-run' };
    rerender();

    operationFailed('wv-some-other-run', 'Bulk job failed');

    expect(result.current.executionStatus).toBe('executing');
    expect(result.current.error).toBeNull();
  });

  it('keeps a finished clone complete when a failure for it is reported afterwards', () => {
    const { result, rerender } = renderHook(() => useClone('target-1'));
    act(() => {
      result.current.handleExecute();
    });
    mockExecuteState = {
      ...mockExecuteState,
      loading: false,
      requestId: 'wv-clone-run',
      data: { success: true },
    };
    rerender();
    expect(result.current.executionStatus).toBe('complete');

    operationFailed('wv-clone-run', 'Bulk job failed');

    expect(result.current.executionStatus).toBe('complete');
    expect(result.current.error).toBeNull();
  });

  it('selects the source org it is opened with and describes it, without previewing or running anything', () => {
    const { result } = renderHook(() => useClone('target-1', 'source-9'));

    expect(result.current.sourceOrgId).toBe('source-9');
    expect(mockDescribeMutate).toHaveBeenCalledWith({ sourceOrgId: 'source-9' });
    expect(mockPreviewMutate).not.toHaveBeenCalled();
    expect(mockExecuteMutate).not.toHaveBeenCalled();
  });
});
