# Phase 02: Sync History & Scheduling -- Research

**Researched:** 2026-03-27
**Phase goal:** Persist every sync execution to ConfigStore, surface it in a paginated history UI with detail/re-run/export, and build a full cron scheduling system on top of OperationScheduler.

---

## Don't Hand-Roll

| Problem | Recommended solution | Why |
|---------|---------------------|-----|
| Cron expression parsing | `cron-parser` (npm) | The codebase has THREE incomplete cron implementations: `OperationScheduler.computeNextRunAt` (hourly/daily/weekly/monthly enum only), `BackupScheduler.computeNextRun` (2-3 part simplified), and `SyncScheduler.getNextRun` (5-field but buggy -- ignores dayOfMonth and dayOfWeek). `cron-parser` handles all 5-field edge cases (ranges, steps, lists, last-day-of-month) and provides timezone support via its `tz` option. Do NOT extend the existing hand-rolled parsers. |
| Cron expression UI builder | Build a visual picker but validate with `cron-parser` | No good React cron builder exists that fits the VSCode webview aesthetic. Build a simple visual picker (minute/hour/day selects) that generates a cron string, plus a raw text input for advanced users. Always round-trip through `cron-parser.parseExpression()` for validation. |
| Timezone handling | `Intl.DateTimeFormat` + `cron-parser`'s `tz` option | `cron-parser` natively supports IANA timezone strings via its `tz` option. Use `Intl.supportedValuesOf('timeZone')` to get the list of valid timezones for the selector UI. `date-fns` is already in the webview for display formatting. Do NOT add `luxon` or `moment-timezone`. |
| CSV/JSON export | Hand-roll (trivial) | For history export, CSV is just header + rows with `Array.map().join(',')`. JSON is `JSON.stringify`. No library needed -- the data is flat (no nested objects, no special characters beyond what Salesforce API names contain). |

---

## Common Pitfalls

### 1. ConfigStore writes on every execution will grow unbounded

**What goes wrong:** If sync executions are logged as individual keys (one per execution), the ConfigStore accumulates thousands of entries over weeks. Every `persist()` call serializes ALL entries to the backend, causing increasing write latency.

**Why:** `ConfigStore.persist()` calls `this.backend.setData({ ...this.entries })` -- it writes the entire data set every time.

**How to avoid:**
- Cap history at a fixed size (e.g., 500 entries) with FIFO eviction -- the `AlertStateStore` already does this with `MAX_HISTORY_SIZE = 500`.
- Store all history entries under a SINGLE key (e.g., `sync:history:all`) as an array, not one key per entry. This avoids polluting the ConfigStore key namespace and makes `getByCategory` efficient.
- Use the `SyncConfigStore` pattern: facade class over ConfigStore with dedicated prefix and category.

### 2. OperationScheduler uses frequency enum, not cron strings

**What goes wrong:** The existing `ScheduledOperation` type uses `frequency: 'hourly' | 'daily' | 'weekly' | 'monthly'` + `time: string` + optional `dayOfWeek`/`dayOfMonth`. SCHED-01 requires full 5-field cron support. Attempting to force cron strings into this enum system will break the existing automation module.

**Why:** `OperationScheduler` was designed for simple preset schedules. It has no concept of cron expressions -- `computeNextRunAt` is a switch/case on the frequency enum.

**How to avoid:**
- Do NOT modify the existing `OperationScheduler` directly -- it is used by the automation module.
- Create a new `SyncScheduleExecutor` (or similar) that:
  - Uses `cron-parser` to compute next run times
  - Follows the same `setInterval` + `tick()` pattern as `OperationScheduler`
  - Stores schedules with the `schedule:sync:{id}` prefix as specified in SCHED-04
  - Accepts a `SyncConfig` reference to execute via `SyncOrchestrator`
- Alternatively, extend `OperationScheduler` to accept an optional `cronExpression` field on `ScheduledOperation` and use `cron-parser` when present, falling back to the enum logic otherwise. This is cleaner but requires updating the shared type.

### 3. SyncScheduler already exists but is disconnected and incomplete

**What goes wrong:** There is already a `SyncScheduler` class in `packages/extension/src/modules/sync/SyncScheduler.ts`. It has a `getNextRun()` method but: (a) it is in-memory only (no persistence), (b) its cron parsing is broken (ignores dayOfWeek when time has already passed today), (c) it is not wired to any orchestrator or execution pipeline.

**Why:** It was scaffolded early and never completed.

