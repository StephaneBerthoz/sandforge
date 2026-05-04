# Plan 03-02 Summary — TimeSeriesStore substrate

**Status**: COMPLETE
**Wave**: 1 (Phase 03 storage layer)
**Delivered**: 8 tasks, 8 commits
**Date**: 2026-05-04

## What shipped

1. **`RingBuffer<T>` data structure** (`monitor/RingBuffer.ts`, 59 LOC) —
   hand-rolled fixed-capacity FIFO. O(1) push, O(n) toArray. No external
   deps (RESEARCH §1: no `mnemonist`).
2. **RingBuffer unit tests** — 7 tests covering eviction, wraparound,
   range filter, clear, invalid capacity rejection.
3. **`metricSampleArb` + `orderedSamplesForOneSeriesArb`** appended to
   `src/test/arbitraries.ts` — fast-check generators driving the
   property tests in tasks 06 + 08. Existing 16 Phase 02 property tests
   still PASS.
4. **`TimeSeriesStore` class** (`monitor/TimeSeriesStore.ts`) —
   per-(orgId, seriesId) ring-buffered MetricSample store. API:
   `record / query / getStats / clear / rehydrate / flush / dispose`.
   Defaults: 7-day window (matches TrendStorage), 50 MB LRU ceiling,
   ~96 bytes/sample, 30 s probe interval → 20,160 samples/series cap.
   LRU eviction triggers above the byte cap; pino-style logger
   surfaces every eviction (P-03.1 watchpoint).
5. **Opt-in disk persistence + 5-min flush timer + 15-min per-org rate
   limit + corruption recovery (P-03.10)**. New VS Code setting
   `sandforge.monitor.persistTimeSeries` (default off) in EN + FR NLS.
   ConfigStore-backed, category `monitor-ts`, key prefix `series-`,
   500 KB/org cap (skip + log if over). Corrupted JSON → drop + log
   warn + telemetry breadcrumb, NEVER throws. flush timer cleared in
   `dispose()`; `audit:disposables` PASS.
6. **TimeSeriesStore tests** — 9 unit + 3 property + 1 vertical-slice
   = 13 tests. Persistence round-trip, rate-limit gating, P-03.10
   corruption recovery, capacity / order / bytes-cap invariants, all
   green. Tests use `FIXED_NOW = 2099-01-01` to keep `query()`'s
   default upper bound above the 2024-base sample range — avoids
   "future ts" flakes on the real-time clock.
7. **MonitorOrchestrator wiring** — new public readonly
   `timeSeriesStore` field, optional `persistTimeSeries` dep flag.
   `start()` awaits `timeSeriesStore.rehydrate()` BEFORE any probe
   fetch (P-03.10 race fix). `dispose()` runs a final flush then
   disposes. Plumbed `services.configStore` (new optional field on
   `CoreServices`) so the store sees the right backend.
8. **Vertical-slice e2e** — Plan 03-02 demoable proof: 50,000 samples
   across 5 orgs × 20 series with 1 MB cap. LRU + per-series cap
   invariants both hold. Wall-time 115 ms.

## Commits

- `789161d` feat(monitor)[plan-03-02-task-01]: RingBuffer<T>
- `c1c4323` test(monitor)[plan-03-02-task-02]: RingBuffer unit tests
- `39d62a8` test(monitor)[plan-03-02-task-03]: metricSampleArb arb
- `4f60fca` feat(monitor)[plan-03-02-task-04]: TimeSeriesStore class
- `c4f3e84` feat(monitor)[plan-03-02-task-05]: opt-in disk persistence
- `c869c00` test(monitor)[plan-03-02-task-06]: TimeSeriesStore tests
- `2d78f18` feat(monitor)[plan-03-02-task-07]: wire into orchestrator
- `(this summary)` test+docs: vertical-slice 50K + SUMMARY

## Test impact

- Tests added: +20 (7 RingBuffer + 13 TimeSeriesStore)
- Total before Plan 03-02: 8579
- Total after: 8599
- Regressions: 0
- Mutation testing: deferred — same Stryker config bug as Plan 03-01
  (only `packages/shared/` tests run, extension tests skipped). Fix
  tracked in Phase 06 BP-04 backlog.

## Requirements covered

- TS-01: time-series substrate ✓
- TS-02: ring-buffered per-series storage ✓
- TS-03: LRU memory cap ✓
- TS-04: opt-in disk persistence with corruption recovery ✓
- TS-05: rehydrate-before-start race fix (P-03.10) ✓

## Risks closed

- **P-03.1 (Memory blow-up at 5+ orgs)** — per-series capacity derived
  from interval + LRU eviction at 50 MB. Verified by property test +
  vertical-slice 50K e2e (1 MB cap held).
- **P-03.10 (Persistence rehydration race)** — `start()` awaits
  `rehydrate()` before any probe, AND corrupted entries are dropped
  with telemetry breadcrumb but never throw. Tested in unit suite.

## Next plan

**03-03 — MonitorRegistry + Probe scheduler**: refactor 8 existing
trackers into thin `MonitorProbe` adapters; introduce single
`setInterval`-per-org scheduler; subscribe `MetricBus → store.record()`.
This is the seam where TimeSeriesStore actually starts receiving data.
