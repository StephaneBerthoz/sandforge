# Roadmap: SandForge v1.1.0

**Milestone:** v1.1.0 — Stabilisation & Real-World Readiness
**Phases:** 5
**Requirements:** 27 (all mapped)

## Phases

### Phase 1 — Bridge Wiring Fix ✓ Complete (2026-03-17)

**Goal:** Make BridgeProvider listen for ALL response messages and add reliable request/response correlation.
**Requirements:** BRG-01, BRG-02, BRG-03, BRG-04

### Phase 2 — Module Execution Fixes ✓ Complete (2026-03-17)

**Goal:** Every module works end-to-end with real Salesforce orgs.
**Requirements:** MOD-01, MOD-02, MOD-03, MOD-04, MOD-05, MOD-06, MOD-07, MOD-08, AI-01, AI-02, AI-03

### Phase 3 — UX Cleanup & Ghost Features ✓ Complete (2026-03-18)

**Goal:** Clean, coherent user experience with no dead features or broken buttons.
**Requirements:** UX-01, UX-02, UX-03, UX-04, UX-05, GHO-01, GHO-02, GHO-03

### Phase 4 — Robustness

**Goal:** Handle real-world scale and failure modes gracefully.

**Requirements:** ROB-01, ROB-02, ROB-03, ROB-04

**Scope:**
- Bulk API 2.0 for Seed/Sync when records > 200
- Exponential backoff retry (max 3) for transient Salesforce API errors
- Configurable timeout for describe operations on large orgs
- Field-type validation before Sync upsert

**Dependencies:** Phase 2 (modules must work before hardening)

### Phase 5 — Monitor Enrichment

**Goal:** Make Monitor best-in-class compared to existing Salesforce monitoring tools.

**Requirements:** MON-01, MON-02, MON-03

**Scope:**
- Research: Salesforce Inspector, ORGanizer, Salesforce Org Monitor, DevOps Center
- Identify top 5 feature gaps
- Implement gaps (likely: real-time limit refresh, storage breakdown, deployment timeline, setup audit trail, API usage analytics)
- Polish dashboard refresh UX

**Dependencies:** Phase 1-2 (monitor wiring must work first)

---

## Completed Milestones

### v1.0.0 — Marketplace-Ready Release
Completed 2026-03-17. 2 phases, 16 requirements delivered. See `.planning/milestones/v1.0.0-ROADMAP.md` for full details.

---
*Roadmap created: 2026-03-17*
