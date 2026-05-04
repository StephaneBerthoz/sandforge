# Plan 03-03 Summary — MonitorProbe + MonitorRegistry + DescribeCache

**Status**: COMPLETE
**Wave**: 1 (Phase 03 — substrate scheduler + audit Perf #1)
**Delivered**: 8 tasks, 8 commits
**Date**: 2026-05-02

## What shipped

1. **`MonitorProbe.ts`** — single-source-of-truth contract for every probe.
   Exports `MonitorProbe` interface, `ProbePriority` type
   (`critical | normal | low`), `MIN_PROBE_INTERVAL_MS = 5_000`,
   `PROBE_HARD_TIMEOUT_MS = 30_000`. 40 LOC.
2. **`adapters/salesforce/DescribeCache.ts`** — audit Perf #1 mitigation.
   Per-org `Map<objectApiName, { fields, cachedAt }>` with TTL gate
   (default 15 min) + LRU org eviction (default cap 10). Hit/miss counters
   surface via `getStats()`. Caller supplies the loader so the cache stays
   decoupled from any specific jsforce path. 178 LOC.
3. **`DescribeCache.test.ts`** — 10 unit tests covering miss / hit / TTL
   expiry / per-object invalidation / per-org invalidation / LRU eviction /
   LRU keep-alive on touch / `getStats` accuracy / `clear` / default TTL.
4. **`SalesforceAdapter` extension** — `describeCache: DescribeCache` field
   exposed publicly + `describeFields(orgId, objectApiName, loader)`
   convenience method routing through the cache. Legacy direct-jsforce
   describes elsewhere are NOT touched (per CONTEXT D-03-9 — Phase 06).
5. **`MonitorRegistry.ts`** — single-tick scheduler, the heart of Plan 03-03.
   ONE `setInterval` per registry instance (not N per-probe), with:
   - Per-`(orgId, probeId)` in-flight gate (P-03.6 — prevents overlap)
   - Drift accounting `nextRunAt = lastFinishedAt + intervalMs` (P-03.6)
   - Hard 30 s timeout via `Promise.race`-equivalent `setTimeout` race
   - Visibility-gated tick rate (30 s when hidden) + low-priority skip
     (audit M1, P-03.7)
   - MetricBus → TimeSeriesStore subscription bridged in constructor
   - `register / unregister / startOrg / stopOrg / setVisibility / dispose /
     getStats` API
   - 302 LOC.
6. **`MonitorRegistry.test.ts`** — 9 tests covering: single-tick dispatch,
   in-flight gate, drift accounting, hard timeout, visibility gating, bus →
   store wiring, dispose cleanup, `getStats` accuracy, **vertical-slice
   integration** (5 s probe / 60 s tick storm — `maxConcurrent === 1`).
7. **8 probe wrappers** in `monitor/probes/`:
   | Probe | Tracker | id | intervalMs | priority |
   |---|---|---|---|---|
   | LimitsProbe | LimitsTracker | `monitor.limits` | 30_000 | critical |
   | JobProbe | JobMonitor | `monitor.jobs` | 60_000 | normal |
   | ApexLogProbe | ApexLogAnalyzer | `monitor.apex` | 120_000 | low |
   | SandboxRefreshProbe | SandboxRefreshTracker | `monitor.sandbox` | 600_000 | low |
   | ErrorLogProbe | ErrorLogMonitor | `monitor.errors` | 60_000 | normal |
   | UserSessionProbe | UserSessionMonitor | `monitor.sessions` | 300_000 | low |
   | HealthProbe | HealthCheck | `monitor.health` | 60_000 | critical |
   | GovernanceProbe | GovernanceEngine | `monitor.governance` | 300_000 | normal |

   Each probe is a thin shell: tracker `fetch()` (or equivalent) is
   preserved verbatim; the probe maps the tracker output into one or more
   `MetricSample` entries.
8. **MonitorOrchestrator wiring** — exposes `public readonly registry:
   MonitorRegistry`. Constructor calls `registerProbes()` to register every
   probe whose tracker dependency is present (3 are optional —
   `apexLogAnalyzer`, `sandboxRefreshTracker`, `governanceEngine`). `start()`
   appends `registry.startOrg(orgId)` after the existing first-fetch warm-up.
   `stop()` calls `registry.stopOrg`. `dispose()` runs registry teardown
   BEFORE bus + store. New `setVisibility(hidden)` proxy method exposed for
   Plan 03-07 to wire later.

## Commits

- `e595cff` feat(monitor)[plan-03-03-task-01]: MonitorProbe interface + constants
- `303699b` feat(monitor)[plan-03-03-task-02]: DescribeCache adapter — audit Perf #1
- `22d19f2` feat(monitor)[plan-03-03-task-03]: MonitorRegistry single-tick scheduler
- `6891546` test(monitor)[plan-03-03-task-04]: MonitorRegistry — 9 unit tests
- `866892a` feat(monitor)[plan-03-03-task-05]: wrap LimitsTracker + JobMonitor + ApexLogAnalyzer as probes
- `41d9e96` feat(monitor)[plan-03-03-task-06]: wrap remaining 5 trackers as probes
- `98b9941` feat(monitor)[plan-03-03-task-07]: wire MonitorRegistry + register all 8 probes
- `351a827` test(monitor)[plan-03-03-task-08]: vertical slice — 5s probe survives 60s tick storm

## Test impact

- Tests added: **+19** (10 DescribeCache + 9 MonitorRegistry)
- Total before Plan 03-03: 8599
- Total after: 8618 (extension 4759 + shared 967 + webview 2892)
- Regressions: **0** — all 27 MonitorOrchestrator tests stay green; all
  79 wrapped-tracker tests stay green; all 21 SalesforceAdapter+DescribeCache
  tests pass.
- Mutation testing: **deferred** — same Stryker config bug as Plan 03-01 +
  03-02 (`vitest.dir` pinned to `packages/shared`, so extension tests are
  not executed against extension-side mutants). Tracked in Phase 06 BP-04.

## Requirements covered

- MON-03: refactor existing trackers into `MonitorProbe` implementations
  driven by a single-tick `MonitorRegistry` ✓
- Audit **Perf #1** (describeFields cache) — owned + shipped ✓
- Audit **M1** (visibility-gated polling) — extension-side gate shipped;
  WebView-side `monitor:visibility` message owned by Plan 03-07 ✓

## Risks closed

- **P-03.6 (Probe scheduling drift / overlap)** — in-flight gate, drift
  accounting via finishedAt, hard timeout, visibility-gated tick rate, all
  shipped + tested.
- **P-03.7 — audit Perf #1** — `DescribeCache` adapter shipped + 10 unit
  tests covering miss / hit / TTL / LRU.
- **P-03.7 — audit M1 (extension side)** — `MonitorRegistry.setVisibility`
  + `MonitorOrchestrator.setVisibility` proxy shipped; tick rate falls to
  30 s when hidden + low-priority probes skipped (verified by Test 5).

## Decisions made during execution

- **GovernanceProbe context shape** — the plan didn't specify how the
  probe gets policies and metric values for evaluation. Chose to introduce
  a `GovernanceProbeContext` interface (`getPolicy(orgId)`, `getMetrics(orgId)`)
  passed in via `MonitorDependencies.governanceContext` so the wiring stays
  decoupled from any specific governance store. When omitted, the probe
  registers but emits an empty array per run (no-op).
- **Optional tracker fields** — `apexLogAnalyzer`, `sandboxRefreshTracker`,
  `governanceEngine` were added as **optional** fields on
  `MonitorDependencies` to preserve backward compatibility with the existing
  27 `MonitorOrchestrator` tests that supply only the original 7 trackers.
  Probes are registered conditionally — absent dependency → no probe.
- **HealthProbe value derivation** — the `HealthCheck.computeHealth()` returns
  an `OrgHealthStatus` (statuses + counts), not a raw score. The probe
  re-derives a 0..100 score using the same formula as
  `MonitorOrchestrator.getHealthScore()` so the time-series store records a
  single comparable scalar series.
- **DescribeCache.describeFields convenience method** — added to
  `SalesforceAdapter` so callers can route through the cache without
  reaching into `services.salesforce.describeCache.getOrFetch(...)` directly.
  Legacy ForgeExecutor migration lives in Phase 06 per CONTEXT D-03-9.
- **Test 2 + Test 3 timing fixes** — first dispatch of MonitorRegistry tests
  needed adjustment: tick rate is `floor(intervalMs / 4)` clamped to
  `[1000, 10000]`, so a 5 s interval yields a 1.25 s first tick (not 1 s),
  and a 10 s interval yields a 2.5 s first tick. Tests 2 + 3 increased
  the `vi.advanceTimersByTimeAsync` budgets accordingly. Also lifted the
  `hardTimeoutMs` ceiling in tests 2 + 3 (default 30 s would short-circuit
  the long-running probe under fake timers).

## Deviations from plan

- **None.** Every task in the plan was executed end-to-end. The vertical
  slice test (task 08) was authored as Test 9 of `MonitorRegistry.test.ts`
  in task 04 (matches the plan's "Append a final integration test"
  instruction); task 08's commit only marks the plan checkbox + verifies
  the test runs by `-t "vertical slice"` filter.

## Notes for downstream

- **Plan 03-04 (Drift v2)** — should consume `services.salesforce.describeCache`
  for permission diffs. The cache is per-org partitioned and fully transparent.
- **Plan 03-05 (AnomalyEngine)** — every probe sample is now in
  `timeSeriesStore`. AnomalyEngine reads from there; no need to subscribe to
  the bus directly.
- **Plan 03-07 (Multi-org overview)** — must:
  1. Wire the WebView `document.visibilitychange` event to a new bridge
     message `monitor:visibility` whose handler calls
     `monitorOrchestrator.setVisibility(hidden)`.
  2. Provide a `GovernanceProbeContext` to `MonitorDependencies` so the
     governance probe starts emitting samples.
  3. Migrate ForgeExecutor's twin-describe pattern to
     `services.salesforce.describeFields(orgId, object, loader)` — Phase 06
     per CONTEXT D-03-9, but the seam is ready today.
- **Stryker** — the config bug from Plans 03-01 + 03-02 still affects this
  plan's mutation coverage. Phase 06 BP-04 backlog.
