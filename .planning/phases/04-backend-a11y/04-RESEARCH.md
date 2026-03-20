# Phase 04 Research: Backend Hardening + Accessibility

## Current State Summary

Phase 03 (UX Enhancements + Performance) is complete. All files targeted by Phase 04 are stable and ready for modification. This is the FINAL phase of v1.2.0.

## Backend Findings

### BE-01: Structured Error Payloads

**Current:** `sendHandlerError()` in HandlerTypes.ts sends `{ message: string }`. No error code, no retryable flag.

**Required:** All forge error responses must include `{ message: string; code: string; retryable: boolean }`.

**Approach:** Modify `sendHandlerError()` to accept optional `code` and `retryable` params (default `code='UNKNOWN'`, `retryable=false`). Update all ForgeHandler catch blocks to pass appropriate codes. Existing callers outside forge (SeedOpsHandler, etc.) continue working via defaults.

**Pitfall:** Must not break the existing `sendHandlerError` signature for non-forge handlers. Use optional params with defaults.

### BE-02: Preview Enrichment

**Current:** `handleForgePreview()` returns `{ objectApiName, objectLabel, recordId, fields }`. No record count, field count, or size estimate.

**Required:** Add `estimatedRecordCount`, `totalFieldCount`, `estimatedSize` to preview response.

**Approach:** After fetching the record, also query `SELECT COUNT() FROM {object}` for record count, use `describe` for total field count, and compute estimated size using the same `MB_PER_RECORD` heuristic from GraphDiscoveryService (0.001 MB/record).

**Pitfall:** The describe call is already partially done (describeGlobal). Need an additional `conn.describe(objectName)` for field count. Keep it efficient -- single describe call.

### BE-03: Timeouts

**Current:** ForgeHandler's `handlePlanRequest`, `handleComplianceRequest`, and `handleMetadataDiffRequest` have no timeout. SeedOpsHandler already uses `TimeoutManager` as a reference pattern.

**Required:** Wrap these three handlers with `TimeoutManager.withTimeout()`.

**Approach:** Use the existing `TimeoutManager` class with sensible defaults: plan=30s, compliance=30s, metadata-diff=60s. Import and instantiate in ForgeHandler. Catch `TimeoutError` and send structured error with `code='TIMEOUT'`, `retryable=true`.

### BE-04: Operation Lifecycle Events

**Current:** `handleDiscover` and `handleExecute` already emit `sendOperationStarted`/`sendOperationCompleted`/`sendOperationFailed`. But `handlePlanRequest`, `handleComplianceRequest`, and `handleMetadataDiffRequest` do NOT emit lifecycle events.

**Required:** Add started/completed/failed lifecycle events to plan, compliance, and metadata-diff handlers.

**Approach:** Generate operationId with `forge-plan-`, `forge-compliance-`, `forge-metadata-diff-` prefixes. Call `sendOperationStarted` before work, `sendOperationCompleted` after, `sendOperationFailed` on catch.

### BE-05: operationId in forge:execute:response

**Current:** `handleExecute()` generates `operationId` locally but does NOT include it in the `forge:execute:response` message payload. Only sends `{ result }`.

**Required:** Include `operationId` in the response payload.

**Approach:** Add `operationId` to the `buildResponse` payload: `{ result, operationId }`.

### BE-06: Compliance Framework Dropdown Triggers Backend Request

**Current:** `ReviewComplianceTab` has a framework dropdown but changing it does NOT send a message to the backend. It only reads `complianceReport` from the store (which is always null since nothing triggers it).

**Required:** When user selects a framework != 'none', send `forge:compliance:request` to the backend with the current graph and config.

**Approach:** Add `useSendMessage` + `buildMessage` to ReviewComplianceTab. On framework change (or via useEffect), send the compliance request. Listen for `forge:compliance:response` to populate the store.

**Pitfall:** This file is in the webview package, but it is listed under backend requirements because it wires the frontend to the backend. It touches ReviewComplianceTab.tsx (webview) and needs no changes to ForgeHandler.ts (the handler already works). This goes in Plan 04-02 since it modifies a webview file that no other plan touches.

### BE-07: Real Bulk API 2.0 IDs

**Current:** In SeedOpsHandler.handleExecute(), the Bulk API path returns synthetic IDs: `Array.from({ length: bulkResult.successCount }, (_, i) => 'bulk-${i}')`. The actual Bulk API 2.0 `getAllResults()` returns individual record results but the current code does not extract real IDs.

