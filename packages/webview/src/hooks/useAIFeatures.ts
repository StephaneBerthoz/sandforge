/**
 * Hooks for AI features (Tier 2).
 * Thin wrappers around useBridgeMutation for type-safe AI feature access.
 */

import type {
  AINL2SOQLResponse,
  AISchemaAdviceResponse,
  AIAnomalyScanResponse,
  AIGeneratePipelineResponse,
} from '@sandforge/shared';

import { useBridgeMutation } from './useBridgeMutation';

/** Convert natural language to SOQL. */
export function useNL2SOQL() {
  return useBridgeMutation<AINL2SOQLResponse['payload']>('ai:nl2soql');
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
