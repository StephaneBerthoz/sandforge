/**
 * Parse and monitor `Sforce-Limit-Info` headers returned by Salesforce API calls.
 *
 * jsforce v2 exposes `connection.limitInfo` after each API call.
 * This utility provides structured access to that data and warns when
 * usage exceeds configurable thresholds.
 *
 * @module sforceLimitParser
 */

import { logger } from '../../logger.js';

/** Parsed API usage from Sforce-Limit-Info header */
export interface SforceLimitInfo {
  /** Number of API calls used in the current 24-hour period */
  apiUsage: number;
  /** Maximum API calls allowed in the current 24-hour period */
  apiLimit: number;
  /** Usage percentage (0–100) */
  usagePercent: number;
}

/** Default warning threshold: 80% of API limit */
const DEFAULT_WARN_THRESHOLD = 80;

/** Default critical threshold: 95% of API limit */
const DEFAULT_CRITICAL_THRESHOLD = 95;

/**
 * Parse the `limitInfo` property from a jsforce Connection.
 *
 * jsforce exposes `connection.limitInfo.apiUsage` after each request,
 * containing `{ used, limit }` from the `Sforce-Limit-Info` header.
 *
 * @param limitInfo - The `limitInfo` object from a jsforce Connection.
 * @returns Parsed limit info, or `undefined` if data is unavailable.
 */
export function parseSforceLimitInfo(
  limitInfo: { apiUsage?: { used: number; limit: number } } | undefined,
): SforceLimitInfo | undefined {
  if (!limitInfo?.apiUsage) {
    return undefined;
  }

  const { used, limit } = limitInfo.apiUsage;
  const usagePercent = limit > 0 ? Math.round((used / limit) * 100) : 0;

  return { apiUsage: used, apiLimit: limit, usagePercent };
}

/**
 * Log a warning if API usage exceeds the configured thresholds.
 *
 * Call this after API-intensive operations (bulk queries, batch DML)
 * to proactively warn about approaching governor limits.
 *
 * @param limitInfo - The `limitInfo` object from a jsforce Connection.
 * @param context - A string describing the operation (for log context).
 * @param warnThreshold - Percentage threshold for warning (default 80).
 * @param criticalThreshold - Percentage threshold for critical alert (default 95).
 */
export function checkApiLimits(
  limitInfo: { apiUsage?: { used: number; limit: number } } | undefined,
  context: string,
  warnThreshold = DEFAULT_WARN_THRESHOLD,
  criticalThreshold = DEFAULT_CRITICAL_THRESHOLD,
): SforceLimitInfo | undefined {
  const parsed = parseSforceLimitInfo(limitInfo);
  if (!parsed) {
    return undefined;
  }

  /* logger is module-level singleton */

  if (parsed.usagePercent >= criticalThreshold) {
    logger.error(
      `[API Limits] CRITICAL: ${parsed.apiUsage}/${parsed.apiLimit} ` +
        `(${parsed.usagePercent}%) during ${context}`,
    );
  } else if (parsed.usagePercent >= warnThreshold) {
    logger.warn(
      `[API Limits] WARNING: ${parsed.apiUsage}/${parsed.apiLimit} ` +
        `(${parsed.usagePercent}%) during ${context}`,
    );
  }

  return parsed;
}
