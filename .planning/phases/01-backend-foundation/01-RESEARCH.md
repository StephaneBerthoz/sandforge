# Phase 01: Backend Foundation — Limits Cache + Health Unification -- Research

**Researched:** 2026-03-20
**Phase goal:** Cache /limits at handler level, unify the two health scorers, integrate trend data into scoring, replace step-function scoring with linear interpolation, and fix the single-point defect in OrgTrendAnalyzer.analyzeJobTrend.

## Don't Hand-Roll

| Problem | Recommended solution | Why |
|---------|---------------------|-----|
| TTL-based cache for /limits response | Simple Map + timestamp field in MonitorOpsHandler (same pattern as OrgInfoFetcher) | OrgInfoFetcher already implements the exact TTL cache pattern at lines 9-24 of OrgInfoFetcher.ts. Reuse the same `{ data, fetchedAt }` Map approach. No external cache library needed -- the scope is a single in-process Map per handler instance. |
| Linear interpolation scoring | Inline math (`Math.max(0, Math.round(100 - usedPercent * scaleFactor))` or clamped linear map) | This is a 3-line function; no library needed. But the formula must be tested at boundary values (0, 100, and the breakpoints). |
| Trend direction from TrendStorage | `TrendStorage.getTrendData()` already returns direction + changePercent | Already implemented at TrendStorage.ts:87-141. Do not re-derive trend direction from raw snapshots -- call TrendStorage directly from the unified scorer. |

## Common Pitfalls

### Pitfall 1: Cache TTL mismatch between /limits and health score staleness

**What goes wrong:** If the /limits cache TTL is shorter than the monitor:refresh auto-refresh interval (30s), the cache never saves a call. If it is longer than 2 minutes (the stale threshold in useMonitorPageData), the UI shows stale data without knowing.
**Why:** The webview auto-refreshes every 30s and marks data stale at 120s. The /limits cache must fit between these bounds.
**How to avoid:** Set the handler-level /limits cache TTL to 30 seconds. This matches the auto-refresh interval exactly: within a single refresh cycle, all three handlers (monitor:refresh, monitor:api-usage, monitor:health-score) share the same cached response. The next auto-refresh cycle gets fresh data.

### Pitfall 2: Two different response shapes for health data

**What goes wrong:** `HealthScoreCalculator.calculate()` returns `HealthReport` (with `factors: HealthFactor[]`, `summary`, `topRisks`). `OrgHealthScoreCalculator.calculate()` returns `OrgHealthScoreResult` (with `dimensions: OrgHealthDimension[]`, `recommendations: string[]`). The webview consumes both shapes in different panels:
- `HealthScoreCard.tsx` reads `HealthReport` (factors, summary, topRisks, overallStatus)
- `OrgHealthPanel.tsx` reads `OrgHealthDimension[]` (name, score, label, detail, recommendation) via the `monitor:health-score:response` message
**Why:** The two calculators were built independently and never unified.
**How to avoid:** The unified scorer MUST output both shapes, or one shape that is a superset. The `HealthReport` type from `monitor.types.ts` is the richer type (has factors with weight, category, status, trend). The `OrgHealthDimension` is a simpler projection (name, score, label, detail, recommendation). The `handleHealthScore` method in MonitorOpsHandler already maps `HealthFactor[]` into `OrgHealthDimension[]` at lines 232-238. The unified scorer should return `HealthReport` natively, and the handler continues to project dimensions for the `monitor:health-score:response` message. This preserves both UI contracts.

### Pitfall 3: OrgHealthScoreCalculator hard-codes defaults for missing data

**What goes wrong:** `codeCoverage ?? 75` (line 145) and the security score returning 50 when settings are undefined (lines 188-193). These fake scores inflate the health score, giving users false confidence.
**Why:** OrgHealthScoreCalculator was designed to always produce 5 dimensions even without data.
**How to avoid:** The unified scorer should mark dimensions as "unavailable" when data is missing rather than inventing optimistic defaults. Two options: (a) skip the dimension and redistribute its weight, or (b) include the dimension with score=0 and a clear "data unavailable" message. Option (a) is safer because including a 0-score for unavailable data penalizes orgs unfairly. The planner should decide which approach, but must NOT keep the current default-75 / default-50 pattern.

