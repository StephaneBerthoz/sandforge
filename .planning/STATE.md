# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-20)

**Core value:** Sandbox provisioning and data management must be reliable, safe, and fast
**Current focus:** v1.2.0 — Forge UX & Reliability (52 items across 4 phases)

## Current Position

Phase: 01 — Bugs + Cleanup (in progress)
Plan: 01-01 COMPLETE (BUG-01, BUG-02, BUG-03, BUG-06), 01-02 COMPLETE (BUG-04, BUG-05, BUG-07, BUG-08, BUG-09)
Status: Executing
Last activity: 2026-03-20 — Plan 01-02 completed (5 UI bug fixes)

Progress: [###░░░░░░░] ~20%

## Performance Metrics

**Velocity:**
- Total plans completed: 21 (v1.1.0: 16 plans + v1.0.0: 7 plans = 23 total across milestones, 21 for v1.1.0)
- Average duration: ~15 min/plan
- Total execution time: ~5h

## Milestone History

### v1.2.0 — Forge UX & Reliability
Started: 2026-03-20
Phases: 4
Requirements: 52 (BUG-01..09, UX-01..23, PERF-01..06, BE-01..08, CLN-01..06, SP-01..06, A11Y-01..07)
Focus: Fix all Forge bugs, deliver polished UX, SidePanel refonte, performance + backend hardening, accessibility

### v1.1.0 — Stabilisation & Real-World Readiness
Completed: 2026-03-19
Phases: 6 (5 + 1 gap closure)
Requirements delivered: BRG-01..04, MOD-01..08, AI-01..03, UX-01..05, GHO-01..03, ROB-01..04, MON-01..03
Key achievements: CorrelationId bridge infrastructure, all 8 modules functional end-to-end, ghost feature cleanup, Bulk API 2.0 + retry logic, competitor benchmark + 5 Monitor feature gaps, dashboard refresh UX with error recovery. Gap closure: buildResponse migration for all 16 handlers (122 calls), Phase 05 verified. 7042 tests passing.

### v1.0.0 — Marketplace-Ready Release
Completed: 2026-03-17
Phases: 2 (E2E Testing + Marketplace Publication)
Requirements delivered: E2E-01 through E2E-07, MKT-01 through MKT-09
Key achievements: 162 E2E tests, WCAG 2.1 AA, GitHub Actions CI, published on Marketplace.

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.

- NoOpHandler returns {success: false, comingSoon: true} for ghost feature types
- monitor:health-score kept in types (has UI consumer in OrgHealthPanel.tsx despite missing handler route)
- RealTimeSyncPanel simplified to static preview (removed hooks/state) since feature is unavailable
- RetryableOperation uses manual retry loop (not RetryStrategy.execute) to support non-retryable error short-circuit
- FieldTypeValidator defines own FieldDescriptor types (independent from SchemaValidator.FieldSchema per Pitfall 4)
- BulkApiExecutor abstracts jsforce via typed interfaces (BulkJobHandle, BulkApiConnection) for testability
- ConfigStore.get() takes only key param (no category). Robustness config stored under key 'robustness:config'
- DataSync field validation is opt-in via targetFieldDescriptors in deps (preserves backward compat)
- getRobustnessConfig() loads per-request (not at construction) so runtime config changes apply immediately
- StorageBreakdownPanel uses EntityDefinition.RecordCount SOQL for per-object record counts
- DeploymentTimeline queries DeployRequest directly (not DeploymentTracker) for richer data
- Badge component requires wrapper span for data-testid (does not spread extra HTML props)
- Button variant "outline" does not exist — use "secondary" instead
- GraphDiscoveryDeps requires describeGlobal dep (resolveRootObject is now async)
- ForgeHandler.isPaused removed (dead code, pause/resume now delegated to ForgeOrchestrator)
- SeedOpsHandler dryRun branch placed after production guard, before insert logic

### Pending Todos

(None)

### Blockers/Concerns

(None)

## Session Continuity

Last session: 2026-03-20
Stopped at: Plan 01-01 complete, ready for plan 01-02
Resume file: None
