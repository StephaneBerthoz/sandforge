# Plan 03-05 Summary — AnomalyEngine

**Status**: COMPLETE
**Wave**: 2 (Phase 03 — anomaly detector substrate)
**Delivered**: 6 tasks, 6 commits
**Date**: 2026-05-02

## What shipped

1. **`anomaly-math.ts`** (`monitor/anomaly-math.ts`, ~67 LOC including JSDoc) —
   Pure-function rolling-window math. No class, no I/O, no logger.
   Exports:
   - Constants: `MIN_SAMPLES_FOR_BASELINE = 30`, `MIN_BASELINE_SPAN_MS = 6h`,
     `DEFAULT_WINDOW_MS = 24h`, `DEFAULT_SIGMA_THRESHOLD = 3`.
   - Functions: `windowOf`, `rollingMean`, `rollingStdDev`, `zScore`,
     `effectiveThreshold`, `isWarmedUp`.
   - No new lib deps (RESEARCH §1 — no `simple-statistics`/`mathjs`/`d3-array`).
2. **`anomaly-math.test.ts`** — **25 tests** (16 unit + 4 property + 1 fast-check
   integration). Property tests use `Math.fround()` to keep finite/positive
   float bounds within fast-check's 32-bit float arbitraries (the previous
   agent's intended fix; applied throughout).
3. **`AnomalyEngine.ts`** — Detector class wired to {@link MetricBus} +
   {@link TimeSeriesStore}. On every `monitor:metric`, queries the per-
   `(orgId, seriesId)` 24h window, builds a baseline excluding the just-
   recorded sample, and:
   - Refuses to emit until baseline ≥ 30 samples AND ≥ 6h span (P-03.3).
   - Widens sigma threshold by `(1 + 1/sqrt(n))` for n < 100 (P-03.3).
   - Emits `monitor:anomaly:detected` with the schema-conformant payload.
   - Constant-series stdDev=0 → null (no divide-by-zero spam).
   - Warmup-suppression telemetry breadcrumb rate-limited to 1/hr per series.
4. **`AlertEngine.submitAnomalyInstance(event)` bridge** — RESEARCH §2's
   "directly construct AlertInstance" path. Synthetic instance carries
   `definitionId = SYNTHETIC_ANOMALY_DEFINITION_ID = '__synthetic_anomaly__'`,
   `badge: 'anomaly'`, `severity = 'critical'` when `|zScore| >= 5`, signed
   3σ `threshold`, and `metadata: { mean, stdDev, zScore, recentContext }`.
   Tracked in `activeAlerts` and notified via the existing `onNotify`
   callback so AlertsPanel renders synthetic instances with no extra wiring.
   Two new optional fields added to the shared `AlertInstance` type
   (`badge?: 'anomaly'`, `metadata?: Record<string, unknown>`) — both
   additive and backward-compatible.
5. **`MonitorOrchestrator` wiring** — exposes `public readonly anomalyEngine:
   AnomalyEngine`. Constructor builds the engine alongside the existing
   bus/store/registry trio. `start()` now: `rehydrate()` → `anomalyEngine
   .start()` → subscribe `metricBus 'monitor:anomaly:detected'` →
   `alertEngine.submitAnomalyInstance(event)`. Subscription registered once
   across orgs (idempotent). `dispose()` tears down registry, anomaly bridge
   sub, anomaly engine, then bus, then store.
6. **`AnomalyEngine.test.ts`** — **14 tests** (10 unit + 3 property + 1
   vertical slice). Vertical slice: 100 monotone sin-wave samples
   (mean≈50, stdDev≈3.5) over 24h plus 1 outlier at value=80 (~6σ) emits
   exactly 1 anomaly AND bridges to AlertEngine as exactly 1 synthetic
   AlertInstance with badge='anomaly', definitionId=SYNTHETIC sentinel,
   severity='critical', and full metadata.

## Commits

- `e6e331f` feat(monitor)[plan-03-05-task-01]: anomaly-math.ts pure rolling-window math + 25 tests
- `b2de2dd` feat(monitor)[plan-03-05-task-02]: AnomalyEngine class — warmup gate + 3σ emit
- `d040633` feat(monitor)[plan-03-05-task-03]: bridge anomalies into AlertEngine via submitAnomalyInstance
- `e434f9b` feat(monitor)[plan-03-05-task-04]: wire AnomalyEngine + bridge into MonitorOrchestrator
- `b691c14` test(monitor)[plan-03-05-task-05]: AnomalyEngine unit + property tests + vertical slice (14 tests)
- `9434263` test(monitor)[plan-03-05-task-06]: verify vertical slice via -t filter + mark must-haves

## Test impact

- Tests added: **+14** (25 anomaly-math tests already counted in baseline since
  files existed on disk before the resume; +14 new AnomalyEngine.test.ts)