### Pitfall 4: analyzeJobTrend creates only 1 data point -- fix requires accumulated storage

**What goes wrong:** `analyzeJobTrend` (OrgTrendAnalyzer.ts:74-93) creates a single `TrendDataPoint` from `jobMonitor.getJobStats(orgId).active`. Since `calculateTrend` requires MIN_TREND_POINTS=2, it always returns `{trend: 'stable', changePercent: 0}`.
**Why:** Unlike `analyzeLimitTrend` which reads from `limitsTracker.getHistory()` (accumulated snapshots), `analyzeJobTrend` takes a single point-in-time snapshot. There is no job history accumulation anywhere.
**How to avoid:** The fix needs a history store for job stats, analogous to how LimitsTracker keeps `history: Map<string, LimitsSnapshot[]>`. Two approaches: (a) add a `jobHistory: Map<string, TrendDataPoint[]>` inside OrgTrendAnalyzer that accumulates on each call, or (b) extend TrendStorage to also record job data points. Approach (a) is simpler and more contained -- job trend data does not need persistence across restarts (limits trend data already handles that via ConfigStore). The existing test at OrgTrendAnalyzer.test.ts lines 101-113 explicitly tests the single-point-returns-stable behavior, so these tests must be updated.

### Pitfall 5: Step function cliff effects in HealthScoreCalculator

**What goes wrong:** The `usageScore` function jumps: 49% usage = 100 score, 50% usage = 80 score. This 20-point cliff at exactly 50% (and 75%, 90%, 95%) creates unstable scoring where small usage changes cause large score swings.
**Why:** Step functions are simpler to implement but produce discontinuous derivatives.
**How to avoid:** Replace with a continuous linear interpolation. The formula should map 0% usage to 100 score and 100% usage to 0 score, with optional non-linearity (e.g., a slight curve that penalizes high usage more). The simplest correct formula: `score = Math.max(0, Math.round(100 - usedPercent))`. If the design wants a non-linear curve that accelerates penalties above 70%, use a piecewise linear with 2-3 segments -- still continuous, but with steeper slope at higher usage. Key: the function MUST be monotonically decreasing and continuous.

### Pitfall 6: OrgInfoFetcher cache verification is not about code changes

**What goes wrong:** PERF-02 says "verify OrgInfoFetcher 5-min cache is shared across handler calls." The OrgInfoFetcher instance is created as a field of MonitorOpsHandler at line 39: `private readonly orgInfoFetcher = new OrgInfoFetcher()`. Since all monitor messages route through the same MonitorOpsHandler instance, the cache IS already shared.
**Why:** This requirement is a verification task, not a code change. The cache works correctly.
**How to avoid:** Write a targeted unit test that calls handleRefresh twice (within 5 min) and asserts the OrgInfoConnection methods are called only once. This proves the cache is shared. Do not add any new caching mechanism -- one already exists.

### Pitfall 7: Three separate /limits API calls in a single refresh cycle

**What goes wrong:** When the webview sends `monitor:refresh`, then `monitor:api-usage`, then `monitor:health-score` in sequence (or when the user clicks scan in OrgHealthPanel while a refresh is running), each handler independently calls `conn.request(/limits)`. This triples the API consumption against the user's DailyApiRequests limit.
**Why:** Each handler method is self-contained and fetches its own data.
**How to avoid:** Introduce a handler-level limits cache field on MonitorOpsHandler (e.g., `private limitsCache: Map<string, { data: RawLimitsResponse; fetchedAt: number }>`). Each handler checks the cache before calling the API. With a 30s TTL, the auto-refresh cycle shares the call. Note: the cache key must include orgId (the user can switch orgs). The `handleRefresh` method at line 104 calls `conn.request` and then `transformLimitsResponse`. The `handleApiUsage` at line 355 calls `conn.request` but processes the raw response differently (it reads individual keys from `limitsRaw[key]`). So the cache must store the RAW response (`RawLimitsResponse`), not the transformed `ApiLimit[]`, because the two handlers need different processing.

## Existing Patterns in This Codebase

