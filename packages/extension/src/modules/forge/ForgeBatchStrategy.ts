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
   * @param strategy - User-chosen strategy or 'auto'.
   * @param recordCount - Number of records to process.
   * @returns Resolved strategy with API type, batch size, and batch count.
   */
  resolve(strategy: StrategyType, recordCount: number): ResolvedBatchStrategy {
    const api = strategy === 'auto'
      ? (recordCount > BULK_THRESHOLD ? 'bulk' : 'rest')
      : strategy;

    const batchSize = api === 'bulk' ? BULK_BATCH_SIZE : REST_BATCH_SIZE;
    const batchCount = Math.max(1, Math.ceil(recordCount / batchSize));

    return { api, batchSize, batchCount };
  }
}
