# Roadmap: SandForge v1.2.1 — Monitor Enrichment & Wiring

## Phase 01 — Backend Foundation: Limits Cache + Health Unification ✓
**Requirements:** PERF-01, PERF-02, HEALTH-01, HEALTH-02, HEALTH-03, TREND-03
**Completed:** 2026-03-20. 2 plans, 6 requirements delivered. /limits cache (30s TTL), UnifiedHealthScorer (linear interpolation + trend integration), job trend accumulator fix.

## Phase 02 — Wire Dead Services ✓
**Requirements:** WIRE-01, WIRE-02, WIRE-03, WIRE-04, WIRE-05
**Completed:** 2026-03-20. 2 plans, 5 requirements delivered. Bridge handlers for all 5 services (error logs, sessions, apex insights, sandbox refresh, health check) + 5 UI panels wired into MonitorPage with loading/empty/data states and co-located tests. 2293 webview tests passing.

## Phase 03 — Alert System + Governance Wiring ✓
**Requirements:** ALERT-01, ALERT-02, ALERT-03, ALERT-04, ALERT-05, GOV-01, GOV-02, GOV-03
**Completed:** 2026-03-21. 3 plans, 8 requirements delivered. AlertEngine + AlertStateStore (persistence, default definitions), MonitorOpsHandler alert handlers (ack/dismiss/list+history), GovernanceEngine + GovernancePolicyStore + GovernanceOpsHandler (CRUD + evaluate + templates + GOV-03 pipeline), AlertHistoryPanel timeline UI, GovernancePanelConnected bridge wiring, both integrated into MonitorPage.

## Phase 04 — Limits Coverage + Trends + UI Polish ✓
**Requirements:** LIMITS-01, LIMITS-02, LIMITS-03, LIMITS-04, TREND-01, TREND-02
**Completed:** 2026-03-21. 2 plans, 6 requirements delivered. Email/platform/file storage limits, reset countdown, real timestamps in TrendCharts (time-proportional x-positioning, multi-day format), historical CSV export via LimitExportButton.

---

## Summary

| Phase | Name | Reqs | Depends On |
|-------|------|------|------------|
| 01 | Backend Foundation ✓ | 6 | — |
| 02 | Wire Dead Services ✓ | 5 | 01 |
| 03 | Alert System + Governance ✓ | 8 | 01 |
| 04 | Limits + Trends + Polish ✓ | 6 | 01 |

**Total:** 4 phases, 25 requirements
**Parallelism:** Phases 02, 03, 04 can execute in parallel after Phase 01 completes.

## Completed Milestones

### v1.2.0 — Forge UX & Reliability
Completed 2026-03-20. 4 phases, 13 plans, 52 requirements delivered. See `.planning/milestones/v1.2.0-ROADMAP.md`.

### v1.1.0 — Stabilisation & Real-World Readiness
Completed 2026-03-19. 6 phases, 16 plans, 27 requirements delivered. See `.planning/milestones/v1.1.0-ROADMAP.md`.

### v1.0.0 — Marketplace-Ready Release
Completed 2026-03-17. 2 phases, 5 plans, 16 requirements delivered. See `.planning/milestones/v1.0.0-ROADMAP.md`.

---
*Last updated: 2026-03-21 (All phases complete -- v1.2.1 milestone done)*
