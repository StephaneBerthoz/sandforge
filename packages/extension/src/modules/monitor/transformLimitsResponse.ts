import type { ApiLimit } from '@sandforge/shared';

/**
 * Raw Salesforce limits response shape from the REST API.
 *
 * Each key is a limit name, and the value contains Max and Remaining counts.
 */
export type RawLimitsResponse = Record<string, { Max: number; Remaining: number }>;

/**
 * Transform a raw Salesforce limits API response into an array of ApiLimit objects.
 *
 * Computes usedPercent as the rounded percentage of consumed capacity.
 * Returns 0 for usedPercent when Max is 0 to avoid division by zero.
 *
 * @param limitsRaw - Raw limits response from `/services/data/vXX.0/limits`.
 * @returns Array of normalized ApiLimit objects.
 */
export function transformLimitsResponse(limitsRaw: RawLimitsResponse): ApiLimit[] {
  return Object.entries(limitsRaw).map(([name, { Max, Remaining }]) => ({
    name,
    max: Max,
    remaining: Remaining,
    usedPercent: Max > 0 ? Math.round(((Max - Remaining) / Max) * 100) : 0,
  }));
}
