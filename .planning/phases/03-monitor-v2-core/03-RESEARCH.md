# Phase 03 — Monitor v2 Core — Research

**Scope:** MON-01 (MetricBus), MON-02 (TimeSeriesStore), MON-03 (MonitorProbe refactor), MON-04 (Drift v2), MON-05 (AnomalyEngine), MON-06 (PDF/CSV export), MON-07 (multi-org overview).
**Written:** 2026-05-02 (autopilot; synthesized from `03-CONTEXT.md`, `audit-2026-05-02-cross-cutting.md`, ROADMAP, and a deep scan of `packages/extension/src/modules/monitor/`, `packages/extension/src/modules/compare/`, `packages/extension/src/core/`, `packages/shared/src/`).

---

## 1. Library choices (don't hand-roll)

### Event bus — Node EventEmitter via `TypedEventEmitter`
- **Choice:** Reuse the existing `packages/extension/src/core/common/TypedEventEmitter.ts`. Already battle-tested by `AutopilotExecutor`, `ForgeOrchestrator`. Provides typed `on(type, listener) → unsubscribe` + emit-error isolation (a throwing listener does not crash siblings) + `removeAllListeners()` for clean disposal.
- **Why here:** Plain `node:events.EventEmitter` is untyped — every listener has to cast its argument. `TypedEventEmitter<TEventMap>` is 47 lines, has its own tests (`TypedEventEmitter.test.ts`), and matches what the rest of the orchestrators already extend. The MetricBus is just one more `extends TypedEventEmitter<MetricEventMap>`.
- **DO NOT hand-roll** a new `MetricBus` class with its own `Map<event, Set<handler>>`. We already have that abstraction; reusing it keeps the codebase consistent and avoids two parallel emitter implementations to audit for leaks.
- **DO NOT** reach for `mitt`, `eventemitter3`, `nanoevents`, etc. Adds a new dep + bundles into the extension for the same shape we already own.

### Ring buffer — write a thin local class, NOT `mnemonist`
- **Choice:** Hand-roll a `RingBuffer<T>` (~30 lines) inside `TimeSeriesStore.ts` (or split as a sibling file). Use a head-index + capped JS array.
- **Why here:** `mnemonist` is 500 KB+ devDep with dozens of structures we don't need. The existing code already does FIFO trimming inline (`LimitsTracker.appendToHistory` shifts at `MAX_HISTORY_SIZE = 100`; `TrendStorage.trimToSizeLimit` does the same with a size cap). A typed `push(v): T | undefined` returning the evicted entry, plus `toArray()` and `range(fromTs, toTs)`, is < 50 lines.
- **DO NOT** import `mnemonist` or `circular-buffer` packages — pure overhead for one specialized use site.

### Std-dev / rolling-window math — write a tiny pure-function module
- **Choice:** New `packages/extension/src/modules/monitor/anomaly-math.ts` with `rollingMean(samples, windowMs, now): number`, `rollingStdDev(samples, windowMs, now, mean): number`, `zScore(value, mean, stdDev): number`. ~40 lines, pure.
- **Why here:** `simple-statistics` is ~80 KB and pulls in `Object.assign` polyfills and 30 functions we don't need. The math is textbook (Welford or two-pass). The codebase already has analogous in-house math: `GovernorLimitPredictor` does linear regression by hand in 25 lines (`linearRegression()`, `computeConfidence()` with R²); `trendUtils.ts` already does its own direction classification. Phase 02 added `monotoneNonDecreasingSnapshotsArb` arbitrary that maps directly onto the rolling-window inputs we need.
- **DO NOT** add `simple-statistics`, `mathjs`, or `d3-array` to extension deps. The whole AnomalyEngine should be pure-function, easily property-testable with reused fast-check arbitraries.

### PDF rendering — `pdfkit` (extension-side), confirmed
- **Choice:** Confirm `pdfkit` ^0.15 as a runtime dep (not devDep) on `packages/extension`.
- **Why here:** Extension-side keeps the PDF authoring authority where the data already lives (no need to round-trip the time-series back to webview). `pdfkit` is the canonical Node PDF lib (15+ years), zero native deps, streaming API (writes chunks → `vscode.workspace.fs.writeFile` consumes). Bundle hit ~1.2 MB raw, ~400 KB gzipped — absorbed by the VSIX. Lazy-loadable: `import('pdfkit')` only inside the export handler so cold activation isn't penalized.
- **Why NOT `jspdf` (in webview) + blob-postMessage**: requires base64-encoding the blob across the WebView bridge, which already has a strict envelope and a 1 MB-ish practical message size limit (large dashboards would hit it). Also `jspdf` font rendering for non-ASCII is poor — French/Japanese labels in our i18n files would mojibake.
- **DO NOT** consider headless Chromium / Puppeteer / wkhtmltopdf — orders-of-magnitude heavier and forbidden in a VSCode extension surface.

