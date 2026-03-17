import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useSeedNL2SOQL } from './useSeedNL2SOQL';

/* ------------------------------------------------------------------ */
/* Mock AI features hook                                               */
/* ------------------------------------------------------------------ */
const mockMutate = vi.fn();

vi.mock('../../hooks/useAIFeatures', () => ({
  useNL2SOQL: () => ({
    mutate: mockMutate,
    data: null,
    loading: false,
    error: null,
  }),
}));

describe('useSeedNL2SOQL', () => {
  beforeEach(() => {
    mockMutate.mockClear();
  });

  it('should initialize with empty query', () => {
    const { result } = renderHook(() => useSeedNL2SOQL('org-1'));

    expect(result.current.nl2soqlQuery).toBe('');
    expect(result.current.nl2soql.loading).toBe(false);
    expect(result.current.nl2soql.data).toBeNull();
  });

  it('should update query via setNl2soqlQuery', () => {
    const { result } = renderHook(() => useSeedNL2SOQL('org-1'));

    act(() => {
      result.current.setNl2soqlQuery('show all accounts');
    });

    expect(result.current.nl2soqlQuery).toBe('show all accounts');
  });

  it('should call mutate with trimmed query and orgId on handleNl2soql', () => {
    const { result } = renderHook(() => useSeedNL2SOQL('org-1'));

    act(() => {
      result.current.setNl2soqlQuery('  show all accounts  ');
    });

    act(() => {
      result.current.handleNl2soql();
    });

    expect(mockMutate).toHaveBeenCalledWith({
      query: 'show all accounts',
      orgId: 'org-1',
    });
  });

  it('should not call mutate when query is empty', () => {
    const { result } = renderHook(() => useSeedNL2SOQL('org-1'));

    act(() => {
      result.current.handleNl2soql();
    });

    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('should not call mutate when query is whitespace only', () => {
    const { result } = renderHook(() => useSeedNL2SOQL('org-1'));

    act(() => {
      result.current.setNl2soqlQuery('   ');
    });

    act(() => {
      result.current.handleNl2soql();
    });

    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('should not call mutate when orgId is empty', () => {
    const { result } = renderHook(() => useSeedNL2SOQL(''));

    act(() => {
      result.current.setNl2soqlQuery('show all accounts');
    });

    act(() => {
      result.current.handleNl2soql();
    });

    expect(mockMutate).not.toHaveBeenCalled();
  });
});
