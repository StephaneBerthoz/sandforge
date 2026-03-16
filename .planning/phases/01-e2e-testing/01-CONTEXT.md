# Phase 1: E2E Testing - Context

**Gathered:** 2026-03-16
**Status:** Ready for planning

<domain>
## Phase Boundary

Complete E2E test coverage across all 8 core modules (seed, sync, monitor, compare, dataops, automation, ai, autopilot) with CI integration via GitHub Actions. Build on the existing 47 WebView UI tests and Playwright infrastructure.

</domain>

<decisions>
## Implementation Decisions

### Mock Strategy
- Keep page-level `postMessage` mocks (no HTTP mock server) — current `injectVSCodeApiMock` + `sendExtensionMessage` pattern works, no network layer needed for WebView E2E
- Extract shared fixtures to `e2e/fixtures/` (mock orgs, describe responses, preview data) — DRY across specs
- Use realistic payloads matching actual SF API shapes — catches serialization bugs, validates Zod schemas. Leverage shapes from `test/FIXTURES-README.md`
- Create a `MockBridge` helper that auto-correlates request→response by message type — eliminates repeated manual `correlationId` extraction in every spec

### axe-core Accessibility
- Dedicated `axe-accessibility.spec.ts` for full page scans + inline `axe.run()` checks in critical user flows (wizard step transitions, modal dialogs)
- Target: WCAG 2.1 AA compliance
- Fix all violations before merging — clean baseline, zero accessibility debt
- Keep existing `accessibility.spec.ts` (semantic structure, keyboard nav) separate from axe spec (automated WCAG scanning) — different concerns

### AI Module Test Scope
- Cover all 4 sub-features: NL2SOQL, error resolver, smart suggestions, anomaly detection
- Multiple response scenarios per feature: success, partial, error, timeout
- AI specs are the first written with MockBridge — serve as reference implementation for the new pattern

### Autopilot Module Test Scope
- Cover full user journey: navigate to page, select compliance profile, view dependency graph, start provisioning (mock), view execution progress/waves
- Also cover: approval gates, error recovery, wave reordering
- Multiple response scenarios: success, partial, error, timeout
- Autopilot specs also use MockBridge as reference implementation

### CI Pipeline
- Windows runner (`windows-latest`) — matches dev environment, catches path/encoding issues natively
- Trigger: push to `master` + PR to `master`
- Pipeline: full `pnpm validate` (typecheck + lint + test + build) then Playwright E2E as separate step — unit tests gate before E2E
- Upload `playwright-report/` as GitHub Actions artifact, 7-day retention

### Claude's Discretion
- Exact MockBridge API design (method signatures, handler registration pattern)
- Internal structure of shared fixtures (single file vs. per-object files)
- Playwright test organization within each module spec (test.describe grouping)
- axe-core rule exclusion strategy if edge cases arise during implementation

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `e2e/mocks/vscode-api.ts`: `injectVSCodeApiMock()` and `sendExtensionMessage()` — foundation for MockBridge
- `playwright.config.ts`: Chromium-only, Vite dev server on 5173, HTML reporter with screenshots on failure, trace on first retry
- 6 module specs (seed, sync, monitor, compare, dataops, automation) — established test patterns to follow
- 6 cross-cutting specs (home-page, navigation, accessibility, i18n, responsive, theme) — already passing
- `test/FIXTURES-README.md`: SF API mock shapes (describe, limits, bulk job, sample CSV data)

### Established Patterns
- Every spec: `beforeEach` with `injectVSCodeApiMock(page)` → `page.goto('/')` → `waitForSelector('[data-testid="app-shell"]')`
- Module navigation: click sidebar button → `expect(page.getByTestId('module-page')).toBeVisible()`
- Extension message simulation: `sendExtensionMessage(page, { type, id, payload })` for mock responses
- `resolveOrgListLoading()` helper to unblock pages that query org list on mount — duplicated across specs, good candidate for MockBridge
- All UI elements use `data-testid` attributes for stable selectors

### Integration Points
- `packages/webview/e2e/` — all E2E specs live here
- `packages/webview/vite.config.e2e.ts` — dedicated Vite config for E2E (serves app without VSCode host)
- `packages/shared/src/types/messages.types.ts` — typed message definitions (source of truth for mock message shapes)
- No `.github/workflows/` directory yet — needs to be created from scratch

</code_context>

<specifics>
## Specific Ideas

- MockBridge should be the first thing built — AI and Autopilot specs depend on it as reference implementations
- Shared fixtures should use realistic SF API shapes from FIXTURES-README.md
- axe-core violations must be zero before merge (AA level) — no baseline/snapshot approach

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---
*Phase: 01-e2e-testing*
*Context gathered: 2026-03-16*
