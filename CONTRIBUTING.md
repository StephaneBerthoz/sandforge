# Contributing to SandForge

Thanks for the interest. SandForge is a VS Code extension shipped to the
marketplace. Patches are welcome. Please follow the conventions below so
review stays fast.

## Prerequisites

- **Node** 22+ (a `.nvmrc` is committed; run `nvm use` or `fnm use`).
- **pnpm** 11, pinned via the `packageManager` field in the root
  `package.json`. With Corepack enabled
  (`corepack enable`) the right version is selected automatically.
  `pnpm-workspace.yaml` uses pnpm ≥ 10 settings (`allowBuilds`,
  `overrides`, `catalog`), so older pnpm versions will not install
  correctly.
- **VS Code** 1.95+ if you want to test the extension host locally.

## Setup

```bash
git clone https://github.com/StephaneBerthoz/sandforge.git
cd sandforge
pnpm install          # also installs the git pre-commit hook (prepare script)
pnpm validate         # the gates CI runs, bar the Playwright E2E suite and mutation testing
                      # (the list is the `validate` script in package.json)
```

## Workspace layout

```
packages/
  shared/          # @sandforge/shared — protocol types, zod schemas, utils
  extension/       # VS Code extension host (esbuild → dist/extension.js)
  webview/         # React 18 + Vite + Tailwind + Zustand UI
docs/              # module guides and ADR/ (standing decisions)
scripts/           # repo-wide tooling (audit-disposables, soak-test, hooks)
```

## Commit conventions

