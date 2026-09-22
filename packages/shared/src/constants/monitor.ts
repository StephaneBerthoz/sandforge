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
 *
 * Every name is one `/limits` answers with. The list used to carry
 * `DailySoqlQueries` and `DailyDmlStatements`, which are Apex governor limits
 * counted per transaction, not org limits: no org returns them, and read
 * against real orgs their two trends never held a single point. The Bulk API
 * limits took their place: SandForge writes through Bulk API 2.0 ingest jobs,
 * which draw on `DailyBulkApiBatches`, and Bulk API 2.0 queries draw on
 * `DailyBulkV2QueryJobs`.
 */
export const MONITOR_KEY_LIMITS = [
  'DailyApiRequests',
  'DataStorageMB',
  'FileStorageMB',
  'DailyBulkApiBatches',
  'DailyBulkV2QueryJobs',
  'DailyAsyncApexExecutions',
] as const;

/** Type representing valid key limit names. */
export type MonitorKeyLimit = (typeof MONITOR_KEY_LIMITS)[number];