**Required:** Use real Salesforce record IDs from the bulk job results.

**Approach:** The `BulkJobRecordResult` interface has `success` and `errors` but no `id` field. Need to extend it with optional `id?: string` to match jsforce's actual response shape. Then in SeedOpsHandler, map successful results to their IDs (falling back to `bulk-{jobId}-{i}` only when ID is null).

**Pitfall:** The `BulkJobRecordResult` type in BulkApiExecutor.ts needs the `id` field added. The `executeBulk` return type (`BulkExecutionResult`) needs a `successIds: string[]` field. These are shared interfaces -- changes propagate.

## Accessibility Findings

### A11Y-01: ARIA Roles on ForgeReview Tabs

**Current:** ForgeReview has a custom tab bar using plain `<div>` + `<button>` elements. No `role="tablist"`, `role="tab"`, or `role="tabpanel"` attributes.

**Approach:** Add `role="tablist"` to the tab container div. Add `role="tab"`, `aria-selected`, and `aria-controls` to each tab button. Add `role="tabpanel"`, `id`, and `aria-labelledby` to the tab content div.

### A11Y-02: aria-pressed on Filter Buttons

**Current:** LogStream filter buttons and ForgeExecution log filter buttons are plain `<button>` elements with visual-only active state (background color change). No `aria-pressed`.

**Approach:** Add `aria-pressed={activeFilter === tab.key}` to LogStream filter buttons. Add `aria-pressed={logFilter === filterValue}` to ForgeExecution filter buttons.

### A11Y-03: role="log" + aria-live on LogStream

**Current:** LogStream's scrollable container is a plain `<div>` with no semantic role.

**Approach:** Add `role="log"` and `aria-live="polite"` to the scroll container (the inner div with `ref={scrollRef}`).

### A11Y-04: Depth Chips as Radiogroup

**Current:** Depth chips in ForgeInput are plain buttons. No radiogroup semantics, no arrow-key navigation.

**Approach:** Wrap the depth chip buttons in a `<div role="radiogroup">`. Change each button to `role="radio"` with `aria-checked={depth === d}`. Add `onKeyDown` handler for ArrowLeft/ArrowRight to cycle through options. Use `tabIndex={depth === d ? 0 : -1}` for roving tabindex pattern.

### A11Y-05: Fix LiveGraph Container Role

**Current:** LiveGraph has `role="img"` on its container div, but the graph is interactive (clickable nodes, checkboxes, zoom/pan).

**Approach:** Change `role="img"` to `role="application"` (since React Flow is a fully interactive widget that needs its own keyboard handling). Keep `aria-label`.

### A11Y-06: ProgressNode Checkbox onChange

**Current:** ProgressNode's include checkbox uses `onClick` handler with `readOnly` prop. This is semantically incorrect -- checkboxes should use `onChange`.

**Approach:** Change from `onClick={handleCheckboxChange}` + `readOnly` to `onChange={handleCheckboxChange}`. Adjust the handler signature to accept `React.ChangeEvent<HTMLInputElement>` instead of `React.MouseEvent`.

### A11Y-07: Contrast Fix for Skipped Status

**Current:** In ForgeNodeDetail, `statusColors.skipped` is `'bg-gray-500/20 text-gray-500'`. Gray-500 on a dark background may not meet WCAG AA 4.5:1 contrast ratio.

**Approach:** Change `text-gray-500` to `text-gray-400` for the skipped status. Gray-400 provides better contrast on dark backgrounds while remaining visually distinct from other statuses.

## File Ownership by Plan

| Plan | Files Modified | Package |
|------|---------------|---------|
| 04-01 (BE errors/timeouts) | HandlerTypes.ts, ForgeHandler.ts + their tests | extension |
| 04-02 (BE features) | GraphDiscoveryService.ts (preview logic in ForgeHandler), SeedOpsHandler.ts, BulkApiExecutor.ts, ReviewComplianceTab.tsx + tests | extension + webview (1 file) |
| 04-03 (A11Y) | ForgeReview.tsx, LogStream.tsx, ForgeExecution.tsx, ForgeInput.tsx, LiveGraph.tsx, ProgressNode.tsx, ForgeNodeDetail.tsx + tests | webview |

No file conflicts across plans -- all three can run in parallel (Wave 1).
