import { describe, it, expect, vi } from 'vitest';
import type { StreamingChunkResult } from '@sandforge/shared';
import {
  StreamingPipeline,
  type ChunkProcessFn,
  type OnChunkProgress,
} from './StreamingPipeline.js';

/** Helper: create an async generator from arrays. */
async function* toAsyncIterable(
  batches: Record<string, unknown>[][],
): AsyncGenerator<Record<string, unknown>[]> {
  for (const batch of batches) {
    yield batch;
  }
}

/** Helper: create a simple processFn that returns all successes. */
function makeSuccessProcessor(): ChunkProcessFn {
  return async (records) => ({
    successCount: records.length,
    failureCount: 0,
    successIds: records.map((_, i) => `id-${i}`),
    errors: [],
  });
}

describe('StreamingPipeline', () => {
  it('should process all chunks from an async generator', async () => {
    const chunks = [
      [{ Name: 'A1' }, { Name: 'A2' }],
      [{ Name: 'B1' }, { Name: 'B2' }, { Name: 'B3' }],
    ];
    const pipeline = new StreamingPipeline();
    const result = await pipeline.execute(
      toAsyncIterable(chunks),
      makeSuccessProcessor(),
    );

    expect(result.totalRecords).toBe(5);
    expect(result.successCount).toBe(5);
    expect(result.failureCount).toBe(0);
    expect(result.aborted).toBe(false);
    expect(result.successIds).toHaveLength(5);
    expect(result.errors).toHaveLength(0);
  });

  it('should accumulate success and failure counts correctly', async () => {
    const chunks = [
      [{ Name: 'A1' }, { Name: 'A2' }],
      [{ Name: 'B1' }, { Name: 'B2' }, { Name: 'B3' }],
    ];
    const processFn: ChunkProcessFn = async (records) => ({
      successCount: records.length - 1,
      failureCount: 1,
      successIds: records.slice(0, -1).map((_, i) => `id-${i}`),
      errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION'],
    });

    const pipeline = new StreamingPipeline();
    const result = await pipeline.execute(toAsyncIterable(chunks), processFn);

    expect(result.totalRecords).toBe(5);
    expect(result.successCount).toBe(3);
    expect(result.failureCount).toBe(2);
    expect(result.errors).toHaveLength(2);
  });

  it('should call onChunkProgress after each chunk with correct counts', async () => {
    const chunks = [
      [{ Name: 'A1' }],
      [{ Name: 'B1' }],
      [{ Name: 'C1' }],
    ];
    const progressCalls: Array<{
      chunksProcessed: number;
      totalChunks: number;
      result: StreamingChunkResult;
    }> = [];
    const onChunkProgress: OnChunkProgress = (
      chunksProcessed,
      totalChunks,
      result,
    ) => {
      progressCalls.push({ chunksProcessed, totalChunks, result });
    };

    const pipeline = new StreamingPipeline({
      onChunkProgress,
      totalChunks: 3,
    });
    await pipeline.execute(toAsyncIterable(chunks), makeSuccessProcessor());

    expect(progressCalls).toHaveLength(3);
    expect(progressCalls[0].chunksProcessed).toBe(1);
    expect(progressCalls[0].totalChunks).toBe(3);
    expect(progressCalls[1].chunksProcessed).toBe(2);
    expect(progressCalls[2].chunksProcessed).toBe(3);
  });

  it('should use chunksProcessed as totalChunks when totalChunks is not provided', async () => {
    const chunks = [[{ Name: 'A1' }], [{ Name: 'B1' }]];
    const progressCalls: Array<{
      chunksProcessed: number;
      totalChunks: number;
    }> = [];

    const pipeline = new StreamingPipeline({
      onChunkProgress: (chunksProcessed, totalChunks) => {
        progressCalls.push({ chunksProcessed, totalChunks });
      },
    });
    await pipeline.execute(toAsyncIterable(chunks), makeSuccessProcessor());

    expect(progressCalls[0].totalChunks).toBe(1);
    expect(progressCalls[1].totalChunks).toBe(2);
  });

  it('should abort when signal is triggered and return aborted: true', async () => {
    const controller = new AbortController();
    const processedChunks: number[] = [];

    const processFn: ChunkProcessFn = async (records) => {
      processedChunks.push(records.length);
      if (processedChunks.length === 1) {
        controller.abort();
      }
      return {
        successCount: records.length,
        failureCount: 0,
        successIds: [],
        errors: [],
      };
    };

    const chunks = [
      [{ Name: 'A1' }],
      [{ Name: 'B1' }],
      [{ Name: 'C1' }],
    ];

    const pipeline = new StreamingPipeline({ signal: controller.signal });
    const result = await pipeline.execute(toAsyncIterable(chunks), processFn);

    expect(result.aborted).toBe(true);
    expect(result.totalRecords).toBe(1);
    expect(processedChunks).toHaveLength(1);
  });

  it('should abort before processing any chunk if signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const processFn = vi.fn(makeSuccessProcessor());
    const chunks = [[{ Name: 'A1' }]];

    const pipeline = new StreamingPipeline({ signal: controller.signal });
    const result = await pipeline.execute(toAsyncIterable(chunks), processFn);

    expect(result.aborted).toBe(true);
    expect(result.totalRecords).toBe(0);
    expect(processFn).not.toHaveBeenCalled();
  });

  it('should handle empty chunks gracefully by skipping them', async () => {
    const chunks = [
      [],
      [{ Name: 'A1' }],
      [],
      [{ Name: 'B1' }],
      [],
    ];

    const progressCalls: number[] = [];
    const pipeline = new StreamingPipeline({
      onChunkProgress: (chunksProcessed) => {
        progressCalls.push(chunksProcessed);
      },
    });
    const result = await pipeline.execute(
      toAsyncIterable(chunks),
      makeSuccessProcessor(),
    );

    expect(result.totalRecords).toBe(2);
    expect(result.successCount).toBe(2);
    expect(progressCalls).toEqual([1, 2]);
  });

  it('should cap errors at 100 entries', async () => {
    const chunkCount = 120;
    const batches: Record<string, unknown>[][] = Array.from(
      { length: chunkCount },
      () => [{ Name: 'X' }],
    );

    const processFn: ChunkProcessFn = async (records) => ({
      successCount: 0,
      failureCount: records.length,
      successIds: [],
      errors: ['ERROR_LINE_1', 'ERROR_LINE_2'],
    });

    const pipeline = new StreamingPipeline();
    const result = await pipeline.execute(
      toAsyncIterable(batches),
      processFn,
    );

    expect(result.failureCount).toBe(120);
    expect(result.errors.length).toBe(100);
  });

  it('should handle zero chunks without error', async () => {
    const pipeline = new StreamingPipeline();
    const result = await pipeline.execute(
      toAsyncIterable([]),
      makeSuccessProcessor(),
    );

    expect(result.totalRecords).toBe(0);
    expect(result.successCount).toBe(0);
    expect(result.aborted).toBe(false);
  });
});
