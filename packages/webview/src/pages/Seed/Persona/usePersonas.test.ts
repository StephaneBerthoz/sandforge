import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { PersonaMsg } from '@sandforge/shared';
import { usePersonas, generateSampleRecords } from './usePersonas';

/* ------------------------------------------------------------------ */
/* Mock bridge hooks                                                   */
/* ------------------------------------------------------------------ */
let mockQueryState = {
  data: null as { personas: PersonaMsg[] } | null,
  loading: false,
  error: null as string | null,
  refetch: vi.fn(),
};

const mockMutate = vi.fn();
let mockMutationState = {
  mutate: mockMutate,
  data: null as { persona: PersonaMsg; success: boolean; error?: string } | null,
  loading: false,
  error: null as string | null,
  reset: vi.fn(),
};

vi.mock('../../../hooks/useBridgeQuery', () => ({
  useBridgeQuery: () => mockQueryState,
}));

vi.mock('../../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: () => mockMutationState,
}));

/* ------------------------------------------------------------------ */
/* Test data                                                           */
/* ------------------------------------------------------------------ */
const mockPersona: PersonaMsg = {
  id: 'assureur-fr',
  name: 'Assureur francais',
  description: "Compagnie d'assurance francaise",
  industry: 'Insurance',
  locale: 'fr-FR',
  dataPatterns: {
    Name: {
      fieldType: 'string',
      generator: 'faker',
      examples: ['AXA Prevoyance', 'Mutuelle du Soleil', 'Groupe Assurancia'],
    },
    Contract_Type__c: {
      fieldType: 'picklist',
      generator: 'random_pick',
      examples: ['Auto', 'Habitation', 'Sante'],
    },
    Premium__c: {
      fieldType: 'currency',
      generator: 'range',
      examples: ['450.00', '1200.50', '3200.00'],
    },
  },
};

const mockPersona2: PersonaMsg = {
  id: 'hospital-us',
  name: 'Hospital US',
  description: 'Hospital system',
  industry: 'Healthcare',
  locale: 'en-US',
  dataPatterns: {
    FirstName: { fieldType: 'string', generator: 'faker', examples: ['James', 'Sarah'] },
    ICD10_Code__c: { fieldType: 'string', generator: 'random_pick', examples: ['J06.9', 'I10'] },
  },
};

describe('usePersonas', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryState = {
      data: { personas: [mockPersona, mockPersona2] },
      loading: false,
      error: null,
      refetch: vi.fn(),
    };
    mockMutationState = {
      mutate: mockMutate,
      data: null,
      loading: false,
      error: null,
      reset: vi.fn(),
    };
  });

  it('fetches persona list and exposes them', () => {
    const { result } = renderHook(() => usePersonas());
    expect(result.current.personas).toHaveLength(2);
    expect(result.current.personas[0].id).toBe('assureur-fr');
    expect(result.current.personas[1].id).toBe('hospital-us');
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('selectPersona sets selectedPersona by id', () => {
    const { result } = renderHook(() => usePersonas());
    act(() => result.current.selectPersona('hospital-us'));
    expect(result.current.selectedPersona?.id).toBe('hospital-us');
  });

  it('openPreview / closePreview manages preview state', () => {
    const { result } = renderHook(() => usePersonas());
    act(() => result.current.openPreview('assureur-fr'));
    expect(result.current.previewedPersona?.id).toBe('assureur-fr');
    act(() => result.current.closePreview());
    expect(result.current.previewedPersona).toBeNull();
  });

  it('createCustom calls mutation with trimmed description', () => {
    const { result } = renderHook(() => usePersonas());
    act(() => result.current.setCustomDescription('  Restaurant chain  '));
    act(() => result.current.createCustom());
    expect(mockMutate).toHaveBeenCalledWith({ description: 'Restaurant chain' });
  });

  it('createCustom does nothing when description is empty', () => {
    const { result } = renderHook(() => usePersonas());
    act(() => result.current.setCustomDescription(''));
    act(() => result.current.createCustom());
    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('returns empty array when query data is null', () => {
    mockQueryState.data = null;
    const { result } = renderHook(() => usePersonas());
    expect(result.current.personas).toEqual([]);
  });
});

describe('generateSampleRecords', () => {
  it('generates 5 records from persona data patterns', () => {
    const records = generateSampleRecords(mockPersona);
    expect(records).toHaveLength(5);
    expect(Object.keys(records[0])).toEqual(['Name', 'Contract_Type__c', 'Premium__c']);
  });

  it('cycles through examples for rows beyond examples length', () => {
    const records = generateSampleRecords(mockPersona);
    // Name has 3 examples, row 3 wraps to index 0
    expect(records[0].Name).toBe('AXA Prevoyance');
    expect(records[1].Name).toBe('Mutuelle du Soleil');
    expect(records[2].Name).toBe('Groupe Assurancia');
    expect(records[3].Name).toBe('AXA Prevoyance');
    expect(records[4].Name).toBe('Mutuelle du Soleil');
  });

  it('handles persona with empty examples gracefully', () => {
    const emptyPersona: PersonaMsg = {
      id: 'empty',
      name: 'Empty',
      description: 'No examples',
      industry: 'Test',
      locale: 'en-US',
      dataPatterns: {
        Field1: { fieldType: 'string', generator: 'faker', examples: [] },
      },
    };
    const records = generateSampleRecords(emptyPersona);
    expect(records).toHaveLength(5);
    expect(records[0].Field1).toBe('');
  });
});