### CSV — reuse `papaparse` (webview package only) OR small backend writer
- **Pivot:** `papaparse` is currently in `packages/webview/package.json` ONLY (used by `useCsvImport`). The export emitter lives in the **extension** in `ReportExporter.ts`. Two options:
  - **Option A (recommended)**: write CSV in the extension by hand (`['header1','header2'].join(',') + '\n' + rows.map(r => r.map(escapeCsv).join(',')).join('\n')`). No new dep; ~15 lines including RFC 4180 quoting (`"` doubled, comma/quote/newline force quoting). The data shape is bounded (numeric + ISO dates + short labels) so escaping is trivial.
  - **Option B**: add `papaparse` to extension package deps too (~50 KB). Worth it only if we ship streaming CSV for huge ranges.
- **Recommendation:** Option A — defer Option B to v1.4 if Plan 03-06 finds the hand-written quoting a liability. Cite Phase 02 RESEARCH §1 ("DO NOT hand-roll … unless trivially small") — this fits the trivially-small bucket.
- **DEFER to plan-phase**: pick one. Plan 03-06 should make the call by counting expected export sizes; if any view exports > 50K rows, switch to papaparse.

### PDF charting — inline SVG sparklines, not `chartjs-node-canvas`
- **Choice:** Render a sparkline as an inline SVG `<polyline points="…">` string and embed via `pdfkit.svg()` (built-in SVG support since 0.13).
- **Why:** Recharts is webview-only (CONTEXT non-goal "no new charting library"). `chartjs-node-canvas` requires `node-canvas` which is a native binding (won't work in VSCode extension host on Windows without rebuild). Pure SVG strings render crisp at any zoom and are < 30 lines of math (normalize y to bbox + emit the path).

### What we are NOT adding this phase
- **`mnemonist`** — own ring buffer is < 50 LOC.
- **`simple-statistics` / `mathjs`** — anomaly math is < 50 LOC pure functions.
- **`mitt` / `nanoevents` / `eventemitter3`** — `TypedEventEmitter` already exists.
- **`pdfkit-table`** — over-abstracts PDF rendering; pdfkit primitives are sufficient.
- **`canvas` / `chartjs-node-canvas`** — native binding hell.
- **A new charting lib in webview** — non-goal per CONTEXT.
- **`d3` for sparklines** — already huge; we render 1 path/series.

---

## 2. Existing codebase patterns to respect

### Existing trackers (target of Plan 03-03 refactor)
All eight live in `packages/extension/src/modules/monitor/`. Each has paired `.test.ts`:

| Tracker | File | Public surface to preserve |
|---|---|---|
| LimitsTracker | `LimitsTracker.ts` | `fetch(orgId): Promise<LimitsSnapshot>`, `getSnapshot`, `getCriticalLimits`, `getHistory` (already has internal `MAX_HISTORY_SIZE = 100` ring) |
| JobMonitor | `JobMonitor.ts` | `fetch(orgId)` |
| ApexLogAnalyzer | `ApexLogAnalyzer.ts` | `fetch(orgId)` |
| SandboxRefreshTracker | `SandboxRefreshTracker.ts` | `fetch(orgId)` |
| ErrorLogMonitor | `ErrorLogMonitor.ts` | `fetch(orgId)` |
| UserSessionMonitor | `UserSessionMonitor.ts` | `fetch(orgId)` |
| HealthCheck | `HealthCheck.ts` | `computeHealth(orgId)` |
| GovernanceEngine | `GovernanceEngine.ts` | governance-policy evaluation |

**Pattern to apply:** introduce `MonitorProbe` interface (`{ id, intervalMs, run(orgId): Promise<MetricSample[]> }`); each existing class implements it via a thin adapter — body of `fetch()` stays untouched, results are mapped into `MetricSample[]` and emitted on `MetricBus`. Tests stay green because the public `fetch()` API is preserved.

### `MonitorOrchestrator.start()` parallel-fetch pattern (preserve)
- `MonitorOrchestrator.ts:64-70` already does `await Promise.all([…each fetch…])` per org. The new `MonitorRegistry` (Plan 03-03) replicates this — drives N probes per org via ONE scheduler tick, not N independent timers. Existing `Set<orgId>` activeOrgs guard pattern (`MonitorOrchestrator.ts:58`) carries over.

### `AlertEngine` — anomalies plug INTO it, not replacing
- `AlertEngine.ts:46-68` evaluates a metric+value+orgId against `Map<id, AlertDefinition>` with `cooldownMinutes`. Anomaly events from Plan 03-05 must produce an `AlertInstance` shape (`AlertEngine.createAlert()` builds it) so the existing UI panels (`AlertsPanel.tsx`, `AlertHistoryPanel.tsx`) render them with no UI change beyond a "anomaly" badge variant.
- **Reuse pattern:** AnomalyEngine emits `monitor:anomaly:detected`; a small bridging subscriber translates the event into a synthetic `AlertDefinition`-style match and calls `alertEngine.evaluate()` OR directly constructs an `AlertInstance` (preferred — shorter path, doesn't pollute definition store).
- **DO NOT replace** `AlertEngine` per CONTEXT non-goal #1.

### `SnapshotManager` (Compare module) — reused for Drift v2
- `packages/extension/src/modules/compare/SnapshotManager.ts` — in-memory `Map<id, OrgSnapshot>` with 30-day expiry, `createSnapshot`, `getSnapshots(orgId)`, `cleanExpired()`. Plan 03-04 (Drift v2) consumes existing snapshots; does NOT add a separate snapshot store.
- `DriftDetector.detect(orgId, baseline, current)` — current implementation is **object-level only** (added/removed component fullNames). Drift v2 extends it with `detectFieldDrift()` and `detectPermissionDrift()` returning richer deltas. Keep the existing `detect()` signature for backward compatibility.

### Persistence pattern — `ConfigStore` wrapper (NOT raw VSCode globalState)
- `TrendStorage.ts:26-67` and `AlertStateStore.ts:18-43` both follow the same shape: `category` constant + `prefix` constant + `configStore.get/set/delete`. New `TimeSeriesStore` opt-in disk persistence MUST follow that shape (use category `'monitor-ts'`).
- **Disk format:** JSON, gzip-optional. `TrendStorage` enforces 500 KB / 7 days / 15-min rate-limit per org — same caps for `TimeSeriesStore` persistence.

### Bridge envelope — `monitor:metric` Zod schema (Phase 01 contract)
- `packages/shared/src/bridge/protocolVersion.ts` exports `PROTOCOL_VERSION = 1`. The broker rejects mismatched envelopes after 3 consecutive bad ones. `messageSchemas.ts` builds domain unions via `msg(type)` helper.
- `packages/shared/src/types/messages.types.ts` already defines 15+ `monitor:*` types (lines 580–1488). Adding `monitor:metric`, `monitor:metric:subscribe`, `monitor:drift:detected`, `monitor:anomaly:detected`, `monitor:fleet:summary[:response]` follows the existing `BaseMessage` interface + literal-string `type` discriminant pattern.
- **MUST DO:** add Zod entries in `messageSchemas.ts` for every new monitor message type. Phase 01 added the audit comment "If a new message type is introduced, add it to the matching domain union". `monitor:` schema is already a discriminated union — extend it.

### `TypedEventEmitter` listener-isolation contract
- `TypedEventEmitter.emit()` wraps each listener in try/catch and logs via `logger.warn` (`TypedEventEmitter.ts:30-39`). MetricBus inherits this for free — a misbehaving Drift subscriber cannot crash the Anomaly subscriber.

### Existing `setInterval` pattern (timer cleanup)
- `ConnectionPool` (cleanupTimer + recycleTimer), `OperationScheduler`, `SyncScheduleExecutor`, `OfflineManager`, `OrgHealthProbe` all use the same shape: `private timer: ReturnType<typeof setInterval> | undefined`. Phase 01 verify-work flagged any new timer must be paired with a `dispose()` that clears it. `MonitorRegistry` follows the same shape.
- **Existing test pattern:** `vi.useFakeTimers()` + `vi.advanceTimersByTime(N)` is used by `CacheManager.test.ts`, `OperationScheduler.test.ts`. Reuse for `MonitorRegistry` tests.

### CoreServices DI contract
- `services.ts:26-37` defines `CoreServices`. `MonitorOrchestrator` already accepts an optional `services` (`MonitorOrchestrator.ts:38`). Plan 03-03 / 03-04 / 03-05 / 03-06 / 03-07 all need `services.salesforce`, `services.telemetry`, `services.storage`. Pass them in via `MonitorDependencies` — the optional `services` member is the path.
- `OrchestratorFactories.monitorOrchestrator` is the `(deps) => new MonitorOrchestrator(deps)` factory. Phase 03 must NOT add a separate `metricBus` to `Services` — instead, expose it as a singleton ON `MonitorOrchestrator` (same way AlertEngine is wired).

### E2E harness pattern (E2EHarness.tsx)
- `packages/webview/src/pages/E2EHarness/E2EHarness.tsx:249-270` shows the `?e2e-harness=monitor` mode — a finite-event harness for Playwright. New specs (Drift Feed, Multi-org overview) reuse this pattern. `MockBridge.respondToNext()` is the canonical pattern (cf Phase 02 P-02.7/P-02.8).

### Reusable fast-check arbitraries (from Phase 02)
- `packages/extension/src/test/arbitraries.ts` already exposes `limitsSnapshotArb`, `orderedSnapshotsArb`, `monotoneNonDecreasingSnapshotsArb`, `apiLimitArb`. These are EXACTLY what Plan 03-05 (AnomalyEngine) needs to property-test the rolling-std-dev math:
  - "for any monotone-non-decreasing sequence, anomaly count is bounded by N − warmup window"
  - "for any sequence, sum of (anomaly + nominal) classifications equals input length"
- **DO NOT** rebuild these. Add 2-3 new arbitraries (`metricSampleArb`, `permissionDeltaArb`) that compose with the existing ones.

---

## 3. Phase 03-specific pitfalls

### P-03.1 — TimeSeriesStore memory blow-up at 5+ orgs (HIGH)
**Symptom:** With 7-day retention, 30-second cadence, 100 series/org, 5 connected orgs → `5 × 100 × 7 × 24 × 120 = 1,008,000` samples in RAM. At ~80 bytes per `MetricSample`, that's ~80 MB — exceeds the 50 MB cap stated in CONTEXT D-03-2.
**Root cause:** Naive `Map<seriesId, MetricSample[]>` without per-series capacity sizing × org-count multiplication.
**Prevention:**
- Cap per-series capacity at `ceil((7 * 24 * 60 * 60 * 1000) / intervalMs)` so a 30-second probe holds 20,160 samples max; a 5-minute probe holds 2016.
- LRU evict whole `(orgId)` partitions when total estimated bytes > 50 MB. Estimate via `samples.length * APPROX_BYTES_PER_SAMPLE = 96`; recompute on each `record()` call cheaply.
- Aggressive defaults: probes that fire faster than 30s (none today) need explicit cap override.
- Tests: a property test (`fc.array(metricSampleArb, { minLength: 50_000 })`) asserts ring eviction keeps `store.size` ≤ capacity.
- **Stat watchpoint:** add a `getStats()` method returning `{ totalSamples, estimatedBytes, perOrgBytes }` so the existing `vscode.window.createOutputChannel('SandForge')` can log a one-line summary every 5 minutes — early warning before OOM.

### P-03.2 — Drift v2 noise: every describe diff is NOT a drift event (HIGH)
**Symptom:** Salesforce describes return Pending CustomObject IDs that change without semantic meaning, ordering of `permissionsRead` collections varies between calls, `lastModifiedDate` ticks on every Setup save. A naive deep-diff floods the timeline with false positives.
**Root cause:** Object describe responses are not stable shapes — reordering and metadata-noise fields drift on every fetch.
**Prevention:**
- **Allowlist of comparison fields per type**: `CustomField` → `[type, length, picklistValues, required, externalId]`; `PermissionSet` → `[name, fieldPermissions, objectPermissions]`; `Profile` → same as PermissionSet. Skip `lastModifiedDate`, `lastModifiedById`, `systemModstamp`, `urls`, `attributes`.
- **Canonical sort**: sort `picklistValues` by `value`, sort `fieldPermissions` by `field` BEFORE diffing. Use `microdiff` (already a `@sandforge/shared` dep, lines 19 of shared package.json) on the canonicalized projection.
- **Debounce**: emit only one `monitor:drift:detected` event per `(orgId, snapshotPair)` per 60s. The event itself batches all deltas detected in that window.
- **Threshold filter**: a `DriftDelta` with `< 1%` of fields touched on a `CustomObject` is informational; only emit the event if it's a `breaking` or `permission` change. Plan 03-04 should expose a settings slider.
- Tests: property test with `componentMapArb` (existing arbitrary): "for any pair of identical canonical projections, `detectFieldDrift` returns []".

### P-03.3 — AnomalyEngine false positives at startup (HIGH)
**Symptom:** First 24h after install, `TimeSeriesStore` has < 24h of samples — std-dev is computed over a tiny n, anything looks anomalous, alert panel floods on day 1.
**Root cause:** Insufficient warmup window; std-dev with n < 5 is meaningless.
**Prevention:**
- **Warmup gate:** AnomalyEngine REFUSES to emit until `samples.length ≥ MIN_SAMPLES_FOR_BASELINE = 30` AND `(latest.ts - oldest.ts) ≥ MIN_BASELINE_SPAN_MS = 6 * 60 * 60 * 1000` (6 hours). Below either, return null.
- **Sigma scale-up at low n:** even after warmup, multiply the threshold by `1 + (1 / sqrt(n))` for n < 100 to widen the band on small samples (textbook small-sample correction).
- **Persistence-aware:** if disk persistence is on (CONTEXT D-03-2 opt-in), rehydrate samples on activate so warmup doesn't reset every time the user reopens VSCode.
- **Telemetry:** log via `services.telemetry.addBreadcrumb` whenever an anomaly is suppressed by warmup — gives us field data for tuning.
- Tests: property — "for any sequence with `length < MIN_SAMPLES_FOR_BASELINE`, anomaly count = 0".

### P-03.4 — PDF generation memory pressure on large ranges (MEDIUM)
**Symptom:** User exports a 7-day × 100-series PDF; pdfkit accumulates the entire doc in memory, balloons to 200 MB+, extension host OOMs.
**Root cause:** pdfkit's `doc.text()` etc. buffer until `doc.end()`. For multi-page reports with many tables, the buffer grows unbounded.
**Prevention:**
- **Stream to disk, not to buffer:** `const stream = fs.createWriteStream(filePath); doc.pipe(stream); … doc.end();` — pdfkit emits chunks as you go.
- **Cap series per PDF:** if `series.length > 50`, paginate and add a "Continued in part 2" footer; refuse to render a 100-series PDF in one shot.
- **Downsample sparklines:** 7 days × 30s cadence = 20,160 points per series. SVG sparkline at 800 px wide can show ~800 distinct columns. Use bucket-min-max downsampling (LTTB algorithm — 30 lines, well-known) before emitting the polyline.
- **Progress reporting:** per CONTEXT non-goal, no streaming; but for export we can still post a `monitor:export:progress` event so the user sees a spinner.
- Tests: integration test that exports a 1000-sample × 5-series fixture and asserts file written + < 10 MB output.

### P-03.5 — Multi-org overview spawns N parallel jsforce connections (HIGH)
**Symptom:** `monitor:fleet:summary` polls every 60s for 10 connected orgs; each call independently acquires a jsforce connection → bursts of 10 simultaneous connection setups, each running its own auth refresh, hitting Salesforce login rate limits.
**Root cause:** Naive `Promise.all(orgs.map(o => salesforce.fetchHealth(o)))` without using the connection pool.
**Prevention:**
- **Reuse `ConnectionPool`** (`packages/extension/src/core/connection/ConnectionPool.ts`). Pool already enforces `maxConnections = 10`, `maxPerOrg = 5`, `keepAliveInterval = 60_000`, idle eviction. The fleet handler MUST `pool.acquire(orgId, ...)` not construct new jsforce instances.
- **`p-limit`** (already a dep, `packages/extension/package.json:303`): wrap fleet poll in `pLimit(3)` so at most 3 health probes run concurrently — same semantic as the existing `sandforge.sync.maxConcurrentOps` setting.
- **Cache fleet response for 60s** in `MonitorOrchestrator.healthCache: Map<orgId, OrgHealthStatus>`. The poll is "if cache miss OR stale, refetch".
- **Backoff on per-org failure:** if org X errors twice in a row, double its interval (60 → 120 → 240) and surface a "stale" badge in the overview row instead of red-banner-everywhere.
- **Audit cross-ref:** this is the `M1` reviewer finding (visibility-gated polling) slotted into Phase 03 per audit doc lines 30-33. When `document.hidden` (webview-side), DO NOT post the 60s tick.

### P-03.6 — Probe scheduling drift when collapsing N timers into 1 (MEDIUM)
**Symptom:** Old code used `setInterval(fetch, 60_000)` per tracker. New `MonitorRegistry` runs ONE `setInterval(tickAll, 1_000)` and dispatches probes whose `nextRunAt ≤ Date.now()`. If a probe's `run()` takes 10s, the next tick may fire on top of the still-running run — back-pressure or duplicated runs.
**Root cause:** Single-scheduler tick rate × probe overrun = race.
**Prevention:**
- **Per-probe in-flight gate:** `Map<probeId, Promise>` — tick checks `if (inFlight.has(probeId)) return`.
- **Tick rate vs probe rate:** scheduler ticks at `min(probe.intervalMs) / 4` clamped to `[1s, 10s]`. For our cadences (30s — 5min), that's a 1s tick.
- **Drift accounting:** `nextRunAt = lastFinishedAt + intervalMs` (NOT `lastStartedAt + intervalMs`) so a slow run doesn't compound.
- **Visibility-gated polling (audit M1):** when `document.hidden` (forwarded by webview via a new `monitor:visibility` message), tick rate falls to 30s and skips low-priority probes. Critical probes (limits, errors) still tick.
- **Hard timeout per probe:** `Promise.race([probe.run(orgId), timeout(30_000)])`. Probe that hangs gets killed and logged.
- Tests: `vi.useFakeTimers()` + a probe whose `run()` returns a 5-tick-delayed Promise — assert no duplicate run dispatched.

### P-03.7 — Cross-cutting findings carried into Phase 03 (audit doc lines 28-33)
The 2026-05-02 audit slotted four items into Phase 03 — Plans MUST address:

| ID | Description | Plan that owns it |
|---|---|---|
| **Perf #1** | `describeFields` cache miss on target org — ForgeExecutor calls `deps.describeFields(targetOrgId, ...)` twice per object without caching | Folds into Plan 03-03 (Probe refactor) — introduce `services.salesforce.describeCache` lookup to be reused by both Forge AND Drift v2 (which will call describes for permissions) |
| **M1** | CDC polling without `document.visibilitychange` pause | Plan 03-07 (multi-org overview) implements `document.hidden` gate; Plan 03-03 shares the visibility-gating mechanism |
| **M5 (subset)** | `useGrappeStore.partitions` Map → Record (also Perf #11) | Apply to new monitor stores (`useMonitorMetricsStore`, `useFleetStore`) — never use Map values inside Zustand state (referential equality issue) |
| **H7** | `BridgeProvider` mount-only `useEffect` | Plan 03-07 boot batching: `monitor:fleet:summary` request must be dispatched after `bridge:hello` round-trip, NOT in `useEffect(() => …, [])` directly |

Each Plan 03-XX must explicitly cite which audit ID it picks up + the file changed, mirroring how Phase 02 plans reported their TEST-DELTA.

### P-03.8 — Discriminated-union exhaustiveness in MetricEvent (MEDIUM)
**Symptom:** Adding a new `MetricEvent` subtype tomorrow (e.g. CDC events in Phase 05) without updating the bus subscribers — TypeScript silently widens to `unknown`, runtime drops events.
**Prevention:**
- Define `MetricEvent` in `packages/shared/src/monitor/MetricEvent.ts` as `discriminatedUnion('type', [LimitsEvent, JobEvent, ApexEvent, …])` AND export a `MetricEventTypeMap` that the bus is parameterized on.
- Use TS `never` exhaustiveness check in any switch over `event.type` (`assertNever(event)` helper). Mutation testing (Stryker) WILL catch this — cf Phase 02 P-02.10 — so guard early.
- Mirror with Zod: `MetricEventSchema` in `messageSchemas.ts` so wire-format validation matches TS types. Phase 01 envelope contract requires it.

### P-03.9 — `monitor:metric` event flood across the WebView bridge (MEDIUM)
**Symptom:** 100 series × 30s emit rate → 100 events/30s = 3.3 events/sec across the bridge. Webview re-renders on every event. Animation jank.
**Prevention:**
- **Coalesce events**: extension-side `MetricBus` accumulates emits over a 250 ms window into a single `monitor:metrics:batch` payload.
- **Subscribe by type-prefix only:** the webview subscribes to `monitor:metric:limits.apiRequests`, not the firehose.
- **Per-panel `data-testid` props remain stable across events** — render-coalescing won't swap testids that Phase 02 specs depend on.

### P-03.10 — Persistence rehydration race (LOW)
**Symptom:** TimeSeriesStore loads from disk on activate; first probe.run() fires before rehydration finishes; new sample inserted into stale Map.
**Prevention:**
- `await store.rehydrate()` BEFORE `MonitorRegistry.start()`. Synchronous in `services.ts` activation path.
- If rehydrate fails (corrupt JSON), reset the store + emit a one-time `monitor:persist:corrupted` notification + telemetry breadcrumb. DO NOT throw — Monitor must keep running.

---

## 4. Cross-references

### What Phase 03 prepares for downstream phases
- **Phase 04 (AI Integration):** AI Diagnose narrates anomalies. The exact contract is `services.ai.narrateAnomaly(event: AnomalyDetectedEvent): Promise<string>`. Plan 03-05 must expose `monitor:anomaly:detected` events with all fields needed for narration: `{ orgId, seriesId, samples, mean, stdDev, zScore, recentContext: MetricSample[10] }`.
- **Phase 05 (CDC Real-Time Monitor):** CONTEXT D-03 open question Q4 says "fold CDC into MetricBus retroactively in v1.4 if abstraction holds". For Phase 03, just keep `MetricEvent` extensible (discriminated union) — DO NOT close the type by writing a giant `enum`.
- **Phase 06 (Best Practices & Polish):** Phase 06 picks up the wider audit backlog (C1, C5, H1, H3, etc.). Phase 03 picks up only Perf #1, M1, M5, H7 (audit lines 28-33). The line is sharp — DO NOT widen Phase 03 scope to include AI prompt-injection (RT-#10/#11) or AI provider stub (C1) — those are Phase 04 / Phase 06.

### What NOT to build (mirroring CONTEXT non-goals)
- ❌ Replacement of `AlertEngine` — it stays. Anomalies plug INTO it.
- ❌ A new charting library — Recharts handles all visualization.
- ❌ Setup Audit Trail in Drift v2 — metadata-restricted, deferred to v1.4.
- ❌ Server-side push for fleet overview — pure 60s poll.
- ❌ Stryker mutation re-baseline on Monitor v2 modules — inherit Phase 02 thresholds.
- ❌ Real-time CDC events as MetricBus events — Phase 05 keeps its own pipeline.

---

## 5. Test strategy notes

### Stryker scope
- `stryker.conf.json` already includes `packages/extension/src/modules/monitor/**/*.ts` (line 16) — **NO config change needed for Phase 03 scope.** New files (MetricBus, TimeSeriesStore, MonitorRegistry, AnomalyEngine, ReportExporter, etc.) automatically enter the mutation set.
- **CAUTION:** the existing `mutate` glob is broad. Phase 03 introduces ~7 new modules. The Stryker wall-time may rise above the 45-min CI cap (Phase 02 P-02.1). Plan 03-01 / 03-02 should run a one-shot `pnpm stryker:incremental` against just the new file as a smoke test before merging.
- Exclusion candidates (constants-heavy, low mutation value): `MetricEvent.ts` if it's just type literals.

### fast-check arbitraries to reuse
| Arbitrary | Plan that consumes | Property |
|---|---|---|
| `limitsSnapshotArb` | 03-02 (TimeSeriesStore) | "for any random snapshot stream, ring buffer never exceeds capacity" |
| `orderedSnapshotsArb` | 03-05 (AnomalyEngine) | "rolling mean is monotonic with respect to insertion order" |
| `monotoneNonDecreasingSnapshotsArb` | 03-05 (AnomalyEngine) | "no anomaly when sequence is monotone within stdDev" |
| `apiLimitArb` | 03-02 | "samples in same series share series ID" |
| `componentMapArb` | 03-04 (Drift v2) | "diff of identical canonical projections is empty" |

### New arbitraries to add (`arbitraries.ts`)
- `metricSampleArb`: `{ ts: Date.toISOString, seriesId: string, value: float, orgId: string, tags?: dict }`
- `permissionDeltaArb`: `{ profile, object, field, beforePerms, afterPerms }`
- `driftEventArb`: composed from the above.

### Playwright E2E specs
Two new specs justified for Phase 03 user-facing surfaces:
- **`monitor-fleet-overview.spec.ts`** (Plan 03-07): mock 3 orgs, assert overview renders 3 health gauges + drill-down click navigates to single-org dashboard.
- **`monitor-drift-feed.spec.ts`** (Plan 03-04): mock a Drift event stream (3 events, finite — re-using P-02.9 mitigation), assert virtualized rows render + filter chips toggle visibility.

The existing `monitor-dashboard-refresh-export.spec.ts` (Phase 02) already exercises the export button. **No need to add a Phase 03 export spec** — extend mock fixtures instead.

PDF/CSV export is BACKEND — no Playwright spec, just unit tests in `ReportExporter.test.ts`.

### Vitest patterns
- Use `vi.useFakeTimers()` for `MonitorRegistry` (consistent with `OperationScheduler.test.ts`).
- For TimeSeriesStore, use real timers but pass an injected `now: () => number` clock for determinism.
- For AnomalyEngine, pure functions — no timers, no mocks beyond `TimeSeriesStore` stubs.

---

## 6. Recommended approach (opinionated default for plan-phase)

**Wave 1 (sequential — substrate):**
1. **Plan 03-01 — MetricBus + Zod schemas.** Extend `TypedEventEmitter`. Add `MetricEvent` discriminated union to `packages/shared/src/monitor/`. Add to `messageSchemas.ts`. Wire into `MonitorOrchestrator` as a singleton field. Test: `TypedEventEmitter`-style listener-isolation tests + Zod round-trip tests.
2. **Plan 03-02 — TimeSeriesStore.** Hand-rolled `RingBuffer<MetricSample>` with capacity derivation `ceil(7d / intervalMs)`. Disk persistence opt-in via `monitor.persistTimeSeries: true` setting. Bytes estimator + 50 MB LRU cap. Property tests with `metricSampleArb`. Rehydrate-before-start in `services.ts`.
3. **Plan 03-03 — MonitorProbe refactor.** Introduce `MonitorProbe` interface, `MonitorRegistry` with single-tick scheduler. Each existing tracker gets a thin wrapper. Public `fetch()` API preserved. Visibility gating + per-probe inflight gate + hard timeout. Address audit Perf #1 (describe cache) here.

**Wave 2 (parallel — features):**
4. **Plan 03-04 — Drift v2.** Extend `DriftDetector` with `detectFieldDrift` + `detectPermissionDrift`. Allowlist + canonical sort + 60s debounce. New `DriftFeed.tsx`. New Playwright spec.
5. **Plan 03-05 — AnomalyEngine.** Pure-function `anomaly-math.ts`. Warmup gate (30 samples / 6h). Plug into `AlertEngine` via synthetic `AlertInstance`. Property tests with reused arbitraries.
6. **Plan 03-06 — ReportExporter.** `pdfkit` (lazy-imported), inline-SVG sparklines, LTTB downsampling, hand-rolled CSV. Stream PDF to disk. Cap at 50 series/PDF.
7. **Plan 03-07 — Multi-org overview.** `MonitorOverviewPage.tsx` + `monitor:fleet:summary` handler. Reuse `ConnectionPool`, `p-limit(3)`, 60s cache. Visibility-gated polling. Address audit M1, M5, H7 here.

**Total deps added:**
- Runtime: `pdfkit ^0.15` (extension only, lazy-imported).
- DevDep: none new beyond Phase 02.
- No `mnemonist`, no `simple-statistics`, no `mitt`, no `chartjs-node-canvas`.

---

## 7. Confidence

- **HIGH:** TypedEventEmitter reuse, ConnectionPool reuse, fast-check arbitrary reuse, Stryker scope unchanged, audit-finding mapping, AlertEngine non-replacement.
- **MEDIUM:** pdfkit memory ceiling on 7-day exports (mitigated via streaming + LTTB + series cap), Drift v2 noise threshold tuning (CONTEXT defers settings slider to v1.4), MetricBus event-flood coalescing window of 250 ms (may need tightening based on observed render jank).
- **LOW:** anomaly warmup window of 30 samples / 6h — first-week field data may show this is too tight or too loose; expose as constants from day one. PDF font rendering for non-Latin scripts (i18n locales include `ja.json`, `pt-BR.json`) — pdfkit ships with Helvetica only; need to embed a Unicode font (~250 KB) if i18n PDF labels are required. **DEFER to plan-phase**: decide if PDF export must be i18n on day one (recommended: NO — English-only labels for v1.3.0; i18n PDFs in v1.4).

---

## 8. References

- `.planning/phases/03-monitor-v2-core/03-CONTEXT.md` (D-03-1 through D-03-10)
- `.planning/audit-2026-05-02-cross-cutting.md` (audit findings — 11 closed, 4 slotted into Phase 03 lines 28-33, 17 slotted into Phase 06)
- `.planning/phases/02-test-hardening/02-RESEARCH.md` (structure mirror; arbitraries inventory)
- `packages/extension/src/core/common/TypedEventEmitter.ts` (canonical event-bus pattern)
- `packages/extension/src/core/connection/ConnectionPool.ts` (fleet-poll connection reuse target)
- `packages/extension/src/modules/monitor/{MonitorOrchestrator,AlertEngine,LimitsTracker,TrendStorage,GovernorLimitPredictor,trendUtils}.ts` (refactor targets)
- `packages/extension/src/modules/compare/{SnapshotManager,DriftDetector}.ts` (Drift v2 dependencies)
- `packages/extension/src/test/arbitraries.ts` (fast-check reuse base)
- `packages/shared/src/bridge/{protocolVersion,messageSchemas}.ts` (envelope contract)
- `packages/shared/src/types/messages.types.ts` (existing `monitor:*` type registry; lines 580–1488)
- `stryker.conf.json` (`mutate` glob already covers `monitor/**`)
