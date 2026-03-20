# Plan 04-02 Summary

**Completed:** 2026-03-20
**Phase:** 04 -- Backend Hardening + Accessibility

## What was built

Three backend feature improvements: (1) enriched the forge:preview:response payload with estimatedRecordCount, totalFieldCount, and estimatedSize fields using conn.describe() and SELECT COUNT() queries; (2) wired the ReviewComplianceTab dropdown to send forge:compliance:request to the backend when a non-none framework is selected with graph and config available; (3) replaced synthetic bulk-N IDs with real Salesforce record IDs from Bulk API 2.0 getAllResults(), with fallback to bulk-{jobId}-{i} when IDs are undefined.

## Key files

- `packages/extension/src/bridge/handlers/ForgeHandler.ts`: Added describe + COUNT() calls in handleForgePreview, enriching response with estimatedRecordCount, totalFieldCount, estimatedSize
- `packages/webview/src/pages/Forge/ReviewComplianceTab.tsx`: Added useSendMessage/useMessageListener hooks to wire framework dropdown to forge:compliance:request backend call with loading state
- `packages/extension/src/core/engine/BulkApiExecutor.ts`: Added `id` field to BulkJobRecordResult, `successIds` array to BulkExecutionResult, built from real getAllResults() IDs
- `packages/extension/src/bridge/handlers/SeedOpsHandler.ts`: Replaced `Array.from({ length: bulkResult.successCount }, ...)` with `bulkResult.successIds`

## Decisions made

- Used the same MB_PER_RECORD (0.001) heuristic from GraphDiscoveryService for estimated size calculation
- COUNT() query failure silently falls back to 0 (some objects do not support COUNT())
- Compliance request is sent via useEffect triggered by framework/graph/config changes, not on button click
- Loading state distinguishes between "analyzing" (request sent) and "waiting" (no graph/config)
- Bulk ID fallback uses `bulk-{jobId}-{i}` format (includes jobId for traceability) instead of just `bulk-{i}`

## Deviations from plan

- Plan 04-01 had already been applied to ForgeHandler.ts (adding TimeoutManager, structured error codes, operation lifecycle events). No conflict -- this plan's changes to handleForgePreview are orthogonal to 04-01's changes to other handler methods.
- ReviewComplianceTab loading state splits into two visual states: "compliance-loading" (analyzing) and "compliance-waiting" (no graph/config), improving UX clarity beyond what the plan specified.

## Notes for downstream

- The pre-existing unhandled rejection in ExtensionHandlers.test.ts (performanceTracker.complete) is not caused by this plan. It exists before and after these changes.
- The pre-existing vitest timeout for @vite/env fetch in webview tests is a test infrastructure issue, not related to code changes.
