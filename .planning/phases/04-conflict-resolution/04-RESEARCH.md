# Phase 04: Conflict Resolution UI -- Research

**Researched:** 2026-03-27
**Phase goal:** Build a full conflict resolution UI for bidirectional sync and CDC: detection feed with badge, paginated conflict list, side-by-side diff viewer with microdiff, per-field resolution with bulk actions, and execution with history logging.

## Don't Hand-Roll

| Problem | Recommended solution | Why |
|---------|---------------------|-----|
| Structured field-level diffing | `microdiff` (0.5KB, ESM-native) | Returns typed change descriptors (`create`, `remove`, `change`) with path arrays. The existing `ConflictResolver.findConflictFields()` uses `JSON.stringify` equality which mishandles `Date` objects, `undefined` vs missing keys, and nested values. microdiff handles these edge cases correctly. Not yet installed -- needs `pnpm add microdiff` in `packages/shared`. |
| 3-way merge (base + source + target) | Field-level merge using microdiff diffs | No library exists for Salesforce-specific 3-way merge. Pattern: `diff(base, source)` + `diff(base, target)` -> non-overlapping changes auto-merge, overlapping = conflict. Salesforce records are flat key-value so deep recursion is unnecessary. |
| Paginated conflict list | Reuse existing `DataTable` + `Pagination` + `usePagination` hook | All three exist from Phase 01 (SCALE-01/02). DataTable already supports virtual scrolling via @tanstack/react-virtual. Do not build a new table component. |
| Side-by-side layout | Reuse existing `SplitView` component | `packages/webview/src/components/ui/SplitView.tsx` provides master/detail with configurable ratios (50/50, 60/40, 70/30), animated collapse, and toggle button. |
| Modal for detailed diff | Adapt pattern from `DiffDetailModal` | `packages/webview/src/pages/Compare/DiffDetailModal.tsx` already has side-by-side source/target values, keyboard trap (Escape/Tab), a11y (role="dialog", aria-modal). Clone the pattern, do not import directly (different data model). |

## Common Pitfalls

### 1. conflictFeedHandlers in RealTimeSyncOrchestrator is never called

**What goes wrong:** The orchestrator has `conflictFeedHandlers` array and `onConflictDetected()` registration, but no code ever iterates or calls these handlers. The CDCReplicator's `onConflict` callback is set up to emit `CDCConflict` objects, but the orchestrator does not forward them to the feed handlers.

**Why:** Phase 03 built the handler registration infrastructure but left the actual wiring as a stub for Phase 04.

**How to avoid:** When creating the CDCReplicator in `start()`, wire the `onConflict` callback to iterate `conflictFeedHandlers`. Then in `RealTimeSyncMessageHandler`, subscribe to `onConflictDetected` and post `realtime:conflict` messages to the WebView via the broker. The message type `RealTimeConflictDetected` already exists in `messages.types.ts` with the right payload shape.

### 2. realtime:resolve-conflict is a NoOp handler

**What goes wrong:** The `realtime:resolve-conflict` message type is defined in `messages.types.ts` (line 1577-1584) with payload `{ eventReplayId: number; resolution: string }`, but it's registered in `NoOpHandler.ts` (line 21) -- meaning the extension silently ignores resolution requests from the WebView.

**Why:** Intentional stub for Phase 04. The handler needs to be moved from NoOpHandler to RealTimeSyncMessageHandler with actual logic.

**How to avoid:** Remove `realtime:resolve-conflict` from NoOpHandler's list. Add a new handler in RealTimeSyncMessageHandler that: (1) looks up the conflict by replayId, (2) applies the chosen resolution via the ConflictResolver, (3) calls the replicator's applyFn to write resolved values, (4) logs the decision to SyncHistoryStore.

### 3. ConflictRecord type lacks base values for 3-way context

**What goes wrong:** The existing `ConflictRecord` type (sync.types.ts line 205-212) has `sourceValues` and `targetValues` but no `baseValues` field. CONFLICT-03 explicitly requires "base value shown for 3-way context."

**Why:** The original ConflictRecord was designed for simple source-vs-target comparison, not 3-way merge.

**How to avoid:** Extend `ConflictRecord` with an optional `baseValues?: Record<string, unknown>` field. For CDC conflicts, the base value is the record state before the CDC event (i.e., `event.changedFields` represents the delta, so `targetValues` minus the change is the base). For bidirectional sync conflicts, the base is the last-synced snapshot (requires persisting snapshots in SyncHistoryStore or a new store).

### 4. CDCConflict and ConflictRecord are two separate types

**What goes wrong:** There are two conflict type hierarchies: `CDCConflict` (CDC real-time, contains a `CDCEvent` reference) and `ConflictRecord` (batch sync, contains flat source/target values). The UI needs to display both uniformly.

**Why:** CDCConflict was designed for the CDC pipeline; ConflictRecord for the batch ConflictResolver. They evolved independently.

**How to avoid:** Create a unified `UIConflict` type in shared that normalizes both into a common shape: `{ id, objectApiName, recordId, conflictType ('edit/edit' | 'delete/edit' | ...), sourceValues, targetValues, baseValues?, conflictFields, timestamp, resolved, resolution? }`. Map from CDCConflict and ConflictRecord to this type at the boundary (message handler or store).

### 5. Conflict count badge requires surfacing conflict count in sync results

**What goes wrong:** CONFLICT-01 requires a "count badge on results" for sync execution. The current `SyncExecutionResult` type has no `conflictCount` or `conflicts` field. The results step in SyncPage (step 5) shows per-object success/fail/skip but no conflicts.

**Why:** Conflicts are currently auto-resolved silently by ConflictResolver in the batch sync path (SyncOrchestrator calls `ConflictResolver.resolve()` with the chosen strategy). When strategy is not `manual`, there is no trace.

