/**
 * Monitor-related shared constants used by both extension handlers.
 *
 * @module constants/monitor
 */

/** Period string to milliseconds mapping for trend computation. */
export const MONITOR_PERIOD_MAP: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

/**
 * Key limit names to compute trends for.
 *
 * Used by both MonitorHandler and MonitorOpsHandler to determine which
 * Salesforce API limits should have trend data computed.
 */
export const MONITOR_KEY_LIMITS = [
  'DailyApiRequests',
  'DataStorageMB',
  'DailySoqlQueries',
  'DailyDmlStatements',
  'DailyAsyncApexExecutions',
] as const;

/** Type representing valid key limit names. */
export type MonitorKeyLimit = (typeof MONITOR_KEY_LIMITS)[number];
