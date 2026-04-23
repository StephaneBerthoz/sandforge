# SUMMARY — v1.3.0 Research Synthesis

**Milestone:** Hardening & Monitor v2
**Synthesized from:** STACK.md, FEATURES.md, ARCHITECTURE.md, PITFALLS.md

---

## Top 5 Strategic Recommendations

### 1. Ship Monitor v2 (time-series + drift) BEFORE AI
Gearset / Copado / Elements all trend metrics; SandForge today is snapshot-only. AI delivers 10x more value on top of `MetricBus` + `TimeSeriesStore` than without. Build the substrate first.

### 2. AI scope = EXPLAIN / DIAGNOSE, not GENERATE / EXECUTE
Defensible niche vs Copado/Gearset is in-editor contextual "this job failed, here's why" with **read-only** tools, Zod-validated output, user-approved actions. Do NOT compete on Apex code generation — Copado owns it, requires huge prompt/model investment.

### 3. Hardening foundations are non-negotiable
Adapters layer (centralize jsforce with `p-limit(8)` + backoff + Retry-After), Sentry + Pino, Knip in CI, Zod-validate every WebView message, SecretStorage for Anthropic/Salesforce tokens. Invisible to users, compounds every future phase.

### 4. Adopt CDC for real-time monitoring — unique differentiator
No developer-facing SF tool does in-editor real-time record monitoring (Shield/EventMon is licensed). Opt-in due to event-allocation cost. Ship on MetricBus with replay-ID persistence.

### 5. Rejected stack choices matter as much as accepted ones
- **NO** LangChain.js (heavy abstraction, community moved to direct SDKs)
- **NO** InversifyJS / tsyringe (decorator overhead — use composition root)
- **NO** Winston (Pino is 5–8x faster; JSON-native)
- **NO** ts-prune (dead project — Knip is strictly superior)
- **YES** Direct Anthropic SDK + `betaZodTool` + vanilla factory DI (modern 2026 consensus)

---

## Top 3 Technical-Debt Audit Targets

**A. Disposable hygiene** — every `EventEmitter` / `setInterval` / `onDid*` must be paired with a `Disposable` tracked in `context.subscriptions`. Memory leaks are the #1 cause of VSCode extension restarts (Claude Code v2.1.20 leaked to 11.6 GB, Copilot Chat crossed 4 GB).

**B. Salesforce concurrency** — combined load from monitor + sync + seed can exceed jsforce's 10-concurrent default and burn 429s. Needs `SalesforceAdapter` with `p-limit`, backoff, and Retry-After.

**C. WebView message schemas** — any `as MessageType` casts should become Zod-validated with `protocolVersion` envelope field. Any cross-milestone protocol change must bump version and reject mismatches gracefully.

---

## Recommended AI Integration Scope

**Build:**
- AI failure diagnosis for failed bulk jobs / deployments
- AI inline SOQL review (code action on selection)
- Read-only tools: `fetch_soql_preview`, `fetch_metadata`, `read_file`
- Guardrails: token budget per session, Zod-validated output, user-approve gate, circuit-breaker on 529

**Do NOT build:**
- Apex code generation
- Conversational chat over full org metadata (retrieval infra missing)
- Auto-apply AI edits (always diff + user confirm)
- Destructive tools (no `bulk_delete`, no free-form SOQL execute)
- Org-wide tech-debt scorecard (Elements.cloud owns it)

---

## Priority REQ Ordering (Phase assignment)

**Phase A — Hardening Foundations (REQ HARD-01..07)** — must land first
- HARD-01 `adapters/` folder + `SalesforceAdapter` (jsforce centralization)
- HARD-02 Composition root (`createServices`) + DI refactor
- HARD-03 Sentry + Pino end-to-end (opt-in telemetry)
- HARD-04 Knip in CI + dead-code cleanup pass
- HARD-05 Zod validation for all WebView messages + `protocolVersion` envelope
- HARD-06 SecretStorage for Anthropic + Salesforce tokens
- HARD-07 Disposable hygiene audit + leak-fix pass (1h soak test)

**Phase B — Monitor v2 Core (REQ MON-01..07)** — depends on A
- MON-01 `MetricBus` (EventEmitter) + typed events
- MON-02 `TimeSeriesStore` (rolling JSON with SQLite as stretch)
- MON-03 `MonitorProbe` interface + refactor existing trackers
- MON-04 Drift detection v2 (snapshot compare + diff viz)
- MON-05 Anomaly detection smarter thresholds (rolling std-dev)
- MON-06 Report export (PDF + CSV)
- MON-07 Multi-org overview tile (consolidated health across N orgs)

**Phase C — AI Integration (REQ AI-01..04)** — depends on A
- AI-01 `adapters/ai/` with Anthropic SDK + betaZodTool + circuit breaker
- AI-02 AI failure diagnosis flow (failed job → structured context → diagnosis)
- AI-03 AI inline SOQL review (code action with read-only tool use)
- AI-04 AI guardrails: token budget, prompt-injection delimiters, user-approve gate

**Phase D — CDC Real-Time Monitor (REQ CDC-01..02)** — depends on B
- CDC-01 Pub/Sub subscription adapter (opt-in, per-object) with replay-ID persistence
- CDC-02 Real-time record activity dashboard + 3-day retention warning

**Phase E — Test Hardening (REQ TEST-01..03)** — parallel with A/B
- TEST-01 Stryker mutation testing on shared + core modules
- TEST-02 fast-check property-based tests (ErrorClassifier, DiffEngine, GovernorLimitPredictor)
- TEST-03 Playwright E2E for 5 critical user flows

**Phase F — Best Practices & Polish (REQ BP-01..04)** — parallel with others
- BP-01 Zustand slice refactor (single store, 8 slices)
- BP-02 React error boundaries per-panel (module-scoped fallback)
- BP-03 AbortSignal propagation audit (streaming + bulk operations)
- BP-04 Bug bash pass on v1.2.x modules (community + personal backlog)

---

## Confidence

- **HIGH:** Phase A content, Phase B substrate, Phase C scope boundaries
- **MEDIUM:** Phase D CDC complexity (depends on jsforce Pub/Sub API maturity in 2026), Stryker wall-time
- **LOW:** None — all recommendations are ecosystem-standard in 2026

---

**Sources:** Anthropic SDK, Sentry OTel, Knip, Stryker, SF Inspector, Gearset, Copado, DevOps Center, Elements.cloud, VSCode DI patterns, Zustand slices, CDC Spring '26, Claude 529 handling, SF API rate limits 2026, Pino vs Winston 2026, React error boundaries 2026.
