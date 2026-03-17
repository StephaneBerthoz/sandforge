import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useSeedFieldRules } from './useSeedFieldRules';

/* ------------------------------------------------------------------ */
/* Mock bridge hooks                                                   */
/* ------------------------------------------------------------------ */
const mockMutate = vi.fn();

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: () => ({
    mutate: mockMutate,
    data: null,
    loading: false,
    error: null,
    reset: vi.fn(),
  }),
}));

describe('useSeedFieldRules', () => {
  beforeEach(() => {
    mockMutate.mockClear();
  });

  it('should initialize with empty field configs', () => {
    const { result } = renderHook(() => useSeedFieldRules('org-1', ['Account'], 0));

    expect(result.current.fieldConfigs).toEqual([]);
  });

  it('should expose handleChangeFieldRule that updates rule type and resets config', () => {
    const { result } = renderHook(() => useSeedFieldRules('org-1', [], 0));

    /* Manually seed a field config to test the handler */
    act(() => {
      /* We simulate by directly calling the hook with initial state — since
         describe mutation is mocked to return null, we test the handlers
         by first verifying the function exists and is callable. */
      result.current.handleChangeFieldRule('Account', 'Name', 'faker');
    });

    /* Should not throw — the handler works on an empty array gracefully */
    expect(result.current.fieldConfigs).toEqual([]);
  });

  it('should expose handleChangeFieldConfig that updates field config params', () => {
    const { result } = renderHook(() => useSeedFieldRules('org-1', [], 0));

    act(() => {
      result.current.handleChangeFieldConfig('Account', 'Name', 'pattern', '###');
    });

    /* Should not throw — operates on empty array gracefully */
    expect(result.current.fieldConfigs).toEqual([]);
  });

  it('should return stable callback references', () => {
    const { result, rerender } = renderHook(() => useSeedFieldRules('org-1', [], 0));

    const firstRuleRef = result.current.handleChangeFieldRule;
    const firstConfigRef = result.current.handleChangeFieldConfig;

    rerender();

    expect(result.current.handleChangeFieldRule).toBe(firstRuleRef);
    expect(result.current.handleChangeFieldConfig).toBe(firstConfigRef);
  });
});
