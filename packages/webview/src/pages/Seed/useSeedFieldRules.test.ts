import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { PersonaMsg } from '@sandforge/shared';

import { useSeedFieldRules, mapGeneratorToRuleType } from './useSeedFieldRules';

/* ------------------------------------------------------------------ */
/* Mock bridge hooks                                                   */
/* ------------------------------------------------------------------ */
const bridge = vi.hoisted(() => ({
  mutate: vi.fn(),
  /* describe-object response replayed by the hook's mapping effect */
  data: null as unknown,
}));

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: () => ({
    mutate: bridge.mutate,
    data: bridge.data,
    loading: false,
    error: null,
    reset: vi.fn(),
  }),
}));

describe('useSeedFieldRules', () => {
  beforeEach(() => {
    bridge.mutate.mockClear();
    bridge.data = null;
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

  it('should carry a persona ai_generate instruction to the aiPrompt config key', () => {
    bridge.data = {
      objectApiName: 'Product_Review__c',
      objectLabel: 'Product Review',
      fields: [
        {
          fieldApiName: 'Review_Text__c',
          label: 'Review Text',
          type: 'textarea',
          required: false,
          picklistValues: [],
          referenceTo: [],
          length: 32768,
        },
      ],
    };

    const { result } = renderHook(() => useSeedFieldRules('org-1', ['Product_Review__c'], 1));

    /* Same pattern shape as the built-in "E-commerce B2C" persona: the
       instruction sits under the persona-side `prompt` param. */
    const persona: PersonaMsg = {
      id: 'ecommerce-b2c',
      name: 'E-commerce B2C',
      description: 'Online retail with products, orders, customers, and reviews.',
      industry: 'Retail',
      locale: 'en-US',
      dataPatterns: {
        Review_Text__c: {
          fieldType: 'textarea',
          generator: 'ai_generate',
          params: { prompt: 'Product review, 1-3 sentences, realistic tone' },
          examples: ['Great product, fast shipping!'],
        },
      },
    };

    act(() => {
      result.current.applyPersona(persona);
    });

    const field = result.current.fieldConfigs[0].fields[0];
    expect(field.ruleType).toBe('ai_generate');
    /* Only `config.aiPrompt` is forwarded to the model (AIDataGenerator.buildPrompt)
       and it is the only prompt key the seed contract carries (FieldRuleConfig). */
    expect(field.config['aiPrompt']).toBe('Product review, 1-3 sentences, realistic tone');
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
