import { SF_LIMITS } from './sf-limits.js';

/**
 * Default batch sizes by API mode.
 *
 * Each value is aligned with Salesforce governor limits to maximize throughput
 * without exceeding platform constraints.
 *
 * - `rest` — Matches `SF_LIMITS.REST_API_BATCH_SIZE` (200), the maximum number
 *   of records per REST API DML call (insert/update/delete).
 * - `bulk` — 10,000 records per chunk submitted to Bulk API 2.0. The platform
 *   accepts up to 150M records per job, but chunking at 10k keeps memory
 *   pressure low and enables progress reporting per batch.
 * - `composite` — Matches `SF_LIMITS.COMPOSITE_BATCH_SIZE` (25), the maximum
 *   number of subrequests in a single Composite API call.
 * - `auto` — Starting batch size used by the adaptive algorithm before it tunes
 *   based on response times; defaults to the REST limit.
 */
export const DEFAULT_BATCH_SIZES = {
  rest: SF_LIMITS.REST_API_BATCH_SIZE,
  bulk: 10_000,
  composite: SF_LIMITS.COMPOSITE_BATCH_SIZE,
  auto: SF_LIMITS.REST_API_BATCH_SIZE,
} as const;

/**
 * Default timeout values.
 *
 * All values are in **milliseconds**.
 *
 * - `connection` — 30 s. Maximum wait for a TCP/TLS handshake to Salesforce.
 * - `request` — 120 s (2 min). Maximum wait for a single REST/SOAP API response.
 * - `bulkJob` — 600 s (10 min). Maximum wait for a Bulk API 2.0 job to complete;
 *   large jobs may need this extended via user config.
 * - `healthProbe` — 5 s. Timeout for org health-check pings used by Monitor.
 * - `tokenRefresh` — 10 s. Maximum wait for an OAuth token refresh round-trip.
 */
export const DEFAULT_TIMEOUTS = {
  /** 30 000 ms — TCP/TLS connection timeout */
  connection: 30_000,
  /** 120 000 ms — single API request timeout */
  request: 120_000,
  /** 600 000 ms — Bulk API 2.0 job completion timeout */
  bulkJob: 600_000,
  /** 5 000 ms — org health-check probe timeout */
  healthProbe: 5_000,
  /** 10 000 ms — OAuth token refresh timeout */
  tokenRefresh: 10_000,
} as const;

/**
 * Default retry configuration using an **exponential backoff** strategy.
 *
 * On transient failures (network errors, 429/503 responses) the system waits
 * `initialDelay * backoffMultiplier ^ attempt` milliseconds before retrying,
 * capped at `maxDelay`. This avoids thundering-herd effects and respects
 * Salesforce rate-limit headers.
 *
 * - `maxRetries` — 3 attempts after the initial call (4 total).
 * - `initialDelay` — 1 000 ms (1 s) base delay before the first retry.
 * - `maxDelay` — 30 000 ms (30 s) ceiling so retries don't stall the pipeline.
 * - `backoffMultiplier` — 2× geometric factor (delays: 1 s → 2 s → 4 s, capped at 30 s).
 */
export const DEFAULT_RETRY_CONFIG = {
  /** Maximum number of retry attempts after the initial call */
  maxRetries: 3,
  /** 1 000 ms — base delay before the first retry */
  initialDelay: 1_000,
  /** 30 000 ms — maximum delay between retries */
  maxDelay: 30_000,
  /** Geometric multiplier applied to the delay after each retry */
  backoffMultiplier: 2,
} as const;

