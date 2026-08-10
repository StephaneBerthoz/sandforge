# Contributing to SandForge

Thanks for the interest. SandForge is a VS Code extension shipped to the
marketplace. Patches are welcome. Please follow the conventions below so
review stays fast.

## Prerequisites

- **Node** 22+ (a `.nvmrc` is committed; run `nvm use` or `fnm use`).
- **pnpm** 11, pinned via the `packageManager` field in the root
  `package.json` (`pnpm@11.18.0`). With Corepack enabled
  (`corepack enable`) the right version is selected automatically.
  `pnpm-workspace.yaml` uses pnpm ≥ 10 settings (`allowBuilds`,
  `overrides`, `catalog`), so older pnpm versions will not install
  correctly.
- **VS Code** 1.95+ if you want to test the extension host locally.

## Setup

```bash
git clone https://github.com/StephaneBerthoz/SANDFORGE.git
cd SANDFORGE
pnpm install          # also installs the git pre-commit hook (prepare script)
pnpm validate         # build:shared + typecheck + lint + test + audit:disposables + build
```

## Workspace layout

```
packages/
  shared/          # @sandforge/shared — protocol types, zod schemas, utils
  extension/       # VS Code extension host (esbuild → dist/extension.js)
  webview/         # React 18 + Vite + Tailwind + Zustand UI
.planning/         # current milestone phases (active development docs)
docs/              # module guides, ADR/, archive/ (historical genesis docs)
scripts/           # repo-wide tooling (audit-disposables, soak-test, hooks)
```

## Commit conventions

Conventional Commits: `<type>(<scope>): <subject>`. Types:
`feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `chore`, `style`,
`ci`, `build`. Keep subject under 70 chars. Body explains the *why*.

Atomic commits preferred. Don't mix unrelated changes.

A **pre-commit hook** (`scripts/git-hooks/pre-commit`, auto-installed via
`core.hooksPath` by the root `prepare` script) runs on every commit:

1. `pnpm -r typecheck`: the webview tsc is the historical blind spot of
   the extension-only vitest runs.
2. A duplicate-top-level-key scan over `packages/webview/src/i18n/locales/*.json`:
   `JSON.parse` silently keeps the second duplicate key, which once wiped
   whole module translations in production.

Bypass with `--no-verify` only if you really have to (don't).

## Branching

- Fork or branch off `master`.
- Branch name should describe the work: `fix/sync-conflict-merge`,
  `feat/forge-cycle-cap`. Auto-runs use `auto/<purpose>-YYYYMMDD-HHmm`.
- PRs require green CI (`.github/workflows/ci.yml` runs on
  ubuntu/macos/windows for typecheck + lint + test + build, plus
  Playwright E2E on Windows).

## Tests

- All new logic must have unit tests (`vitest`, colocated `*.test.ts`,
  one test file per source file, next to it).
- Run per package: `pnpm --filter @sandforge/shared test`,
  `pnpm --filter sandforge test` (extension), `pnpm --filter @sandforge/webview test`.
  Targeted: `pnpm --filter @sandforge/extension exec vitest run <pattern>`.
- Coverage: `pnpm test:coverage` (v8 provider, per package).
- E2E tests live in `packages/webview/e2e/` (Playwright):
  `pnpm --filter @sandforge/webview e2e`.
- Mutation testing with Stryker: `pnpm stryker`
  (`pnpm stryker:incremental` for faster local loops; config in
  `stryker.conf.json`).
- The full suite runs in ~3 minutes locally and is required green
  pre-merge.

## Code conventions

- **TypeScript strict** everywhere (`tsconfig.base.json`: `strict`,
  `noImplicitReturns`, `noUnusedLocals/Parameters`,
  `noFallthroughCasesInSwitch`).
- **`@typescript-eslint/no-explicit-any` is an error**: type the boundary
  or use `unknown` + narrowing.
- **i18n**: any user-facing UI string must go through i18next in all
  **6 languages** (`en`, `fr`, `de`, `es`, `ja`, `pt-BR`) in
  `packages/webview/src/i18n/locales/`. Extension-side strings use
  `package.nls.*.json` (`%key%` placeholders).
- **Message contract (zero-drift rule)**: every bridge message literal has
  both a Zod schema entry (`msg('domain:verb')` in
  `packages/shared/src/bridge/messageSchemas.ts`) **and** a TS interface in
  the matching `packages/shared/src/types/messages/<domain>.messages.ts`
  file, wired into a directional union in `index.ts`. The anti-drift
  coverage test (`types/messages/coverage.test.ts`) walks both sides and
  fails on any orphan in either direction. New message = both sides +
  the test stays green. See `docs/ADR/0002-message-contract-zero-drift.md`.
- Shared devDependency versions come from the **pnpm catalog** in
  `pnpm-workspace.yaml` (`"vitest": "catalog:"`), bump them there, once.

## Linting / formatting

- ESLint runs via `pnpm lint`; auto-fix with `pnpm lint:fix`.
- Prettier runs via `pnpm format` (writes) or `pnpm format:check` (CI-style).

## Disposable hygiene

The extension manages many disposables (timers, listeners, panels). The
`pnpm audit:disposables` script (wired into `pnpm validate`) walks every
`setInterval` / `setTimeout` / `addEventListener` / `onDid*` call and
fails the build if the result is not retained somewhere reasonable
(`subscriptions.push`, `Map.set([disp])`, `clearTimeout/Off/Remove`,
`.dispose()` lookup). Adding a new listener? Make sure it has a sink.

## Security

See [SECURITY.md](SECURITY.md) for the responsible disclosure flow.
Do **not** open public issues for security findings; email instead.

When changing code that touches credentials, SOQL/SOQL-like construction,
CSP nonces, or the webview ↔ extension bridge, mention it explicitly in
the PR description so reviewers focus there.

## Release flow

Releases are cut from `master` after `pnpm validate` is green.

1. `./scripts/bump-version.sh <patch|minor|major|x.y.z>`: syncs the
   version across the workspace `package.json` files.
2. Update `changelog.md` (root) and `packages/extension/CHANGELOG.md`.
   Keep both in semver-descending order.
3. `./scripts/pre-publish-check.sh`: marketplace readiness gate
   (validate + package + VSIX/bundle size checks).
4. `pnpm package` builds the VSIX with `@vscode/vsce`
   (`--no-dependencies`, output `sandforge.vsix`).
5. Tag `v*`: `.github/workflows/release.yml` takes over from the tag.

Maintainers handle versioning (SemVer).

## Where to start

- Browse `.planning/phases/<latest>/` for the current focus area.
- Look at `changelog.md` `## [Unreleased]` for in-flight work.
- `docs/ADR/` records the standing architectural decisions.
- `pnpm audit:disposables` and `pnpm knip` surface low-hanging quality
  improvements.
