# Plan 02-02 Summary

**Completed:** 2026-04-24 (autopilot, YOLO mode)
**Phase:** 02 — Test Hardening
**Plan:** 02-02 fast-check Property-Based Tests
**Requirement:** TEST-02

## What was built

Introduced `fast-check` v3 as a devDep in `packages/shared/` and `packages/extension/`, authored a reusable `arbitraries.ts` test-helper module with composed generators for every domain type consumed by the 4 target modules, and shipped **5 property-test files** (4 in extension + 1 bonus in shared) totaling **20 new fast-check properties** with **100 runs each** (2 000 concurrent property evaluations per `pnpm test`). Vitest's default discovery glob picks up `*.property.test.ts` automatically — no config changes required. Every property constructs a fresh subject-under-test inside `fc.property` / `fc.asyncProperty` to eliminate shared-state bleed (P-02.5), and arbitraries bound numeric domains to exclude `NaN` / `Infinity` (P-02.4).

## Key files

- `packages/shared/package.json` — added `"fast-check": "^3"` devDep.
- `packages/extension/package.json` — added `"fast-check": "^3"` devDep.
- `pnpm-lock.yaml` — refreshed, frozen-lockfile install passes.
- `packages/extension/src/test/arbitraries.ts` — reusable generators: `salesforceStatusCodeArb`, `salesforceApiErrorArb`, `metadataComponentTypeArb`, `componentMapArb`, `apiLimitArb`, `limitsSnapshotArb`, `orderedSnapshotsArb`, `monotoneNonDecreasingSnapshotsArb(limitName)`, `queryRecordArb`, `errorCategoryArb`.
- `packages/extension/src/core/engine/ErrorClassifier.property.test.ts` — 4 properties: determinism, batch-vs-single equivalence, summary totals, `byErrorCode` completeness.
- `packages/extension/src/modules/compare/DiffEngine.property.test.ts` — 4 properties: identity/reflexivity + input non-mutation, count invariant, commutativity up to `added <-> removed` swap, disjoint-key classification.
- `packages/extension/src/modules/monitor/GovernorLimitPredictor.property.test.ts` — 4 properties: `predictedPercent ∈ [0,100]`, `confidence ∈ [0,1]`, monotone non-decreasing usage never classifies as `decreasing`, history < 2 → empty result.
- `packages/extension/src/modules/sync/DeltaDetector.property.test.ts` — 4 async properties: totals invariant, no-`lastSync` baseline, `IsDeleted` precedence count, re-run idempotency.
- `packages/shared/src/utils/hash-utils.property.test.ts` — 4 properties: `fnv1aHash` determinism, `shortHash` 8-char hex shape, `checksum` + `verifyChecksum` agreement, FNV-1a range invariants on distinct inputs.
- `.planning/phases/02-test-hardening/02-02-TEST-DELTA.md` — per-package baseline, post-run counts, and per-file property breakdown.

## Decisions made

