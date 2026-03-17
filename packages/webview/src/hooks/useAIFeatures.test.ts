import { describe, it, expect, vi } from 'vitest';

// Mock useBridgeMutation before importing
vi.mock('./useBridgeMutation', () => ({
  useBridgeMutation: vi.fn(() => ({
    mutate: vi.fn(),
    data: null,
    loading: false,
    error: null,
    reset: vi.fn(),
  })),
}));

import { useBridgeMutation } from './useBridgeMutation';
import {
  useNL2SOQL,
  useErrorResolver,
  useSmartSuggestions,
  useSchemaAdvice,
  useAnomalyScan,
  usePipelineGenerator,
  useAIPersonas,
} from './useAIFeatures';

describe('useAIFeatures', () => {
  it('useNL2SOQL calls useBridgeMutation with ai:nl2soql', () => {
    useNL2SOQL();
    expect(useBridgeMutation).toHaveBeenCalledWith('ai:nl2soql');
  });

  it('useErrorResolver calls useBridgeMutation with ai:resolve-error', () => {
    useErrorResolver();
    expect(useBridgeMutation).toHaveBeenCalledWith('ai:resolve-error');
  });

  it('useSmartSuggestions calls useBridgeMutation with ai:suggestions', () => {
    useSmartSuggestions();
    expect(useBridgeMutation).toHaveBeenCalledWith('ai:suggestions');
  });

  it('useSchemaAdvice calls useBridgeMutation with ai:schema-advice', () => {
    useSchemaAdvice();
    expect(useBridgeMutation).toHaveBeenCalledWith('ai:schema-advice');
  });

  it('useAnomalyScan calls useBridgeMutation with ai:anomaly-scan', () => {
    useAnomalyScan();
    expect(useBridgeMutation).toHaveBeenCalledWith('ai:anomaly-scan');
  });

  it('usePipelineGenerator calls useBridgeMutation with ai:generate-pipeline', () => {
    usePipelineGenerator();
    expect(useBridgeMutation).toHaveBeenCalledWith('ai:generate-pipeline');
  });

  it('useAIPersonas calls useBridgeMutation with ai:personas', () => {
    useAIPersonas();
    expect(useBridgeMutation).toHaveBeenCalledWith('ai:personas');
  });
});