/**
 * Default configuration for **grappe mode** (partitioned parallel processing).
 *
 * Grappe mode splits large datasets into partitions ("grappes") processed by
 * parallel workers, with back-pressure control to prevent memory exhaustion.
 *
 * - `autoActivateThreshold` — 10 000 records. When a dataset exceeds this count,
 *   grappe mode activates automatically instead of single-threaded processing.
 * - `maxWorkers` — 4. Matches a typical 4-core CPU; keeps parallelism effective
 *   without over-subscribing the event loop or hitting Salesforce concurrent-request limits.
 * - `grappeSize` — 5 000 records per partition. Balances memory footprint
 *   (~10 MB per grappe at 2 KB/record) against overhead of partition management.
 * - `strategy` — `'by_volume'`. Partitions are split by record count (vs. by object).
 * - `checkpointing` — `true`. Each completed grappe is persisted so the job can
 *   resume from the last checkpoint on failure.
 * - `isolationLevel` — `'per_grappe'`. Errors in one partition do not abort others.
 */
export const DEFAULT_GRAPPE_CONFIG = {
  /** 10 000 records — threshold above which grappe mode auto-activates */
  autoActivateThreshold: 10_000,
  /** 4 workers — CPU-count-matched default for parallel processing */
  maxWorkers: 4,
  /** 5 000 records per partition */
  grappeSize: 5_000,
  /** Partitioning strategy: split by record volume */
  strategy: 'by_volume' as const,
  /** Persist completed grappes for crash-recovery */
  checkpointing: true,
  /** Errors in one grappe do not abort sibling grappes */
  isolationLevel: 'per_grappe' as const,
  /**
   * Back-pressure configuration.
   *
   * Prevents the producer (query/read) from overwhelming the consumer
   * (transform/write) when workers cannot keep up.
   */
  backPressure: {
    /** Enable back-pressure monitoring */
    enabled: true,
    /** Maximum number of grappes queued and waiting for a worker */
    maxQueueDepth: 3,
    /** 80 % — queue utilisation percentage at which the producer pauses */
    highWaterMark: 80,
    /** 60 % — queue utilisation percentage at which the producer resumes */
    lowWaterMark: 60,
    /** Back-pressure response: pause the producer rather than dropping data */
    strategy: 'pause' as const,
    /** 5 000 ms — interval between queue-depth measurements */
    monitoringInterval: 5_000,
  },
};

/**
 * Default Monitor module settings.
 *
 * - `refreshInterval` — 60 000 ms (1 min). Polling interval for org limit checks.
 * - `alertCooldownMinutes` — 15 min. Minimum time between repeated alerts for the
 *   same limit to avoid notification fatigue.
 * - `maxHistoryDays` — 90 days. Retention period for historical limit snapshots
 *   used in trend analysis and charts.
 */
export const DEFAULT_MONITOR_CONFIG = {
  /** 60 000 ms — org limits polling interval */
  refreshInterval: 60_000,
  /** 15 min — cooldown between duplicate alerts */
  alertCooldownMinutes: 15,
  /** 90 days — historical snapshot retention */
  maxHistoryDays: 90,
} as const;

/**
 * Default SOQL query limits used across handler queries.
 *
 * These replace hardcoded LIMIT values in SOQL strings, making them
 * configurable from a single location.
 *
 * - `dataQuery` — 2 000 records. Default limit for data export, backup,
 *   anonymization, and compare queries.
 * - `monitorJobs` — 50. Number of recent AsyncApexJob records to fetch.
 * - `permissionSets` — 100. Number of PermissionSet records to fetch for comparison.
 * - `anomalyScan` — 500. Default sample size for AI anomaly detection.
 * - `singleRecord` — 1. Used when fetching a single org or record.
 */
export const DEFAULT_SOQL_LIMITS = {
  /** 2 000 — default record limit for data queries */
  dataQuery: 2_000,
  /** 50 — recent async jobs to display in Monitor */
  monitorJobs: 50,
  /** 100 — permission sets to compare */
  permissionSets: 100,
  /** 500 — default sample size for AI anomaly scan */
  anomalyScan: 500,
  /** 1 — single record fetch */
  singleRecord: 1,
} as const;

/** Module names */
export const MODULE_NAMES = [
  'seed',
  'sync',
  'monitor',
  'compare',
  'dataops',
  'automation',
] as const;

export type ModuleName = (typeof MODULE_NAMES)[number];
