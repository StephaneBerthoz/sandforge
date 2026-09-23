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

/**
 * Every status a sandbox process can be in, as Salesforce Help lists them
 * ("Sandbox Action and Status Reference").
 *
 * The type used to name four, one of which (`Failed`) Salesforce does not
 * have, and a status read from the org was cast to it: an activation waiting
 * for an admin, a copy being sampled or activated, all went uncounted as a
 * refresh in progress.
 */
export const SANDBOX_PROCESS_STATUSES = [
  'Sampling',
  'Pending',
  'Processing',
  'Suspended',
  'Stopped',
  'Pending Activation',
  'Activating',
  'Discarding',
  'Completed',
  'Deleting',
  'Locking',
  'Locked',
] as const;

/** A status Salesforce documents for a sandbox process. */
export type SandboxProcessStatus = (typeof SANDBOX_PROCESS_STATUSES)[number];

/**
 * The statuses of a copy that has not replaced the sandbox yet: queued,
 * sampled, built, interrupted (the copy engine resumes a suspended copy on
 * its own), waiting for an admin to activate it, or being activated. A
 * stopped process, a discarded copy, a deletion and a license lock are not
 * refreshes under way.
 *
 * Shared because two places read it: the extension, which counts a refresh
 * in progress, and Monitor's refresh panel, which styles its rows. The panel
 * kept a list of its own, and still knew only Pending and Processing once the
 * extension had learnt the other four.
 */
const SANDBOX_REFRESH_IN_PROGRESS_STATUSES: readonly SandboxProcessStatus[] = [
  'Sampling',
  'Pending',
  'Processing',
  'Suspended',
  'Pending Activation',
  'Activating',
];

/** Whether a sandbox process in `status` is a refresh still under way. */
export function isSandboxRefreshInProgress(status: string): boolean {
  return (SANDBOX_REFRESH_IN_PROGRESS_STATUSES as readonly string[]).includes(status);
}
