# Plan 02-02 Summary

**Completed:** 2026-03-27
**Phase:** 02 -- Sync History & Scheduling

## What was built

Cron-based sync scheduling engine with persistence, sleep-wake resilience, and notification integration. SyncScheduleStore provides a thin ConfigStore facade with `schedule:sync:` prefix and `syncSchedules` category for persisting schedule entries. SyncScheduleExecutor implements a 60-second tick loop that checks for due enabled schedules, executes them via an injected `onExecute` callback, and uses cron-parser v5 for timezone-aware next-run computation. The old broken SyncScheduler class (with its incomplete parseCronField function and no persistence) has been fully replaced.

## Key files

- `packages/extension/src/modules/sync/SyncScheduleStore.ts`: Thin ConfigStore facade for schedule persistence (save/load/list/delete/loadAll)
- `packages/extension/src/modules/sync/SyncScheduleStore.test.ts`: 9 tests covering round-trip, sorting, upsert, delete
- `packages/extension/src/modules/sync/SyncScheduleExecutor.ts`: Core executor with start/stop/tick/upsert/delete/toggle/getSchedules
- `packages/extension/src/modules/sync/SyncScheduleExecutor.test.ts`: 14 tests covering all required scenarios including sleep-wake detection
- `packages/extension/src/modules/sync/SyncScheduler.ts`: Re-export of SyncScheduleExecutor (backward compatibility)
- `packages/extension/src/modules/sync/SyncScheduler.test.ts`: 3 tests verifying re-export and absence of old symbols

## Decisions made

- Used cron-parser v5 API (`CronExpressionParser.parse()` + `.next().toDate().toISOString()`) instead of v4's `parseExpression()` since v5 was installed
- Defined SyncScheduleEntry import from `@sandforge/shared` (Plan 01's types were already in the codebase but uncommitted)
- Fixed pre-existing ExportFormat duplicate export conflict between sync.types.ts and reporting.types.ts (removed the narrower sync.types version)
- Used dependency injection for all external dependencies (store, config, execute callback, notification center, clock) for full testability
- NotificationCenter integration uses the actual signature `notify(level, title, message)` matching the real class, not the `notify({ level, title, message })` object pattern from the plan

## Deviations from plan

- Plan specified `cron-parser.parseExpression()` but cron-parser v5 uses `CronExpressionParser.parse()` -- adapted accordingly
- Plan specified NotificationCenter notify with object arg `{ level, title, message }` but actual NotificationCenter uses positional args `(level, title, message)` -- used real signature
- Fixed pre-existing shared type errors (ExportFormat conflict, test import fixes) that were blocking typecheck

## Notes for downstream

- The shared package needs `pnpm build` (in packages/shared) before extension typecheck will see new types from Plan 01
- SyncScheduleExecutor is ready to be wired into the extension activation flow (load schedules on activate, stop on deactivate)
- The `onExecute` callback should be wired to the SyncOrchestrator's execute method
- cron-parser v5 is installed (`^5.5.0`) in packages/extension only
