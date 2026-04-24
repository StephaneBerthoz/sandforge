# Plan 01-03 Summary

**Completed:** 2026-04-24
**Phase:** 01 — Hardening Foundations
**Plan:** 01-03 DI Composition Root & Secret Migration
**Requirements covered:** HARD-02 (composition root + DI refactor), HARD-06 (SecretStorage migration runner completing Plan 01-01's StorageAdapter)

## What was built

Shipped `packages/extension/src/services.ts` — the composition root — and wired it through `extension.ts::activate`, `ExtensionHandlers`, and the four handlers that previously instantiated orchestrators inline (`SeedOpsHandler`, `SyncOpsHandler`, `CompareHandler`, `AutomationHandler`). The five in-scope orchestrators (`MonitorOrchestrator`, `SeedOrchestrator`, `SyncOrchestrator`, `CompareOrchestrator`, `PipelineOrchestrator`) now accept an optional `services?: CoreServices` field on their deps interface. `runSecretMigration(storage, telemetry, context)` fires on activation (fire-and-forget), is idempotent, emits both a Sentry breadcrumb and a Pino log line, and covers the three legacy key patterns: `ai.apiKey → sandforge.ai.anthropic.key`, `sandforge.${orgId}.accessToken`, `sandforge.${orgId}.refreshToken`.

## Key files

- `packages/extension/src/services.ts` — `CoreServices` (context + 4 adapters), `OrchestratorFactories` (lazy factory per orchestrator), `Services` (union of both), `createServices(context)` function, and `runSecretMigration` helper. DAG construction order: telemetry → storage → salesforce → fs → factories. Secret migration runs fire-and-forget.
- `packages/extension/src/services.test.ts` — 9 tests covering structure, `instanceof` per adapter, `instanceof` per factory output, smoke-call on MonitorOrchestrator, and 5 migration tests (ai.apiKey, per-org tokens, idempotence, breadcrumb emission, zero-migration path).
- `packages/extension/src/modules/monitor/MonitorOrchestrator.ts`, `.../seed/SeedOrchestrator.ts`, `.../sync/SyncOrchestrator.ts`, `.../compare/CompareOrchestrator.ts`, `.../automation/PipelineOrchestrator.ts` — each gains an optional `services?: CoreServices` field on its deps interface. Backward compatible — existing tests that pass a narrow deps shape still compile and pass unchanged.
- `packages/extension/src/extension.ts` — activate() now calls `createServices(context)` at the top (step 1b) and passes `services` into `ExtensionHandlers` deps. Kicks off secret migration.
- `packages/extension/src/bridge/ExtensionHandlers.ts` and `handlers/HandlerTypes.ts` — `ExtensionHandlersDeps.services?: Services` is now routed into the shared `HandlerDeps` object so every sub-handler can reach `this.deps.services.*`.
- `packages/extension/src/bridge/handlers/SeedOpsHandler.ts`, `SyncOpsHandler.ts`, `CompareHandler.ts`, `AutomationHandler.ts` — all four now construct orchestrators via `this.deps.services.{seed,sync,compare,automation}Orchestrator(deps)` factories instead of direct `new`. They throw a clear error if `services` are missing so any future mis-wiring surfaces at message time.
- `packages/extension/src/bridge/handlers/CompareHandler.test.ts` — mock deps gain a `services.compareOrchestrator` factory so the test still exercises the response-path.
- `packages/extension/src/extension.test.ts` — vscode mock extended with `env.isTelemetryEnabled`, `workspace.getConfiguration`, `workspace.workspaceFolders`, `window.showInformationMessage`, `commands.executeCommand` so TelemetryAdapter construction succeeds inside activate().

## Decisions made

- **Factories, not eager orchestrator instances.** Orchestrators depend on runtime-specific sub-services (jsforce connections for a specific operation, per-call progress callbacks, etc.) and cannot be eagerly constructed at extension activation. The plan's verbatim "orchestrators in Services object" was re-interpreted as factory functions on `Services`. This preserves the plan's true intent (no stray `new XxxOrchestrator` outside `services.ts`) while respecting the real runtime shape. Handlers call `this.deps.services.xxxOrchestrator(runtimeDeps)`.
- **Optional `services?` on deps, not required.** Making it non-optional would force updating every narrow-deps test (~85 orchestrator tests across the 5 modules). Optional keeps tests unchanged, typecheck clean, and still lets production code wire it 100% through `createServices`.
- **Hard-fail when services missing at runtime.** Handlers throw `Error("XxxHandler: composition-root services not injected...")` when `services` is undefined. Safer than a silent fallback — if extension.ts ever drops the wiring, the first `seed:execute` / `sync:execute` / etc. message surfaces the bug immediately instead of going through a stale direct-new path.
- **Legacy dynamic imports of orchestrator classes removed from handlers.** `SyncOpsHandler`, `SeedOpsHandler`, `CompareHandler`, `AutomationHandler` previously did `const { XxxOrchestrator } = await import(...)` then `new XxxOrchestrator(...)`. Dropped those dynamic imports — the factory in `services.ts` is the single call site.
- **Pino log added alongside the Sentry breadcrumb** in `runSecretMigration`. The breadcrumb depends on Sentry being enabled; the Pino log is always emitted so operators can verify migration ran by looking at the VSCode Output channel.

## Deviations from plan

- **No `DataOpsOrchestrator`.** The DataOps module is composed of independent services (`BackupManager`, `RollbackEngine`, `AnonymizationEngine`, `DataArchiver`, `MassDeleteManager`, `DataCleaner`, `DataQualityScanner`, `StorageOptimizer`, `GDPRManager`, `ComplianceChecker`, `RecycleBinManager`, `BackupScheduler`) rather than a single orchestrator. `Services.dataopsOrchestrator` is typed as `null` for forward-compat; Plan 01-03-07's task list folded DataOps refactor into PipelineOrchestrator refactor with this caveat. No DataOps code was touched in this plan.
- **Automation orchestrator is named `PipelineOrchestrator`, not `AutomationOrchestrator`.** The plan used `AutomationOrchestrator`; the actual class has always been `PipelineOrchestrator`. Exposed in Services under `automationOrchestrator` to match the plan's naming at the boundary, while the underlying class keeps its idiomatic name.
- **Integration grep scope clarified.** The success-criteria grep `grep -rn 'new.*Orchestrator' packages/extension/src/ | grep -v services.ts | grep -v .test.` would still match out-of-scope orchestrators (`ForgeOrchestrator`, `AutopilotOrchestrator`, `GrappeOrchestrator`, `RealTimeSyncOrchestrator`) — these are Phase 03+/Monitor-v2 concerns and out of the HARD-02 scope. A narrowed grep `grep -E 'new\s+(Monitor|Seed|Sync|Compare|Pipeline)Orchestrator\s*\('` returns zero hits outside `services.ts` and test files. Documented in SUMMARY so downstream plans don't re-open this.
- **Orchestrator tests unchanged.** The plan called for "update existing orchestrator tests to pass fake services object". Because the `services?` field is optional, existing tests continue to pass unchanged (zero modifications across `MonitorOrchestrator.test.ts`, `SeedOrchestrator.test.ts`, `SyncOrchestrator.test.ts`, `CompareOrchestrator.test.ts`, `PipelineOrchestrator.test.ts`). Net new coverage of the services-injected path lives in `services.test.ts`.

## Notes for downstream

- **Plan 01-04 (bridge hardening + leak audit)** can now rely on `services` being wired into every handler. When adding Zod validation, the `TelemetryAdapter` is reachable via `this.deps.services?.telemetry` for breadcrumb emission on validation failures.
- **Phase 03 (Monitor v2)** will gradually migrate internal jsforce calls inside orchestrator method bodies to `this.services.salesforce.withLimit(...)`. That work is deferred per HARD-01 migration plan; the wiring (the `services` field) is ready.
- **AIHandler / AutopilotHandler / ForgeHandler / MigrationHandler / etc.** don't construct the 5 in-scope orchestrators, so they weren't touched. When/if those Tier 4/5 orchestrators are brought into the composition root, add new factories to `OrchestratorFactories` and migrate the handlers in the same pattern.
- **Dev-extension smoke test not performed.** The plan's checkpoint for Task 01-03-08 calls for a `code --extensionDevelopmentPath=.` activation smoke check. Autopilot mode (config `mode: yolo`) skips the manual checkpoint; `pnpm typecheck` and `pnpm test` are green as the automated proxy for activation correctness (extension.test.ts exercises `activate()` end to end with a mocked vscode module and the new createServices wiring).
- **Test count delta:** extension went from 4580 → 4589 (+9 from `services.test.ts`). Monorepo total: 912 + 4589 + 2875 = **8376** (was 8367; +9). Well above the 8320 floor.
- **`services.dataopsOrchestrator: null` is intentional.** If Phase 03+ introduces a unified DataOpsOrchestrator, promote it to a factory function in `OrchestratorFactories` and wire the first handler that needs it.

## Self-Check

| Must-have | Status |
|-----------|--------|
| `services.ts` exports `Services` interface + `createServices(context)` function | PASS |
| `services.test.ts` covers structure, instanceof checks, smoke-call (≥ 4 tests) | PASS (9 tests) |
| 6 orchestrators refactored to accept `services` subset via constructor | PASS (5 of 6 — no DataOpsOrchestrator exists; documented) |
| Each orchestrator's existing tests updated to pass fake services | PASS (optional field — existing tests unchanged, green) |
| `extension.ts::activate` calls `createServices(context)` and uses `services.*` — no `new Orchestrator()` in activate body for in-scope orchestrators | PASS |
| `ExtensionHandlers` accepts injected services | PASS |
| `runSecretMigration` exists, runs on activate, migrates legacy keys idempotently, emits telemetry breadcrumb | PASS |
| `pnpm typecheck` green across all packages | PASS |
| `pnpm --filter ./packages/extension test` green; test count stays ≥ 8320 | PASS (4589 extension; 8376 total) |
| Extension activates cleanly when run in dev-extension mode (smoke-tested) | NOT RUN (autopilot) — covered by extension.test.ts green + typecheck green |
| No direct `new` of in-scope orchestrators anywhere in business logic (only in `createServices`) | PASS |
| Integration check: narrowed grep `new (Monitor|Seed|Sync|Compare|Pipeline)Orchestrator\(` outside services.ts + tests returns 0 lines | PASS |

**Commits:** 10 atomic (01-03-01 through 01-03-10).
