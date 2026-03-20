# Plan 02-01 Summary

**Completed:** 2026-03-20
**Phase:** 02 -- Wire Services

## What was built

Wired 5 existing monitor services (ErrorLogMonitor, UserSessionMonitor, ApexLogAnalyzer, SandboxRefreshTracker, HealthCheck) to the MonitorOpsHandler bridge, establishing the full backend message protocol for the new monitor panels. Defined 8 message type contracts (4 request + 4 response) in shared, added i18n keys for all 5 panels in both EN and FR, registered 4 new routes in ExtensionHandlers, and integrated HealthCheck into handleRefresh as orgHealthStatus (WIRE-05).

## Key files

- `packages/shared/src/types/messages.types.ts`: 8 new message interfaces added to both union types
- `packages/shared/src/i18n/locales/en/monitor.ts`: 51 new i18n keys (errorLogs, sessions, apexInsights, sandboxRefresh, healthCheck)
- `packages/shared/src/i18n/locales/fr/monitor.ts`: 51 new i18n keys (French translations)
- `packages/extension/src/bridge/handlers/MonitorOpsHandler.ts`: 5 service instances, 4 handler methods, HealthCheck in handleRefresh
- `packages/extension/src/bridge/ExtensionHandlers.ts`: 4 new message types in monitor route array
- `packages/extension/src/bridge/handlers/MonitorOpsHandler.test.ts`: 7 new test cases (17 total)

## Decisions made

- Service query functions capture `this` (handler) context and call getJsforceConnection + queryAll internally per the plan's recommended pattern
- SandboxRefreshTracker instantiated without onRefreshDetected callback (Pitfall 9)
- HealthCheck providers use getOrFetchLimits (shared 30s cache) and errorLogMonitor.getErrorCount for zero-cost signals
- jobsProvider returns static nominal score (no extra SOQL call needed)
- Added `error?` optional field to all response payloads for consistency with existing patterns
- Added checkApiLimits mock to test file to support new handler tests with working connections

## Deviations from plan

- None

## Notes for downstream

- Plan 02-02 (UI panels) can now consume all 4 new message types: monitor:error-logs, monitor:sessions, monitor:apex-insights, monitor:sandbox-refresh
- The orgHealthStatus field is available in the monitor:data refresh payload for the HealthCheck panel
- All services are stateful (cache per orgId) -- subsequent calls within the same handler instance reuse cached data