- **OrgInfoFetcher TTL cache pattern** (`packages/extension/src/modules/monitor/OrgInfoFetcher.ts` lines 9-24): `Map<string, { data: T; fetchedAt: number }>` with configurable TTL. Check `Date.now() - fetchedAt < ttl`, return cached if fresh, else fetch and update. This is the exact pattern to replicate for /limits caching.

- **TrendStorage.getTrendData()** (`packages/extension/src/modules/monitor/TrendStorage.ts` lines 87-141): Already computes direction (up/down/stable), changePercent, predictedTimeToLimit, and sparklineData for any limit name. This is the data source HEALTH-02 needs -- feed `getTrendData(orgId, limitName).direction` into the unified health factor's `trend` field.

- **trendUtils.computeTrendData()** (`packages/extension/src/modules/monitor/trendUtils.ts`): Standalone utility doing the same trend computation as TrendStorage but from raw snapshots. Used in handleTrends. For health scoring, prefer TrendStorage.getTrendData() since it already handles persistence and rate-limiting.

- **transformLimitsResponse()** (`packages/extension/src/modules/monitor/transformLimitsResponse.ts`): Converts `RawLimitsResponse` to `ApiLimit[]`. Used by handleRefresh (line 105) but NOT by handleApiUsage (which reads raw keys directly). The cache must store raw data to serve both consumers.

- **HealthReport / HealthFactor types** (`packages/shared/src/types/monitor.types.ts` lines 161-180): The `HealthFactor.trend` field is typed as `'improving' | 'stable' | 'degrading'`. Note this differs from TrendData.direction which uses `'up' | 'down' | 'stable'`. The unified scorer must map between these vocabularies: up -> degrading, down -> improving, stable -> stable.

- **HealthCheck signal provider pattern** (`packages/extension/src/modules/monitor/HealthCheck.ts`): A `HealthSignalProvider` is an async function `(orgId: string) => Promise<HealthSignal>`. This is a separate aggregation service (WIRE-05 scope) that consumes health scores. The unified scorer should be usable as a signal provider for HealthCheck in Phase 02.

- **Test helper conventions**: All monitor tests use a `makeLimit(name, max, usedPercent)` helper to build ApiLimit fixtures. Tests are in the same directory as source. The project has 7149+ tests passing.

- **MONITOR_KEY_LIMITS** (`packages/shared`): A shared constant listing the limit names that get trend tracking. Health scoring should iterate these same limits for trend-aware scoring.

## Key Type Compatibility Constraints

1. **HealthReport** (used by HealthScoreCard, useMonitorPageData, monitor:data response) must retain: `overallScore`, `overallStatus`, `factors: HealthFactor[]`, `summary`, `topRisks`.

2. **OrgHealthDimension** (used by OrgHealthPanel, monitor:health-score:response) must retain: `name`, `score`, `label`, `detail`, `recommendation`.

3. **HealthFactor.category** is currently `'limits' | 'jobs' | 'storage'`. The unified scorer adds metadata complexity, code coverage, and security dimensions. The category union type in `monitor.types.ts` must be extended (e.g., `'metadata' | 'coverage' | 'security'`).

4. **HealthFactor.trend** is `'improving' | 'stable' | 'degrading'`. TrendData.direction is `'up' | 'down' | 'stable'`. Need a mapping function.

## Recommended Approach

Implement the /limits cache as a private `Map<string, { data: RawLimitsResponse; fetchedAt: number }>` on MonitorOpsHandler with a 30-second TTL, caching the raw response so both handleRefresh (which transforms to ApiLimit[]) and handleApiUsage (which reads raw keys) can share it. For health unification, create a single new `UnifiedHealthScorer` class that replaces both `HealthScoreCalculator` and `OrgHealthScoreCalculator`, taking limits + optional orgInfo/metadata/security/trendStorage as input and returning `HealthReport`. Use linear interpolation (continuous piecewise function) for scoring instead of the current step functions. For HEALTH-02, call `TrendStorage.getTrendData()` inside the unified scorer to populate each factor's `trend` field with real data. For TREND-03, add a `jobHistory: Map<string, TrendDataPoint[]>` accumulator inside `OrgTrendAnalyzer` so `analyzeJobTrend` builds up history across calls. Verify PERF-02 with a unit test rather than code changes. Update the shared `HealthFactor.category` type to include the new dimension categories.
