/**
 * Batch strategy type for Forge operations.
 * Local alias — will be replaced by the shared type once Chunk 1 completes.
 */
type StrategyType = 'rest' | 'bulk' | 'auto';

/** REST API DML limit per call. */
const REST_BATCH_SIZE = 200;
/** Bulk API 2.0 batch size. */
const BULK_BATCH_SIZE = 10_000;
/** Record count threshold for switching from REST to Bulk in auto mode. */
const BULK_THRESHOLD = 200;

/**
 * Rows of one write past which a run that writes through the Bulk API
 * (`writeApi: 'auto'`, a clone of the whole org) sends it as a Bulk API 2.0
 * job, and under which it sends it by REST calls of 200. A job sends some ten
 * calls whatever it holds — opened, sent, closed, its state read four times
 * or more, its results read three ways — and waits its turn in the org first,
 * some 24 seconds on a scratch org: under two thousand rows, the ten REST
 * calls they take cost no more and end sooner. Apart from
 * {@link BULK_THRESHOLD}, which only the plan's strategy reads, and which no
 * write follows.
 */
export const FORGE_BULK_MIN_ROWS = 2_000;

/**
 * Objects a Forge run writes by REST whatever their number:
 * - a file's version and an attachment carry their content as base64, which
 *   the Bulk API refuses (`FileCopier`);
 * - an email is written with the task the org makes for it, and a task with
 *   the emails that wait for it: both are answered row by row.
 */
export const FORGE_REST_ONLY_OBJECTS: ReadonlySet<string> = new Set([
  'ContentVersion',
  'Attachment',
  'EmailMessage',
  'Task',
]);

/**
 * The objects the standard duplicate rules every org starts with watch, and
 * keep active: Account, Contact and Lead. A Bulk API job cannot waive a rule
 * (no `DuplicateRuleHeader`), so they are written by REST unless the target
 * says which of its objects a rule watches: as a Seed job, the standard
 * account rule refused 296 of 500 accounts.
 */
export const DUPLICATE_RULE_FALLBACK_OBJECTS: ReadonlySet<string> = new Set([
  'Account',
  'Contact',
  'Lead',
]);

/** Resolved batch strategy with concrete values. */
export interface ResolvedBatchStrategy {
  /** API to use for this object. */
  api: 'rest' | 'bulk';
  /** Maximum records per batch. */
  batchSize: number;
  /** Total number of batches needed. */
  batchCount: number;
}

/**
 * Resolves batch strategy (REST vs Bulk API) based on record count and user override.
 */
export class ForgeBatchStrategy {
  /**
   * Resolve the concrete batch strategy for a given object.
   *
   * No record, no batch: the plan adds up these counts as the API calls a run
   * makes, and the writer makes none for an object with nothing to write.
   * Held to one batch at least, every empty object of a graph was one call
   * more in the plan's estimate and its duration.
   *
   * @param strategy - User-chosen strategy or 'auto'.
   * @param recordCount - Number of records to process.
   * @returns Resolved strategy with API type, batch size, and batch count.
   */
  resolve(strategy: StrategyType, recordCount: number): ResolvedBatchStrategy {
    const api = strategy === 'auto' ? (recordCount > BULK_THRESHOLD ? 'bulk' : 'rest') : strategy;

    const batchSize = api === 'bulk' ? BULK_BATCH_SIZE : REST_BATCH_SIZE;
    const batchCount = Math.ceil(recordCount / batchSize);

    return { api, batchSize, batchCount };
  }
}
