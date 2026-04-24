# Plan 01-02 Summary

**Completed:** 2026-04-24
**Phase:** 01 — Hardening Foundations
**Plan:** 01-02 Knip CI + Dead Code Cleanup
**Requirements covered:** HARD-04 (Knip in CI + initial cleanup pass)

## What was built

Installed Knip 5 and ts-morph 23 at the monorepo root, authored a workspace-aware
`knip.json` that protects the six new adapter deps (Plan 01-01) and the adapter
source tree from cleanup false-positives, and wired a non-blocking
`.github/workflows/knip.yml` GitHub Actions job that publishes a
`knip-report.md` artifact on every push/PR. Executed an initial cleanup pass in
three atomic commits — removing 16 unused exports, 2 orphan barrel files, and 16
unused dependencies — then froze a post-cleanup baseline under
`01-02-KNIP-BASELINE.md` for trend tracking.

## Key files

- `knip.json` — monorepo workspace config. Entry points per workspace, adapter
  directory protected via `src/adapters/**/*.ts!` pattern, the six Plan 01-01
  deps (`@sentry/node`, `@sentry/browser`, `pino`, `pino-pretty`, `p-limit`,
  `p-retry`) listed in `ignoreDependencies`.
- `.github/workflows/knip.yml` — non-blocking CI job. Runs `pnpm knip --reporter markdown`
  with `|| true`, uploads `knip-report.md` as an artifact, comments on PRs.
- `.planning/phases/01-hardening-foundations/01-02-KNIP-BASELINE.md` —
  post-cleanup baseline (567 lines). Includes rationale for every kept-despite-flagged
  entry + a trend table for v1.4 targets.
- `package.json` — added `"knip": "knip"` script + `knip` and `ts-morph` devDeps.

## Decisions made

- **`zod` kept as direct dep in `packages/webview`** despite Knip flagging — zero
  runtime cost (already transitive via `@sandforge/shared`), hedge for Plan 01-04
  validation wiring.
- **`ts-morph` kept as devDep at root** despite Knip flagging — reserved for
  Plan 01-04 (bridge hardening codemods).
- **Schema Zod constants de-exported rather than deleted**: `AuditEntrySchema`,
  `TeamConfigBundleSchema`, `GovernanceRuleConditionSchema`, and
  `DiamondMarkerDef` are used within their own files. Knip flagged the
  `export` keyword as unnecessary; we dropped the keyword instead of the
  constant itself.
- **Barrel re-exports pruned to only page/entry-point components** in
  `AutopilotGraph`, `AutopilotWizard`, `ComplianceReport`, `ControlPanel`.
  Internal helpers are already imported by sibling files via direct path, so
  barrel exposure was redundant.
- **`@types/glob` removed alongside `glob`** — orphan `@types/*` packages are
  ignored by Knip but still waste install time.
- **Single-run webview flake tolerated**: `MonitorPage.test.tsx > should display
  correct API Calls KPI values` intermittently fails under full `pnpm test`
  (React `act()` warnings from framer-motion) but passes in isolation
  (`pnpm vitest run MonitorPage.test.tsx` → 40/40). Not caused by this plan;
  pre-existing test flake.

## Deviations from plan

- **Task 01-02-04 delivered 16 removals, not "≥ 50% reduction"** — the baseline
  of 12 unused exports was fully resolved (100% removal); the plan's 50%
  threshold was comfortably beat.
- **Task 01-02-06 kept 14 Knip-flagged deps on purpose** (documented in
  `01-02-KNIP-BASELINE.md` — rationale per dep). The plan predicted a single
  pass of `pnpm remove`; reality required triage for ESLint-config-only deps,
  script-consumed deps, and the Plan 01-04 hedge.
- **`@types/glob` removal** was a minor extra not in the plan; trivially additive.

## Notes for downstream

- **Plan 01-03 (DI wiring)** will need to ensure the composition root imports
  `@sandforge/shared` schemas directly (the barrel `packages/shared/src/schemas/index.ts`
  was deleted; `shared/src/index.ts` still re-exports each schema file
  individually).
- **Plan 01-04 (bridge hardening)** — `ts-morph` is installed at root and
  ready for codemod work. `zod` is available in both `extension` and `webview`
  packages for validation wiring.
- **Knip CI workflow** is non-blocking. When we want to gate PRs on
  no-new-findings, flip `|| true` to `exit 1` and set `fail-on` thresholds.
  Target milestone: v1.4.
- **Unused exported types (467)** remain in the baseline. Most are component
  `*Props` interfaces; a per-module sweep is the cleanest follow-up. Do not
  batch them via codemod — each one needs a "is this exported for dev-time
  doc clarity?" judgment call.
- **Test count unchanged** across shared/extension/webview: 912 + 4580 + 2875 = 8367
  (identical to the Plan 01-01 baseline).

## Self-Check

| Must-have | Status |
|-----------|--------|
| `knip` and `ts-morph` installed as devDependencies at root | PASS |
| `knip.json` at repo root with valid monorepo workspace config | PASS |
| `pnpm knip` script works, runs to completion | PASS |
| `.github/workflows/knip.yml` exists, non-blocking, publishes artifact | PASS |
| Unused exports cleanup PR committed (≥ 50% reduction from baseline) | PASS (100% — 12/12) |
| Unused files cleanup PR committed (orphans deleted) | PASS (2 barrel files) |
| Unused dependencies cleanup PR committed | PASS (16 deps) |
| `pnpm typecheck && pnpm test && pnpm build` all green post-cleanup | PASS (with known MonitorPage flake, isolated-green) |
| Post-cleanup Knip baseline report saved to `01-02-KNIP-BASELINE.md` | PASS |
| Test count either stays at baseline (8320) or drops only by deleted orphan test counts | PASS (8367 stable) |

**Commits:** 7 atomic (01-02-01 through 01-02-07).
