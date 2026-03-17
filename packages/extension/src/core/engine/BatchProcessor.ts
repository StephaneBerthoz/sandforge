import { extractErrorMessage } from '../common/extractErrorMessage.js';
/** Result of processing a single batch */
export interface BatchResult {
  batchIndex: number;
  totalRecords: number;
  successCount: number;
  failureCount: number;
  errors: string[];
}

/**
 * Splits records into batches and processes them sequentially or in parallel.
 * Batch size is clamped between 1 and 10 000 (Salesforce Bulk API limit).
 */
export class BatchProcessor {
  private readonly batchSize: number;
  private readonly defaultConcurrency: number;

  /**
   * @param batchSize - Number of records per batch, clamped to [1, 10 000] (default: 200)
   * @param defaultConcurrency - Default concurrency for parallel processing, clamped to [1, 20] (default: 3)
   */
  constructor(batchSize: number = 200, defaultConcurrency: number = 3) {
    this.batchSize = Math.max(1, Math.min(batchSize, 10_000));
    this.defaultConcurrency = Math.max(1, Math.min(defaultConcurrency, 20));
  }

  /** Split records into batches of the configured size */
  createBatches<T>(records: T[]): T[][] {
    const batches: T[][] = [];
    for (let i = 0; i < records.length; i += this.batchSize) {
      batches.push(records.slice(i, i + this.batchSize));
    }
    return batches;
  }

  /** Process batches sequentially, one after another */
  async processSequential<T>(
    records: T[],
    processor: (batch: T[], batchIndex: number) => Promise<BatchResult>
  ): Promise<BatchResult[]> {
    const batches = this.createBatches(records);
    const results: BatchResult[] = [];
    for (let i = 0; i < batches.length; i++) {
      const result = await processor(batches[i], i);
      results.push(result);
    }
    return results;
  }

  /**
   * Process batches in parallel with a concurrency limit.
   * @param records - All records to process
   * @param processor - Async function to process each batch
   * @param concurrency - Max parallel batches (default: constructor value, clamped to [1, 20])
   */
  async processParallel<T>(
    records: T[],
    processor: (batch: T[], batchIndex: number) => Promise<BatchResult>,
    concurrency?: number
  ): Promise<BatchResult[]> {
    const effectiveConcurrency = concurrency !== undefined
      ? Math.max(1, Math.min(concurrency, 20))
      : this.defaultConcurrency;
    const batches = this.createBatches(records);
    const results: BatchResult[] = new Array<BatchResult>(batches.length);
    let nextIndex = 0;

    async function runWorker(): Promise<void> {
      while (nextIndex < batches.length) {
        const index = nextIndex++;
        try {
          results[index] = await processor(batches[index], index);
        } catch (err) {
          results[index] = {
            batchIndex: index,
            totalRecords: batches[index].length,
            successCount: 0,
            failureCount: batches[index].length,
            errors: [extractErrorMessage(err)],
          };
        }
      }
    }

    const workers = Array.from(
      { length: Math.min(effectiveConcurrency, batches.length) },
      () => runWorker()
    );
    await Promise.all(workers);
    return results;
  }

  /** Get the configured batch size */
  getBatchSize(): number {
    return this.batchSize;
  }

  /** Get the configured default concurrency */
  getDefaultConcurrency(): number {
    return this.defaultConcurrency;
  }

  /** Calculate the number of batches needed for a given record count */
  calculateBatchCount(recordCount: number): number {
    return Math.ceil(recordCount / this.batchSize);
  }
}