Conventional Commits: `<type>(<scope>): <subject>`. Types:
`feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `chore`, `style`,
`ci`, `build`. Keep subject under 70 chars. Body explains the _why_.

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
  `feat/forge-cycle-cap`.
- PRs require green CI: `.github/workflows/ci.yml` runs typecheck, test
  and build on ubuntu/macos/windows, then lint, the repository gates,
  coverage and Playwright E2E on ubuntu; a second job packages the VSIX
  and runs `scripts/pre-publish-check.sh` on it, and a third scans the
  history for secrets. The branch ruleset decides which of these a merge
  waits for; a red one also stops a release, which requires a green
  `ci.yml` run. Format Check and Knip run from their own
  workflows. All of them run Node 24, which is what `engines` promises and
  what development uses; the repository ran its gates on 22 until 1.25.3
  for no reason anyone had written down.

## Tests

- All new logic must have unit tests (`vitest`, colocated `*.test.ts`,
  one test file per source file, next to it).
- Run per package: `pnpm --filter @sandforge/shared test`,
  `pnpm --filter sandforge test` (extension), `pnpm --filter @sandforge/webview test`.
  Targeted: `pnpm --filter @sandforge/extension exec vitest run <pattern>`.
- Coverage: `pnpm test:coverage` (v8 provider, per package).
- E2E tests live in `packages/webview/e2e/` (Playwright):
  `pnpm --filter @sandforge/webview e2e`. Set `E2E_PORT` to a port of your
  own if you keep more than one checkout: the suite boots a Vite dev
  server, and two checkouts on the default 5173 end up sharing one server,
  so one checkout's sources answer the other one's assertions. With
  `E2E_PORT` set, the run always starts its own server and fails rather
  than borrowing a busy port.
- Mutation testing with Stryker: `pnpm stryker` mutates `packages/shared`
  (`stryker.conf.json`), `pnpm exec stryker run stryker.extension.conf.json`
  mutates the extension's execution engine. The Stryker workflow runs both
  on every push that changes the code they mutate, and nightly; each run
  fails below its config's `thresholds.break`.
- Smoke suite in a real VS Code: `pnpm --filter sandforge test:smoke`. It
  builds the whole workspace — the extension loads the shared package and the
  webview bundle, so a partial build has nothing to start — compiles
  `src/test/smoke/` through `tsconfig.smoke.json`, downloads a VS Code the
  first time (into `packages/extension/.vscode-test/`, gitignored) and starts
  it with the extension installed. It answers what every other suite mocks
  away: the extension activates, every contributed command reaches a handler,
  and the panel opens. On a headless machine, prefix it with `xvfb-run -a`, which is
  what the Smoke workflow does; under WSL it runs as it is. Its two tools are
  devDependencies of `packages/extension`: `@vscode/test-cli`, and
  `@vscode/test-electron`, which the CLI loads without declaring, so knip is
  told to ignore it.
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

## Accessibility warnings

`eslint-plugin-jsx-a11y` runs over `packages/webview/src/**/*.tsx` with its
recommended rules as warnings, not errors: the panel is not clean yet, and a
gate that fails on its first run is a gate somebody turns off. Today it reports
**28 warnings**, nearly all of them handlers on elements a keyboard does not
reach on its own:

| Rule                                            | Count |
| ----------------------------------------------- | ----- |
| `no-static-element-interactions`                | 8     |
| `click-events-have-key-events`                  | 7     |
| `no-noninteractive-element-interactions`        | 6     |
| `no-autofocus`                                  | 2     |
| `no-noninteractive-element-to-interactive-role` | 2     |
| `no-noninteractive-tabindex`                    | 2     |
| `label-has-associated-control`                  | 1     |

Bring the count down as you touch the files, and make the rules errors once it
reaches zero.

Two rules are off, for different reasons. `label-has-for` the plugin itself
deprecated, in favour of `label-has-associated-control`, which is on.
`control-has-associated-label` is off because it cannot see what the panel
does: controls are written as `<label><span>{t(key)}</span><input/></label>`,
where the accessible name comes from the label that wraps the control. That is
valid HTML and it is what a screen reader reads, but the rule inspects only the
control's own children, so it reported 58 of them. Following it would mean an
`aria-label` on each — a second name, overriding the visible one and drifting
from it at the next translation. What the rule claims to check is checked for
real by `packages/webview/e2e/axe-accessibility.spec.ts`, which runs the WCAG
2.1 AA rule set over every page in four VS Code themes.

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

Releases are cut from `master`, from a commit whose CI run is green —
`.github/workflows/release.yml` reads that conclusion and stops before the
bump if it is anything else. It reads `ci.yml` only, and the release commit
the workflow pushes starts no CI run of its own, so dispatch from a commit
CI ran on.

1. Update `changelog.md` (root) and `packages/extension/CHANGELOG.md`.
   Keep both in semver-descending order; the pre-publish gate refuses a
   version with no entry in either.
2. Run the workflow from the Actions tab (`workflow_dispatch`) with the
   bump type. It runs `scripts/bump-version.sh`, commits exactly the files
   that script writes plus the lockfile, tags, validates and packages.
3. The GitHub Release is drafted with the VSIX attached before the
   Marketplace publish, and undrafted once the Marketplace serves the new
   version. A publish that fails leaves the draft and the tag in place:
   re-run the workflow with `publish_only` to retry it without a bump.
   Until GitHub Actions is a bypass actor on the `master` ruleset, a
   dispatch cannot get this far: the ruleset requires status checks on
   every commit pushed to `master`, the release commit is new and has
   none, so the workflow's push of it is rejected before anything is
   published.
4. Locally, `pnpm package` builds the same VSIX with `@vscode/vsce`
   (`--no-dependencies`, output `sandforge.vsix`) and
   `SKIP_BUILD_CHECKS=1 bash scripts/pre-publish-check.sh` runs the
   marketplace readiness gates against it — the same pair CI runs on
   every pull request.

Maintainers handle versioning (SemVer).

## Where to start

- Look at `changelog.md` `## [Unreleased]` for in-flight work.
- `docs/ADR/` records the standing architectural decisions.
- `pnpm audit:disposables` and `pnpm knip` surface low-hanging quality
  improvements.
