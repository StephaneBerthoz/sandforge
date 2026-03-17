/**
 * Hooks for AI features (Tier 2).
 * Thin wrappers around useBridgeMutation for type-safe AI feature access.
 */

import type {
  AINL2SOQLResponse,
  AIResolveErrorResponse,
  AISuggestionsResponse,
  AISchemaAdviceResponse,
  AIAnomalyScanResponse,
  AIGeneratePipelineResponse,
  AIPersonasResponse,
} from '@sandforge/shared';

import { useBridgeMutation } from './useBridgeMutation';

/** Convert natural language to SOQL. */
export function useNL2SOQL() {
  return useBridgeMutation<AINL2SOQLResponse['payload']>('ai:nl2soql');
}

/** AI error resolution. */
export function useErrorResolver() {
  return useBridgeMutation<AIResolveErrorResponse['payload']>('ai:resolve-error');
}

/** AI smart suggestions for a module. */
export function useSmartSuggestions() {
  return useBridgeMutation<AISuggestionsResponse['payload']>('ai:suggestions');
}

/** AI schema advice for an org. */
export function useSchemaAdvice() {
  return useBridgeMutation<AISchemaAdviceResponse['payload']>('ai:schema-advice');
}

/** AI anomaly detection scan. */
export function useAnomalyScan() {
  return useBridgeMutation<AIAnomalyScanResponse['payload']>('ai:anomaly-scan');
}

/** AI pipeline generation from description. */
export function usePipelineGenerator() {
  return useBridgeMutation<AIGeneratePipelineResponse['payload']>('ai:generate-pipeline');
}

/** AI personas list/create. */
export function useAIPersonas() {
  return useBridgeMutation<AIPersonasResponse['payload']>('ai:personas');
}
