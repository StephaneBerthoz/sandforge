# Stryker Baseline — Phase 02

**Date:** 2026-04-24
**Stryker version:** 8.7.1 (`@stryker-mutator/core` + `@stryker-mutator/vitest-runner`)
**Node:** v25.9.0
**Runner:** vitest (config: `packages/shared/vitest.config.ts`)
**Scope:** `packages/shared/**` + `packages/extension/src/{core/engine,modules/{compare,sync,monitor}}/**` (per `stryker.conf.json` mutate globs)
**Flags:** `--ignoreStatic --timeoutMS 60000 --concurrency 4` (see "Deviations" below)

## Overall mutation score

- **Score (covered mutants only):** **91.24 %**  — above `break: 60` threshold
- **Score (all mutants, including NoCoverage):** **6.25 %**  — below `break: 60`; reflects `packages/shared`-only test coverage (see "Known scope limitation" below)

The covered-mutant score is the meaningful number for a Phase 02 baseline. The total score is pulled down because the Vitest runner was wired to the `packages/shared` config only, so extension-side tests never executed → 7 457 mutants reported `NoCoverage`. See the known-scope section and the backlog for the follow-up to fix the runner config in Phase 02-follow-up / v1.4.

## Aggregate counts (8 005 tested mutants)

| Bucket      | Count |
|-------------|-------|
| Killed      | 494   |
| Survived    | 48    |
| Timeout     | 6     |
| NoCoverage  | 7 457 |
| RuntimeErr  | 0     |

## Per-module breakdown

| Module | Mutants | Killed | Survived | Timeout | NoCov | Score (total) | Score (covered) |
|---|---|---|---|---|---|---|---|
| `packages/shared/src/utils`                | 494  | 445 | 42 | 6 | 1   | 91.30 % | 91.48 % |
| `packages/shared/src/services`             | 56   | 49  | 6  | 0 | 1   | 87.50 % | 89.09 % |
| `packages/shared/src/bridge`               | 294  | 0   | 0  | 0 | 4*  | 0.00 %  | n/a     |
| `packages/extension/src/core/engine`       | 1522 | 0   | 0  | 0 | 1522 | 0.00 % | n/a     |
| `packages/extension/src/modules/compare`   | 1191 | 0   | 0  | 0 | 1191 | 0.00 % | n/a     |
| `packages/extension/src/modules/sync`      | 2841 | 0   | 0  | 0 | 2841 | 0.00 % | n/a     |
| `packages/extension/src/modules/monitor`   | 1897 | 0   | 0  | 0 | 1897 | 0.00 % | n/a     |

\* `packages/shared/src/bridge` shows 294 mutants but only 4 NoCoverage in this row because `messageSchemas.ts` is excluded via the `!packages/shared/src/schemas/**` pattern and `protocolVersion.ts` has 4 literal constants Stryker classifies as static/no-coverage once `ignoreStatic` is on.

### Named fast-check target modules (for Plan 02-02 correlation)

| File | Mutants | Killed | Survived | Timeout | NoCov | Score |
|---|---|---|---|---|---|---|
| `packages/extension/src/core/engine/ErrorClassifier.ts`             | 59  | 0 | 0 | 0 | 59  | NoCoverage — not exercised by `packages/shared` vitest config |
| `packages/extension/src/modules/compare/DiffEngine.ts`              | 131 | 0 | 0 | 0 | 131 | NoCoverage — idem |
| `packages/extension/src/modules/sync/DeltaDetector.ts`              | 53  | 0 | 0 | 0 | 53  | NoCoverage — idem |
| `packages/extension/src/modules/monitor/GovernorLimitPredictor.ts`  | 123 | 0 | 0 | 0 | 123 | NoCoverage — idem |

These four modules are the primary Plan 02-02 fast-check targets. Once the Stryker runner is re-pointed (see follow-ups below), the property tests from 02-02 will be the tests that kill mutants here.

## Wall-time

| Phase | Duration |
|---|---|
| Smoke (single file `hash-utils.ts`)   | ~1 min 19 s |
| Full baseline run                      | **3 min 12 s** |
| &nbsp;&nbsp;↳ instrumentation          | ~11 s |
| &nbsp;&nbsp;↳ initial dry-run (vitest) | ~40 s |
| &nbsp;&nbsp;↳ mutation phase           | ~1 min 55 s |

