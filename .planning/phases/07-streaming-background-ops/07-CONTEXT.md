# Phase 07: Streaming Execution & Background Ops - Context

**Gathered:** 2026-03-28
**Status:** Ready for planning

<domain>
## Phase Boundary

This phase delivers two scaling capabilities:
1. **SCALE-03**: Chunked sync/seed execution for 100K+ records — memory-efficient pipeline that processes 2000 records/chunk without holding all records in memory
2. **SCALE-04**: Background execution — long-running operations continue when WebView panel is hidden, with VSCode native notification on completion

This is the final optimization pass. All feature code is stable; this phase restructures execution internals.

</domain>

<decisions>
## Implementation Decisions

### Chunked Streaming Architecture (SCALE-03)

- **AsyncGenerator pattern over Node.js Streams**: Use `async function*` generators with `for await...of` for the chunked pipeline. TypeScript-native, no new dependencies, works naturally with existing async/await code. Full Node streams are overkill for record processing.
- **Chunk size: 2000 records** (matches Salesforce Bulk API 2.0 batch alignment and existing CloneRecordFetcher page size)
- **Query-side streaming**: Use jsforce cursor-based pagination (`.query().on('record')` or manual `queryMore` loop), not `.query()` that materializes all records. CloneRecordFetcher already has this pattern — reuse it.
- **Upload-side chunking**: Bulk API 2.0 supports multiple `uploadData()` calls to the same job before closing. Split upload into 2000-record chunks instead of one massive upload.
- **Chunk-and-release pattern**: Each chunk is processed, results emitted, then chunk reference nulled for GC. No accumulation of full result arrays — only aggregate counters (success/fail/skip counts).
- **StreamingSyncPipeline class**: New class wrapping the chunked flow. Takes a `queryChunkGenerator` (async generator yielding record batches) and a `processFn` (existing CRUD function). Orchestrator delegates to it when record count exceeds streaming threshold (10,000 records).
- **Streaming threshold: 10,000 records**: Below this, use existing sequential pipeline (no regression risk). Above this, auto-switch to streaming mode. This is per-object, not total.
- **SeedOrchestrator streaming**: For seed, the "query" side is generation. Wrap `fieldMapper.mapFields()` in a generator that yields chunks of generated records instead of generating all at once.
- **Progress granularity**: Emit `execution:progress` after each chunk completes, with `chunksProcessed / totalChunks` for smooth progress bars. Reuse existing `ObjectProgress` type, add optional `chunksProcessed` and `totalChunks` fields.

### Background Execution Model (SCALE-04)

- **BackgroundOperationRegistry**: New singleton service that stores running operations. Handler starts execution, registers the Promise + AbortController in the registry, and returns immediately to the WebView. The registry manages lifecycle (running/completed/failed).
- **Registry stores**: `{ operationId, module, description, promise, abortController, startedAt, status, result? }` per operation.
- **Detached handler pattern**: Handlers call `registry.register(operationId, promise, abortController)` then immediately send `operation:started` + return. No more blocking `await` in the handler's `handle()` method.
- **Progress forwarding**: The registry subscribes to progress events from the operation and forwards them to WebView via MessageBroker (existing path). When WebView is hidden, progress events are still buffered by VSCode (since `retainContextWhenHidden: true`).
- **WebView visibility tracking**: Add `panel.onDidChangeViewState` listener in `WebviewPanelManager`. Expose `isAnyPanelVisible(): boolean` method. The registry checks visibility before deciding notification strategy.
- **VSCode native notifications on background completion**: When operation completes AND no WebView panel is visible → `vscode.window.showInformationMessage('SandForge: Sync completed — 45,230 records processed', 'Open SandForge')`. Action button reopens the WebView panel.
- **When WebView IS visible**: Use existing WebView notification system (`sendNotification()`), no native notification (avoid duplication).
- **Populate `activeOperations` in WebviewStateSync**: The `activeOperations` field already exists but is never populated. Wire it to the BackgroundOperationRegistry so the WebView can show running operations on reconnect/reopen.
- **Cancel support for sync/seed**: Add `execution:abort` handler that calls `registry.abort(operationId)`. The AbortController signal propagates to the streaming pipeline. Reuse ForgeHandler's abort pattern.
- **Operation persistence**: Do NOT persist operations across extension restarts. If extension restarts, running operations are lost (Bulk API jobs on Salesforce side will time out naturally). This avoids complex recovery logic for a rare edge case.

