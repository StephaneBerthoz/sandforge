# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-20)

**Core value:** Sandbox provisioning and data management must be reliable, safe, and fast
**Current focus:** v1.2.0 — Forge UX & Reliability (52 items across 4 phases)

## Current Position

Phase: 04 — Backend Hardening + Accessibility (IN PROGRESS)
Plan: 01-01 COMPLETE, 01-02 COMPLETE, 01-03 COMPLETE, 02-01 COMPLETE (UX-01..05, UX-07..10), 02-02 COMPLETE (UX-06), 02-03 COMPLETE (SP-01..06), 03-01 COMPLETE (UX-11, UX-20, UX-21, UX-22), 03-02 COMPLETE (UX-13, UX-14, UX-17, UX-18, UX-19), 03-03 COMPLETE (UX-12, UX-15, UX-16, UX-23), 03-04 COMPLETE (PERF-01..06), 04-01 COMPLETE (BE-01, BE-03, BE-04, BE-05)
Status: Phase 04 in progress — plan 04-01 done
Last activity: 2026-03-20 — Plan 04-01 completed (Structured error payloads, timeouts, lifecycle events, operationId)

Progress: [######░░░░] ~40%

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
- setConfig clears stale plan/complianceReport/metadataDiffs/result but preserves graph/templates/history
- canPreview variable removed; condition inlined in preview button disabled prop
- LogStream hideFilterBar prop controls internal filter tab visibility
- extractSalesforceDomain uses first subdomain segment for URL-to-org matching
- UX-01 auto-select useEffect uses empty deps with eslint-disable for mount-only behavior
- sameOrgSelected derived variable exposed at component level for canDiscover guard
- ForgeTableView uses fireEvent.click (not fireEvent.change) for checkbox toggle tests due to jsdom behavior
- Search auto-select in graph view uses useEffect with first case-insensitive match on objectApiName
- ForgeInput template Tabs.Content uses forceMount + CSS hidden for JSDOM test compat and persistent form state
- OrgDropdown uses containerRef click-outside pattern with sorted connected-first org list
- LiveGraph topologyKey uses sorted node names + edge keys for stable Dagre layout caching
- LogStream filterEntries returns readonly LogEntry[] — no spread copy for "all" case
- Flex-based adaptive heights use min-h-[Npx] fallback for unconstrained parents
- sendHandlerError optional code/retryable params with backward-compatible defaults (code='UNKNOWN', retryable=false)
- planGenerator.generate() wrapped in Promise.resolve() for TimeoutManager compatibility (sync to async)
- Duplicate execute errors use sendHandlerError with code='DUPLICATE' instead of raw buildResponse

### Pending Todos

(None)

### Blockers/Concerns

(None)

## Session Continuity

Last session: 2026-03-20
Stopped at: Phase 04 plan 04-01 complete, ready for 04-02
Resume file: None
