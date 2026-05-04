# Plan 03-01 Summary — MetricBus + MetricEvent envelope

**Status**: COMPLETE
**Wave**: 1 (Phase 03 foundation)
**Delivered**: 7 tasks, 6 commits + 1 follow-up note
**Date range**: 2026-04-30 → 2026-05-04

## What shipped

1. **`@sandforge/shared/monitor/MetricEvent.ts`** — Zod-discriminated union of 5
   event subtypes (`monitor:metric`, `monitor:metrics:batch`,
   `monitor:drift:detected`, `monitor:anomaly:detected`,
   `monitor:fleet:summary`) + `MetricSampleSchema` + `MetricEventTypeMap` +
   `assertNever` exhaustiveness helper. All schemas `.strict()` so unknown
   fields fail Zod parse — guards Phase 04 / 05 senders.
2. **`@sandforge/shared/bridge/messageSchemas.ts` + `types/messages.types.ts`** —
   3 envelope entries for `monitor:metric`, `monitor:metrics:batch`,
   `monitor:metric:subscribe` wired into the existing `MonitorMessage` union.
3. **`packages/extension/src/modules/monitor/MetricBus.ts`** — typed event bus
   class. `emit<K>(event)` validates with the matching schema and routes to
   `routeToBridge()` (post-message via webview hook) plus all in-process
   subscribers. `on<K>(type, handler)` returns an unsubscribe disposable.
   `dispose()` clears all subscriptions. Singleton pattern: `getMetricBus()`
   returns the process-wide instance.
4. **`MetricBus.test.ts`** — 10 unit tests covering emit/route, subscribe,
   unsubscribe, dispose, exhaustiveness check (with `@ts-expect-error` guard
   so future event-type additions force a routing-switch update).
5. **MonitorOrchestrator wiring** — replaced the old ad-hoc event emitter with
   `getMetricBus()` for fleet-level + drift events; existing AlertEngine
   listener migrated.
6. **Vertical-slice integration test** — Plan 03-01 end-to-end: emit a
   `monitor:metric` event, assert MetricBus routes it to a registered
   webview-side handler via the bridge, schema rejects malformed payload.

## Task 03-01-07 — Stryker mutation smoke (DEFERRED)

**Result**: ran successfully (2 min 40 s wall-time, 68 mutants applied to
`MetricBus.ts`) but **all 68 mutants survived** — kill ratio 0%, far below
the 60% threshold the plan required.

**Root cause discovered**: `stryker.conf.json` has

```json
"vitest": {
  "configFile": "packages/shared/vitest.config.ts",
  "dir": "packages/shared"
}
```

The Vitest runner is pinned to the `shared` package's test directory.
`MetricBus.test.ts` lives in `packages/extension/`, so Stryker mutates
the source file but executes ZERO tests against it — every mutant trivially
survives because no test discriminates the mutated behavior. The same
defect affects every other extension-side mutate target (`core/engine`,
`modules/compare`, `modules/sync`, `modules/monitor`).

**Mitigation chosen**: documented as a **Phase 06 BP-04 follow-up**
(`fix(stryker): multi-package runner so extension tests are executed`).
Did not lower the threshold per the plan's explicit instruction; did not
add test bloat to MetricBus.test.ts since the failure mode is config
not coverage. Tracked in `.planning/audit-2026-05-02-cross-cutting.md`
backlog.

This finding is the most valuable output of task 03-01-07 — the entire
extension-side Stryker pass has been reporting fictitious numbers since
the original `stryker.conf.json` introduced the `vitest.dir` constraint
(commit 02-01). Phase 06 fix should also re-baseline.

## Commits

- `d58a750` feat(monitor)[plan-03-01-task-01]: define MetricEvent discriminated union + Zod schemas
- `ac7c157` feat(monitor)[plan-03-01-task-02]: add monitor:metric* envelope entries
- `f875648` feat(monitor)[plan-03-01-task-03]: add MetricBus class on extension side
- `9a4f1ca` test(monitor)[plan-03-01-task-04]: add MetricBus unit tests (10 tests)
- `afca42b` feat(monitor)[plan-03-01-task-05]: wire MetricBus singleton into MonitorOrchestrator
- `22c9244` test(monitor)[plan-03-01-task-06]: add Plan 03-01 vertical-slice integration test
- `(this summary)` task-07 retro: stryker config bug surfaced — Phase 06 follow-up

## Test impact

- Before Plan 03-01: 8412 tests
- After Plan 03-01: ~8579 tests (+167 across all post-plan-01 work; MetricBus
  contribution alone is the 10 unit + 1 integration tests)
- Regressions: 0

## Requirements covered

- METRIC-01: shared MetricEvent typed bus ✓
- METRIC-02: 5 event subtypes (sample, batch, drift, anomaly, fleet) ✓
- METRIC-03: bridge envelope entries for metric streaming ✓
- METRIC-04: in-process pub/sub for orchestrator → AlertEngine → UI ✓

## Risks closed / opened

**Closed**:
- P-03.5 (event-type drift between extension and webview) — Zod schemas
  + discriminated union force compile-time + runtime exhaustiveness.
- P-03.6 (silent message-schema drift) — broker auto-validates against
  the same schemas the bus uses.

**Opened (Phase 06 follow-up)**:
- Stryker reports fictitious numbers for everything outside
  `packages/shared/`. Until BP-04 fixes the runner config, the nightly
  Stryker workflow's mutation scores for `core/engine`, `modules/compare`,
  `modules/sync`, `modules/monitor` are not meaningful.

## Next plan

**03-02 — TimeSeriesStore**: hand-rolled RingBuffer + per-(orgId, seriesId)
storage substrate. Already started in this session (tasks 01, 02 shipped).
