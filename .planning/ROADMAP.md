# Roadmap: SandForge v1.2.3 — Scale & Complete

## Phase 01 — Enterprise Foundation & Polish
**Requirements:** SCALE-01, SCALE-02, SCALE-05, SCALE-06, POLISH-01, POLISH-02, POLISH-03, POLISH-04, POLISH-05, POLISH-06
**Why first:** Foundation work that every subsequent phase benefits from. Pagination, virtual scrolling, and skeleton screens improve all list views. Error recovery and cache management prevent issues during heavy CDC/scheduling features. Progress granularity needed before wiring more execution flows.

**Scope:**
- Install @tanstack/react-virtual, create reusable Pagination component
- Virtual scrolling on DataTable, object selectors, any 1000+ list
- Skeleton screens replacing all remaining spinners
- Keyboard shortcuts for module navigation and actions
- Notification center panel (centralized alerts/completions/errors)
- Error recovery UI with retry/backoff
- Per-object live progress bars (Bulk API 2.0 job progress)
- Cache audit: TTLs, org-switch invalidation, memory limits

## Phase 02 — Sync History & Scheduling
**Requirements:** HIST-01, HIST-02, HIST-03, HIST-04, HIST-05, SCHED-01, SCHED-02, SCHED-03, SCHED-04, SCHED-05
**Why second:** Sync history is a prerequisite for meaningful scheduling (schedules need a history log). Both extend the existing Sync module with persistence and time-based features. Uses pagination/virtual scrolling from Phase 01.

**Scope:**
- Sync execution logger (persist to ConfigStore)
- History list UI (paginated table) + detail view + re-run + export
- Cron schedule UI (visual builder + raw input + timezone)
- Schedule management panel (list, pause/resume, delete)
- Wire OperationScheduler with cron-parser for execution
- Schedule persistence + restart survival
- Schedule notifications (VSCode + opt-in desktop)

## Phase 03 — CDC Real-Time Sync
**Requirements:** CDC-01, CDC-02, CDC-03, CDC-04, CDC-05, CDC-06
**Why third:** Depends on virtual scrolling (Phase 01) for event feed and history infrastructure (Phase 02) for logging CDC events. Biggest backend hardening effort — 4 bugs to fix + replay persistence + watchdog.

**Scope:**
- Fix CDCListener.buildChannels() custom object bug (share monitor module's logic)
- Fix RealTimeSyncOrchestrator false positive event applied status
- Persist replay IDs to ExtensionContext.globalState
- Add watchdog reconnection on sleep/wake
- Add handler cleanup on stop (prevent memory leaks)
- Event batching (100-200ms window) + ring buffer on WebView
- CDC subscription UI (object picker, start/stop, status indicator)
- Live event feed with virtual scrolling
- Auto-sync toggle per-object with conflict strategy
- CDC metrics dashboard (throughput, lag, counters)

## Phase 04 — Conflict Resolution UI
**Requirements:** CONFLICT-01, CONFLICT-02, CONFLICT-03, CONFLICT-04, CONFLICT-05
**Why fourth:** Depends on CDC (Phase 03) for real-time conflict generation and sync history (Phase 02) for logging resolutions. Needs microdiff library for structured diffing.

**Scope:**
- Install microdiff for structured record diffing
- Conflict detection feed with count badge on sync results
- Conflict list view (paginated, filterable by object/type)
- Side-by-side diff viewer with per-field highlighting + base value
- Per-field resolution (pick source/target/edit) + bulk actions
- Apply resolutions to target org + log to sync history

## Phase 05 — Seed Extensions (CSV + Clone)
**Requirements:** CSV-01, CSV-02, CSV-03, CSV-04, CLONE-01, CLONE-02, CLONE-03, CLONE-04
**Why fifth:** Independent from sync features. Uses existing BulkApiManager and RecordIdRemapper. CSV uses papaparse (already installed). Clone is the most net-new feature (no backend exists).

**Scope:**
- CSV upload UI (file picker, drag-and-drop, preview, header detection)
- Column mapping with auto-match and type compatibility
- CSV validation (inline errors)
- CSV execution via Seed pipeline
- Clone source picker (org + objects + SOQL filter)
- Clone record fetcher (paginated, relationship-ordered)
- Clone relationship remapper (RecordIdRemapper)
- Clone execution with per-object results + ID mapping

## Phase 06 — AI Personas & Smart Actions
**Requirements:** PERSONA-01, PERSONA-02, PERSONA-03, PERSONA-04, SIMPLE-01, SIMPLE-02, SIMPLE-03, SIMPLE-04
**Why sixth:** Polish features that enhance the UX on top of all other work. Personas use existing AIPersonaManager. Smart actions need all prior features to exist as destinations.

**Scope:**
- Persona gallery UI (card grid, industry icons, locale badges)
- Persona preview (5 sample records)
- Persona customization (field weights, distributions)
- Persona application to Seed wizard
- Smart action recommender (analyze org state → suggest action)
- "Just Do It" mode (auto-detect best action, one click)
- Adaptive wizard (fewer steps for small, grouping for large)
- Contextual help tooltips

## Phase 07 — Streaming Execution & Background Ops
**Requirements:** SCALE-03, SCALE-04
**Why last:** Final scaling pass. Streaming execution (100K+ records) is the most architecturally complex feature. Background execution requires careful lifecycle management. All other features should be stable before this optimization pass.

**Scope:**
- Chunked sync pipeline for 100K+ records (2000/chunk, memory-efficient)
- Background execution: operations continue when WebView hidden
- Notification on background completion
- Memory profiling and optimization pass

---

## Summary

| Phase | Name | Reqs | Depends On |
|-------|------|------|------------|
| 01 | Enterprise Foundation & Polish | 10 | — |
| 02 | Sync History & Scheduling | 10 | 01 |
| 03 | CDC Real-Time Sync | 6 | 01, 02 |
| 04 | Conflict Resolution UI | 5 | 02, 03 |
| 05 | Seed Extensions (CSV + Clone) | 8 | 01 |
| 06 | AI Personas & Smart Actions | 8 | 01, 05 |
| 07 | Streaming Execution & Background | 2 | 01, 02, 03 |

**Total:** 7 phases, 50 requirements (v1 scope: 49 + 1 from SCALE)
**Parallelism:** Phase 05 can execute in parallel with Phases 02-04. Phase 06 after 05. Phase 07 after 01-03.

## Completed Milestones

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
*Last updated: 2026-03-27 — v1.2.3 roadmap created*
