# CDC Real-Time Sync Hardening -- Research

**Researched:** 2026-03-26
**Phase goal:** Harden the existing CDC real-time sync backend and wire it to the WebView UI with live event streaming, conflict resolution, virtual scrolling, and scheduling.

---

## Don't Hand-Roll

| Problem | Recommended solution | Why |
|---------|---------------------|-----|
| Virtual scrolling for 1000+ event list | `@tanstack/react-virtual` (v3) | Already using `@tanstack/react-table` and `@tanstack/react-query` in the webview -- stay in the ecosystem. `react-window` is maintenance-mode. `react-virtuoso` is heavier but has grouping support if needed. TanStack Virtual is the smallest (~3KB), framework-agnostic, and actively maintained. |
| Structured data diffing (record comparison) | `deep-diff` or `microdiff` | `microdiff` is 0.5KB, ESM-native, returns typed change descriptors (add/remove/change). `deep-diff` is older but battle-tested. Do NOT hand-roll recursive field comparison -- edge cases with null vs undefined, Date objects, and nested references are subtle. |
| Cron expression parsing | `cron-parser` (not `node-cron`) | `node-cron` spawns timers that are hard to test and leak in extension deactivation. `cron-parser` is a pure parser -- you give it a cron string, it returns the next Date. The existing `OperationScheduler` already uses a setInterval+check pattern; reuse that pattern with `cron-parser` for proper 5-field cron support instead of the custom `computeNextRun` in `BackupScheduler`. |
| 3-way merge for conflict resolution | Hand-roll a field-level merge using the diff library | No existing library handles Salesforce-specific record merging. The pattern is: diff(base, source) + diff(base, target) -> merge non-overlapping changes, flag overlapping ones as conflicts. Keep it field-level, not deep-recursive -- Salesforce records are flat key-value. |

---

## Common Pitfalls

### 1. jsforce v3 Streaming API is CometD-based and silently drops connections

**What goes wrong:** The CometD long-polling transport used by jsforce's Streaming API will silently stop receiving events after a network interruption (laptop sleep, VPN reconnect, WiFi switch). The client appears connected but receives nothing.

**Why:** CometD's long-poll timeout defaults to ~120s on the server side. After a network drop, the server closes the session, but the client doesn't get the TCP RST. jsforce v3 does not implement automatic reconnection -- it relies on the caller to detect and handle this.

**How to avoid:**
- Implement a heartbeat/watchdog: if no event AND no heartbeat is received within 2x the expected long-poll interval (~240s), force-disconnect and reconnect.
- The existing `CDCListener` has exponential backoff reconnection, which is good, but it only triggers on explicit errors -- add a timeout-based reconnect trigger.
- Store `lastReplayId` to `globalState` (VSCode extension API) before each reconnection so events are not lost across restarts.
- Use replay ID `-2` (earliest available) only for initial cold-start; after that always use the last known replay ID.

### 2. Salesforce CDC has a 3-day event retention window and replay ID gaps

**What goes wrong:** Developers assume replay IDs are sequential. They are not. Salesforce may skip replay IDs and the 72-hour retention window means replaying from an old ID returns a `400` or empty response.

**Why:** CDC events are stored in an event bus with compaction. Replay IDs are opaque cursors, not counters.

**How to avoid:**
- When a `400` or `403` comes back from a replay attempt, fall back to `-1` (latest) and log a warning that events may have been missed.
- Persist replay IDs per-org-per-object to `ExtensionContext.globalState`, not per-session. This survives extension restarts.
- The existing `CDCListener.lastReplayId` is in-memory only -- this needs to be persisted.

### 3. postMessage flooding kills WebView responsiveness

**What goes wrong:** During a burst of CDC events (e.g., a bulk data load in the source org generating 500+ events/second), calling `postToWebview()` for each event freezes the React WebView.

**Why:** Each `postMessage` triggers a structured clone and a message event in the WebView's iframe. At high throughput, the browser event loop can't keep up with re-renders.

