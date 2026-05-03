# Contributing to SandForge

Thanks for the interest. SandForge is a VS Code extension shipped to the
marketplace. Patches are welcome — please follow the conventions below so
review stays fast.

## Prerequisites

- **Node** 20+ (a `.nvmrc` is committed; run `nvm use` or `fnm use`).
- **pnpm** 9+ (the workspace pins `pnpm@9` via `engines`; CI runs pnpm 9).
- **VS Code** 1.95+ if you want to test the extension host locally.

## Setup

```bash
git clone https://github.com/StephaneBerthoz/SANDFORGE.git
cd SANDFORGE
pnpm install
pnpm validate          # typecheck + lint + test + audit:disposables + build
```

## Workspace layout

```
packages/
  shared/          # @sandforge/shared — protocol types, zod schemas, utils
  extension/       # VS Code extension host (esbuild → dist/extension.js)
  webview/         # React 18 + Vite + Tailwind + Zustand UI
.planning/         # current milestone phases (active development docs)
docs/              # historical phase docs + module guides
scripts/           # repo-wide tooling (audit-disposables, soak-test)
```

## Commit conventions

Conventional Commits — `<type>(<scope>): <subject>`. Types:
`feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `chore`, `style`,
`ci`, `build`. Keep subject under 70 chars. Body explains the *why*.

Atomic commits preferred. Don't mix unrelated changes.

## Branching

- Fork or branch off `master`.
- Branch name should describe the work: `fix/sync-conflict-merge`,
  `feat/forge-cycle-cap`. Auto-runs use `auto/<purpose>-YYYYMMDD-HHmm`.
- PRs require green CI (`.github/workflows/ci.yml` runs on
  ubuntu/macos/windows for typecheck + lint + test + build, plus
  Playwright E2E on Windows).

## Tests

- All new logic must have unit tests (`vitest`, colocated `*.test.ts`).
- E2E tests live in `packages/webview/e2e/` (Playwright).
- Run targeted tests during dev: `pnpm --filter @sandforge/extension exec vitest run <pattern>`.
- The full suite runs in ~3 minutes locally and is required green
  pre-merge.

## Linting / formatting

- ESLint runs via `pnpm lint`; auto-fix with `pnpm lint:fix`.
- Prettier runs via `pnpm format` (writes) or `pnpm format:check` (CI-style).
- A `PostToolUse` hook in this repo's `.claude/settings.local.json`
  auto-formats on edit when contributors use Claude Code.

## Disposable hygiene

The extension manages many disposables (timers, listeners, panels). The
`pnpm audit:disposables` script (wired into `pnpm validate`) walks every
`setInterval` / `setTimeout` / `addEventListener` / `onDid*` call and
fails the build if the result is not retained somewhere reasonable
(`subscriptions.push`, `Map.set([disp])`, `clearTimeout/Off/Remove`,
`.dispose()` lookup). Adding a new listener? Make sure it has a sink.

## Security

See [SECURITY.md](SECURITY.md) for the responsible disclosure flow.
Do **not** open public issues for security findings — email instead.

When changing code that touches credentials, SOQL/SOQL-like construction,
CSP nonces, or the webview ↔ extension bridge, mention it explicitly in
the PR description so reviewers focus there.

## Release flow

Releases are cut from `master` after `pnpm validate` is green.
See `.planning/phases/02-marketplace-publication/` for the marketplace
publication checklist. The release flow is automated via
`.github/workflows/release.yml` triggered on `v*` tags. Maintainers
handle versioning (currently SemVer).

## Where to start

- Browse `.planning/phases/<latest>/` for the current focus area.
- Look at `CHANGELOG.md` `## [Unreleased]` for in-flight work.
- `pnpm audit:disposables` and `pnpm knip` surface low-hanging quality
  improvements.
