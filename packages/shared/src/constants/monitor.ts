/**
 * Monitor-related shared constants used by both extension handlers.
 *
 * @module constants/monitor
 */

/**
 * Key limit names to compute trends for.
 *
 * Used by both MonitorHandler and MonitorOpsHandler to determine which
 * Salesforce API limits should have trend data computed.
 */
export const MONITOR_KEY_LIMITS = [
  'DailyApiRequests',
  'DataStorageMB',
  'FileStorageMB',
  'DailySoqlQueries',
  'DailyDmlStatements',
  'DailyAsyncApexExecutions',
] as const;

/** Type representing valid key limit names. */
export type MonitorKeyLimit = (typeof MONITOR_KEY_LIMITS)[number];
