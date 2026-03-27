# Plan 02 Summary

**Completed:** 2026-03-27
**Phase:** 05 -- Seed Extensions (CSV + Clone)

## What was built

Clone backend pipeline: CloneRecordFetcher queries records from a source org using jsforce cursor-based pagination (queryMore, 2000/batch) with configurable SOQL WHERE filters per object. CloneReferenceLinker topologically sorts objects for relationship-ordered insertion using Kahn's algorithm with cycle detection, and identifies self-referential edges (e.g., Account.ParentId) for two-pass handling. Shared types added (CloneConfig, CloneObjectConfig, CloneExecutionResult, CloneObjectResult) and message types (seed:clone:execute, seed:clone:preview, seed:clone:describe-source).

## Key files

- `packages/shared/src/types/clone.types.ts`: CloneConfig, CloneObjectConfig, CloneExecutionResult, CloneObjectResult types
- `packages/shared/src/types/messages.types.ts`: seed:clone:execute, seed:clone:preview, seed:clone:describe-source message types
- `packages/extension/src/modules/seed/CloneRecordFetcher.ts`: Cursor-based pagination with queryMore for large datasets
- `packages/extension/src/modules/seed/CloneReferenceLinker.ts`: Topological sort with cycle detection and self-referential edge identification
- `packages/extension/src/modules/seed/CloneRecordFetcher.test.ts`: Tests for pagination, WHERE filters, empty results
- `packages/extension/src/modules/seed/CloneReferenceLinker.test.ts`: Tests for topo sort, cycle detection, self-ref handling

## Decisions made

- Used jsforce queryMore (cursor-based) instead of SOQL OFFSET (limited to 2000)
- CloneReferenceLinker accepts AutopilotEdge[] for consistency with existing autopilot module
- Self-referential edges separated from normal edges; flagged for two-pass insert by CloneOrchestrator
- Clone types placed in dedicated clone.types.ts (not merged into seed.types.ts) for clarity

## Deviations from plan

- CloneOrchestrator and CloneOpsHandler were not created in this plan; the orchestration and handler wiring was deferred to Plan 04 (Clone UI) which handles the full end-to-end flow
- RecordIdRemapper reuse confirmed but actual wiring happens in the orchestrator (Plan 04)

## Notes for downstream

- Plan 04 (Clone UI) depends on CloneRecordFetcher and CloneReferenceLinker
- CloneReferenceLinker.resolveInsertOrder returns { sorted: string[], selfRefs: AutopilotEdge[] }
- Large clone warning threshold set at 10,000 records (checked in UI)
