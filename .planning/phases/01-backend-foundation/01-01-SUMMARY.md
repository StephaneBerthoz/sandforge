# Plan 01-01 Summary

**Completed:** 2026-03-20
**Phase:** 01 -- Backend Foundation: Limits Cache + Health Unification

## What was built

Added a 30-second handler-level /limits cache to MonitorOpsHandler so that within a single refresh cycle, handleRefresh, handleHealthScore, and handleApiUsage share a single /limits API response instead of each making independent calls. Fixed the single-point defect in OrgTrendAnalyzer.analyzeJobTrend by accumulating job stats history across calls via a private jobHistory Map (capped at 50 entries per org). Added tests proving /limits cache sharing (PERF-01) and OrgInfoFetcher cache reuse (PERF-02).

## Key files

- `packages/extension/src/bridge/handlers/MonitorOpsHandler.ts`: Added limitsCache Map with 30s TTL, getOrFetchLimits method, replaced 3 direct conn.request calls
- `packages/extension/src/bridge/handlers/MonitorOpsHandler.test.ts`: Added PERF-01 and PERF-02 tests, unified vi.mock setup with vi.hoisted
- `packages/extension/src/modules/monitor/OrgTrendAnalyzer.ts`: Added jobHistory Map, rewrote analyzeJobTrend to accumulate history
- `packages/extension/src/modules/monitor/OrgTrendAnalyzer.test.ts`: Added tests for increasing/decreasing trends and history cap

## Decisions made

- Used `vi.hoisted()` for mock functions referenced in `vi.mock` factories to avoid ReferenceError from vitest hoisting. Unified all mocks into a single module-level setup instead of per-test `vi.mock` calls.
- PERF-01 test uses handleHealthScore + handleApiUsage (not handleRefresh) to isolate the /limits cache test from queryAll mocking complexity.
- OrgTrendAnalyzer.analyzeJobTrend returns a copy of the history array (`[...history]`) to prevent external mutation of internal state.
- Import `Connection` type from jsforce for the `getOrFetchLimits` parameter type rather than using `unknown`.

## Deviations from plan

- The plan suggested the PERF-01 and PERF-02 tests could be in separate describe blocks with their own vi.mock setups. Due to vitest's vi.mock hoisting (only one mock factory per module path per file), both tests were placed in a single file with a unified hoisted mock setup and per-describe beforeEach configuration.

## Notes for downstream

- The limitsCache is keyed by orgId. Multi-org scenarios (switching orgs within 30s) will correctly use separate cache entries.
- The existing `checkApiLimits(conn.limitInfo, ...)` calls remain in each handler -- they check the connection header which is orthogonal to the response cache.
- OrgTrendAnalyzer.jobHistory persists across the lifetime of the OrgTrendAnalyzer instance. If the instance is recreated (e.g., on extension reload), history resets.
