# Roadmap: SandForge v1.3.0 — Hardening & Monitor v2

## Phase 01 — Hardening Foundations ✓ verifying (2026-04-24)
**Goal:** Invisible-but-compounding plumbing. Adapter layer, observability, dead-code cleanup, Zod guardrails, secret migration, leak audit — everything that makes later phases safer and easier.

**Requirements:** HARD-01, HARD-02, HARD-03, HARD-04, HARD-05, HARD-06, HARD-07

**Status:** 4/4 plans shipped (01-01 adapters, 01-02 knip, 01-03 DI composition root, 01-04 bridge hardening). 45 atomic commits. Test count 8320 → 8412 (+92). Verdict `human_needed` — full 1h soak + dev-mode smoke pending manual UAT. See `.planning/phases/01-hardening-foundations/01-VERIFICATION.md`.

**Success criteria:**
- [x] All new Salesforce paths route through `adapters/salesforce/`; gradual migration of legacy jsforce callers deferred per plan
- [x] `createServices(context)` returns fully wired `Services`; zero `new Orchestrator()` inside extension.ts business paths (narrowed grep = 0)
- [x] Sentry + Pino active, opt-in gated on `vscode.env.isTelemetryEnabled` + `telemetry.telemetryLevel`
- [x] `pnpm knip` runs in CI (non-blocking, artifact uploaded)
- [x] 14 Zod discriminated-union schemas + envelope with `protocolVersion = 1` enforced at broker
- [x] SecretStorage migration runner wired, idempotent, tested
- [ ] 1h soak heap diff < 50 MB growth — 1-min smoke verified (+19.46 MB); full 1h deferred to manual/nightly

**Depends on:** — (no dependencies)

## Phase 02 — Test Hardening
**Goal:** Raise confidence floor for every other phase. Mutation score and property-based coverage on pure modules; E2E smoke for critical user flows.

**Requirements:** TEST-01, TEST-02, TEST-03

**Success criteria:**
- Stryker mutation score ≥ 60% on `packages/shared/` + Monitor core
- fast-check invariants pass on ErrorClassifier, DiffEngine, GovernorLimitPredictor, DeltaDetector
- 5 Playwright E2E specs green in CI

**Depends on:** — (can run parallel with Phase 01)

## Phase 03 — Monitor v2 Core
**Goal:** Replace snapshot-only Monitor with time-series, drift-aware, event-driven substrate. Table-stake features (historical trending, drift, anomaly, export, multi-org overview) to reach competitive parity with Gearset/Copado/Elements for the in-editor audience.

**Requirements:** MON-01, MON-02, MON-03, MON-04, MON-05, MON-06, MON-07

**Success criteria:**
- `MetricBus` with typed events replaces direct tracker-to-tracker calls
- `TimeSeriesStore` persists 7 days, ring buffer caps memory
- All existing trackers refactored into `MonitorProbe` implementations
- Drift v2 captures field/object/permission deltas with UI visualization
- Rolling-std-dev anomaly detection reduces false-positive rate vs static thresholds
- PDF + CSV report export works for any dashboard view
- Multi-org overview lists N orgs with health status + drill-down

**Depends on:** 01 (adapters + DI, Zod schemas)

## Phase 04 — AI Integration
**Goal:** Defensible AI niche — in-editor EXPLAIN/DIAGNOSE with read-only tools, Zod-validated output, user-approved actions. Explicitly not a code generator (Copado owns that).

**Requirements:** AI-01, AI-02, AI-03, AI-04

**Success criteria:**
- `AIAdapter` with Anthropic SDK, betaZodTool, circuit-breaker on 529, AbortController wired
- Failed job → structured context → diagnosis flow works end-to-end with user-approve gate
- SOQL code action returns analysis + optimizations without auto-applying
- Token budget enforced per session; prompt-injection defense via context delimiters verified via adversarial test

**Depends on:** 01 (adapters/ai, SecretStorage for key, Zod validation)

## Phase 05 — CDC Real-Time Monitor
**Goal:** Unique differentiator no other dev-facing SF tool ships — real-time record activity inside VSCode via Pub/Sub API, opt-in with clear event-allocation warnings.

**Requirements:** CDC-01, CDC-02

**Success criteria:**
- Pub/Sub subscription via jsforce with replay-ID persistence per org
- Event-allocation check on startup with >80% warning
- Live event feed in WebView with 3-day retention banner and virtual scrolling
- Reconnect-after-suspend reconciles gaps with UI warning

**Depends on:** 03 (MetricBus, WebView event feed component reuse from v1.2.3 CDC)

## Phase 06 — Best Practices & Polish
**Goal:** Apply lessons from audits: slice the store, boundary errors, propagate aborts everywhere, kill backlog bugs. Ship-ready close-out phase.

**Requirements:** BP-01, BP-02, BP-03, BP-04

**Success criteria:**
- Zustand split into 8 slices; no component uses raw `useStore`
- Each major panel has its own error boundary with "Reload panel" action
- AbortSignal propagated through every > 100ms async call; server-side Bulk abort verified
- MUST-FIX bugs from bash all closed; NICE-TO-HAVE triaged into v1.4

**Depends on:** 01 (leak audit context), runs in parallel with 03/04 for BP-01/BP-02, final pass for BP-03/BP-04

---

## Summary

| Phase | Name | Reqs | Depends On | Parallelism |
|-------|------|------|------------|-------------|
| 01 | Hardening Foundations | 7 | — | Can run parallel with 02 |
| 02 | Test Hardening | 3 | — | Can run parallel with 01 |
| 03 | Monitor v2 Core | 7 | 01 | After 01 |
| 04 | AI Integration | 4 | 01 | Parallel with 03 |
| 05 | CDC Real-Time Monitor | 2 | 03 | After 03 |
| 06 | Best Practices & Polish | 4 | 01, 03, 04 | Final close-out |

**Total:** 6 phases, 27 requirements
**Parallelism:** Phase 01 + 02 can run concurrently. Phase 03 + 04 can run concurrently after Phase 01. Phase 05 after 03. Phase 06 is the final pass.

## Completed Milestones

### v1.2.3 — Scale & Complete
Completed 2026-04-23. 7 phases, 18 plans, 50 requirements delivered. Shipped on VS Code Marketplace as v1.2.4. See `.planning/milestones/v1.2.3-ROADMAP.md`.

### v1.2.2 — Adoption-First: Sync & Seed Polish
Completed 2026-03-26. 6 phases, 10 plans, 30 requirements delivered. See `.planning/milestones/v1.2.2-ROADMAP.md`.

### v1.2.1 — Monitor Enrichment & Wiring
Completed 2026-03-26. 4 phases, 9 plans, 25 requirements delivered. See `.planning/milestones/v1.2.1-ROADMAP.md`.

### v1.2.0 — Forge UX & Reliability
Completed 2026-03-20. 4 phases, 13 plans, 52 requirements delivered. See `.planning/milestones/v1.2.0-ROADMAP.md`.

### v1.1.0 — Stabilisation & Real-World Readiness
Completed 2026-03-19. 6 phases, 16 plans, 27 requirements delivered. See `.planning/milestones/v1.1.0-ROADMAP.md`.

### v1.0.0 — Marketplace-Ready Release
Completed 2026-03-17. 2 phases, 5 plans, 16 requirements delivered. See `.planning/milestones/v1.0.0-ROADMAP.md`.

---
*Last updated: 2026-04-23 — v1.3.0 milestone roadmap defined (6 phases, 27 requirements).*
