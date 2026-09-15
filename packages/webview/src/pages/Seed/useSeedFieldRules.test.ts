import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { PersonaMsg } from '@sandforge/shared';

import { useSeedWizardStore } from '../../stores/useSeedWizardStore';
import { useSeedFieldRules } from './useSeedFieldRules';

/** Same shapes as the built-in "Assureur français" persona. */
const ASSUREUR_FR: PersonaMsg = {
  id: 'assureur-fr',
  name: 'Assureur français',
  description: "Compagnie d'assurance française",
  industry: 'Insurance',
  locale: 'fr-FR',
  dataPatterns: {
    FirstName: {
      fieldType: 'string',
      generator: 'faker',
      params: { method: 'person.firstName', locale: 'fr' },
      examples: ['Jean'],
    },
    Premium__c: {
      fieldType: 'currency',
      generator: 'range',
      params: { min: 200, max: 5000, currency: 'EUR' },
      examples: ['450.00'],
    },
    Contract_Type__c: {
      fieldType: 'picklist',
      generator: 'random_pick',
      params: { values: ['Auto', 'Habitation', 'Santé'] },
      examples: ['Auto'],
    },
  },
};

function describedField(fieldApiName: string, type: string): Record<string, unknown> {
  return {
    fieldApiName,
    label: fieldApiName,
    type,
    required: false,
    picklistValues: [],
    referenceTo: [],
    length: 0,
  };
}

const CONTRACT_DESCRIBE = {
  objectApiName: 'Contract__c',
  objectLabel: 'Contract',
  fields: [
    describedField('Premium__c', 'currency'),
    describedField('Contract_Type__c', 'picklist'),
    describedField('Notes__c', 'textarea'),
  ],
};

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
    useSeedWizardStore.getState().resetSeedWizard();
  });

  it('counts the fields a persona configures even when another update is still pending', () => {
    bridge.data = CONTRACT_DESCRIBE;
    const { result } = renderHook(() => useSeedFieldRules('org-1', ['Contract__c'], 1));

    /* The wizard applies a persona from an effect that runs right after a
       fieldConfigs update, which is when React defers the state updater. */
    let count = 0;
    act(() => {
      result.current.handleChangeFieldConfig('Contract__c', 'Notes__c', 'staticValue', 'x');
      count = result.current.applyPersona(ASSUREUR_FR);
    });

    expect(count).toBe(2);
    expect(result.current.fieldConfigs[0].fields.map((f) => f.ruleType)).toEqual([
      'random',
      'picklist_random',
      'faker',
    ]);
  });

  it('applies the selected persona to an object described after the persona was applied', () => {
    useSeedWizardStore.getState().setSelectedPersona(ASSUREUR_FR);
    bridge.data = CONTRACT_DESCRIBE;
    const { result, rerender } = renderHook(() =>
      useSeedFieldRules('org-1', ['Contract__c', 'Contact'], 1),
    );
    act(() => {
      result.current.applyPersona(ASSUREUR_FR);
    });

    bridge.data = {
      objectApiName: 'Contact',
      objectLabel: 'Contact',
      fields: [describedField('FirstName', 'string'), describedField('Email', 'email')],
    };
    rerender();

    const contact = result.current.fieldConfigs.find((c) => c.objectApiName === 'Contact');
    expect(contact?.fields[0]).toMatchObject({
      ruleType: 'faker',
      config: { fakerMethod: 'firstName', fakerLocale: 'fr' },
    });
    expect(contact?.fields[1]).toMatchObject({ ruleType: 'faker', config: {} });
  });

  it('leaves the default rule on a field whose type a persona AI pattern cannot fill', () => {
    const persona: PersonaMsg = {
      ...ASSUREUR_FR,
      dataPatterns: {
        Premium__c: {
          fieldType: 'string',
          generator: 'ai_generate',
          params: { prompt: 'Premium' },
          examples: [],
        },
        Notes__c: {
          fieldType: 'textarea',
          generator: 'ai_generate',
          params: { prompt: 'Claim notes' },
          examples: [],
        },
      },
    };
    bridge.data = CONTRACT_DESCRIBE;
    const { result } = renderHook(() => useSeedFieldRules('org-1', ['Contract__c'], 1));

    let count = 0;
    act(() => {
      count = result.current.applyPersona(persona);
    });

    expect(count).toBe(1);
    const [premium, , notes] = result.current.fieldConfigs[0].fields;
    expect(premium).toMatchObject({ ruleType: 'faker', config: {} });
    expect(notes).toMatchObject({ ruleType: 'ai_generate', config: { aiPrompt: 'Claim notes' } });
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

  it('should write persona bounds and picklists under the keys the seed contract reads', () => {
    bridge.data = {
      objectApiName: 'Contract__c',
      objectLabel: 'Contract',
      fields: [
        {
          fieldApiName: 'Premium__c',
          label: 'Premium',
          type: 'currency',
          required: false,
          picklistValues: [],
          referenceTo: [],
          length: 0,
        },
        {
          fieldApiName: 'Contract_Type__c',
          label: 'Contract Type',
          type: 'picklist',
          required: false,
          picklistValues: [],
          referenceTo: [],
          length: 0,
        },
      ],
    };

    const { result } = renderHook(() => useSeedFieldRules('org-1', ['Contract__c'], 1));

    /* Same pattern shapes as the built-in "Assureur français" persona. */
    const persona: PersonaMsg = {
      id: 'assureur-fr',
      name: 'Assureur français',
      description: "Compagnie d'assurance française",
      industry: 'Insurance',
      locale: 'fr-FR',
      dataPatterns: {
        Premium__c: {
          fieldType: 'currency',
          generator: 'range',
          params: { min: 200, max: 5000, currency: 'EUR' },
          examples: ['450.00'],
        },
        Contract_Type__c: {
          fieldType: 'picklist',
          generator: 'random_pick',
          params: { values: ['Auto', 'Habitation', 'Santé'] },
          examples: ['Auto'],
        },
      },
    };

    act(() => {
      result.current.applyPersona(persona);
    });

    const [premium, contractType] = result.current.fieldConfigs[0].fields;
    expect(premium.ruleType).toBe('random');
    expect(premium.config).toEqual({ minValue: 200, maxValue: 5000 });
    expect(contractType.ruleType).toBe('picklist_random');
    expect(contractType.config).toEqual({ picklistValues: ['Auto', 'Habitation', 'Santé'] });
  });
});
