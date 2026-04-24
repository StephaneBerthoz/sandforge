# Plan 02-02 — Test Count Delta

**Captured:** 2026-04-24 (autopilot execution)

## Baseline (before Plan 02-02)

| Package | Test Files | Tests |
|---|---|---|
| `@sandforge/shared` | 51 | 935 |
| `packages/extension` | 282 | 4 596 |
| `packages/webview` | 294 | 2 881 |
| **Total** | **627** | **8 412** |

## After Plan 02-02

| Package | Test Files | Tests | Delta |
|---|---|---|---|
| `@sandforge/shared` | 52 | 939 | **+4** (hash-utils property file, 4 properties) |
| `packages/extension` | 286 | 4 612 | **+16** (4 property files × 4 properties each) |
| `packages/webview` | 294 | 2 881 | +0 (no webview property tests in this plan) |
| **Total** | **632** | **8 432** | **+20** |

## Per-file contribution

| File | Properties (fc.assert / fc.asyncProperty) | Runs per property |
|---|---|---|
| `packages/extension/src/core/engine/ErrorClassifier.property.test.ts` | 4 | 100 |
| `packages/extension/src/modules/compare/DiffEngine.property.test.ts` | 4 | 100 |
| `packages/extension/src/modules/monitor/GovernorLimitPredictor.property.test.ts` | 4 | 100 |
| `packages/extension/src/modules/sync/DeltaDetector.property.test.ts` | 4 (async) | 100 |
| `packages/shared/src/utils/hash-utils.property.test.ts` | 4 | 100 |
| **Total properties** | **20** | **100 each → 2 000 total runs** |

## Requirement trace

- **D-02-8 floor:** 8 412 → ≥ 8 427 — **PASS** (actual: 8 432, +20 tests, +5 beyond floor).
- **Plan 02-02 must-have:** ≥ 3 properties per module — **PASS** (every file ships 4).
- **Plan 02-02 must-have:** every property sets `numRuns: 100` explicitly — **PASS** (grep `numRuns: 100` — 20 hits).
- **P-02.5 mitigation:** fresh subject per property body — **PASS** (every property body constructs `new ErrorClassifier()` / `new DiffEngine()` / `new GovernorLimitPredictor(fakeTracker(…))` / `new DeltaDetector({ query: … })` inside the `fc.property` closure).

## Determinism notes (P-02.4)

- fast-check defaults to a fresh random seed per run; the seed is logged automatically on failure (Vitest output). No seed has been forced in source. Developers replaying a CI failure can set `FC_SEED=<seed>` locally; the 20 properties are reproducible under any seed (they hold universally, not only for the default seed).
- No property intentionally generates `NaN` / `Infinity` (arbitraries constrain domains per P-02.4 guidance — e.g., `fc.float({ noNaN: true, noDefaultInfinity: true })` in `apiLimitArb`).

## Verification

```
pnpm typecheck         → exit 0 (all 3 packages clean)
pnpm test              → exit 0, 8 432 tests across 632 files
pnpm --filter @sandforge/shared test -- hash-utils.property  → 4 / 4 passed
pnpm --filter ./packages/extension test -- ErrorClassifier.property  → 4 / 4 passed
pnpm --filter ./packages/extension test -- DiffEngine.property         → 4 / 4 passed
pnpm --filter ./packages/extension test -- GovernorLimitPredictor.property  → 4 / 4 passed
pnpm --filter ./packages/extension test -- DeltaDetector.property      → 4 / 4 passed
```
