# Roadmap: SandForge v1.0.0

**Milestone:** v1.0.0 — Marketplace-Ready Release
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

### Phase 2 — Marketplace Publication ✅ COMPLETE (2026-03-16)

**Goal:** Publish SandForge on the VS Code Marketplace with complete documentation and automated release pipeline.

**Requirements:** MKT-01, MKT-02, MKT-03, MKT-04, MKT-05, MKT-06, MKT-07, MKT-08, MKT-09 — 7/9 automated, 2 need manual action

**Results:**
- Version bumped to v1.0.0 (first public release)
- 6 Playwright-generated screenshots + banner for Marketplace listing
- User docs: getting-started guide, 6 module guides, FAQ with troubleshooting
- CI on 3 OS (ubuntu, macOS, Windows) with E2E on Windows
- One-click release workflow (workflow_dispatch → bump → validate → publish)
- Version sync script for monorepo, 11-point pre-publish check script
- VSIX 1.08 MB, 162 E2E tests passing

**Manual steps remaining:**
- Configure `VSCE_PAT` in GitHub Secrets
- Trigger release workflow to publish to Marketplace
- Verify activation time < 2s in real VSCode

**Dependencies:** Phase 1 (E2E tests provide quality gate for release pipeline)

---
*Roadmap created: 2026-03-16*
*Last updated: 2026-03-16 — Phase 2 complete*