**How to avoid:** Add `conflictCount: number` and optionally `conflicts: ConflictRecord[]` to `SyncObjectResult`. Capture conflicts during `ConflictResolver.detectConflicts()` and store them even when auto-resolved. The badge goes on the results step header and the Sync History entries.

### 6. Manual edit resolution needs inline input validation

**What goes wrong:** CONFLICT-04 allows "manual-edit" per field. If the user types a value that violates the field's Salesforce type (e.g., text in a Number field, value exceeding max length), the resolution execution will fail with a Salesforce API error.

**Why:** No client-side validation exists for arbitrary field value edits against Salesforce field metadata.

**How to avoid:** When rendering the manual edit input, use the field describe metadata (available from schema cache) to show the field type, max length, and picklist values. Use Zod schemas or simple validators to catch type mismatches before submission. Show inline error messages. For picklist fields, render a Select dropdown instead of a free-text input.

### 7. Bulk "Apply source to all" can overwrite intentional target changes

**What goes wrong:** Users click "Apply source to all" without reviewing individual fields, accidentally overwriting legitimate target-side changes.

**Why:** Bulk actions prioritize speed over safety. Unlike per-field resolution, bulk actions affect all unresolved conflicts at once.

**How to avoid:** Add a confirmation dialog (reuse `DangerConfirm` component) before bulk resolution. Show the count of affected conflicts and fields. Consider a "preview" step that shows what will change before applying.

## Existing Patterns in This Codebase

- **`ConflictResolver` (`packages/extension/src/modules/sync/ConflictResolver.ts`):** Already handles all 5 strategies: source_wins, target_wins, newest_wins, manual, merge. The `detectConflicts()` method matches records by a field and finds differing fields. The `resolve()` method applies a strategy. For Phase 04: extend `detectConflicts` to also populate `baseValues`, and add a `resolvePerField()` method for field-level resolution choices.

- **`CDCReplicator.checkConflicts()` (`packages/extension/src/modules/sync/CDCReplicator.ts`, line 304-365):** Queries target org's `LastModifiedDate` and compares to CDC event's `commitTimestamp`. Emits `CDCConflict` via `onConflict` callback when target was modified after the event. The TOCTOU race is documented and accepted.

- **`RealTimeConflictDetected` message type (`messages.types.ts`, line 1664-1676):** Already defined with payload `{ replayId, objectApiName, recordIds, changeType, sourceValues, targetValues, targetLastModified }`. Ready to use for forwarding conflicts to WebView.

- **`RealTimeResolveConflictRequest` message type (`messages.types.ts`, line 1577-1584):** Already defined with payload `{ eventReplayId, resolution }`. Currently NoOp'd. Needs real handler.

- **`useCDCLiveStore` (`packages/webview/src/stores/useCDCLiveStore.ts`):** Manages CDC events in a ring buffer, handles `realtime:events-batch` messages. Does NOT handle `realtime:conflict` messages yet. Needs a conflict array/map and a message handler case for conflicts.

- **`SyncHistoryStore` (`packages/extension/src/modules/sync/SyncHistoryStore.ts`):** Persists `SyncHistoryEntry` objects with FIFO eviction (max 500). Resolution decisions should be logged here, either as annotations on existing history entries or as new entries.

- **`DiffViewer` + `DiffDetailModal` (`packages/webview/src/pages/Compare/`):** Side-by-side source/target comparison UI with status badges (+/-/~), inline diff view, keyboard-accessible modal. Good pattern reference for the conflict diff viewer. Uses `CompareItem` and `EnrichedDiff` types (different from `ConflictRecord`).

- **`SplitView` (`packages/webview/src/components/ui/SplitView.tsx`):** Master/detail layout with animated right panel, configurable ratio. Ideal for conflict list (left) + diff viewer (right).

- **`DataTable` + `Pagination` + `usePagination`:** Reusable paginated table with virtual scrolling. Already used in SyncHistoryPanel. Reuse for conflict list.

- **`DangerConfirm` (`packages/webview/src/components/ui/DangerConfirm.tsx`):** Confirmation dialog for destructive actions. Reuse for bulk resolution confirmation.

- **`Badge` component with variants (success/error/warning/info/default):** Consistent badge styling. Use for conflict count badge, conflict type badges, resolution status badges.

- **SyncPage tab structure (`packages/webview/src/pages/Sync/SyncPage.tsx`):** Currently has 4 tabs: sync, history, schedules, realtime. The conflict resolution UI can either be a 5th tab ("conflicts") or a sub-view within the realtime/results tabs. The tab type is `SyncTab = 'sync' | 'history' | 'schedules' | 'realtime'`.

- **i18n pattern:** All sync-related keys under `sync.*` namespace. Conflict strategy labels already exist at `sync.conflicts.source_wins` etc. New keys go under `sync.conflictResolution.*`.

## Recommended Approach

Install microdiff in `packages/shared` and create a `ConflictDiffService` that wraps microdiff for field-level diffing with optional 3-way base comparison. Create a unified `UIConflict` type that normalizes both `CDCConflict` and `ConflictRecord`. On the extension side, wire `conflictFeedHandlers` in the orchestrator, move `realtime:resolve-conflict` from NoOp to a real handler, and add `conflictCount` to `SyncObjectResult`. On the WebView side, add a `useConflictStore` Zustand store (receives conflicts from both CDC and batch paths), add a "conflicts" tab to SyncPage, build `ConflictListPanel` (DataTable + Pagination + filters), `ConflictDiffViewer` (SplitView with per-field highlighting), and `ConflictResolutionPanel` (per-field source/target/edit picker + bulk actions). Reuse DiffDetailModal and DangerConfirm patterns. Log resolutions to SyncHistoryStore.
