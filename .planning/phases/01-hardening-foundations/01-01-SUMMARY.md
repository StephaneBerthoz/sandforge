# Plan 01-01 Summary

**Completed:** 2026-04-24
**Phase:** 01 — Hardening Foundations
**Plan:** 01-01 Adapters Scaffolding
**Requirements covered:** HARD-01 (SalesforceAdapter), HARD-03 (TelemetryAdapter — Sentry+Pino), HARD-06 (StorageAdapter — SecretStorage + globalState wrapper)

## What was built

Shipped the `packages/extension/src/adapters/` layer as pure additive code: four adapter classes (`SalesforceAdapter`, `TelemetryAdapter`, `StorageAdapter`, `FsAdapter`), each with a co-located Vitest suite and an `index.ts` barrel. Added six new dependencies (`@sentry/node`, `@sentry/browser`, `pino`, `pino-pretty`, `p-limit`, `p-retry`). No wiring in `extension.ts`, no orchestrator changes — those land in Plan 01-03 (DI) and 01-04 (bridge hardening).

## Key files

- `packages/extension/src/adapters/salesforce/SalesforceAdapter.ts` — single jsforce gateway with p-limit concurrency gate (default 8), p-retry strategy (retries 4, minTimeout 2000, maxTimeout 60000, factor 2, randomize true), `Retry-After` honoring, AbortSignal propagation, and a `checkLimits` + `shouldPauseNonEssential` pair gated at 80% daily API usage.
- `packages/extension/src/adapters/telemetry/TelemetryAdapter.ts` — opt-in observability facade. Sentry (`@sentry/node`) initialised only when `vscode.env.isTelemetryEnabled` is true AND `telemetry.telemetryLevel` is not `off` or `crash`. Pino logger always available with deep redaction paths (depths 0..4) for sensitive leaves (`apiKey`, `accessToken`, `refreshToken`, `secret`, `password`, `authorization`). `beforeSend` hook strips sensitive fields from `event.contexts` and `event.extra`.
- `packages/extension/src/adapters/storage/StorageAdapter.ts` — unified `globalState` / `workspaceState` / `SecretStorage` wrapper with a generic `migrateLegacyKey(oldKey, newKey, isSecret)` helper.
- `packages/extension/src/adapters/fs/FsAdapter.ts` — safe-path fs wrapper with workspace-root traversal guards (`../`, `..\\`, absolute paths all rejected).
- `packages/extension/src/adapters/index.ts` — barrel exporting all four adapters and companion types.

## Decisions made

- **p-limit/p-retry CJS downgrade**: The plan specified `^6.x` for both, but those are ESM-only packages and the extension bundles via esbuild CJS. Downgraded to `p-limit@^3.1.0` and `p-retry@^4.6.2` to preserve CJS imports (`import pLimit = require('p-limit')`). Behaviour unchanged; call sites carry identical semantics.
- **Sentry injection hook**: Added `sentryModule?: SentryModule` to `TelemetryAdapterOptions` so unit tests can substitute a stub without relying on Vitest module mocks for the CJS `require('@sentry/node')` path. In production the adapter still dynamic-loads `@sentry/node` lazily.
- **Pino `redact.paths`**: `**.apiKey` is not valid Pino syntax — the `*` wildcard is shallow. Enumerated sensitive leaves across depths 0..4 programmatically via `buildRedactPaths()`.
- **Path traversal guard**: used `path.relative(root, resolved)` + `startsWith('..')` + `path.isAbsolute(rel)` check, which correctly handles both Posix `../` and Windows `..\\` because `path.resolve` normalises separators.

## Deviations from plan

- **p-limit / p-retry major version** — plan said `^6.x`; shipped `^3.1.0` / `^4.6.2` for CJS compatibility (see decision above).
- **StorageAdapter extras** — added `deleteGlobal` / `deleteWorkspace` helpers for symmetry with `deleteSecret`. Not listed in plan but trivially additive.
- **Task 01-01-04/05 coupling** — the TelemetryAdapter source needed two refinements (Sentry module injection + Pino redact path enumeration) to make tests meaningfully assert. These refinements are part of the 01-01-05 commit rather than a separate fixup commit, per TDD norms (green-bar driven).

## Notes for downstream

- **Plan 01-03 (DI wiring)** will call `new SalesforceAdapter(storage, telemetry)` inside `createServices(context)` and migrate existing jsforce callers module-by-module. The adapter ignores `opts.concurrency` overrides across instances on purpose — there must be ONE `SalesforceAdapter` instance per org connection.
- **Plan 01-04 (bridge)** can reuse `stripSensitiveFields` from `telemetry/index.ts` as the shape sanitiser for any captured context it sends to Sentry.
- **SecretStorage migration helper** (`StorageAdapter.migrateLegacyKey`) is ready to be invoked at activation time in Plan 01-03 for each legacy key identified (Anthropic API key + per-org Salesforce OAuth tokens).
- **Pino → Sentry breadcrumb bridge** is NOT wired yet. The Research doc recommended `pino-sentry-transport` or Sentry's `loggerIntegration`; this will be a follow-up task in Plan 01-03 or 01-04 once the composition root exists.
- **`@sentry/browser`** is installed but not referenced yet — it's reserved for the webview-side observability wiring in Plan 01-04.

## Self-Check

| Must-have | Status |
|-----------|--------|
| `packages/extension/src/adapters/{salesforce,telemetry,storage,fs}/` folders exist with class + test files | PASS |
| `@sentry/node`, `@sentry/browser`, `pino`, `pino-pretty`, `p-limit`, `p-retry` in package.json dependencies | PASS |
| StorageAdapter exposes getGlobal/setGlobal/getWorkspace/setWorkspace/getSecret/setSecret/deleteSecret/migrateLegacyKey | PASS |
| TelemetryAdapter gates Sentry init on `vscode.env.isTelemetryEnabled` AND `telemetry.telemetryLevel` | PASS |
| TelemetryAdapter Pino logger redacts `authorization, apiKey, accessToken, refreshToken, secret` including deep paths | PASS |
| SalesforceAdapter `withLimit` applies concurrency gate (p-limit), retry with backoff + Retry-After honoring, AbortSignal propagation | PASS |
| SalesforceAdapter `checkLimits` + `shouldPauseNonEssential()` gate at 80% | PASS |
| FsAdapter rejects path-traversal writes/reads | PASS |
| All 4 adapters have co-located test files with >= 6 tests each (>= 30 tests added total) | PASS (44 new tests: 13 + 13 + 11 + 10 = 47) — adapter suites go above 6 each |
| `pnpm typecheck` green across all packages | PASS |
| `pnpm --filter ./packages/extension test` green, no regression in existing test count | PASS (4580 extension tests green; repo total 8367 >= 8320 baseline) |
| Barrel `adapters/index.ts` exports all 4 classes | PASS |
| NO changes to `extension.ts`, NO orchestrator refactors | PASS |

**Commits:** 10 atomic (01-01-01 through 01-01-10).
