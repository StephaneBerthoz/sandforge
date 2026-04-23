# Requirements: v1.3.0 — Hardening & Monitor v2

## v1 — Must Ship

### Hardening Foundations (HARD-01..07)

- [ ] **HARD-01** — Adapters layer: `packages/extension/src/adapters/{salesforce,ai,telemetry,storage,fs}/`; `SalesforceAdapter` centralizes jsforce with `p-limit(8)`, exponential backoff (2→4→8→16s, cap 60s), `Retry-After` honoring, `/limits` pre-check with >80% pause
- [ ] **HARD-02** — Composition root: `createServices(context)` factory in `extension.ts` returning typed `Services` object; orchestrators accept services via constructor injection (no `new` inside business logic)
- [ ] **HARD-03** — Observability stack: `@sentry/node` (extension host) + `@sentry/browser` (webview) opt-in via VSCode `telemetry.telemetryLevel`; `pino` structured logs with redaction (authorization, apiKey, accessToken); release health tag from package.json version
- [ ] **HARD-04** — Knip in CI: `pnpm knip` as non-blocking report initially; dead-code cleanup pass on flagged exports; orphan file removal
- [ ] **HARD-05** — Zod validation for ALL WebView messages: audit MessageRouter, add missing schemas, reject messages with `protocolVersion` mismatch via user-friendly "reload to apply" flow
- [ ] **HARD-06** — SecretStorage migration: Anthropic API key + all OAuth tokens move to `context.secrets.store/get`; never `globalState` for secrets; migration helper for existing users
- [ ] **HARD-07** — Disposable hygiene audit: every `EventEmitter`, `setInterval`, `onDidChange*`, `onDidReceiveMessage` tracked in `context.subscriptions`; 1h soak test baseline + post-run heap diff; fix identified leaks

### Monitor v2 Core (MON-01..07)

- [ ] **MON-01** — `MetricBus` EventEmitter: in-process typed pub/sub for metric events; all probes publish, all consumers subscribe; replaces direct method calls between trackers
- [ ] **MON-02** — `TimeSeriesStore`: rolling JSON persistence (SQLite as stretch after benchmark); ring buffer for in-memory recent points (last 1000 per metric); 7-day retention on disk; query API with range + downsampling
- [ ] **MON-03** — `MonitorProbe` interface: `{ id, collect(ctx): Promise<Metric[]> }`; refactor existing ErrorLogMonitor, UserSessionMonitor, ApexLogAnalyzer, SandboxRefreshTracker, HealthCheck into probes; `MonitorOrchestrator` becomes a probe registry
- [ ] **MON-04** — Drift detection v2: store org-metadata snapshot, compute diff on demand, visualize changed fields/objects/permissions; complements existing Compare module with time-based snapshots
- [ ] **MON-05** — Anomaly detection smarter thresholds: replace static percentage thresholds with rolling std-dev over 7-day window; per-metric sensitivity config; reduced false-positive rate
- [ ] **MON-06** — Report export: PDF (via jsPDF) + CSV export of Monitor dashboard; includes time-series charts as rendered SVG embedded in PDF
- [ ] **MON-07** — Multi-org overview tile: consolidated health dashboard across all connected orgs; list view with status indicators; drill-down to single-org dashboard

### AI Integration (AI-01..04)

- [ ] **AI-01** — `adapters/ai/` with Anthropic SDK: direct `@anthropic-ai/sdk` + `betaZodTool`; circuit breaker (3 consecutive 529 → disable 5min); distinguish 429 vs 529 in UI copy; `AbortController` wired to "Cancel" button
- [ ] **AI-02** — AI failure diagnosis flow: on failed bulk job/deployment, build structured context (job JSON, debug log tail, ErrorClassifier verdict, SchemaAnalyzer output), call Anthropic with read-only tools `[fetch_soql_preview, fetch_metadata, read_file]`, return Zod-validated diagnosis with proposed fix; render in WebView with "Apply fix" code action
- [ ] **AI-03** — AI inline SOQL review: code action on SOQL selection in VSCode editor; AI explains query, flags anti-patterns (SELECT *, missing WHERE, bind var issues), suggests optimization; never auto-applies, always shows diff
- [ ] **AI-04** — AI guardrails: token budget per session (default 50K input, configurable); prompt-injection defense via `<context>...</context>` delimiters with instruction wrapper; all tool outputs validated; user confirmation required before ANY model-proposed action; SOQL tool validates via parser and blocks DML

