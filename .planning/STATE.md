# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-20)

**Core value:** Sandbox provisioning and data management must be reliable, safe, and fast
**Current focus:** v1.2.1 — Monitor Enrichment & Wiring

## Current Position

Phase: 02 in progress
Plan: 02-01 complete
Status: Phase 02 plan 01 done (WIRE-01..05 backend wiring). Plan 02-02 next.
Last activity: 2026-03-20 — Plan 02-01 complete (backend handler wiring)

Progress: [###.......] 32%

## Performance Metrics

**Velocity:**
- Total plans completed: 37 (v1.2.1: 3 + v1.2.0: 13 + v1.1.0: 16 + v1.0.0: 5)
- Average duration: ~15 min/plan
- Total execution time: ~8.5h

## Milestone History

### v1.2.0 — Forge UX & Reliability
Completed: 2026-03-20
Phases: 4
Requirements delivered: BUG-01..09, UX-01..23, PERF-01..06, BE-01..08, CLN-01..06, SP-01..06, A11Y-01..07
Key achievements: Fixed all Forge execution bugs (abort/pause/resume wired end-to-end, dryRun honored, dynamic object resolution). Delivered 23 UX improvements (auto-org detection, table view, log persistence, ETA, template CRUD, node search). Full SidePanel refonte (compact mode, improved org switcher, collapsible metrics). Performance pass (Dagre layout separation, KPI memoization, adaptive heights). Backend hardening (structured errors, timeouts, lifecycle events, compliance wiring, real bulk IDs). Accessibility pass (ARIA tablist, aria-pressed, role="log", radiogroup, contrast fixes). 7149 tests passing.

### v1.1.0 — Stabilisation & Real-World Readiness
Completed: 2026-03-19
Phases: 6 (5 + 1 gap closure)
Requirements delivered: BRG-01..04, MOD-01..08, AI-01..03, UX-01..05, GHO-01..03, ROB-01..04, MON-01..03
Key achievements: CorrelationId bridge infrastructure, all 8 modules functional end-to-end, ghost feature cleanup, Bulk API 2.0 + retry logic, competitor benchmark + 5 Monitor feature gaps, dashboard refresh UX with error recovery. 7042 tests passing.

### v1.0.0 — Marketplace-Ready Release
Completed: 2026-03-17
Phases: 2 (E2E Testing + Marketplace Publication)
Requirements delivered: E2E-01 through E2E-07, MKT-01 through MKT-09
Key achievements: 162 E2E tests, WCAG 2.1 AA, GitHub Actions CI, published on Marketplace.

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.

- NoOpHandler returns {success: false, comingSoon: true} for ghost feature types
- GraphDiscoveryDeps requires describeGlobal dep (resolveRootObject is now async)
- ForgeHandler.isPaused removed (dead code, pause/resume now delegated to ForgeOrchestrator)
- SeedOpsHandler dryRun branch placed after production guard, before insert logic
- setConfig clears stale plan/complianceReport/metadataDiffs/result but preserves graph/templates/history
- LogStream hideFilterBar prop controls internal filter tab visibility
- LiveGraph topologyKey uses sorted node names + edge keys for stable Dagre layout caching
- sendHandlerError optional code/retryable params with backward-compatible defaults
- OrgDropdown uses containerRef click-outside pattern with sorted connected-first org list
- ReviewComplianceTab sends compliance request via useEffect on framework/graph/config change
- Bulk ID fallback uses bulk-{jobId}-{i} format (includes jobId) for traceability
- MonitorOpsHandler limitsCache uses vi.hoisted pattern for test mocking (single unified mock per module path per file)
- UnifiedHealthScorer replaces both HealthScoreCalculator and OrgHealthScoreCalculator (linear interpolation, trend penalties, optional dimensions)
- handleRefresh health calculation moved after orgInfo fetch for metadata dimension support
- Monitor service query functions capture handler context for lazy connection resolution
- SandboxRefreshTracker omits onRefreshDetected callback (Pitfall 9)
- HealthCheck providers reuse limitsCache and errorLogMonitor cache for zero-cost signals
- handleRefresh includes orgHealthStatus from HealthCheck.computeHealth (WIRE-05)

### Pending Todos

(None)

### Blockers/Concerns

(None)

## Session Continuity

Last session: 2026-03-20
Stopped at: Plan 02-01 complete, ready for plan 02-02
Resume file: None