**How to avoid:**
- The existing `WebviewStateSync` already uses a 16ms debounce -- extend this pattern for CDC events.
- Batch events on the extension side: accumulate events in a buffer for 100-200ms, then send a single `cdc:events-batch` message with an array.
- On the WebView side, append to a ring buffer (not a growing array) and use `requestAnimationFrame` to schedule renders.
- The MessageBroker already has a RateLimiter (100/s default) for inbound messages. Add a similar outbound limiter or batching mechanism.

### 4. VSCode extension host survives sleep/wake but timers do not

**What goes wrong:** `setInterval` and `setTimeout` callbacks fire immediately (with accumulated delay) after the machine wakes from sleep. A 60s interval that slept for 30 minutes fires once immediately, not 30 times -- but the callback sees stale state.

**Why:** Node.js suspends timers during OS sleep. On wake, timers fire based on elapsed wall-clock time but only once per interval.

**How to avoid:**
- Always re-check current time inside timer callbacks (the existing `OperationScheduler.tick()` does this correctly).
- For CDC reconnection: after wake, the CometD session is likely dead. Use `vscode.workspace.onDidChangeConfiguration` or a periodic health check to detect stale connections.
- There is no VSCode API for sleep/wake events. Use a monotonic clock check: if `Date.now() - lastTickTime > 2 * expectedInterval`, assume a sleep occurred and force reconnect.

### 5. CDCReplicator conflict detection has a race condition

**What goes wrong:** The current `checkConflicts` in `CDCReplicator` queries the target org's `LastModifiedDate` and compares it to the CDC event's `commitTimestamp`. Between the query and the apply, another process could modify the target record.

**Why:** There's no transactional lock across orgs. The time-of-check-to-time-of-use (TOCTOU) window can be seconds under load.

**How to avoid:**
- Accept that perfect conflict detection is impossible across two Salesforce orgs.
- Use optimistic concurrency: apply with the Salesforce `If-Modified-Since` header or check `SystemModstamp` in the WHERE clause of an update.
- For the `manual` conflict strategy, queue conflicts for user review rather than blocking the pipeline. Show them in the WebView conflict feed.
- Consider debouncing conflict checks: if the same record ID appears in multiple events within the flush window, only check the latest.

### 6. Custom objects need different CDC channel names

**What goes wrong:** The `buildChannels()` in `CDCListener` appends `ChangeEvent` to the object name. For custom objects like `MyObj__c`, the correct channel is `/data/MyObj__ChangeEvent` (remove trailing `c`, replace with `e`).

**Why:** Salesforce's CDC channel naming convention differs for standard vs. custom objects. Standard: `/data/AccountChangeEvent`. Custom: `/data/MyObj__ChangeEvent` (suffix `__c` becomes `__e`).

**How to avoid:**
- The `ChangeDataCaptureListener` in the monitor module handles this correctly (see `buildCdcChannel` function). The `CDCListener` in the sync module does NOT -- it naively appends `ChangeEvent` which breaks for custom objects.
- Unify or share the channel-building logic. The monitor module's implementation is correct.

### 7. Memory leaks from event handler accumulation

**What goes wrong:** The `CDCListener`, `CDCReplicator`, and `RealTimeSyncOrchestrator` all use push-only handler arrays (`eventHandlers`, `connectionHandlers`, etc.) with no removal mechanism. If the orchestrator is started/stopped multiple times, handlers accumulate.

**Why:** No `off()` or `removeHandler()` methods exist. The `onEvent()` etc. methods only push, never clean up.

**How to avoid:**
- Return a disposable/unsubscribe function from each `on*()` method (like `MessageBroker.on()` does).
- Or clear all handlers on `stop()`.
- The `RealTimeSyncOrchestrator` creates new listener/replicator instances each `start()`, which mitigates this for the inner classes, but the orchestrator's own handlers (`statusHandlers`, `eventFeedHandlers`) still accumulate.

