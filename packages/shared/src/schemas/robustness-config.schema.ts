import { z } from 'zod';

/**
 * Zod schema for timeout configuration.
 * All values in milliseconds with sensible minimums to prevent zero/negative timeouts.
 */
export const timeoutsConfigSchema = z
  .object({
    /** Timeout for describeGlobal API call (ms) */
    describeGlobal: z.number().min(5000).max(120_000).default(30_000),
    /** Timeout for describe (single object) API call (ms) */
    describe: z.number().min(5000).max(60_000).default(15_000),
    /** Timeout for a single CRUD batch operation (ms) */
    crudBatch: z.number().min(10_000).max(300_000).default(60_000),
    /** Timeout for a Bulk API 2.0 job to complete (ms) */
    bulkJob: z.number().min(60_000).max(600_000).default(300_000),
  })
  .default({});

/**
 * Zod schema for retry strategy configuration.
 * Controls exponential backoff behavior for transient errors.
 */
export const retryConfigSchema = z
  .object({
    /** Maximum number of retry attempts (0 = no retries) */
    maxRetries: z.number().int().min(0).max(10).default(3),
    /** Initial delay before first retry (ms) */
    initialDelay: z.number().min(100).max(30_000).default(1000),
    /** Maximum delay between retries (ms) */
    maxDelay: z.number().min(1000).max(120_000).default(30_000),
    /** Multiplier applied to delay after each retry */
    backoffMultiplier: z.number().min(1).max(5).default(2),
  })
  .default({});

/**
 * Zod schema for Bulk API configuration.
 * Controls when Bulk API 2.0 is used instead of REST API.
 */
export const bulkConfigSchema = z
  .object({
    /** Record count threshold: use Bulk API above this number */
    threshold: z.number().int().min(1).max(10_000).default(200),
    /** Polling interval for bulk job status checks (ms) */
    pollIntervalMs: z.number().min(1000).max(30_000).default(5000),
    /** Maximum number of concurrent bulk jobs */
    maxConcurrentJobs: z.number().int().min(1).max(100).default(5),
  })
  .default({});

/**
 * Complete robustness configuration schema.
 * Validates and provides defaults for timeout, retry, and bulk API settings.
 */
export const RobustnessConfigSchema = z.object({
  /** Timeout settings for various API operations */
  timeouts: timeoutsConfigSchema,
  /** Retry strategy settings for transient error handling */
  retry: retryConfigSchema,
  /** Bulk API 2.0 settings */
  bulk: bulkConfigSchema,
});

/** Inferred TypeScript type for robustness configuration */
export type RobustnessConfig = z.infer<typeof RobustnessConfigSchema>;

/** Inferred TypeScript type for timeout configuration */
export type TimeoutsConfig = z.infer<typeof timeoutsConfigSchema>;

/** Inferred TypeScript type for retry configuration */
export type RetryConfigInput = z.infer<typeof retryConfigSchema>;

/** Inferred TypeScript type for bulk API configuration */
export type BulkConfig = z.infer<typeof bulkConfigSchema>;

/**
 * Default robustness configuration with all defaults applied.
 * Obtained by parsing an empty object through the schema.
 */
export const DEFAULT_ROBUSTNESS_CONFIG: RobustnessConfig = RobustnessConfigSchema.parse({});
