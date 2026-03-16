# Roadmap: SandForge v3.3.0

**Milestone:** v3.3.0 — Marketplace-Ready Release
**Phases:** 2
**Requirements:** 16 (all mapped)

## Phases

### Phase 1 — E2E Testing ✅ COMPLETE (2026-03-16)

**Goal:** Complete E2E test coverage across all modules with CI integration.

**Requirements:** E2E-01, E2E-02, E2E-03, E2E-04, E2E-05, E2E-06, E2E-07 — all met

**Results:**
- 162 Playwright E2E tests, 0 failures, 2.8 minutes
- 8/8 core modules covered (seed, sync, monitor, compare, dataops, automation, ai, autopilot)
- MockBridge + shared fixtures infrastructure for all future specs
- 19 axe-core WCAG 2.1 AA tests (15 page scans + 4 interactive flows), zero violations
- GitHub Actions CI on Windows (validate → E2E → artifact upload)
- 6 accessibility violations fixed across 5 components

**Starting Point:** 47 WebView UI tests already passing (home, navigation, a11y, i18n, theme, responsive). Playwright infrastructure configured.

### Phase 2 — Marketplace Publication

**Goal:** Publish SandForge on the VS Code Marketplace with complete documentation and automated release pipeline.

**Requirements:** MKT-01, MKT-02, MKT-03, MKT-04, MKT-05, MKT-06, MKT-07, MKT-08, MKT-09

**Success Criteria:**
1. After this phase, SandForge is listed on the VS Code Marketplace and installable by anyone
2. After this phase, a new release can be cut with a single GitHub Actions workflow dispatch
3. After this phase, any user can go from install to first data operation following the getting-started guide
4. After this phase, CI runs typecheck + lint + test + build on Windows, macOS, and Linux

**Dependencies:** Phase 1 (E2E tests provide quality gate for release pipeline)

---
*Roadmap created: 2026-03-16*
*Last updated: 2026-03-16 — Phase 1 complete*
