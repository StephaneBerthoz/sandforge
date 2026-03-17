# Roadmap: SandForge v1.1.0

**Milestone:** v1.1.0 — Stabilisation & Real-World Readiness
**Phases:** 5
**Requirements:** 27 (all mapped)

## Phases

### Phase 1 — Bridge Wiring Fix

**Goal:** Make BridgeProvider listen for ALL response messages and add reliable request/response correlation.

**Requirements:** BRG-01, BRG-02, BRG-03, BRG-04

**Scope:**
- Audit every handler response type → register listeners in BridgeProvider
- Add correlationId to message protocol (shared types + broker + hooks)
- Update useBridgeQuery/useBridgeMutation to use correlationId
- Log unhandled messages as warnings
- This phase is the foundation — all subsequent module fixes depend on it

**Dependencies:** None (first phase)

### Phase 2 — Module Execution Fixes

**Goal:** Every module works end-to-end with real Salesforce orgs.

**Requirements:** MOD-01, MOD-02, MOD-03, MOD-04, MOD-05, MOD-06, MOD-07, MOD-08, AI-01, AI-02, AI-03

**Scope:**
- Fix Seed: wire `seed:execute:response` listener
- Fix Sync: correct response type mismatch (`sync:execute:response` not `operation:completed`)
- Fix Forge: wire `forge:discover:response`, `forge:execute:response`, `forge:progress`
- Fix Autopilot: wire `autopilot:schema-result`, `autopilot:plan-ready`, `autopilot:node-progress/completed/failed`
- Fix Compare: wire `compare:execute:response`
- Fix Monitor: wire all `monitor:*:response` types
- Fix DataOps: wire all `dataops:*:response` types
- Fix AI: add `ai:status` query on mount, persist conversations, clear "not configured" guidance

**Dependencies:** Phase 1 (bridge wiring must be in place)

### Phase 3 — UX Cleanup & Ghost Features

**Goal:** Clean, coherent user experience with no dead features or broken buttons.

**Requirements:** UX-01, UX-02, UX-03, UX-04, UX-05, GHO-01, GHO-02, GHO-03

**Scope:**
- Remove Grappe from Sidebar.tsx (keep GrappeProgressPanel overlay)
- Wire notifications bell onClick in TopBar
- Dynamic version in StatusFooter from package.json
- Auto-select first connected org in useOrgStore
- Design and implement empty states with CTA for all modules
- Audit messages.types.ts: remove types with no handler, remove dead handler code
- Clean ghost features: audit:*, governance:*, scheduler:*, team:*, realtime:*

**Dependencies:** Phase 2 (modules must work before polishing UX)

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
