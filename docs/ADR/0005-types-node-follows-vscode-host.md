# 0005: @types/node follows the VS Code host

**Status:** Accepted
**Date:** 2026-09-16

## Context

The repository runs on Node 24: `.nvmrc`, the root `engines.node` and CI all
say so, and the latest `@types/node` is several majors ahead. (It said Node 22
when this was written; the repository moved to 24 in 1.25.3, which changes
nothing here — the question below is about the editor's Node, not this one.) The extension's
`@types/node` stayed at `^20`, with nothing recording why, so it read as a
forgotten upgrade.

It is not one. The extension does not run on the repository's Node. It runs
in the VS Code extension host, whose Node is the one Electron embeds, and
`packages/extension/package.json` promises support back to `engines.vscode`
`^1.95.0`. VS Code 1.95.0 builds against Electron 32.2.1 (the `target` in its
`.npmrc`), which ships Node 20.18.0. Types from a newer Node would let code
call an API that host lacks, and `tsc` would not object.

The documented CLI (`packages/extension/cli`) is run through `tsx` on the
machine's own Node, 24. Node 20 types under-promise there and never break it.

## Decision

- The extension's `@types/node` major is the Node major of the oldest VS Code
  release in `engines.vscode`: `^20` while the floor is 1.95.
- `@types/node` and `engines.vscode` move together, in one change. Raising
  the floor means looking up the Electron target of that VS Code release and
  the Node it embeds, then moving `@types/node` to that major.
- `scripts/types-node-engines.test.mjs` enforces it: it holds the host Node
  per VS Code floor and fails when the floor has no entry or when
  `@types/node` names another major.

## Consequences

- `pnpm outdated` keeps listing `@types/node` as behind. That is expected and
  not a task.
- An API newer than the host's Node is a type error, not a runtime failure on
  users still on the oldest supported VS Code.
- Dropping old VS Code releases is what unlocks newer Node types, and the gate
  makes that a deliberate decision, taken in a single change.