---

## Existing Patterns in This Codebase

- **`MessageBroker` (packages/extension/src/bridge/MessageBroker.ts):** Central typed message hub with rate limiting (100 msg/s default). Already handles bidirectional extension<->webview comms. CDC events should flow through this, not a parallel channel.

- **`WebviewStateSync` (packages/extension/src/bridge/WebviewStateSync.ts):** Debounced (16ms) state push pattern. Good model for batching CDC events to the webview. Extend or create a parallel `CDCEventSync` class using the same pattern.

- **`RateLimiter` (packages/extension/src/core/common/RateLimiter.ts):** Sliding-window rate limiter. Reuse for throttling CDC event pushes to webview.

- **`OperationScheduler` (packages/extension/src/modules/automation/OperationScheduler.ts):** setInterval-based scheduler with ConfigStore persistence. Already handles hourly/daily/weekly/monthly schedules. The pattern of `tick() -> check due -> execute` is the established scheduling pattern in this codebase. Use it for CDC sync schedules too instead of introducing `node-cron`.

- **`BackupScheduler` (packages/extension/src/modules/dataops/BackupScheduler.ts):** Has its own cron parser (`computeNextRun`) but it's limited (only supports 2-3 part expressions). If full cron support is needed, add `cron-parser` and update both schedulers.

- **`CDCListener` + `CDCReplicator` + `RealTimeSyncOrchestrator` (packages/extension/src/modules/sync/):** The core CDC pipeline already exists with: Zod validation, exponential backoff reconnection, field mapping, conflict detection, buffered batch flushing, and metrics tracking. This is a hardening task, not a rewrite.

- **`ChangeDataCaptureListener` (packages/extension/src/modules/monitor/):** Simpler CDC listener in the monitor module with correct custom object channel naming. Has a 200-event circular buffer. The channel naming logic should be extracted and shared.

- **`@tanstack/react-table` + `@tanstack/react-query` already in webview deps:** Adding `@tanstack/react-virtual` stays in the same ecosystem.

- **Zustand stores (webview):** All UI state goes through `use*Store.ts` files. CDC real-time state (events, metrics, status) should follow this pattern with a `useSyncLiveStore.ts` or similar.

---

## Key Codebase Bugs Found During Research

1. **`CDCListener.buildChannels()` line 193:** Custom objects like `MyObj__c` will generate wrong channel `/data/MyObj__cChangeEvent` instead of `/data/MyObj__ChangeEvent`. The fix exists in `ChangeDataCaptureListener.buildCdcChannel()` -- share it.

2. **`CDCReplicator.applyEvents()` line 221:** The `catch` block at line 221 catches but swallows errors silently (no logging, no error emission). Failed batch applications are counted but the error details are lost.

3. **`RealTimeSyncOrchestrator` line 97:** Events are marked as `applied: true` in `emitEventFeed` immediately upon receipt, before the replicator has actually applied them. This gives the UI false positive feedback.

4. **`CDCReplicator.timings` unbounded growth:** Although it slices at 1000, the slice operation at line 219 creates a new array of 500 items each time it fires, which can cause GC pressure during sustained high-throughput periods. A ring buffer (fixed-size array with write index) would be more efficient.

---

## Recommended Approach

Harden the existing three-class CDC pipeline (CDCListener -> CDCReplicator -> RealTimeSyncOrchestrator) rather than rewriting it. Fix the six bugs identified above. Add replay ID persistence to `ExtensionContext.globalState`. Extract the custom-object channel naming from the monitor module into a shared utility. For the WebView, create a `useCDCLiveStore` Zustand store that receives batched events via a new `cdc:events-batch` message type, backed by a ring buffer. Use `@tanstack/react-virtual` for the event feed list. For scheduling, extend the existing `OperationScheduler` pattern with `cron-parser` for proper cron expression support. Add a watchdog timer to detect stale CometD connections after sleep/wake.
