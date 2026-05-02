# Phase 03 — Monitor v2 Core — Context

**Decisions locked:** 2026-05-02 (autopilot YOLO; synthesized from v1.3.0 ROADMAP, prior Monitor enrichment work in v1.2.1, and the cross-cutting audit landed during Phase 02 verify-work).

## Scope

Requirements in this phase: **MON-01, MON-02, MON-03, MON-04, MON-05, MON-06, MON-07** (7 reqs).

Phase 03 replaces snapshot-only Monitor with a time-series, drift-aware, event-driven substrate. Goal: competitive parity with Gearset / Copado / Elements / SF Inspector for the in-editor audience. Builds on Phase 01 adapter layer + Zod envelope. Phase 04 (AI Integration) consumes `MetricBus` events for anomaly narratives; Phase 05 (CDC) reuses the WebView event-feed pattern.

## Decisions

### D-03-1 — `MetricBus` is the single source of metric events; trackers publish, panels subscribe
**Why:** v1.2.1 wired 5 dead backend services (ErrorLogMonitor, UserSessionMonitor, ApexLogAnalyzer, SandboxRefreshTracker, HealthCheck) directly into UI panels via point-to-point handlers. Adding a 6th metric meant updating N consumers. Event bus inverts the dependency: trackers publish typed events, panels subscribe by event type. Phase 04 anomaly engine + Phase 05 CDC feed both consume the same bus.
**How to apply:** New `packages/extension/src/modules/monitor/MetricBus.ts` with `emit<E extends MetricEvent>(event: E)` + `subscribe<T extends MetricEvent['type']>(type: T, handler: ...)`. Backed by Node `EventEmitter` for ext-side, mirrored to WebView via existing `monitor:metric` envelope. Discriminated union of event types in `packages/shared/src/monitor/MetricEvent.ts`.

### D-03-2 — `TimeSeriesStore` is in-memory ring buffer + opt-in disk persistence; 7 day retention
**Why:** A monitor that forgets data 5 minutes after refresh is just a ping tester. 7 days = covers a typical ops cycle (deploy Monday, observe through Friday, retro Sunday). Disk persistence is OPT-IN (off by default) because writing every 30s to disk is ext-host-disk I/O cost users haven't agreed to.
**How to apply:** `packages/extension/src/modules/monitor/TimeSeriesStore.ts` — Map<seriesId, RingBuffer<MetricSample>>; ring size derived from interval × 7 days. Optional `--persist` setting writes to `globalStorageUri/monitor-ts/<orgId>.json` every 5 min; rehydrate on activation. Eviction LRU when total memory > 50 MB (estimated cap based on 100 series × 7 days × 30s = 200K samples).

### D-03-3 — Refactor existing trackers into `MonitorProbe` implementations
**Why:** Current trackers have mixed concerns (poll loop + computation + UI shape transform). Extracting a `MonitorProbe` interface (`{ id, intervalMs, run(): Promise<MetricSample[]> }`) lets us register/deregister probes per-org, reuse the polling scheduler, and unit-test computation in isolation.
**How to apply:** Each tracker (`LimitsTracker`, `JobMonitor`, `ApexLogAnalyzer`, `SandboxRefreshTracker`, `ErrorLogMonitor`, `UserSessionMonitor`, `HealthScorer`, `GovernanceEngine`) becomes a `MonitorProbe`. A new `MonitorRegistry` schedules probes via a single `setInterval` per org (not N timers). Probes emit through `MetricBus`. Pre-existing tests stay green by adapting the public API while keeping the computation untouched.

### D-03-4 — Drift v2: field / object / permission delta tracking with UI visualization
**Why:** v1.x Drift detection compares snapshots but only reports object-level delta. Real ops question is "what permission changed for which profile yesterday?" — needs field & permission granularity. UI: a timeline-style "drift events" feed in Monitor with filter chips (object / field / permission / setup audit).
**How to apply:** Extend `DriftDetector` with `detectFieldDrift(prev, curr): FieldDelta[]` and `detectPermissionDrift(prev, curr): PermissionDelta[]`. Emit `monitor:drift:detected` events on the bus. New WebView panel `DriftFeed.tsx` renders the timeline with virtualized rows. Re-uses existing snapshot infrastructure from Compare module (`SnapshotManager`).

### D-03-5 — Rolling-std-dev anomaly detection on time-series data
**Why:** Static thresholds (e.g. "alert when API > 80%") miss usage anomalies that sit below the threshold but are 4σ above the org's normal baseline. Rolling 24h std-dev catches per-org baseline drift better than fixed thresholds.
**How to apply:** New `AnomalyEngine` consumes `TimeSeriesStore` queries. For each `(orgId, seriesId)` it computes 24h rolling mean + std-dev; emits `monitor:anomaly:detected` events when the latest sample crosses 3σ. Anomalies surface in the existing `AlertsPanel` with a distinct "anomaly" badge (vs static "rule" badge). Phase 04 AI generates narratives for these events.

### D-03-6 — PDF + CSV export for any dashboard view
**Why:** Compliance / audit teams want artifacts they can drop into a Confluence page or attach to a ticket. CSV is for spreadsheet jockeys; PDF is for paper trails.
**How to apply:** `packages/extension/src/modules/monitor/ReportExporter.ts` — accepts a `DashboardView` descriptor and a time range; queries `TimeSeriesStore`; renders to CSV (papaparse, already devDep) or PDF (`pdfkit` — new lightweight devDep, ~1.2 MB). PDF includes header (org + range), per-series table + sparkline rendered as inline SVG. Triggered from a new "Export" button on each panel.

