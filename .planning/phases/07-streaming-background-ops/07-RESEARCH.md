# Phase 07: Streaming Execution & Background Ops — Research

## Don't Hand-Roll

### Async Generator Pattern (Built-in)
TypeScript natively supports `async function*` generators with `for await...of`. No library needed. This is the right primitive for chunked record streaming — each `yield` produces a batch, consumer processes it, then requests the next. Memory is naturally bounded because only one chunk exists at a time.

### AbortController (Built-in)
Node.js `AbortController` + `AbortSignal` is the standard cancellation primitive. Pass the signal through the streaming pipeline; check `signal.aborted` between chunks. Already used in ForgeHandler (lines 399-414). No need for a custom cancellation system.

### VSCode Native Notifications (vscode.window API)
`vscode.window.showInformationMessage(message, ...actions)` returns a `Thenable<string | undefined>` — the clicked action label. Use this for background completion notifications. The API handles queueing, dismissal, and action routing. Don't build a custom notification system.

### onDidChangeViewState (VSCode WebviewPanel API)
`panel.onDidChangeViewState(e => e.webviewPanel.visible)` fires when panel visibility changes (tab switched, panel hidden). This is the official way to detect WebView visibility — no polling needed.

### Bulk API 2.0 Multi-Upload
Salesforce Bulk API 2.0 supports multiple `PUT` requests to upload data to the same job before closing it. jsforce's `job.uploadData(records)` can be called multiple times. This means we can upload 2000 records at a time without creating multiple jobs. However, `job.close()` must only be called once after all uploads complete. This is more efficient than creating a new job per chunk.

## Common Pitfalls

### Pitfall: Fire-and-Forget Without Error Tracking
**What goes wrong:** Detaching execution from the handler (`void promise`) means errors are silently swallowed. The operation fails but nobody knows.
**How to avoid:** The BackgroundOperationRegistry must `.catch()` on every registered promise and update status to 'failed'. The `finally` block must clean up resources (progress tracker, performance tracker, DML tracker). Mirror the existing `finally` block in SyncOpsHandler.handleExecute().

### Pitfall: AbortSignal Not Checked Between Chunks
**What goes wrong:** User cancels but the streaming pipeline continues processing the current chunk and all subsequent chunks because the signal is only checked at job creation.
**How to avoid:** Check `signal.aborted` at three points: (1) before each chunk upload, (2) during Bulk API polling loop, (3) before processing results. Throw an `AbortError` on detection.

### Pitfall: Race Condition on WebView Reopen
**What goes wrong:** Operation completes between panel close and reopen. The WebView reopens with stale state, not knowing the operation finished.
**How to avoid:** On WebView reopen, immediately push the full `activeOperations` list from BackgroundOperationRegistry. The existing `pushState()` debounce in WebviewStateSync handles this if `activeOperations` is populated.

### Pitfall: Duplicate Notifications
**What goes wrong:** Operation completes, VSCode native notification fires (panel hidden). User clicks "Open SandForge" → panel opens → WebView also shows completion notification. Two notifications for the same event.
**How to avoid:** Track whether native notification was sent for an operation. When the WebView reconnects and receives the completed status, skip the WebView notification if native was already shown.

### Pitfall: Memory Leak in Long-Running Background Operations
**What goes wrong:** Progress tracker intervals, event listeners, and connection references accumulate during background operations that run for minutes.
**How to avoid:** The `finally` block pattern from existing handlers is correct. The BackgroundOperationRegistry must execute the same cleanup as the current handler `finally` blocks. Use `try/catch/finally` inside the registered promise, not outside.

### Pitfall: SeedOrchestrator chunkArray Returns [emptyArray] for Empty Input
**What goes wrong:** The existing `chunkArray` function (SeedOrchestrator line 236-242) returns `[array]` when chunks is empty (i.e., empty input produces `[[]]` — one chunk with zero records). The streaming pipeline must handle this edge case.
**How to avoid:** The StreamingPipeline should check `chunk.length > 0` before processing. Or fix the `chunkArray` to return `[]` for empty input.

### Pitfall: Bulk API Job Limits
**What goes wrong:** Salesforce limits concurrent Bulk API 2.0 jobs (typically 100 per org). Background operations that create many jobs can exhaust this limit.
**How to avoid:** The existing `BulkApiManager.canStartNewJob()` check (BulkApiExecutor line 126) already enforces `maxConcurrentJobs`. The streaming pipeline must reuse the same BulkApiManager instance and respect this gate.

---
*Research completed: 2026-03-28*