Well under the 45-minute CI hard cap (P-02.1). With `--ignoreStatic` the run shrank from an estimated 4h 57m to 3m 12s (290 static mutants were responsible for 99 % of the time per Stryker's planner warning).

## Thresholds

- `high = 80`, `low = 60`, **`break = 60`**
- CLI exit code: **1** (Stryker's total-score comparison triggered break on 6.25 %).
- Workflow will therefore FAIL on this baseline in CI until one of:
  1. the runner is re-scoped (see follow-up #1 below), **or**
  2. the extension mutate globs are temporarily excluded, **or**
  3. `break` is adjusted to allow NoCoverage until Phase 02-02 / v1.4 follow-up lands.

## Verdict

**`BASELINE_ACCEPTED`** — per Phase 02-CONTEXT open question 1 and P-02.3 ("accept the baseline for this phase, carry to v1.4 as a backlog item"). The shared utilities already exceed the 60 % break threshold on covered mutants; the extension-side 0 % is a **test-discovery scope gap**, not a quality gap.

## Deviations from plan

1. **`--ignoreStatic` added** to the local invocation: Stryker emitted a `MutantTestPlanner` warning ("290 static mutants estimated to take 99 % of the time"). The first full run was extrapolating to ~5 h remaining after 2 min of wall-time. Per P-02.1 wall-time mitigations + the execution-note allowance to "accept whatever baseline can be produced", the static mutants were skipped. Follow-up: evaluate whether `ignoreStatic: true` belongs in `stryker.conf.json` permanently (4 % of mutants, but 99 % of time).
2. **Stryker CLI invocation used `pnpm exec stryker run …`** rather than `pnpm stryker run …`. The root `scripts.stryker = "stryker run"` definition concatenated with `pnpm stryker run --mutate X` produced `stryker run run --mutate X`, and Stryker interpreted the second `run` as a config file name → `Invalid config file "run". File does not exist!`. The `pnpm exec` form bypasses the script wrapper. The root script remains valid when invoked without extra args (`pnpm stryker` or `pnpm stryker:incremental`).
3. **Total score 6.25 % vs expected ≥ 60 %**: `stryker.conf.json` wires `vitest.configFile = packages/shared/vitest.config.ts`, so only `packages/shared/**` tests actually run. Extension-side mutate globs produce mutants but have zero tests executing → all `NoCoverage`. This is a Stryker-runner scope issue that was not anticipated when the plan was written. Fix path captured in follow-up #1.

## Next-step backlog (top survivors to revisit in v1.4 / Phase 06)

Ranked by survivor count on the modules that DID get coverage:

- [ ] `packages/shared/src/utils/sf-utils.ts` — **18 survivors** (SFID alphanumeric-range boolean checks at L24-26, `id` method expressions).
- [ ] `packages/shared/src/utils/validation-utils.ts` — **9 survivors** (cron regex boundary anchors at L49/67, `isValidCron` conditional at L44/66, `.trim()` method).
- [ ] `packages/shared/src/utils/string-utils.ts` — **8 survivors** (toCamelCase / toKebabCase regex anchors at L19-20/33, truncate string-literal at L52).
- [ ] `packages/shared/src/services/ConflictDiffService.ts` — **6 survivors** (boolean short-circuits L54/97/104/114/121, trailing empty StringLiteral at L141).
- [ ] `packages/shared/src/utils/hash-utils.ts` — **4 survivors** (loop-boundary `i <= str.length` at L11, `padStart('','0')` at L20, arithmetic swaps in `checksum` at L27).
- [ ] `packages/shared/src/utils/date-utils.ts` — 1 survivor.
- [ ] `packages/shared/src/utils/execution-result.ts` — 1 survivor (`determineExecutionStatus` empty-array short-circuit at L31).
- [ ] `packages/shared/src/utils/format-utils.ts` — 1 survivor.

These are exactly the boundary / regex-anchor / constant mutants that fast-check property tests in Plan 02-02 are likely to kill for the four named modules — and that Phase 06 "bug bash" can finish off for the shared utilities.

## Known scope limitation (critical — read before Phase 02-02 execution)

The current Stryker config runs Vitest via `packages/shared/vitest.config.ts`. This means:

- Tests co-located under `packages/extension/src/**/*.test.ts` (including `ErrorClassifier.test.ts`, `DiffEngine.test.ts`, etc.) **do not execute** during Stryker runs.
- All mutants in `packages/extension/src/{core/engine,modules/*}` register as `NoCoverage`.
- Overall score is artificially low (6.25 %) even though the covered subset is strong (91.24 %).

**To repair** (follow-up for Plan 02-02 or a v1.4 chore): either (a) add a second Vitest project pointing at `packages/extension/vitest.config.ts` via Stryker's `vitest.configFile` array semantics if supported, (b) run Stryker twice — once per package — with sharded configs, or (c) add a multi-package top-level Vitest config that imports both sub-configs. Option (c) mirrors the existing `pnpm -r test` flow most cleanly.

Until that fix lands, CI must either honor the `BASELINE_ACCEPTED` verdict, loosen `break` temporarily, or pin the mutate globs to `packages/shared/**` only.

## CI behavior

- Nightly run at `06:00 UTC` + manual dispatch via `workflow_dispatch`.
- `break: 60` — workflow fails if mutation score drops below 60 %.
- Opt-out: add `skip-stryker` label to PR (guard already in `.github/workflows/stryker.yml`).
- HTML report uploaded as `stryker-html-report` artifact (30-day retention).
- JSON report uploaded as `stryker-json-report` artifact (90-day retention) for long-term trending.
- Hard timeout `timeout-minutes: 45` on the GitHub runner (P-02.1 wall-time cap).

## Follow-ups captured for v1.4 / Phase 06

- [ ] **Fix Stryker Vitest scope** — point the runner at a multi-project Vitest config so extension-side tests execute during mutation runs (currently 7 457 of 8 005 mutants are NoCoverage because only `packages/shared` tests run). Highest-priority follow-up — gates any meaningful total-score measurement.
- [ ] Promote Stryker to per-PR blocking once baseline stabilizes ≥ 70 on covered mutants across **both** shared and extension scopes.
- [ ] Consider making `ignoreStatic: true` permanent in `stryker.conf.json` — 290 static mutants represented 99 % of run time; they rarely yield useful signal.
- [ ] Shard mutate globs if single-runner wall-time exceeds 45 min once the extension scope is wired in.
- [ ] Revisit exclusions (schemas, constants, i18n) — may yield additional mutation opportunities once the runner scope is broadened.
- [ ] Kill the top survivors list (sf-utils / validation-utils / string-utils / ConflictDiffService / hash-utils) in Phase 06 "bug bash" or carry to v1.4.

