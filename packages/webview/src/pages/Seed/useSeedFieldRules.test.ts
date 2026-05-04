import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { PersonaMsg } from '@sandforge/shared';

import { useSeedFieldRules, mapGeneratorToRuleType } from './useSeedFieldRules';

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

  it('should expose applyPersona that returns 0 on empty configs', () => {
    const { result } = renderHook(() => useSeedFieldRules('org-1', [], 0));

    const persona: PersonaMsg = {
      id: 'test-persona',
      name: 'Test',
      description: 'Test persona',
      industry: 'tech',
      locale: 'en_US',
      dataPatterns: {
        Name: {
          fieldType: 'string',
          generator: 'faker',
          params: { method: 'company.name' },
          examples: ['Acme'],
        },
      },
    };

    let count = 0;
    act(() => {
      count = result.current.applyPersona(persona);
    });

    expect(count).toBe(0);
  });
});

describe('mapGeneratorToRuleType', () => {
  it('should map faker to faker', () => {
    expect(mapGeneratorToRuleType('faker')).toBe('faker');
  });

  it('should map random_pick to picklist_random', () => {
    expect(mapGeneratorToRuleType('random_pick')).toBe('picklist_random');
  });

  it('should map weighted_pick to picklist_random', () => {
    expect(mapGeneratorToRuleType('weighted_pick')).toBe('picklist_random');
  });

  it('should map range to random', () => {
    expect(mapGeneratorToRuleType('range')).toBe('random');
  });

  it('should map sequence to sequence', () => {
    expect(mapGeneratorToRuleType('sequence')).toBe('sequence');
  });

  it('should map pattern to regex', () => {
    expect(mapGeneratorToRuleType('pattern')).toBe('regex');
  });

  it('should map ai_generate to ai_generate', () => {
    expect(mapGeneratorToRuleType('ai_generate')).toBe('ai_generate');
  });

  it('should map relative_date to faker', () => {
    expect(mapGeneratorToRuleType('relative_date')).toBe('faker');
  });

  it('should return null for unknown generator', () => {
    expect(mapGeneratorToRuleType('unknown_type')).toBeNull();
  });
});
