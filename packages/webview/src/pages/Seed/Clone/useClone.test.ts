import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useClone } from './useClone';
import type { TFunction } from 'i18next';

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
};

vi.mock('../../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: (type: string) => {
    if (type === 'seed:clone:describe-source') return mockDescribeState;
    if (type === 'seed:clone:preview') return mockPreviewState;
    if (type === 'seed:clone:execute') return mockExecuteState;
    return { mutate: vi.fn(), data: null, loading: false, error: null, reset: vi.fn() };
  },
}));

const mockT: TFunction = ((key: string) => key) as unknown as TFunction;

describe('useClone', () => {
  beforeEach(() => {
    mockDescribeMutate.mockClear();
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
    };
  });

  it('should initialize with default state', () => {
    const { result } = renderHook(() => useClone(mockT, 'target-1'));

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
    const { result } = renderHook(() => useClone(mockT, 'target-1'));

    act(() => {
      result.current.handleSourceOrgSelected('source-1');
    });

    expect(result.current.sourceOrgId).toBe('source-1');
    expect(mockDescribeMutate).toHaveBeenCalledWith({ sourceOrgId: 'source-1' });
  });

  it('should add and remove objects via handleObjectToggle', () => {
    const { result } = renderHook(() => useClone(mockT, 'target-1'));

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
    const { result } = renderHook(() => useClone(mockT, 'target-1'));

    act(() => {
      result.current.handleObjectToggle('Account');
    });
    act(() => {
      result.current.handleWhereClauseChange('Account', "Industry = 'Technology'");
    });

    expect(result.current.selectedObjects[0].whereClause).toBe("Industry = 'Technology'");
  });

  it('should clear WHERE clause when set to empty string', () => {
    const { result } = renderHook(() => useClone(mockT, 'target-1'));

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
    const { result } = renderHook(() => useClone(mockT, 'target-1'));

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
    const { result } = renderHook(() => useClone(mockT, 'target-1'));

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
    const { result } = renderHook(() => useClone(mockT, 'target-1'));

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
    const { result } = renderHook(() => useClone(mockT, 'target-1'));

    act(() => {
      result.current.setStep('objects');
    });
    expect(result.current.step).toBe('objects');

    act(() => {
      result.current.setStep('preview');
    });
    expect(result.current.step).toBe('preview');
  });
});