- **`arbitraries.ts` lives in `packages/extension/src/test/` (not the target-directory adjacent to each test).** Rationale: the 4 extension property files share the module, and Vitest does NOT pick up files outside a `.test.ts` suffix, so no risk of Vitest running the helper as a test. The shared hash-utils property test imports nothing from it (pure shared-package scope).
- **Built `apiLimitArb` from `{ name, max, remainingRatio }` and derived `remaining` + `usedPercent` consistently.** The plan text proposed a simple `{ max, remaining }` record, but `LimitsSnapshot.limits` is typed as `ApiLimit[]` (with `usedPercent` as a separate field). Deriving all three fields from a single ratio keeps the arbitrary consistent (`usedPercent = (max - remaining) / max * 100`), which matters for GovernorLimitPredictor's bounded-prediction property.
- **Adapted `limitsSnapshotArb` to use `fc.array(apiLimitArb, …)` instead of `fc.dictionary(…)`.** Matches the actual `LimitsSnapshot` shape in `packages/shared/src/types/monitor.types.ts`. The plan's proposed dictionary shape would not typecheck.
- **Added a dedicated `monotoneNonDecreasingSnapshotsArb(limitName)` factory** for the monotone-trend property. The plan mentioned a "monotonically non-decreasing usage series" without specifying the construction. A pure post-hoc filter on random data would shrink to trivial pass-through; a constructive generator ensures the invariant is actually exercised.
- **`DeltaDetector` "no lastSync" property asserts exactly what source does** (`newRecords === records.length`, all other buckets = 0, including IsDeleted records). The plan explicitly noted "baseline the invariant to match source"; this is what was done.
- **Every property body constructs a fresh subject inside the `fc.property` closure** — not only for P-02.5 safety but also because some of the targets (`GovernorLimitPredictor`, `DeltaDetector`) take constructor-injected deps that depend on the generated inputs (the fake tracker's `getHistory` / the mock `query` closure).

## Deviations from plan

- **`limitsSnapshotArb` shape.** Plan text used `fc.dictionary` under a `limits: { [name]: { max, remaining } }` assumption. Real shape is `limits: ApiLimit[]`. Arbitrary was adapted to `fc.array(apiLimitArb, …)` and includes the `usedPercent` field required by `GovernorLimitPredictor.predictLimit` → `extractDataPoints`. Downstream plans can reuse this without ceremony.
- **`SyncObjectConfig` minimal constant needed all required fields.** The plan sketch only listed `objectApiName` + `fields`. In practice `SyncObjectConfig` (per `packages/shared/src/types/sync.types.ts`) requires `operation`, `fieldMappings`, `transformRules`, `excludedFields`, `addOnFields`, `batchSize`, `insertOrder` — all added as constants in the DeltaDetector property file. No `fields` key exists on the type.
- **Bonus properties everywhere.** Every file ships **4** properties rather than the minimum 3; four-per-file is the uniform shape. Total: 20 properties × 100 runs = 2 000 property evaluations per `pnpm test`, fully deterministic from the seed fast-check logs on failure.
- **Added `fc.float({ noNaN: true, noDefaultInfinity: true })` in `apiLimitArb`** — P-02.4 mitigation that the plan's generator sketch did not include. Prevents flakes from `NaN` propagating into the predictor's regression math.

## Test count delta (full recap)

| | Before | After | Delta |
|---|---|---|---|
| `@sandforge/shared` | 935 | 939 | **+4** |
| `packages/extension` | 4 596 | 4 612 | **+16** |
| `packages/webview` | 2 881 | 2 881 | +0 |
| **Total** | **8 412** | **8 432** | **+20** |

Floor per D-02-8 / must-haves was **+15** (baseline 8 412 → ≥ 8 427). Actual delta is **+20**, **5 beyond floor**.

See `02-02-TEST-DELTA.md` for per-file breakdown.

## Commits (this plan's slice of the wave)

- `chore(02-02-01)` add fast-check v3 devDep to shared + extension packages
- `test(02-02-02)` add shared fast-check arbitraries for 4 target modules
- `test(02-02-03)` ErrorClassifier property tests (4 properties, 100 runs each)
- `test(02-02-04)` DiffEngine property tests (4 properties, 100 runs each)
- `test(02-02-05)` GovernorLimitPredictor property tests (4 properties, 100 runs each)
- `test(02-02-06)` DeltaDetector async property tests (4 properties, 100 runs each)
- `test(02-02-07)` hash-utils property tests in shared (4 properties, 100 runs each)
- `docs(02-02-08)` record test count delta 8412 -> 8432 (+20 property tests)

## Notes for downstream

- **Plan 02-03 (Playwright)**: unaffected by this plan's artefacts. The 5 target specs live in `packages/webview/e2e/` and use MockBridge; nothing here changes that surface.
- **Phase 02 verification**: test-count floor per D-02-8 is 8 412 → ≥ 8 500 at phase close. Plan 02-02 delivered **+20** toward the **+88** required total. Plan 02-03 needs to add ≥ **+68** via Playwright specs to hit the phase floor; this is consistent with 5 specs × ~14 assertions/spec (Vitest counts each Playwright test as 1).
- **Stryker follow-up (Plan 02-01 carry-over)**: the same 4 modules that got property tests reported NoCoverage in the Stryker baseline because the Vitest runner config scope pointed only at `packages/shared/vitest.config.ts`. Once the Stryker runner is pointed at the extension Vitest config, these new property tests should dramatically improve the mutation score on ErrorClassifier / DiffEngine / GovernorLimitPredictor / DeltaDetector — property tests are particularly good at killing arithmetic, boolean, and conditional mutants. This is the top Phase 06 / v1.4 follow-up.
- **Reusable arbitraries**: `packages/extension/src/test/arbitraries.ts` is intentionally dependency-light. Future plans can extend it with `syncObjectConfigArb`, `compareItemArb`, etc. as more property tests land on adjacent modules.
- **Seed determinism**: fast-check logs the seed on failure in the default Vitest reporter. No `FC_SEED` is hard-coded; CI and local runs use fresh seeds, maximising coverage per run while staying reproducible post-hoc.

## Self-Check

| Must-have | Status |
|-----------|--------|
| `fast-check` added to `packages/extension/package.json` devDeps | PASS |
| `fast-check` added to `packages/shared/package.json` devDeps | PASS |
| `pnpm install --frozen-lockfile` succeeds after devDep addition | PASS |
| `packages/extension/src/test/arbitraries.ts` exports the named arbitraries | PASS (all 7 named exports + 3 bonus) |
| `ErrorClassifier.property.test.ts` has ≥ 3 `fc.assert` properties, each `numRuns: 100` | PASS (4 properties) |
| `DiffEngine.property.test.ts` has ≥ 3 properties incl. identity + count + commutativity | PASS (4 properties; all 3 named + disjoint-keys bonus) |
| `GovernorLimitPredictor.property.test.ts` has ≥ 3 properties incl. bounded-prediction + bounded-confidence | PASS (4 properties) |
| `DeltaDetector.property.test.ts` has ≥ 3 `fc.asyncProperty` properties incl. totals + idempotency | PASS (4 async properties) |
| `hash-utils.property.test.ts` in `packages/shared` demonstrates fast-check in shared | PASS (4 properties) |
| Every property constructs a fresh subject (P-02.5) | PASS |
| Every property explicitly sets `numRuns: 100` | PASS (grep `numRuns: 100` — 20 hits) |
| Every property-test file runs via `pnpm test` (no special runner) | PASS (Vitest default glob picks them up) |
| Test suite total increases by ≥ 15 tests | PASS (+20) |
| `pnpm typecheck` green across all packages | PASS |
| `pnpm test` green across all packages | PASS (8 432 / 8 432) |
