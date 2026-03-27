# Plan 04-01 Summary

**Completed:** 2026-03-27
**Phase:** 04 -- Conflict Resolution

## What was built

Installed microdiff in shared package and built the complete backend infrastructure for conflict resolution. Created ConflictDiffService with 2-way and 3-way field-level diffing using microdiff. Added UIConflict unified type, ConflictType, and FieldResolution types to normalize both CDCConflict and ConflictRecord. Extended SyncObjectResult with conflictCount, ConflictRecord with baseValues, and RealTimeResolveConflictRequest with per-field resolutions. Wired the orchestrator's conflict feed to CDCReplicator via setOnConflict, added conflict subscription and resolve-conflict handler in RealTimeSyncMessageHandler, and implemented ConflictResolver.resolvePerField for field-level resolution choices. Removed realtime:resolve-conflict from NoOpHandler.

## Key files
- `packages/shared/src/services/ConflictDiffService.ts`: Stateless diffing service with diffFields() and diffThreeWay() using microdiff
- `packages/shared/src/types/sync.types.ts`: UIConflict, ConflictType, FieldResolution types; baseValues on ConflictRecord; conflictCount on SyncObjectResult
- `packages/shared/src/types/messages.types.ts`: Extended RealTimeResolveConflictRequest; new RealTimeConflictResolvedResponse
- `packages/extension/src/modules/sync/ConflictResolver.ts`: Added static resolvePerField() method
- `packages/extension/src/modules/sync/RealTimeSyncOrchestrator.ts`: Wired conflict feed via setOnConflict + emitConflict
- `packages/extension/src/modules/sync/RealTimeSyncMessageHandler.ts`: Conflict feed subscription + resolve-conflict handler
- `packages/extension/src/modules/sync/CDCReplicator.ts`: Added setOnConflict() setter method
- `packages/extension/src/bridge/handlers/NoOpHandler.ts`: Removed realtime:resolve-conflict

## Decisions made
- Renamed FieldDiff to ConflictFieldDiff in shared to avoid name collision with existing compare.types.ts FieldDiff
- Added setOnConflict() method on CDCReplicator rather than modifying the factory interface, allowing the orchestrator to wire the callback post-creation
- RealTimeConflictResolvedResponse added as new message type for resolve-conflict acknowledgments

## Deviations from plan
- FieldDiff renamed to ConflictFieldDiff to resolve export collision with compare module's FieldDiff

## Notes for downstream
- Plan 02 (UI) can now subscribe to realtime:conflict messages and send realtime:resolve-conflict with fieldResolutions payload
- ConflictDiffService.diffThreeWay is available for the UI to display 3-way diffs when baseValues are present
- SeedOpsHandler.test.ts has a pre-existing flaky timeout (unrelated to this plan)
