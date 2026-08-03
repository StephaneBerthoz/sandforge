# 0001 — pnpm 11 settings migration

**Status:** Accepted
**Date:** 2026-08-03

## Context

The workspace relied on pnpm settings that moved around between major
versions: build-script approvals (`onlyBuiltDependencies`) and security
`overrides` (CVE-driven pins for `minimatch`, `picomatch`, `lodash`,
`rollup`, `flatted`) had to live in `pnpm-workspace.yaml`, and the
build-approval key itself was renamed by pnpm 11 (`allowBuilds`). A wrong
override once flipped `@vscode/vsce` to an incompatible `minimatch` major
and broke `vsce package` (see the 1.2.6 changelog). Version drift between
contributors' pnpm clients made these settings behave inconsistently.

## Decision

- Pin the package manager: `"packageManager": "pnpm@11.18.0"` in the root
  `package.json`, plus `"engines": { "pnpm": ">=11" }`. Corepack /
  `pnpm/action-setup@v4` both honor the pin — CI takes its pnpm version
  from the `packageManager` field, never from a workflow-level hardcode.
- Keep all pnpm settings in `pnpm-workspace.yaml`:
  - `allowBuilds` (pnpm 11 spelling) approves `esbuild`, `keytar`,
    `@vscode/vsce-sign` build scripts and explicitly blocks the
    `core-js*` postinstall funding banner. The legacy
    `onlyBuiltDependencies` list stays alongside for pre-11 clients;
    `allowBuilds` is authoritative.
  - `overrides` carry only CVE-closing pins, each with a comment naming
    the advisory and any consumer constraint (e.g. `minimatch` capped at
    `<4` because vsce's CJS-default interop only works on 3.x).
- Shared devDependency versions are centralized in the workspace `catalog:`
  and referenced as `"catalog:"` from the package manifests.

## Consequences

- Contributors need Corepack enabled or pnpm ≥ 11 installed; older clients
  fail fast instead of silently mis-resolving.
- One file (`pnpm-workspace.yaml`) is the single place to audit for
  dependency policy; CI and local installs cannot diverge on pnpm version.
- Changing an override is a deliberate, reviewable diff — that is the
  point.
