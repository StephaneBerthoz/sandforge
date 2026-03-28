# Plan 07-01 Summary

**Completed:** 2026-03-28
**Phase:** 07 -- Streaming Execution & Background Ops

## What was built

Created the core streaming execution engine for SandForge. This includes a `StreamingPipeline` class that processes records in chunks via async iterables (never holding more than one chunk in memory), a `ChunkedBulkExecutor` that opens a single Bulk API 2.0 job and uploads records in 2000-record batches, and shared types for streaming results and background operation tracking. Both components support abort via `AbortSignal` and report per-chunk progress.

## Key files

- `packages/shared/src/types/execution.types.ts`: Extended `ObjectProgress` with `chunksProcessed`/`totalChunks`; added `StreamingChunkResult`, `StreamingExecutionResult`, `ActiveOperation`, `BackgroundOperationStatus` types
- `packages/extension/src/core/engine/StreamingPipeline.ts`: Async-iterable pipeline with abort support, progress callbacks, error capping at 100 entries
- `packages/extension/src/core/engine/ChunkedBulkExecutor.ts`: Multi-upload Bulk API 2.0 executor with `canStartNewJob()` gate, abort during upload/poll phases, `createChunkGenerator` helper

## Decisions made

- Errors capped at 100 entries in StreamingPipeline to prevent memory growth on massive failures
- ChunkedBulkExecutor constructor accepts `Partial<ChunkedBulkConfig>` with sensible defaults (chunkSize=2000, pollIntervalMs=5000) for ergonomic instantiation
- `createChunkGenerator` is an instance method (not static) so it can default to the instance's `chunkSize`
- `closeJobSafely` swallows errors when aborting during upload phase, since the job may be in an invalid state

## Deviations from plan

- Removed unused `BulkApiConnection` import from ChunkedBulkExecutor (caught by typecheck)
- Plan specified `createChunkGenerator` as static; implemented as instance method for better defaults access

## Notes for downstream

- Plan 07-02 (BackgroundOperationRegistry) consumes `ActiveOperation` and `BackgroundOperationStatus` types defined here
- Plan 07-03 will wire `StreamingPipeline` and `ChunkedBulkExecutor` into ForgeHandler
- The `StreamingPipeline` is stateless -- create a new instance per execution
- `successIds` accumulation is opt-in: callers that don't need IDs pass processFn returning empty arrays to save memory
