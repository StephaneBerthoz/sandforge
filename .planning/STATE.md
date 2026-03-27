# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-26)

**Core value:** Sandbox provisioning and data management must be reliable, safe, and fast
**Current focus:** v1.2.3 — Scale & Complete

## Current Position

Phase: 05 — Seed Extensions (CSV + Clone)
Plan: 05-03 complete (CSV Import UI)
Status: Plan 05-03 delivered 3 tasks: FileDropZone + useCsvImport, CsvColumnMapper + CsvPreview + CsvValidationPanel, CsvUploadWizard + SeedPage mode selector.
Last activity: 2026-03-27 — Plan 05-03 executed (CSV Import UI)

Progress: [######----] 57% (4/7 phases)

## Performance Metrics

**Velocity:**
- Total plans completed: 72 (v1.2.3: 12 + v1.2.2: 10 + v1.2.1: 9 + v1.2.0: 13 + v1.1.0: 16 + v1.0.0: 5 + pre-v1: 7)
- Average duration: ~15 min/plan
- Total execution time: ~12h

## Milestone History

### v1.2.2 — Adoption-First: Sync & Seed Polish
Completed: 2026-03-26
Phases: 6
Requirements delivered: QSYNC-01..06, SWIZ-01..06, STPL-01..06, SQUAL-01..05, QSEED-01..03, ONBO-01..04
Key achievements: Quick Sync 3-click flow with smart defaults and auto-field mapping. Quick Seed 1-click from template gallery. 3 pre-built seed templates + 3 sync templates. Locale-aware data generation (6 locales), geo-coherent addresses, VR-aware generation. Wizard reduced from 7 to 6 steps. Sandbox onboarding with guided first-step cards. 7623 tests passing.

### v1.2.1 — Monitor Enrichment & Wiring
Completed: 2026-03-26
Phases: 4
Requirements delivered: WIRE-01..05, ALERT-01..05, HEALTH-01..03, LIMITS-01..04, PERF-01..02, TREND-01..03, GOV-01..03
Key achievements: Wired 5 dead backend services end-to-end with UI panels. Full alert system (default rules, persistence, VSCode notifications, history timeline). Unified health scorer with trend feedback and linear interpolation. Expanded limits coverage (email, platform events, file storage, reset countdown). API caching (/limits 30s TTL, OrgInfo 5min). Real timestamps in trends + CSV export. Governance CRUD + evaluate + AlertEngine pipeline.

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

- cron-parser v5 uses `CronExpressionParser.parse()` API (not v4's `parseExpression()`)
- NotificationCenter uses positional args `(level, title, message)` not object pattern
- Fixed ExportFormat duplicate export between sync.types.ts and reporting.types.ts
- Added getVscodeApi() non-hook export to useVSCodeApi.ts for Zustand store postMessage access
- buildCdcChannel uses `__c` -> `__ChangeEvent` (not `slice(0,-1)+'e'`) to match actual Salesforce CDC naming
- Ring buffer for CDC events uses module-level state for perf, Zustand exposes ordered array view
- CDCEventFeed tests mock VirtualList (jsdom has no layout engine for tanstack/react-virtual)
- CDC metrics i18n keys placed under `sync.realtime.metricsPanel.*` to match existing namespace
- Sparkline uses inline SVG polyline (no external lib), polling interval ID as module-level var
- Renamed shared FieldDiff to ConflictFieldDiff to avoid collision with compare.types.ts FieldDiff
- Added CDCReplicator.setOnConflict() for post-creation callback wiring by orchestrator
- ConflictResolutionPanel tracks field resolutions in local React state (not Zustand) to avoid polluting global state
- Added sync.tabs.* i18n keys that were missing from en.json/fr.json (SyncPage was using them via fallback)
- CSV Import UI uses FileReader (not File.text()) for jsdom test compatibility
- SeedPage mode selector uses local React state (not persisted); always starts at mode selection
- useCsvImport auto-map uses case-insensitive, underscore-tolerant matching against apiName and label
- CsvValidationPanel "Proceed Anyway" gated by <10% error rate threshold

### Pending Todos

(None)

### Blockers/Concerns

(None)

## Session Continuity

Last session: 2026-03-27
Stopped at: Plan 05-03 (CSV Import UI) complete. Plans 05-01, 05-02, 05-03 done. Plans 05-04 may be in progress (parallel).
Resume file: .planning/ROADMAP.md
