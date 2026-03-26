# Roadmap: SandForge v1.2.2 — Adoption-First: Sync & Seed Polish

## Phase 01 — Persistence & Templates Foundation
**Requirements:** SWIZ-01, SWIZ-02, STPL-06, STPL-01, STPL-02, STPL-03
**Why first:** Everything else depends on config persistence (Quick Sync saves configs, templates need storage, auto-save needs draft store). Pre-built templates are the content that Quick Seed and the template gallery will serve.

**Scope:**
- SyncConfigStore: save/load/list/delete named sync configs via ConfigStore
- SeedTemplateStore: persist seed templates to ConfigStore (replace in-memory store)
- Wizard draft auto-save on step change (survives page refresh)
- 3 pre-built Seed templates: Sales Cloud Starter, Service Cloud Starter, Minimal Demo
- Template data: realistic field rules, correct insertOrder, proper relationships

## Phase 02 — Seed Quality & Realism
**Requirements:** SQUAL-01, SQUAL-02, SQUAL-03, SQUAL-04, SQUAL-05
**Why second:** Pre-built templates from Phase 01 are only as good as the generated data. Better data quality makes templates actually useful and builds trust.

**Scope:**
- Locale-aware FakerFallback (fr_FR, de_DE, es_ES, ja_JP, pt_BR — matching i18n locales)
- Geo-coherent address generation (city+state+country consistent)
- Picklist-aware Smart Suggest (all active values, not subset)
- VR-aware auto-adjustment (high-risk rules → auto-fix field rules)
- Context-aware amount/date ranges per object type

## Phase 03 — Quick Sync
**Requirements:** QSYNC-01, QSYNC-02, QSYNC-03, QSYNC-04, QSYNC-05, QSYNC-06, SWIZ-05, SWIZ-06
**Why third:** Depends on persistence (Phase 01) to save Quick Sync configs. This is the highest-impact adoption feature — the "3 clicks to data" promise.

**Scope:**
- Quick Sync entry point on SyncPage (card/button above wizard)
- 3-screen flow: pick orgs → multi-select objects → preview & go
- Auto-field mapping (same-name match)
- Smart defaults (source_to_target, full, source_wins, upsert)
- Preview screen (object count, record estimates, API calls)
- Results reuse existing Step6 component
- Smart object suggestions (top 5 common objects)
- Relationship auto-detection (add parent objects automatically)

## Phase 04 — Quick Seed & Template Gallery
**Requirements:** STPL-04, STPL-05, QSEED-01, QSEED-02, QSEED-03
**Why fourth:** Depends on persisted templates (Phase 01) and quality data (Phase 02). This is the Seed equivalent of Quick Sync — the "1-click to realistic data" promise.

**Scope:**
- Template gallery UI on SeedPage (card grid with name, description, object count, total records)
- "Use This" → customize record counts → execute
- Quick Seed bypasses field config (uses Smart Suggest defaults)
- Progress + results reuse existing Step7/Step8 components

## Phase 05 — Sync Wizard Polish
**Requirements:** SWIZ-03, SWIZ-04
**Why fifth:** Lower priority than Quick flows (most users will use Quick Sync/Seed). Still important for power users who need the full wizard.

**Scope:**
- Sync templates: pre-built configs for common patterns (Account hierarchy, Opps+Products, Cases+Attachments)
- Step merge: combine org selection + object selection into one screen (7→6 steps)

## Phase 06 — Onboarding & First-Run
**Requirements:** ONBO-01, ONBO-02, ONBO-03, ONBO-04
**Why last:** Depends on Quick Seed gallery (Phase 04) and Quick Sync (Phase 03) existing as destinations. Onboarding wires everything together into a cohesive first-run experience.

**Scope:**
- Sandbox detection banner ("Your sandbox is empty — populate it")
- Welcome wizard update: sandbox orgs → suggest Seed/Sync
- Home dashboard: "Populate Sandbox" quick action → template gallery
- SyncPage + SeedPage: guided first-step cards when empty

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
*Last updated: 2026-03-26 — v1.2.2 roadmap created*
