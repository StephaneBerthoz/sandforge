---
phase: 2
status: passed
verified: 2026-03-20
---

# Phase 2: Wire Dead Services — Verification

## Must-Have Results

### Plan 02-01 (Backend Wiring)

| Plan | Must-Have | Status |
|------|-----------|--------|
| 02-01 | MonitorOpsHandler has 4 new private handler methods: handleErrorLogs, handleSessions, handleApexInsights, handleSandboxRefresh | ✓ |
| 02-01 | MonitorOpsHandler.handleRefresh calls HealthCheck.computeHealth and includes orgHealthStatus in the monitor:data response payload | ✓ |
| 02-01 | MONITOR_TYPES Set contains 4 new entries: monitor:error-logs, monitor:sessions, monitor:apex-insights, monitor:sandbox-refresh | ✓ |
| 02-01 | ExtensionHandlers.registerAll route array for monitor includes all 4 new message types | ✓ |
| 02-01 | messages.types.ts has 8 new interfaces (4 request + 4 response) added to both WebViewToExtensionMessage and ExtensionToWebViewMessage unions | ✓ |
| 02-01 | en/monitor.ts and fr/monitor.ts have i18n keys for errorLogs, sessions, apexInsights, sandboxRefresh, healthCheck | ✓ |
| 02-01 | MonitorOpsHandler.test.ts has at least 5 new test cases covering the new handler methods | ✓ (7 new cases, 17 total) |
| 02-01 | pnpm typecheck passes | ✓ |
| 02-01 | pnpm test passes (extension package) | ✓ (4080 tests, 244 files) |

### Plan 02-02 (Frontend Panels)

| Plan | Must-Have | Status |
|------|-----------|--------|
| 02-02 | ErrorLogsPanel.tsx exists and renders loading/empty/data states with data-testid attributes | ✓ |
| 02-02 | SessionsPanel.tsx exists and renders loading/empty/data states with data-testid attributes | ✓ |
| 02-02 | ApexInsightsPanel.tsx exists and renders loading/empty/data states with data-testid attributes | ✓ |
| 02-02 | RefreshPanel.tsx exists and renders loading/empty/data states with data-testid attributes | ✓ |
| 02-02 | HealthCheckPanel.tsx exists and renders loading/empty/data states with data-testid attributes | ✓ |
| 02-02 | MonitorPage.tsx imports and renders all 5 new panels in the dashboard layout | ✓ |
| 02-02 | Each panel has a co-located .test.tsx with at least 3 test cases (loading, empty, data) | ✓ (4 tests each) |
| 02-02 | All visible text uses t('monitor.*.key', 'fallback') — no hardcoded strings | ✓ |
| 02-02 | pnpm typecheck passes | ✓ |
| 02-02 | pnpm test passes (webview package) | ✓ (2293 tests, 226 files) |

## Requirement Coverage

| Req ID | Deliverable | Status |
|--------|-------------|--------|
| WIRE-01 | ErrorLogMonitor wired in MonitorOpsHandler.handleErrorLogs; ErrorLogsPanel.tsx renders the data | ✓ |
| WIRE-02 | UserSessionMonitor wired in MonitorOpsHandler.handleSessions; SessionsPanel.tsx renders the data | ✓ |
| WIRE-03 | ApexLogAnalyzer wired in MonitorOpsHandler.handleApexInsights; ApexInsightsPanel.tsx renders the data | ✓ |
| WIRE-04 | SandboxRefreshTracker wired in MonitorOpsHandler.handleSandboxRefresh; RefreshPanel.tsx renders the data | ✓ |
| WIRE-05 | HealthCheck.computeHealth called inside handleRefresh; orgHealthStatus included in monitor:data payload; HealthCheckPanel.tsx consumes it as prop from MonitorPage | ✓ |

## Integration Checks

| Import | Export exists | Status |
|--------|--------------|--------|
| MonitorPage imports ErrorLogsPanel from ./ErrorLogsPanel | export const ErrorLogsPanel | ✓ |
| MonitorPage imports SessionsPanel from ./SessionsPanel | export const SessionsPanel | ✓ |
| MonitorPage imports ApexInsightsPanel from ./ApexInsightsPanel | export const ApexInsightsPanel | ✓ |
| MonitorPage imports RefreshPanel from ./RefreshPanel | export const RefreshPanel | ✓ |
| MonitorPage imports HealthCheckPanel from ./HealthCheckPanel | export const HealthCheckPanel | ✓ |
| MonitorOpsHandler imports ErrorLogMonitor, UserSessionMonitor, ApexLogAnalyzer, SandboxRefreshTracker, HealthCheck | All 5 services exist in packages/extension/src/modules/monitor/ | ✓ |
| messages.types.ts exports MonitorErrorLogsRequest/Response in union types | Confirmed at lines 232–235 (request union) and 307–310 (response union) | ✓ |

## Evidence Summary

- `MonitorOpsHandler.ts`: private methods `handleErrorLogs` (line 587), `handleSessions` (line 613), `handleApexInsights` (line 637), `handleSandboxRefresh` (line 661) — all confirmed
- `MonitorOpsHandler.ts`: `this.healthCheck.computeHealth(payload.orgId)` called at line 343, result added to `monitor:data` payload at line 349
- `MONITOR_TYPES` Set: 4 new entries confirmed at lines 39–42
- `ExtensionHandlers.ts`: all 4 new types in route array at line 209
- `messages.types.ts`: 8 interfaces (MonitorErrorLogsRequest, MonitorSessionsRequest, MonitorApexInsightsRequest, MonitorSandboxRefreshRequest + 4 response counterparts) confirmed at lines 1180–1283
- `en/monitor.ts` + `fr/monitor.ts`: 9 keys per panel × 5 panels = 45+ keys each, all confirmed
- `MonitorOpsHandler.test.ts`: 7 new test cases confirmed at lines 263–467 (17 total `it()` calls)
- All 5 panel files exist with correct `data-testid` attributes for loading/empty/data states
- All 5 panel files use `t('monitor.*')` for all static UI labels — no hardcoded strings found
- `MonitorPage.tsx` imports all 5 panels (lines 34–38) and renders them (lines 680–687)
- `pnpm typecheck`: 0 errors across shared, extension, webview packages
- Extension tests: 4080 passed / 244 files
- Webview tests: 2293 passed / 226 files

## Summary

**Score:** 19/19 must-haves verified

All automated checks passed. Phase goal achieved.

All 5 dead monitor services (ErrorLogMonitor, UserSessionMonitor, ApexLogAnalyzer, SandboxRefreshTracker, HealthCheck) are wired to bridge handlers with message types, i18n keys, and handler tests (WIRE-01 through WIRE-05). All 5 corresponding UI panels exist in the webview with correct states, co-located tests, and i18n compliance. MonitorPage renders all 5 panels. Typecheck and all test suites pass cleanly.
