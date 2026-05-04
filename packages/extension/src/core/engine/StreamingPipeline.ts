import type { StreamingChunkResult, StreamingExecutionResult } from '@sandforge/shared';

/** Maximum number of error messages to accumulate (prevents memory growth). */
const MAX_ERRORS = 100;

/** Progress callback for chunk completion. */
export type OnChunkProgress = (
  chunksProcessed: number,
  totalChunks: number,
  chunkResult: StreamingChunkResult,
) => void;

/** Function that processes a batch of records and returns a chunk result. */
export type ChunkProcessFn = (records: Record<string, unknown>[]) => Promise<StreamingChunkResult>;

/** Configuration for the streaming pipeline. */
export interface StreamingPipelineConfig {
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
  /** Callback after each chunk completes. */
  onChunkProgress?: OnChunkProgress;
  /** Total number of chunks (for progress calculation, if known upfront). */
  totalChunks?: number;
}

/**
 * Streaming pipeline that processes records in chunks using async iterables.
 *
 * Consumes an async iterable of record batches, processes each batch via a
 * caller-supplied function, and accumulates aggregate results. Never holds
 * more than one chunk in memory at a time.
 *
 * The pipeline is stateless -- create a new instance per execution.
 */
export class StreamingPipeline {
  private readonly signal?: AbortSignal;
  private readonly onChunkProgress?: OnChunkProgress;
  private readonly totalChunksHint?: number;

  constructor(config: StreamingPipelineConfig = {}) {
    this.signal = config.signal;
    this.onChunkProgress = config.onChunkProgress;
    this.totalChunksHint = config.totalChunks;
  }

  /**
   * Execute the streaming pipeline over an async iterable of record batches.
   *
   * @param chunks - Async iterable yielding arrays of records (one chunk at a time).
   * @param processFn - Function that processes a single chunk and returns its result.
   * @returns Aggregate result across all chunks.
   */
  async execute(
    chunks: AsyncIterable<Record<string, unknown>[]>,
    processFn: ChunkProcessFn,
  ): Promise<StreamingExecutionResult> {
    let totalRecords = 0;
    let successCount = 0;
    let failureCount = 0;
    const successIds: string[] = [];
    const errors: string[] = [];
    let chunksProcessed = 0;

    for await (const chunk of chunks) {
      if (this.signal?.aborted) {
        return {
          totalRecords,
          successCount,
          failureCount,
          successIds,
          errors,
          aborted: true,
        };
      }

      if (chunk.length === 0) {
        continue;
      }

      const result = await processFn(chunk);

      totalRecords += chunk.length;
      successCount += result.successCount;
      failureCount += result.failureCount;

      for (const id of result.successIds) {
        successIds.push(id);
      }

      if (errors.length < MAX_ERRORS) {
        const remaining = MAX_ERRORS - errors.length;
        const toAdd = result.errors.slice(0, remaining);
        for (const err of toAdd) {
          errors.push(err);
        }
      }

      chunksProcessed++;
      this.onChunkProgress?.(chunksProcessed, this.totalChunksHint ?? chunksProcessed, result);
    }

    return {
      totalRecords,
      successCount,
      failureCount,
      successIds,
      errors,
      aborted: false,
    };
  }
}
