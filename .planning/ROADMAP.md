# Roadmap: SandForge v1.2.1 — Monitor Enrichment & Wiring

## Phase 01 — Backend Foundation: Limits Cache + Health Unification
**Requirements:** PERF-01, PERF-02, HEALTH-01, HEALTH-02, HEALTH-03, TREND-03
**Rationale:** Cache must exist before wiring new handlers (avoid multiplying API calls). Health scorer unification is a prerequisite for alert default rules (ALERT-01 needs the unified scorer). Trend job fix is small and blocks HEALTH-02 (trend feedback).

## Phase 02 — Wire Dead Services
**Requirements:** WIRE-01, WIRE-02, WIRE-03, WIRE-04, WIRE-05
**Rationale:** All 5 services already have full implementations + unit tests. This phase adds bridge handlers + UI panels. Depends on Phase 01 (cached /limits shared, HealthCheck uses unified scorer).

## Phase 03 — Alert System + Governance Wiring
**Requirements:** ALERT-01, ALERT-02, ALERT-03, ALERT-04, ALERT-05, GOV-01, GOV-02, GOV-03
**Rationale:** AlertEngine.evaluate() runs in the refresh cycle (needs Phase 01 cache). Default rules reference unified health thresholds. GovernanceEngine feeds into AlertEngine (GOV-03). Grouped because alerts and governance are two halves of the same threshold→notification pipeline.

## Phase 04 — Limits Coverage + Trends + UI Polish
**Requirements:** LIMITS-01, LIMITS-02, LIMITS-03, LIMITS-04, TREND-01, TREND-02
**Rationale:** New limit categories plug into the cached /limits response (Phase 01). Trend timestamp fix and historical export are independent UI improvements. Reset countdown is a standalone UI addition. All are leaf items with no downstream dependencies.

---

## Summary

| Phase | Name | Reqs | Depends On |
|-------|------|------|------------|
| 01 | Backend Foundation | 6 | — |
| 02 | Wire Dead Services | 5 | 01 |
| 03 | Alert System + Governance | 8 | 01 |
| 04 | Limits + Trends + Polish | 6 | 01 |

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
*Last updated: 2026-03-20*
