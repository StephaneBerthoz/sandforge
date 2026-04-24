# Phase 02 — Test Hardening — Context

**Decisions locked:** 2026-04-24 (autopilot mode, synthesized from v1.3.0 research + roadmap)

## Scope

Requirements in this phase: **TEST-01, TEST-02, TEST-03** (3 reqs).

Phase 02 raises the confidence floor for every downstream phase (Monitor v2, AI, CDC, Best Practices). Three orthogonal techniques: mutation testing (Stryker) on pure modules, property-based testing (fast-check) on invariant-heavy logic, and Playwright E2E smokes on the 5 most critical user flows.

## Decisions

### D-02-1 — Stryker scope: `packages/shared/` + extension Monitor core only
**Why:** Mutation testing on pure modules gives the best signal for lowest cost. WebView React components are hard to mutate meaningfully (DOM assertions). Extension glue (handlers, registries) has too many side-effects for stable mutation runs.
**How to apply:** Stryker config `mutate:` globs target `packages/shared/src/**/*.ts` and `packages/extension/src/modules/monitor/**/*.ts`; test runner uses existing Vitest configs.

### D-02-2 — Mutation score target: 60% minimum, 70% stretch
**Why:** 60% is the industry-standard "good" floor. Going higher means diminishing returns and busy-work tests. Aspirational 70% only if the first run exceeds 65% naturally.
**How to apply:** CI workflow fails on score < 60%. Report published as artifact. Target tracked in phase SUMMARY.

### D-02-3 — fast-check targets: the 4 modules with invariant-heavy logic
**Why:** ErrorClassifier (classification invariants), DiffEngine (commutativity + identity), GovernorLimitPredictor (monotonicity), DeltaDetector (idempotency) are pure, invariant-rich, and already have some unit tests. Property tests here catch edge cases unit tests miss.
**How to apply:** `fast-check` as devDep; co-located `*.property.test.ts` files with ≥ 3 properties each; 100 runs per property by default.

### D-02-4 — Playwright E2E: 5 specs only, against WebView in isolation
**Why:** E2E against the full VSCode extension activation is flaky and slow. Playwright against the WebView bundle (with mocked bridge) gives 80% of the value at 20% of the cost. Full extension-host tests are deferred to a nightly job or v1.4.
**How to apply:** Use existing `packages/webview/playwright.config.ts` + `packages/webview/e2e/`. Each spec uses the bridge mock to script extension responses. 5 critical flows per roadmap:
1. Seed AI persona → execute
2. Quick sync with conflict → resolve
3. Monitor dashboard refresh → export
4. CDC subscription → event received
5. AI diagnose failed job → apply fix

### D-02-5 — Stryker runs separately from main CI; fast-check in main test suite
**Why:** Stryker mutation runs take 10–30 min. They gate merges via nightly, not per-PR. fast-check runs fast enough to sit in the main vitest suite.
**How to apply:** Two CI workflows — `stryker.yml` (nightly + manual trigger); fast-check tests inherit `pnpm test` via Vitest discovery.

### D-02-6 — Playwright runs in webview package, not extension
**Why:** `packages/webview/` already has Playwright wired (configs exist from earlier phases). Leverage it; don't duplicate in `packages/extension/`.
**How to apply:** Extend existing `packages/webview/e2e/` with 5 new spec files.

### D-02-7 — No dependency on Phase 01 code
**Why:** Phase 02 is orthogonal — works on existing pure modules (ErrorClassifier, DiffEngine etc.) and pre-existing WebView. Phase 01 adapters exist but aren't required for mutation/property tests to run.
**How to apply:** Phase 02 can be merged in parallel with Phase 01 UAT.

### D-02-8 — Test count floor: 8412 → ≥ 8500
**Why:** Property tests per spec add ≥ 3 properties × ≥ 100 runs (fast-check reports 1 test per property). 4 modules × ≥ 3 = ≥ 12 new test cases. Playwright adds 5 specs. Plus any mutation-driven test adds.
**How to apply:** Plan SUMMARYs must report test deltas; gap triggers a follow-up.

## Open questions (deferred, not blocking)

- **Mutation score on legacy modules** (ErrorClassifier has 2k lines of historical code): if initial Stryker run shows < 40%, do we fix tests or accept baseline? **Default:** accept baseline for this phase, carry to v1.4 as a backlog item.
- **CI budget for Stryker nightly:** GitHub Actions minutes cost. **Default:** run on a single Ubuntu runner, cap at 45 min timeout, opt-out via `skip stryker` label.
- **Flaky Playwright retries:** how many? **Default:** 2 retries in CI, 0 locally.

## Non-goals

- Rewriting existing tests to improve coverage for its own sake.
- Mutation testing of WebView React components.
- Full extension-host E2E (deferred to v1.4 nightly).
- Stryker on orchestrators (side-effect heavy, low signal).
- Adding Chromatic visual regression (scope creep, out for v1.3.0).

## Wave structure

- **Wave 1** — Plan 02-01 (Stryker setup + initial run) + Plan 02-02 (fast-check properties) in parallel (no file overlap).
- **Wave 2** — Plan 02-03 (Playwright 5 specs) after Wave 1 (leverages any test infrastructure from Wave 1 if applicable).

Total: 3 plans, 2 waves.
