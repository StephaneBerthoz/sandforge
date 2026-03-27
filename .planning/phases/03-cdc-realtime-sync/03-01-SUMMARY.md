# Plan 03-01 Summary

**Completed:** 2026-03-27
**Phase:** 03 -- CDC Real-Time Sync

## What was built

Hardened the CDC backend pipeline by fixing 4 known bugs and adding 4 new capabilities. Extracted `buildCdcChannel` to shared utils (fixing custom object channel naming `__c` -> `__ChangeEvent`). Fixed CDCReplicator error swallowing by adding `onError` and `onApplyResult` callbacks. Replaced the unbounded timings array with a fixed-size ring buffer (capacity 1000). Fixed false positive applied status in RealTimeSyncOrchestrator -- events now emit `applied: false` initially, updated to `true` only after replicator confirms. Added handler cleanup (unsubscribe functions + clear on stop) to prevent memory leaks. Added replay ID persistence via injected `ReplayIdPersister` interface. Added watchdog timer (240s silence threshold, 60s check interval). Created CDCEventBatcher with 150ms batching window and ring buffer overflow protection. Added `realtime:events-batch` message type for efficient WebView delivery.

## Key files

- `packages/shared/src/utils/cdcChannel.ts`: Shared buildCdcChannel utility for correct CDC channel naming
- `packages/extension/src/modules/sync/CDCListener.ts`: CDC Streaming API listener with replay persistence, watchdog, handler cleanup
- `packages/extension/src/modules/sync/CDCReplicator.ts`: Event replicator with onError callback, onApplyResult, ring buffer timings
- `packages/extension/src/modules/sync/RealTimeSyncOrchestrator.ts`: Orchestrator with two-phase applied status, handler cleanup
- `packages/extension/src/modules/sync/CDCEventBatcher.ts`: Event batcher with 150ms window and ring buffer
- `packages/shared/src/types/messages.types.ts`: Added RealTimeEventsBatchMessage type

## Decisions made

- Used `__c` -> `__ChangeEvent` pattern (replace `__c` suffix with `__ChangeEvent`) instead of the plan's `slice(0, -1) + 'e'` pattern, which was incorrect for Salesforce CDC channels. The old monitor code had the same bug.
- Added `handleApplyResult()` as a public method on RealTimeSyncOrchestrator rather than wiring it internally, since the replicator is created externally via factory deps.

## Deviations from plan

- The `buildCdcChannel` implementation differs from the plan's description (`slice(0, -1)` + `e` = `MyObj__e`). Corrected to `slice(0, -3)` + `__ChangeEvent` = `MyObj__ChangeEvent` which matches actual Salesforce CDC channel naming convention. The plan's must-haves and bug description both confirmed `__ChangeEvent` is the correct output.
- Updated the monitor's `ChangeDataCaptureListener.test.ts` to expect the corrected channel name.
- The pre-existing `ExtensionHandlers.test.ts > pipeline:run` test has an intermittent timeout -- not related to this plan.

## Notes for downstream

- `CDCEventBatcher` is ready to be wired into the RealTimeSyncOrchestrator or a handler to post `realtime:events-batch` messages to the WebView.
- `CDCReplicator.onApplyResult` callback needs to be wired to `RealTimeSyncOrchestrator.handleApplyResult()` when creating the replicator in the factory function.
- The `ReplayIdPersister` interface needs a concrete implementation using VSCode `globalState` (or `ExtensionContext.globalState`).