- Extension before Plan 03-05: 4812 → after: **4826** (+14)
- Shared: **967** (unchanged — additive type fields didn't change schema tests)
- Webview: **2899** (unchanged — no webview surface in 03-05)
- **Total: 8692** (baseline 8678 + 14)
- Regressions: **0** — AlertEngine 30/30, MonitorOrchestrator 27/27, all
  shared monitor type tests 30/30 green.
- Mutation testing: **deferred** — same Stryker config bug as Plans 03-01 /
  02 / 03 / 04. Tracked in Phase 06 BP-04.

## Requirements covered

- **MON-05**: rolling-std-dev anomaly detection with warmup-aware emission
  bridged into the existing AlertEngine ✓

## Risks closed

- **P-03.3 (False positives at startup)** — warmup gate (30 samples + 6h
  span), sigma scale-up at low n (`baseSigma * (1 + 1/sqrt(n))` for n < 100),
  persistence-aware rehydration via TimeSeriesStore (Plan 03-02), telemetry
  breadcrumb on every suppression rate-limited to 1/hr per series.
- **P-03.8 (Discriminated-union exhaustiveness)** — `monitor:anomaly:detected`
  variant already exists in `MetricEventTypeMap` from Plan 03-01; no
  exhaustiveness regression.

## Decisions made during execution

- **Bus payload omits `detectedAt`** — `AnomalyDetectedEventSchema` in
  `@sandforge/shared` (Plan 03-01) does NOT have a `detectedAt` field.
  AnomalyEngine emits the schema-conformant subset on the bus and keeps
  `detectedAt` on the in-process return value (`AnomalyDetectedEvent`
  interface) so the AlertEngine bridge can populate
  `AlertInstance.triggeredAt` meaningfully. The MonitorOrchestrator
  bridge re-synthesizes `detectedAt` at receive-time. Trade-off: small
  clock skew between emit and bridge consume (typically < 1 ms).
- **Property test arbitraries** — plan specified `orderedSnapshotsArb` +
  `monotoneNonDecreasingSnapshotsArb` from Phase 02 — but those produce
  `LimitsSnapshot[]` (different domain). AnomalyEngine.evaluate consumes
  `MetricSample`s. Used `metricSampleArb` + `orderedSamplesForOneSeriesArb`
  (Plan 03-02 substrate-correct arbs) instead.
- **`AlertInstance` widening** — added two optional fields (`badge?:
  'anomaly'`, `metadata?: Record<string, unknown>`) to the shared type.
  Both additive — every existing alert keeps working. AlertsPanel can
  read `badge` to render a distinct visual treatment without inspecting
  `definitionId`.
- **Sentinel exported as constant** — `SYNTHETIC_ANOMALY_DEFINITION_ID =
  '__synthetic_anomaly__'` lives on `AlertEngine.ts` so downstream
  consumers (AlertsPanel filter, AlertHistoryPanel grouping, telemetry
  routing) reference the same string instead of duplicating the literal.
- **Subscription idempotence in MonitorOrchestrator.start** — wrapped the
  bridge subscription in a `if (!this.anomalyBridgeUnsub)` guard so a
  second `start(orgId)` for a different org does NOT re-subscribe and
  produce duplicate AlertInstances per anomaly.
- **Math.fround for fast-check float bounds** — applied in property tests
  so JS doubles round-trip cleanly to fast-check's 32-bit float
  arbitraries (the previous agent's intended fix).

## Deviations from plan

- **Property test arbitraries** — see "Decisions" above (LimitsSnapshot
  arbs would not type-check against AnomalyEngine).
- **Bus payload `detectedAt`** — see "Decisions" above (existing schema
  doesn't carry it).
- **`AlertInstance` field additions** — plan said "if it's not a current
  field, ADD it as optional". Done. AlertsPanel CSS variant for the
  `'anomaly'` badge is NOT shipped here (no webview surface in Plan 03-05);
  Plan 03-07 owns the AlertsPanel UI variant.

## Notes for downstream

- **Plan 03-06 (ReportExporter)** — anomaly events are already routable via
  `metricBus.subscribe('monitor:anomaly:detected', ...)` and the
  AlertEngine `getActiveAlerts()` filters by `definitionId ===
  SYNTHETIC_ANOMALY_DEFINITION_ID` to surface anomaly instances in the
  weekly PDF.
- **Plan 03-07 (Multi-org overview)** — must:
  1. Render `badge: 'anomaly'` AlertInstances with a distinct visual
     variant in `AlertsPanel.tsx`.
  2. Optionally display the `metadata.zScore` and `metadata.recentContext`
     sparkline in the alert detail drawer.
- **Phase 04 (AI narrator)** — every emitted anomaly carries a 10-sample
  `recentContext` trailing window plus mean/stdDev/zScore — enough
  numeric context for an LLM to compose a human-readable explanation
  WITHOUT extra round-trips to TimeSeriesStore.
- **Plan 03-05 + Plan 03-04 disjoint** — DriftDetector lives in its own
  files; no overlap.
- **Stryker** — config bug from Plans 03-01/02/03/04 still affects this
  plan's mutation coverage. Phase 06 BP-04 backlog.
