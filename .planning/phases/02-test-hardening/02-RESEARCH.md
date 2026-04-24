# Phase 02 — Test Hardening — Research

**Scope:** TEST-01 (Stryker mutation testing), TEST-02 (fast-check property tests), TEST-03 (Playwright E2E critical paths).
**Written:** 2026-04-24 (autopilot; synthesized from STACK.md, PITFALLS.md, ARCHITECTURE.md, and a stack inventory of the current monorepo).

---

## 1. Library choices (don't hand-roll)

### Mutation testing — Stryker
- **Choice:** `@stryker-mutator/core` + `@stryker-mutator/vitest-runner` v8.x.
- **Why here:** Vitest runner is first-class in 2026 — no custom runner scaffolding. Our shared + core modules are pure TS, the ideal shape for mutation testing. Writing mutation ops by hand is weeks of work; Stryker has 40+ operators out of the box (arithmetic, boolean, conditional, string, array, optional-chain, etc.).
- **Config file:** `stryker.conf.json` (JSON preferred over .mjs — Stryker's loader behaves more predictably in monorepos, and we avoid adding another `.mjs` to the root).
- **Runner delegation:** Vitest runner uses the package-local `vitest.config.ts`, so test discovery mirrors `pnpm test` exactly. No duplicated test path config.
- **DO NOT hand-roll:** mutation operators, test-per-mutant orchestration, kill/survive reporting, HTML reports — all provided.

### Property-based testing — fast-check
- **Choice:** `fast-check` v3.x as devDep in `packages/shared/` and `packages/extension/`.
- **Why here:** Our target modules (ErrorClassifier, DiffEngine, GovernorLimitPredictor, DeltaDetector) are invariant-rich: classification consistency, commutativity of diffs, monotonicity of predictors, idempotency of delta detection. fast-check's `fc.assert(fc.property(gen, predicate))` model with 100 runs per property catches edge cases our unit tests miss (empty arrays, NaN, duplicated keys, Unicode).
- **Integration:** Co-located `*.property.test.ts` files sit next to `.test.ts` — Vitest picks them up by default glob `**/*.test.ts`. No separate runner.
- **Arbitraries to prefer:** `fc.record`, `fc.constantFrom`, `fc.date`, `fc.string`, `fc.dictionary`, `fc.array`. For domain types, build composed arbitraries in a local `fixtures/arbitraries.ts` helper (reuse across property files).
- **DO NOT hand-roll:** RNG, shrinking, counterexample reporting, seed replay.

### E2E — Playwright (already wired)
- **Choice:** Extend existing `packages/webview/e2e/` with 5 new specs. No config change needed; `playwright.config.ts` already sets `retries: 2` in CI, `0` locally — matches D-02-decision on retries.
- **Bridge mock pattern:** reuse `packages/webview/e2e/helpers/MockBridge.ts` + `packages/webview/e2e/mocks/vscode-api.ts`. These give us auto-correlated `waitForMessage` / `respond` / `respondToNext`. Zero new infrastructure required.
- **Fixtures:** extend `packages/webview/e2e/fixtures/mock-responses.ts` and `mock-orgs.ts` rather than inlining responses in specs.
- **DO NOT hand-roll:** extension-host emulator, full VSCode activation, SFDC mock server (we don't need them — WebView + MockBridge is sufficient for the 5 target flows).

### What we are NOT adding this phase
- **Chromatic / Percy** — visual regression; explicitly out per D-02 non-goals.
- **Playwright against real extension host** — deferred to v1.4 nightly.
- **Jest** — already on Vitest.
- **msw / sinon** — MockBridge handles WebView message mocking; no HTTP mocking needed for these flows.
- **Custom Stryker runner** — the vitest-runner is officially maintained.

---

## 2. Existing codebase patterns to respect

### Test file layout
- Unit tests: `<SourceName>.test.ts` co-located with source. Example: `ErrorClassifier.test.ts` next to `ErrorClassifier.ts`.
- Vitest picks up every `src/**/*.test.ts` in each package — ADDING `*.property.test.ts` is seen automatically. No config change needed.
- `shared/vitest.config.ts` enforces 80% global coverage thresholds. Our property tests add coverage for free.

### Target modules (confirmed existing)
| Module | Location | Key surface |
|---|---|---|
| `ErrorClassifier` | `packages/extension/src/core/engine/ErrorClassifier.ts` | `classify(SalesforceApiError): ClassifiedError`, `classifyBatch(errors[]): { classified, summary }` |
| `DiffEngine` | `packages/extension/src/modules/compare/DiffEngine.ts` | `diff(source: Map, target: Map, type): CompareItem[]`, `diffFields(source, target): FieldDiff[]` |
| `GovernorLimitPredictor` | `packages/extension/src/modules/monitor/GovernorLimitPredictor.ts` | `predict(orgId): LimitPrediction[]`, `predictLimit(snapshots, name): LimitPrediction` — uses linear regression |
| `DeltaDetector` | `packages/extension/src/modules/sync/DeltaDetector.ts` | `detect(config, sourceOrgId, lastSync?): Promise<DeltaResult>` — classifies records into new/modified/deleted/unchanged buckets |

All four live in `packages/extension/` (not `packages/shared/`). This is important for Stryker scope: mutate globs must include `packages/extension/src/modules/{compare,sync,monitor}/**/*.ts` and `packages/extension/src/core/engine/**/*.ts`, not only `packages/shared/**`.

### CI workflow conventions
- Existing workflows: `.github/workflows/ci.yml` (validate on push/PR), `.github/workflows/knip.yml` (nightly non-blocking), `.github/workflows/release.yml`.
- Runner template: `ubuntu-latest` + `pnpm/action-setup@v4` + `actions/setup-node@v4 (node 20, cache pnpm)` + `pnpm install --frozen-lockfile`. New `stryker.yml` should mirror this template.
- Artifact upload pattern: `actions/upload-artifact@v4` with `retention-days`. Stryker HTML report should follow.

### Phase 01 infrastructure available for reuse
- `TelemetryAdapter` (Pino + Sentry) exists and is wired via `createServices`. Property tests of pure functions do not need it, but mutation tests targeting `createServices`-dependent modules must import via `@sandforge/shared` barrel rather than deep imports.
- `PROTOCOL_VERSION` envelope is in `packages/shared/src/bridge/`. E2E specs must wrap mock responses in envelopes (MockBridge already does this — verify when reading helpers).
- `scripts/soak-test.ts` + `scripts/audit-disposables.ts` exist as one-shot harnesses. Stryker's runner is a third one-shot harness — same spiritual pattern (tsx + CLI invocation). Keep it out of the default `pnpm test` path.

### Test count baseline
- As of end of Phase 01: **8412 tests across all packages**. Phase 02 floor per CONTEXT D-02-8: ≥ 8500 → need +88 new test cases. Property tests count 1 per property; 4 modules × ≥ 3 properties = 12. Playwright adds 5 specs with ≥ 4 assertions each ≈ 20 "tests". Mutation-driven gap fixes add the rest. Plan 02-01 and 02-02 SUMMARYs must report their delta.

---

## 3. Pitfalls specific to Phase 02

### P-02.1 — Stryker wall-time blows out on large suites (HIGH)
**Symptom:** Initial Stryker run on `packages/shared/` reports 30+ minutes for mutants × test-suite cycles.
**Root causes:** Default `concurrency` auto-detects CPU cores (up to 4); Vitest cold start adds ~1–2s per mutant.
**Prevention:**
- Narrow `mutate` globs: exclude `*.test.ts`, `index.ts` barrels, `types/**`, `constants/**` (no logic to mutate).
- Use `incremental: true` in `stryker.conf.json` — Stryker persists an incremental report and skips unchanged files on re-runs.
- Set `coverageAnalysis: 'perTest'` (default for Vitest runner) — Stryker runs only the tests that cover each mutant's source line.
- CI timeout: 45 min hard cap. If exceeded, split `mutate` globs across two shards (parallel matrix job).
- Local dev: `pnpm stryker run --mutate "packages/shared/src/utils/execution-result.ts"` to mutate one file at a time.

### P-02.2 — Stryker Vitest runner and ESM shared package interop (MEDIUM)
**Symptom:** Stryker sandboxes node_modules per mutant; `@sandforge/shared` is a workspace symlink — Stryker may not copy shared source into sandboxes, causing "module not found" errors.
**Prevention:**
- In `stryker.conf.json`, set `tempDirName` to a local path (default `.stryker-tmp` is fine) and `cleanTempDir: true`.
- Pre-build shared package once before Stryker via `pnpm build:shared` step in the workflow (the published `dist/` is what other packages consume).
- If symlinks still break: add `files` array in `stryker.conf.json` to explicitly include `packages/shared/dist/**` and `packages/shared/package.json`.

### P-02.3 — Mutation score thresholds that fail CI unexpectedly (MEDIUM)
**Symptom:** Initial baseline is 55% on legacy modules; CI blocks every PR.
**Prevention:**
- Set `thresholds: { high: 80, low: 60, break: 60 }` per D-02-2. `break` is the only failure threshold.
- First run writes a BASELINE file; subsequent runs compare. If a PR drops the score below 60% OR below baseline, fail.
- Opt-out: honor PR label `skip-stryker` in workflow (`if: !contains(github.event.pull_request.labels.*.name, 'skip-stryker')`).

### P-02.4 — fast-check non-determinism / flaky seeds (MEDIUM)
**Symptom:** A property fails in CI but passes locally; developers can't reproduce.
**Prevention:**
- Every property test uses a deterministic seed in CI via `FC_SEED` env var when debugging. By default, fast-check's random seed is logged with every failure; CI output must preserve it.
- Shrinking is enabled by default — shrunk counter-example is in the failure message. Capture Vitest output with `--reporter=verbose`.
- If a property is inherently flaky (rare), bound the domain (e.g., `fc.float({ min: -1e6, max: 1e6, noNaN: true })`) — avoid producing NaN/Infinity unless the property is explicitly about them.
- Use `fc.assert(property, { numRuns: 100 })` explicitly — don't rely on the default (may change across minor versions).

### P-02.5 — Property tests that secretly depend on side effects (HIGH)
**Symptom:** A property for DiffEngine.diff() passes, but the underlying map was mutated — the next property call sees the mutation.
**Prevention:**
- Property tests MUST construct fresh inputs per run (fast-check does this by default — never share a `Map` instance across the property).
- For modules that take `Map` / arrays: always pass a new copy inside the property body, never a closure-captured reference.
- Add an assertion at the property end that input is structurally unchanged (identity invariant).

### P-02.6 — DeltaDetector needs an injected `query` function (HIGH for property tests)
**Symptom:** DeltaDetector's constructor requires `{ query: QueryFn }`; property tests can't make real Salesforce calls.
**Prevention:**
- Inject a **deterministic mock `query`** built from the generated `QueryRecord[]` — the property generates the record list as input, then the mock returns it verbatim.
- Property: "for any record list + lastSync date, sum of (new + modified + deleted + unchanged) equals input length." This is the idempotency invariant.
- Never import jsforce inside property tests.

### P-02.7 — Playwright flakes on hidden/detached elements (MEDIUM)
**Symptom:** `await page.getByTestId(...).click()` times out because the element is inside a collapsed panel or a tab that hasn't rendered.
**Prevention:**
- Reuse MockBridge's `waitForMessage` / `respondToNext` — these avoid arbitrary `waitForTimeout` calls.
- Always await `expect(locator).toBeVisible()` before interacting with an element. Existing specs (seed.spec.ts, sync.spec.ts) do this — match the style.
- `data-testid` is the only stable selector policy in this codebase; CSS classes change with Tailwind rebuilds. Verify target components already expose the required testids BEFORE writing the spec — if missing, the spec must add them.
- Use `test.describe.configure({ mode: 'serial' })` only if a spec genuinely needs shared state; default is parallel.

### P-02.8 — Playwright E2E against WebView bridge envelope changes (MEDIUM, carry-over from P-4)
**Symptom:** Phase 01 added a `protocolVersion` envelope. Existing fixture responses still work because `useMessageBus` accepts both wrapped and raw messages, but the 5 new specs should use the enveloped shape to match production traffic.
**Prevention:**
- MockBridge's `respond` / `respondToNext` constructs the envelope automatically (verified by reading the helper). When writing new specs, prefer `mockBridge.respond(type, payload)` over hand-crafted `sendExtensionMessage` calls.
- If a flow asserts on outgoing messages via `getMessages`, unwrap `.payload` before asserting on `type` (see 01-04-SUMMARY.md "unwrap envelope.payload" pattern).
- Version mismatch banner: new specs should NOT trigger it — use `PROTOCOL_VERSION = 1` in all fixtures.

### P-02.9 — Streaming / abort flows in E2E (MEDIUM, reprise of PITFALLS P-8)
**Symptom:** Monitor dashboard spec subscribes to a metric stream, then navigates away — stream listener leaks in the test.
**Prevention:**
- Each spec must `afterEach` call `await mockBridge.getMessages()` then `await page.close()` — Playwright's `test.afterEach` auto-closes, but explicit close prevents cross-spec leaks.
- For the CDC spec: use a finite mock event stream (post 3 events, then post `cdc:subscription:end`). Do not send infinite events.
- AI diagnose spec: when "Apply fix" is clicked, the mock should respond with a single `ai.fix:applied` message — no retries.

### P-02.10 — Stryker false positives on unused branches (LOW)
**Symptom:** Stryker kills a mutant in an unreachable branch (e.g., `if (MIN_DATA_POINTS === 2)` when the constant is never 1).
**Prevention:**
- Mark truly unreachable code with `/* istanbul ignore next */` (Stryker respects coverage-ignore comments).
- Better: delete the unreachable branch during Phase 02 or defer to Phase 06 (BP-04 bug bash).
- Accept a lower score on constants-heavy files by excluding them from `mutate` globs when the cost-benefit is clear.

---

## 4. Summary — what each plan should leverage

| Plan | Library | Existing infra | Pitfalls to address |
|---|---|---|---|
| 02-01 Stryker | `@stryker-mutator/core` + `vitest-runner` | Existing `vitest.config.ts` per package, CI workflow template | P-02.1, P-02.2, P-02.3, P-02.10 |
| 02-02 fast-check | `fast-check` v3 | Co-located `*.test.ts` glob, existing module surfaces | P-02.4, P-02.5, P-02.6 |
| 02-03 Playwright | `@playwright/test` (already installed) | `MockBridge`, `mocks/vscode-api.ts`, existing fixture files, `playwright.config.ts` (retries already configured) | P-02.7, P-02.8, P-02.9 |

---

## 5. Confidence

- **HIGH:** Stryker + Vitest runner combo, fast-check library choice, reuse of MockBridge for Playwright, existing test-file layout patterns.
- **MEDIUM:** Initial mutation score on legacy ErrorClassifier (may land below 60% — CONTEXT D-02 open question says accept baseline), exact number of E2E specs that need testid additions to target components, wall-time of Stryker on full scope (may need shard split).
- **LOW:** None.

---

## 6. References

- STACK.md §4 "Testing hardening — stryker-mutator + fast-check (MEDIUM confidence)"
- PITFALLS.md P-4 "Refactoring at scale breaks downstream consumers", P-8 "Streaming + abort + background operations edge cases"
- ARCHITECTURE.md Phase E (Phase 02 mirror)
- 02-CONTEXT.md D-02-1 through D-02-8
- 01-04-SUMMARY.md (envelope wrap pattern, 8412 test baseline)
