# Roadmap: SandForge v1.2.3 — Scale & Complete

## Phase 01 — Enterprise Foundation & Polish ✓ Complete (2026-03-27)
**Requirements:** SCALE-01, SCALE-02, SCALE-05, SCALE-06, POLISH-01, POLISH-02, POLISH-03, POLISH-04, POLISH-05, POLISH-06
**Plans:** 4 plans, 2 waves, 11 tasks, 32/32 must-haves verified
**Key deliverables:** Pagination component + usePagination hook, @tanstack/react-virtual installed + DataTable/VirtualList/VirtualCombobox, CacheManager with org-switch invalidation, SkeletonTable/Card/Panel, Ctrl+1..6 keyboard shortcuts, NotificationCenter with filters, BulkJobProgressTracker + ObjectProgressPanel, ErrorRecoveryPanel with retry/backoff

## Phase 02 — Sync History & Scheduling ✓ Complete (2026-03-27)
**Requirements:** HIST-01, HIST-02, HIST-03, HIST-04, HIST-05, SCHED-01, SCHED-02, SCHED-03, SCHED-04, SCHED-05
**Plans:** 3 plans, 2 waves, 8 tasks, 30/30 must-haves verified
**Key deliverables:** SyncHistoryStore (FIFO 500), SyncExecutionLogger, SyncScheduleExecutor (cron-parser, sleep-wake resilient), SyncScheduleStore, SyncHistoryPanel (DataTable + Pagination), SyncHistoryDetail (re-run), CronScheduleBuilder (visual + raw + timezone), SyncSchedulePanel (CRUD), SyncPage tabs
- Schedule persistence + restart survival
- Schedule notifications (VSCode + opt-in desktop)

## Phase 03 — CDC Real-Time Sync ✓ Complete (2026-03-27)
**Requirements:** CDC-01, CDC-02, CDC-03, CDC-04, CDC-05, CDC-06
**Plans:** 3 plans, 3 waves, 9 tasks, 31/31 must-haves verified
**Key deliverables:** Shared buildCdcChannel (custom object fix), replay ID persistence, watchdog reconnection, handler cleanup, CDCEventBatcher (150ms), CDCSubscriptionPanel, CDCEventFeed (VirtualList + ring buffer 5000), auto-sync toggle with conflict strategy, RealTimeSyncMessageHandler, CDCMetricsDashboard (sparkline, lag, counters, uptime), 7986 tests passing
- Add watchdog reconnection on sleep/wake
- Add handler cleanup on stop (prevent memory leaks)
- Event batching (100-200ms window) + ring buffer on WebView
- CDC subscription UI (object picker, start/stop, status indicator)
- Live event feed with virtual scrolling
- Auto-sync toggle per-object with conflict strategy
- CDC metrics dashboard (throughput, lag, counters)

## Phase 04 — Conflict Resolution UI ✓ Complete (2026-03-27)
**Requirements:** CONFLICT-01, CONFLICT-02, CONFLICT-03, CONFLICT-04, CONFLICT-05
**Plans:** 2 plans, 2 waves, 6 tasks, 19/19 must-haves verified
**Key deliverables:** microdiff installed, ConflictDiffService (2-way + 3-way), unified UIConflict type, conflict feed wiring, resolve-conflict handler, resolvePerField, useConflictStore, ConflictListPanel (DataTable + Pagination + filters), ConflictDiffViewer (side-by-side + base value), ConflictResolutionPanel (per-field + bulk), SyncPage conflicts tab with badge

## Phase 05 — Seed Extensions (CSV + Clone) ✓ Complete (2026-03-27)
**Requirements:** CSV-01, CSV-02, CSV-03, CSV-04, CLONE-01, CLONE-02, CLONE-03, CLONE-04
**Plans:** 4 plans, 2 waves, 12 tasks, all must-haves verified
**Key deliverables:** CsvFieldMapper (auto-match + type conversion), CsvValidator (5 validation rules), FileDropZone (drag-and-drop), CsvUploadWizard (4-step), CsvColumnMapper, CsvPreview, CsvValidationPanel, useCsvImport hook, CloneRecordFetcher (cursor-based pagination), CloneReferenceLinker (topological sort + cycle detection), CloneWizard (4-step), CloneSourcePicker, CloneObjectSelector, ClonePreviewPanel, CloneResultsPanel (ID mapping + CSV export), useClone hook, SeedPage mode selector (AI/CSV/Clone), i18n en+fr

## Phase 06 — AI Personas & Smart Actions ✓ Complete (2026-03-28)
**Requirements:** PERSONA-01, PERSONA-02, PERSONA-03, PERSONA-04, SIMPLE-01, SIMPLE-02, SIMPLE-03, SIMPLE-04
**Plans:** 3 plans, 2 waves, 10 tasks, all must-haves verified
**Key deliverables:** PersonaGallery (10 industry cards with icons/locale badges), PersonaPreviewPopover (5 sample records), PersonaCustomizePanel (editable field patterns), persona application to seed wizard field rules, SmartActionAnalyzer (record count analysis on 5 standard objects), SmartActionCard on HomePage (recommendation + Just Do It CTA with confirmation), adaptive wizard (auto-advance <5 objects, grouping >20 objects), InfoTooltip (dismissible contextual help via localStorage)

## Phase 07 — Streaming Execution & Background Ops ✓ Complete (2026-03-28)
**Requirements:** SCALE-03, SCALE-04
**Plans:** 3 plans, 2 waves, 10 tasks, 36/36 must-haves verified
**Key deliverables:** StreamingPipeline (async generator chunk processing with abort), ChunkedBulkExecutor (multi-upload Bulk API 2.0, 2000/chunk), BackgroundOperationRegistry (detached operation lifecycle, events, abort), WebviewPanelManager visibility tracking (onDidChangeViewState), WebviewStateSync activeOperations wiring, ExecutionHandler (abort/status/list), SyncOpsHandler + SeedOpsHandler refactored (streaming >10K records, background detachment), VSCode native notifications on background completion

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
*Last updated: 2026-03-28 — All 7 phases complete, v1.2.3 milestone delivered*