### CDC Real-Time Monitor (CDC-01..02)

- [ ] **CDC-01** — Pub/Sub subscription adapter: `adapters/salesforce/CdcSubscriber.ts` using jsforce Streaming/Pub-Sub API; opt-in per user with event-allocation warning (`PlatformEventUsageMetric` > 80% → banner); replay-ID persisted to globalState per org
- [ ] **CDC-02** — Real-time record activity dashboard: live event feed with virtual scrolling; 3-day retention window explicit in UI; reconnect-after-suspend with gap warning; batched WebView postMessage (150ms)

### Test Hardening (TEST-01..03)

- [ ] **TEST-01** — Stryker mutation testing: `@stryker-mutator/core` + `@stryker-mutator/vitest-runner`; scoped to `packages/shared/` + core/monitor pure modules (skip WebView React); target mutation score ≥ 60%
- [ ] **TEST-02** — fast-check property-based tests: cover ErrorClassifier, DiffEngine, GovernorLimitPredictor, DeltaDetector with generator-based invariants
- [ ] **TEST-03** — Playwright E2E critical paths: 5 flows: (1) seed AI persona → execute, (2) quick sync with conflict → resolve, (3) monitor dashboard refresh → export, (4) CDC subscription → event received, (5) AI diagnose failed job → apply fix

### Best Practices (BP-01..04)

- [ ] **BP-01** — Zustand slice refactor: single store split into 8 slices (org, monitor, seed, sync, compare, ai, ui, telemetry); each slice in own file with `StateCreator<Root, [], [], SliceShape>`; export selector hooks, never raw `useStore`
- [ ] **BP-02** — React error boundaries per-panel: `react-error-boundary` wrapping each major route (Monitor/Seed/Sync/Compare/DataOps/Automation/AI); module-scoped fallback UI with "Reload panel" action; logs boundary catches to Sentry
- [ ] **BP-03** — AbortSignal propagation audit: every async call >100ms must accept and propagate `AbortSignal`; on abort during Bulk job, call Salesforce abort endpoint server-side; `AbortError` logged at info level not error
- [ ] **BP-04** — Bug bash pass: 48h community bug collection (GitHub issues + personal backlog); triage into MUST-FIX / NICE-TO-HAVE / DEFER; fix all MUST-FIX before release

## v2 — Next Milestone Candidates

- [ ] SQLite TimeSeriesStore migration (after rolling-JSON benchmark results)
- [ ] Full conversational AI with retrieval over org metadata
- [ ] Plugin system for user-contributed monitor probes
- [ ] OpenAI / local-model fallback for AI adapter
- [ ] AI-generated test cases for Seed data
- [ ] Cost/license usage tracking (sandbox refresh frequency, storage trending)
- [ ] Metadata dependency blast-radius analyzer (light version of Elements.cloud feature)
- [ ] OTEL direct tracing (beyond Sentry's OTel integration)

## Out of Scope

- Full DevOps pipeline / CI-CD orchestration (DevOps Center / Copado / Gearset own this)
- Managed test generation for Apex (Copado AI owns this, model investment huge)
- Org-wide technical-debt scorecard (Elements.cloud owns this)
- Threat / security event monitoring (Shield / Event Monitoring, compliance minefield)
- Visual flow / process designer
- Public-facing shareable dashboards (requires backend, SandForge stays local-only)
- User-facing credential vault / SSO hub (VSCode SecretStorage is the boundary)
- Automatic refactor of user code with AI (blast-radius risk — AI proposes, user applies)