### Claude's Discretion

- Internal class decomposition and method signatures for StreamingSyncPipeline
- Exact wording of VSCode native notification messages (follow pattern: "SandForge: [Module] [status] — [summary]")
- Whether to add a "Background Operations" panel or just use the existing notification + activeOperations list (prefer minimal: no new panel, just wire existing pieces)
- Test structure and mock patterns for async generators

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- **CloneRecordFetcher** (`packages/extension/src/modules/seed/CloneRecordFetcher.ts`): Already implements cursor-based pagination with 2000/batch. Reuse pattern for streaming query.
- **CDCEventBatcher** (`packages/extension/src/modules/sync/CDCEventBatcher.ts`): Ring buffer + flush timer pattern. Reference for buffered emission.
- **WorkerPool** (`packages/extension/src/core/engine/WorkerPool.ts`): Promise concurrency pool. Could be used to process multiple chunks concurrently (if parallelism desired).
- **BulkJobProgressTracker** (`packages/extension/src/core/engine/BulkJobProgressTracker.ts`): Already emits fine-grained progress via polling. Wire to streaming pipeline.
- **ForgeHandler abort pattern** (`packages/extension/src/bridge/handlers/ForgeHandler.ts:399-414`): AbortController + orchestrator.abort(). Reuse for sync/seed cancel.
- **SeedGrappeAdapter** (`packages/extension/src/modules/seed/SeedGrappeAdapter.ts`): Existing partition logic. Streaming replaces this for large datasets.
- **RetryableOperation** (`packages/extension/src/core/engine/RetryableOperation.ts`): Wraps transient error retry with backoff. Apply per-chunk.
- **DmlOperationTracker** (`packages/extension/src/core/common/DmlOperationTracker.ts`): Duplicate prevention. Must still work with background operations.

### Established Patterns
- **Lazy imports**: All module imports in handlers use `await import()`. Continue this pattern for new streaming classes.
- **Operation lifecycle messages**: `operation:started` → `operation:progress` → `operation:completed/failed`. Streaming adds more frequent progress but same message types.
- **Handler structure**: `implements DomainHandler`, `handle(msg)` returns `boolean`, delegates to private `handleXxx()` methods.
- **Grappe mode**: Existing partitioning system. Streaming mode is an alternative path (not a replacement). Grappe = parallel partitions for orchestration complexity; Streaming = sequential chunks for memory efficiency.

### Integration Points
- **SyncOpsHandler.handleExecute()** (line 236): Must be refactored to detach execution
- **SeedOpsHandler.handleExecute()** (line 317): Same detachment refactor
- **BulkApiExecutor.executeBulk()** (line 140): Must support chunked upload
- **WebviewPanelManager.registerPanel()**: Add visibility listener
- **WebviewStateSync.activeOperations**: Wire to registry
- **ExtensionHandlers**: Register new `execution:abort` handler
- **execution.types.ts**: Add `chunksProcessed`, `totalChunks` to ObjectProgress

</code_context>

<specifics>
## Specific Ideas

- Streaming threshold of 10,000 is per-object. A sync with 50 objects of 500 records each (25K total) uses the normal path. A sync with 1 object of 50K records uses streaming for that object.
- The BackgroundOperationRegistry should be a singleton created in `extension.ts` activate and injected into handlers via deps.
- VSCode native notification should include a "Show Details" action that opens/focuses the SandForge WebView panel.
- The `activeOperations` list in WebviewStateSync should show: operation ID, module name, description, progress %, started time. This gives the WebView enough to render a "running operations" indicator on reopen.

</specifics>

<deferred>
## Deferred Ideas

- **Parallel chunk processing** (multiple chunks in flight): Potential perf gain but adds complexity around ordering and error handling. Defer to v2 if needed.
- **Operation persistence across extension restart**: Would require storing Bulk API job IDs and resuming polling. Complex recovery logic for a rare case. Defer.
- **Cancel with partial rollback**: Canceling mid-sync could leave partial data. Full rollback would require tracking all inserted IDs and deleting them. Defer — current approach just stops processing remaining chunks.

</deferred>

---
*Phase: 07-streaming-background-ops*
*Context gathered: 2026-03-28*