**How to avoid:**
- Either replace `SyncScheduler` entirely with a proper implementation backed by `cron-parser`, or gut it and rebuild on the same file. Do not try to "fix" the existing `getNextRun` -- it is fundamentally inadequate for real cron.
- The existing `ScheduledSync` interface in that file has the right shape (syncId, configId, cron, nextRun, enabled) -- reuse or extend it.

### 4. Timer drift after sleep/wake fires all missed schedules at once

**What goes wrong:** After a laptop sleeps for 8 hours, the `tick()` method finds multiple schedules whose `nextRunAt` is in the past. It executes ALL of them in rapid succession, potentially hammering the Salesforce API.

**Why:** The existing `OperationScheduler.tick()` iterates all schedules and executes any where `nextRun <= now`. After sleep, all scheduled runs between sleep and wake are "overdue."

**How to avoid:**
- After detecting a sleep (see existing pattern in CDC research: `Date.now() - lastTickTime > 2 * interval`), only execute each schedule ONCE (the most recent missed run), not once per missed interval.
- After executing, immediately recompute `nextRunAt` to the NEXT future time, not the next time after the last missed run.
- `cron-parser` has `parseExpression(cron).next()` which always returns the next future occurrence -- use it instead of computing from `lastRunAt`.

### 5. Re-run from history must deep-clone the config, not reference it

**What goes wrong:** HIST-04 requires a "Run Again" button. If the implementation stores a reference to the `SyncConfig` ID and loads the current config, the re-run might use a DIFFERENT config than what was originally executed (if the user edited it since).

**Why:** History should be a snapshot of what was executed, not a pointer to a mutable config.

**How to avoid:**
- The sync execution log (HIST-01) must store a FULL COPY of the `SyncConfig` used at execution time, not just `configId`.
- For HIST-04, pre-fill the wizard/Quick Sync with the snapshot config, not the current config.
- This means the history entry type needs a `config: SyncConfig` field, which will increase storage. With 500 entries max and ~2KB per config, this is ~1MB -- acceptable.

### 6. Schedule persistence must survive extension restart AND update

**What goes wrong:** SCHED-04 requires schedules to survive extension restart. Using `ConfigStore` (backed by `ConfigStoreBackend`) works for restart, but extension UPDATES may reset the workspace state depending on the backend implementation.

**Why:** The `ConfigStoreBackend` interface is abstract. The actual backend used in production needs to be checked -- if it uses `ExtensionContext.globalState`, it persists across updates. If it uses `ExtensionContext.workspaceState`, it persists but is workspace-scoped.

**How to avoid:**
- Use `ConfigStore` with the same backend the rest of the app uses -- it already persists across restarts.
- On `activate()`, reload schedules from ConfigStore and restart the tick loop.
- Add a version field to the schedule data structure so future migrations are possible.

### 7. Desktop notifications require user consent and platform differences

**What goes wrong:** SCHED-05 mentions "opt-in desktop notification." VSCode's `window.showInformationMessage` is NOT a desktop notification -- it shows in the VSCode notification area. True desktop notifications (OS-level) are not available in the VSCode extension API.

**Why:** VSCode sandboxes extensions. There is no `Notification` API like in a browser.

**How to avoid:**
- "Desktop notification" in this context means VSCode's native notification API (`vscode.window.showInformationMessage` / `showWarningMessage`).
- The existing `NotificationCenter` class is the correct abstraction -- it already dispatches to listeners. Add a VSCode API listener that calls `vscode.window.show*Message`.
- For "opt-in": store a `notifyDesktop` boolean per schedule in the schedule config. When a schedule completes, check this flag before calling the VSCode notification API.
- Do NOT try to use `node-notifier` or similar -- it would require native dependencies and break the VSIX packaging.

---

## Existing Patterns in This Codebase

- **`SyncConfigStore` (packages/extension/src/modules/sync/SyncConfigStore.ts):** Thin facade over ConfigStore with `sync:config:` prefix and `syncConfigs` category. Has `save`, `load`, `list`, `delete`. The sync history store should follow this EXACT pattern with a `sync:history:` prefix and `syncHistory` category.

- **`AlertStateStore` (packages/extension/src/modules/monitor/AlertStateStore.ts):** Same ConfigStore facade pattern but with FIFO history capping at 500 entries. Use this as the template for history storage -- the `saveHistory` method with deduplication and trimming is directly reusable.

- **`OperationScheduler` (packages/extension/src/modules/automation/OperationScheduler.ts):** The `tick()` loop pattern (setInterval 60s, check due, execute, persist) is the established scheduling pattern. Reuse this architecture but swap `computeNextRunAt` for `cron-parser`.

