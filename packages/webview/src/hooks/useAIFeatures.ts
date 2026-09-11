/**
 * Hooks for AI features.
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

/** Schema advice for an org — rule-based, no model call. */
export function useSchemaAdvice() {
  return useBridgeMutation<AISchemaAdviceResponse['payload']>('ai:schema-advice');
}

/** Anomaly scan over sampled records — rule-based, no model call. */
export function useAnomalyScan() {
  return useBridgeMutation<AIAnomalyScanResponse['payload']>('ai:anomaly-scan');
}

/** AI pipeline generation from description. */
export function usePipelineGenerator() {
  return useBridgeMutation<AIGeneratePipelineResponse['payload']>('ai:generate-pipeline');
}
