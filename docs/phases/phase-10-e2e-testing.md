# Phase 10 — E2E Testing

> **Status:** IN PROGRESS (partially set up as of 2026-03-13)

## Objectifs

Mettre en place les tests end-to-end avec Playwright pour valider les workflows complets de l'extension VSCode, de l'UI WebView jusqu'aux interactions Salesforce.

## Avancement (2026-03-13)

### Infrastructure E2E — DONE

- `packages/webview/playwright.config.ts` — Configuration Playwright (Chromium, Firefox, WebKit)
- `@playwright/test` added as dev dependency in webview package
- Scripts configured: `pnpm e2e`, `pnpm e2e:ui`, `pnpm e2e:report`

### Tests WebView UI — DONE (6 spec files, 47 tests)

- `e2e/home-page.spec.ts` — Home page rendering, KPI cards, quick actions, navigation (10 tests)
- `e2e/navigation.spec.ts` — Sidebar navigation, routing, breadcrumbs, CommandPalette (9 tests)
- `e2e/accessibility.spec.ts` — ARIA attributes, keyboard navigation, focus management, skip links (10 tests)
- `e2e/i18n.spec.ts` — Language switching, translation keys, locale-aware formatting (5 tests)
- `e2e/theme.spec.ts` — Light/dark theme switching, VSCode CSS variable integration (5 tests)
- `e2e/responsive.spec.ts` — Responsive layout, mobile breakpoints, overflow handling (8 tests)

### Tests par module — PLANNED

- `e2e/tests/connection.spec.ts` — Connexion a une org (OAuth, credentials, SFDX)
- `e2e/tests/seed.spec.ts` — Workflow complet de seeding (wizard -> execution -> validation)
- `e2e/tests/sync.spec.ts` — Workflow de synchronisation (mapping -> preview -> execution)
- `e2e/tests/monitor.spec.ts` — Dashboard monitoring (health score, limits, alerts)
- `e2e/tests/compare.spec.ts` — Comparaison entre orgs (diff, permissions, drift)
- `e2e/tests/dataops.spec.ts` — Operations DataOps (backup, restore, anonymize)
- `e2e/tests/automation.spec.ts` — Creation et execution de pipeline
- `e2e/tests/ai.spec.ts` — Fonctionnalites IA (NL2SOQL, chat, suggestions)
- `e2e/tests/autopilot.spec.ts` — Workflow Autopilot complet
- `e2e/tests/settings.spec.ts` — Configuration et preferences
- `e2e/tests/offline.spec.ts` — Mode hors-ligne et reconnexion
- `e2e/tests/error-handling.spec.ts` — Gestion des erreurs (timeout, permissions, limits)

### CI/CD — PLANNED

- `.github/workflows/e2e.yml` — Workflow GitHub Actions pour tests E2E
- `e2e/scripts/setup-test-org.sh` — Script setup scratch org de test
- `e2e/scripts/teardown-test-org.sh` — Script cleanup org de test

## Criteres de validation

- [x] Playwright configure et fonctionnel avec multi-browser support (Chromium, Firefox, WebKit)
- [x] 47 tests E2E WebView UI passent (home, navigation, a11y, i18n, theme, responsive)
- [ ] Fixture Salesforce cree/detruit une scratch org pour les tests
- [ ] Au moins 1 test E2E par module (8 modules)
- [ ] Tests d'accessibilite passent avec axe-core
- [ ] Tests executables en CI (GitHub Actions)
- [ ] Temps d'execution total < 15 minutes
- [ ] Rapport HTML genere avec screenshots des echecs
- [ ] Mock server pour tests sans org reelle (mode offline)