- **`SyncOrchestrator` (packages/extension/src/modules/sync/SyncOrchestrator.ts):** The `execute()` method returns `SyncExecutionResult` with `configId`, `operationId`, `status`, `objectResults`, `totalProcessed/Success/Failed/Skipped`, `duration`, `timestamp`. This is the data that HIST-01 needs to capture. The logger should wrap `SyncOrchestrator.execute()` to intercept the result.

- **`SyncScheduler` (packages/extension/src/modules/sync/SyncScheduler.ts):** Existing but incomplete. Has `ScheduledSync` interface with `syncId`, `configId`, `cron`, `nextRun`, `enabled`. Can be replaced/rebuilt.

- **`NotificationCenter` (packages/extension/src/core/notifications/NotificationCenter.ts):** Listener-based notification hub. SCHED-05 should call `notificationCenter.success/error/info` for schedule events. Already has auto-dismiss support.

- **`ConfigStore` (packages/extension/src/core/storage/ConfigStore.ts):** Key-value store with categories. Key methods: `get<T>`, `set<T>`, `getByCategory`, `getKeysByPrefix`, `delete`, `clearCategory`. Categories group entries for bulk retrieval. Backend is synchronous reads, fire-and-forget writes.

- **`Pagination` + `DataTable` (packages/webview/src/components/ui/):** Phase 01 deliverables. `DataTable` has virtual scrolling via `@tanstack/react-virtual`. `Pagination` has page size selector and navigation. Wire these for HIST-02.

- **`SyncPage` (packages/webview/src/pages/Sync/SyncPage.tsx):** Current sync UI is a wizard-based flow. History and scheduling should be added as tabs or sections on this page (or as sub-routes), not as separate top-level pages. The page already uses `useSyncPageData` hook for state management.

- **`date-fns` (webview dependency):** Already installed in the webview package. Use `format`, `formatDistanceToNow`, `differenceInMilliseconds` for displaying history timestamps and durations. Do NOT add another date library.

- **Existing shared types:** `SyncExecutionResult`, `SyncObjectResult`, `SyncConfig`, `SyncSchedule` (has `enabled`, `cron`, `timezone`, `maxRetries`, `notifyOnFailure`), `ScheduledOperation`, `ScheduledOperationRun` are all already defined in `packages/shared/src/types/`. Several can be reused or extended.

- **Message types for scheduler:** `scheduler:list:response`, `scheduler:upsert`, `scheduler:toggle`, `scheduler:delete` already exist in `messages.types.ts`. These are wired to the existing `OperationScheduler` via the automation module. New sync-specific schedule messages may be needed (e.g., `sync:schedule:*`) to avoid conflating with automation schedules.

---

## Key Findings

1. **Three overlapping scheduler implementations exist** (`OperationScheduler`, `BackupScheduler`, `SyncScheduler`) -- all with different cron parsing quality. The planner must decide: extend one, or create a clean sync-specific scheduler. Recommendation: create `SyncScheduleExecutor` following `OperationScheduler`'s architecture but with `cron-parser`.

2. **`SyncSchedule` type already exists** in `sync.types.ts` with `cron`, `timezone`, `maxRetries`, `notifyOnFailure`. This is the right shape for schedule config. The missing piece is a runtime execution entry type for tracking active schedules with `nextRunAt`, `lastRunAt`, `status`.

3. **The ConfigStore persists entire state on every write.** History entries must be stored as a single array under one key, not individual keys. Cap at 500.

4. **No Zustand store exists for sync state** (no `useSyncStore`). The webview uses a `useSyncPageData` hook instead. A new `useSyncHistoryStore` and `useSyncScheduleStore` should be created following the existing `use*Store` convention.

---

## Recommended Approach

Install `cron-parser` in the extension package. Create a `SyncHistoryStore` facade over ConfigStore (following `AlertStateStore` pattern) that persists execution snapshots with FIFO capping. Create a `SyncScheduleExecutor` that uses `cron-parser` for next-run computation, follows the `OperationScheduler` tick-loop pattern, and persists to ConfigStore with `schedule:sync:` prefix. On the webview side, add `useSyncHistoryStore` and `useSyncScheduleStore` Zustand stores, a `SyncHistoryPage` with `DataTable` + `Pagination` for the list, a detail panel, and a `CronScheduleBuilder` component for the visual cron UI. Wire schedule notifications through `NotificationCenter`. Replace or rebuild the existing incomplete `SyncScheduler` class rather than patching it.