### D-03-7 — Multi-org overview: list of orgs with health status + drill-down
**Why:** Today the user picks one org and sees its health. With 5+ sandboxes it's tedious. A "fleet" overview (default landing view) shows all connected orgs with a health gauge each + 3 recent alerts. Click → drill into the existing single-org dashboard.
**How to apply:** New `MonitorOverviewPage.tsx`. Backend: `monitor:fleet:summary` handler returns `{ orgs: Array<{ orgId, name, healthScore, lastUpdated, alerts: AlertSummary[] }> }`. Polls every 60s for connected orgs; respects `monitor:limits` cache. Replaces current "single-org-only" landing.

### D-03-8 — Phase 03 depends on Phase 01 (adapters/DI/Zod) but is independent of Phase 02
**Why:** Adapters are required for telemetry-emit on probes; Zod envelope guarantees `monitor:metric` payloads round-trip. Phase 02 is test infrastructure — Phase 03 consumes it but is not blocked by it.
**How to apply:** Phase 03 plans assume `services.telemetry`, `services.salesforce`, and `PROTOCOL_VERSION` are already wired. New monitor types are added to the existing `messages.types.ts` discriminated union with corresponding Zod schemas.

### D-03-9 — Slot Phase 02 verify-work findings into Phase 03 / Phase 06 backlog
**Why:** The cross-cutting audit run during Phase 02 verify-work surfaced ~50 findings across reviewer / red-team / perf-critic / fast-scout. Sprint 1 quick wins were applied during verify-work. The remaining items split between (a) "needs design" (DI race, BulkApi singleton, AI prompt-injection defense, bundle splitting) which fits Phase 06 (Best Practices & Polish), and (b) "Monitor-adjacent" (describe-cache miss on target, polling back-pressure, Map clones in stores) which fits Phase 03 because TimeSeriesStore + MonitorRegistry refactor naturally.
**How to apply:** Phase 03 plans pick up perf #1 (describe cache target), reviewer M1 (visibility-gated polling), reviewer M5 (Map → Record store). Phase 06 picks up C1 (aiProvider stub fix), C5 (BulkApiManager singleton), H1 (DI ordering), H3 (deactivate await), H5 (per-route ErrorBoundary), red-team #3/#4 (sync where clause schema), red-team #5 already fixed in verify-work, red-team #9 (login URL whitelist), red-team #10/#11 (AI prompt injection defense — overlaps with Phase 04).

### D-03-10 — Wave structure: Wave 1 substrate (MetricBus + TimeSeriesStore + Registry refactor); Wave 2 features (Drift v2, Anomaly, Export, Overview)
**Why:** Wave 1 is the foundation every Wave 2 plan depends on. Within Wave 2, features are independent (Drift / Anomaly / Export / Overview don't touch each other) so they parallelize.
**How to apply:**
- **Wave 1**: Plan 03-01 (MetricBus + Zod schemas), Plan 03-02 (TimeSeriesStore + ring buffer), Plan 03-03 (Probe refactor). Sequential within wave (each depends on prior).
- **Wave 2**: Plan 03-04 (Drift v2), Plan 03-05 (Anomaly engine), Plan 03-06 (Report export), Plan 03-07 (Multi-org overview). Parallel.
- Total: 7 plans, 2 waves.

## Open questions (deferred, not blocking)

- **`pdfkit` vs server-side render**: `pdfkit` adds ~1.2 MB to extension bundle. Alternative: render PDF in WebView via a `<canvas>` + `jsPDF` then post the blob back to extension for save. **Default**: `pdfkit` (extension-side) — simpler; bundle hit absorbed by VSIX gzip + only loaded on Export click.
- **Persistence default**: should `TimeSeriesStore` default to disk-on or disk-off? **Default**: disk-off (memory-only) — opt-in via `monitor.persistTimeSeries: true` setting. Avoids surprising disk writes for first-time users.
- **Anomaly false-positive tuning**: 3σ might be too loose or too tight. **Default**: 3σ ship + a settings slider in v1.4 if user feedback flags it.
- **Pub/Sub events as a `MonitorProbe`**: Phase 05 CDC ships the Pub/Sub adapter. Is CDC just another probe? **Default**: keep CDC as its own pipeline with its own UI for now — fold into MetricBus retroactively in v1.4 if the abstraction holds up.

## Non-goals

- Replacing `AlertEngine` (v1.2.1) wholesale. AlertsPanel keeps the existing pipeline; anomaly events plug INTO it rather than replacing it.
- A new charting library. Recharts (already used) handles trend visualization. Phase 03 does not introduce ApexCharts / D3 / Visx.
- Querying Setup Audit Trail in Drift v2 — the API is metadata-restricted, deferred to v1.4.
- Server-side push for the Multi-org overview (would need a long-lived subscription per-org). Phase 03 polls; CDC + Pub/Sub stay confined to Phase 05.
- Stryker mutation tests on Monitor v2 modules (Phase 02 set the pattern; Phase 03 inherits it but doesn't re-baseline).

## Wave structure

- **Wave 1** — Plan 03-01 (MetricBus), 03-02 (TimeSeriesStore), 03-03 (MonitorProbe refactor). Sequential.
- **Wave 2** — Plan 03-04 (Drift v2), 03-05 (AnomalyEngine), 03-06 (Report export), 03-07 (Multi-org overview). Parallel.

Total: 7 plans, 2 waves.
