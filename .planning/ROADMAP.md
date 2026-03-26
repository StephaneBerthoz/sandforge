# Roadmap: SandForge v1.2.2 — Adoption-First: Sync & Seed Polish

## Phase 01 — Persistence & Templates Foundation ✓
**Requirements:** SWIZ-01, SWIZ-02, STPL-06, STPL-01, STPL-02, STPL-03
**Completed:** 2026-03-26. 2 plans, 6 requirements delivered. SyncConfigStore + SeedTemplateStore with CRUD bridge handlers. 3 pre-built seed templates (Sales Cloud 7 objects, Service Cloud 5 objects, Minimal Demo 3 objects). useWebviewPersistedState hook + wizard draft auto-save for Sync and Seed.

## Phase 02 — Seed Quality & Realism ✓
**Requirements:** SQUAL-01, SQUAL-02, SQUAL-03, SQUAL-04, SQUAL-05
**Completed:** 2026-03-26. 1 plan, 5 requirements delivered. Locale-aware FakerFallback (6 locales), GeoCoherentGenerator for address consistency, ContextualRanges for realistic amounts/dates, full picklist pass-through in SmartFieldGenerator, VRAutoAdjuster for validation rule compliance. 184 new tests.

## Phase 03 — Quick Sync ✓
**Requirements:** QSYNC-01, QSYNC-02, QSYNC-03, QSYNC-04, QSYNC-05, QSYNC-06, SWIZ-05, SWIZ-06
**Completed:** 2026-03-26. 2 plans, 8 requirements delivered. SmartObjectSuggester + RelationshipDetector + QuickSyncPreviewEstimator backend. QuickSyncHandler bridge with smart defaults. 6 React components (QuickSyncCard, OrgStep, ObjectStep, PreviewStep, Flow, useQuickSyncFlow). Auto-field mapping via AutoFieldMapper. 73 new tests.

## Phase 04 — Quick Seed & Template Gallery ✓
**Requirements:** STPL-04, STPL-05, QSEED-01, QSEED-02, QSEED-03
**Completed:** 2026-03-26. 1 plan, 5 requirements delivered. TemplateGallery card grid with pre-built + saved templates. TemplateCustomizeModal for record count adjustment. QuickSeedFlow with org selection + progress + results reusing Step7/Step8.

## Phase 05 — Sync Wizard Polish ✓
**Requirements:** SWIZ-03, SWIZ-04
**Completed:** 2026-03-26. 1 plan, 2 requirements delivered. 3 pre-built sync templates (Full Account hierarchy, Opportunities+Products, Cases+Attachments). SyncTemplatePicker card grid. Wizard reduced from 7 to 6 steps (merged org+object selection).

## Phase 06 — Onboarding & First-Run ✓
**Requirements:** ONBO-01, ONBO-02, ONBO-03, ONBO-04
**Completed:** 2026-03-26. 1 plan, 4 requirements delivered. useSandboxDetection hook, SandboxBanner component, GuidedFirstStepCard reusable component. WelcomePage Step 4 updated for sandbox orgs. HomePage "Populate Sandbox" action. SyncPage + SeedPage guided cards when empty. 7623 total tests.

---

## Summary

| Phase | Name | Reqs | Depends On |
|-------|------|------|------------|
| 01 | Persistence & Templates Foundation | 6 | — |
| 02 | Seed Quality & Realism | 5 | 01 |
| 03 | Quick Sync | 8 | 01 |
| 04 | Quick Seed & Template Gallery | 5 | 01, 02 |
| 05 | Sync Wizard Polish | 2 | 01 |
| 06 | Onboarding & First-Run | 4 | 03, 04 |

**Total:** 6 phases, 30 requirements
**Parallelism:** Phases 02, 03, 05 can execute in parallel after Phase 01. Phase 04 after 01+02. Phase 06 after 03+04.

## Completed Milestones

### v1.2.1 — Monitor Enrichment & Wiring
Completed 2026-03-26. 4 phases, 9 plans, 25 requirements delivered. See `.planning/milestones/v1.2.1-ROADMAP.md`.

### v1.2.0 — Forge UX & Reliability
Completed 2026-03-20. 4 phases, 13 plans, 52 requirements delivered. See `.planning/milestones/v1.2.0-ROADMAP.md`.

### v1.1.0 — Stabilisation & Real-World Readiness
Completed 2026-03-19. 6 phases, 16 plans, 27 requirements delivered. See `.planning/milestones/v1.1.0-ROADMAP.md`.

### v1.0.0 — Marketplace-Ready Release
Completed 2026-03-17. 2 phases, 5 plans, 16 requirements delivered. See `.planning/milestones/v1.0.0-ROADMAP.md`.

---
*Last updated: 2026-03-26 — all 6 phases complete, 30/30 requirements delivered*
