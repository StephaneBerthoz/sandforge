# Roadmap: SandForge

## Active Milestone: v1.2.0 — Forge UX & Reliability

52 items across 7 categories. 4 phases.

### Phase 01 — Bugs + Cleanup
**Goal:** Fix all broken behavior and remove dead code before building new features.
**Requirements:** BUG-01..09, CLN-01..06, BE-08
**Files:** ForgeHandler.ts, ForgeOrchestrator.ts, ForgeExecutor.ts, SeedOpsHandler.ts, SidePanel.tsx, LiveGraph.tsx, ForgeInput.tsx, ForgeResults.tsx, ForgeNodeDetail.tsx, ForgeExecution.tsx, ForgeDiscovery.tsx, LogStream.tsx, useForgeStore.ts, GraphDiscoveryService.ts, ForgeOpsHandler.ts (delete)
**Estimated plans:** 3 (bugs-critical, bugs-medium, cleanup)

### Phase 02 — UX Quick Wins + SidePanel Refonte
**Goal:** High-impact, low-effort UX improvements + full SidePanel redesign.
**Requirements:** UX-01..10, SP-01..06
**Files:** ForgeInput.tsx, ForgeDiscovery.tsx, SidePanel.tsx, OrgCard (new custom dropdown), useOrgStore.ts
**Estimated plans:** 3 (forge-input-ux, sidepanel-refonte, org-selection)

### Phase 03 — UX Enhancements + Performance
**Goal:** Medium-effort features (table view, log persistence, template management) + performance optimization pass.
**Requirements:** UX-11..23, PERF-01..06
**Files:** LiveGraph.tsx, ForgeDiscovery.tsx, ForgeExecution.tsx, ForgeResults.tsx, LogStream.tsx, useForgeStore.ts, new ForgeTableView.tsx
**Estimated plans:** 4 (table-view, log-improvements, results-enhancements, performance)

### Phase 04 — Backend Hardening + Accessibility
**Goal:** Production-grade error handling, enriched responses, ARIA compliance.
**Requirements:** BE-01..07, A11Y-01..07
**Files:** ForgeHandler.ts, HandlerTypes.ts, SeedOpsHandler.ts, GraphDiscoveryService.ts, ForgeComplianceService.ts, ForgeReview.tsx, LogStream.tsx, ProgressNode.tsx, ForgeNodeDetail.tsx
**Estimated plans:** 3 (backend-errors-timeouts, backend-features, accessibility)

---

## Completed Milestones

### v1.1.0 — Stabilisation & Real-World Readiness
Completed 2026-03-19. 6 phases (5 + 1 gap closure), 27 requirements delivered. See `.planning/milestones/v1.1.0-ROADMAP.md` for full details.

### v1.0.0 — Marketplace-Ready Release
Completed 2026-03-17. 2 phases, 16 requirements delivered. See `.planning/milestones/v1.0.0-ROADMAP.md` for full details.

---
*Last updated: 2026-03-20*
