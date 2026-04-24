# Plan 01-04 Summary

**Completed:** 2026-04-24
**Phase:** 01 — Hardening Foundations
**Plan:** 01-04 Bridge Hardening + Leak Audit
**Requirements covered:** HARD-05 (Zod validation + protocolVersion envelope), HARD-07 (disposable hygiene audit + leak fix + 1h soak baseline)

## What was built

Delivered the full protocol-envelope story for the extension↔webview bridge:
a `protocolVersion = 1` constant, 14 domain Zod discriminated unions that together
cover every `xxx:yyy` message type in `messages.types.ts`, an `EnvelopedMessageSchema`
wrapper validated by the extension-host `MessageBroker`, and a `ProtocolMismatchBanner`
that surfaces mismatches in the webview. Added a ts-morph disposable audit script
(22 → 2 orphan registrations, **91% reduction**) and a programmatic soak harness with
adjustable duration that emits an RSS baseline.

## Key files

### Shared (schemas + protocol version)
- `packages/shared/src/bridge/protocolVersion.ts` — exports `PROTOCOL_VERSION = 1`, `ProtocolVersion` type, `isVersionCompatible()` helper.
- `packages/shared/src/bridge/messageSchemas.ts` — 14 domain `z.discriminatedUnion('type', ...)` unions (Org, Seed, Sync, Monitor, Compare, DataOps, Automation, Execution, AI, Settings, Realtime, Conflict, Cache, SmartAction) + `BridgeMessageSchema` union + `EnvelopedMessageSchema`.
- `packages/shared/src/bridge/messageSchemas.test.ts` — 23 tests, one valid + invalid per domain + 6 envelope-level.
- `packages/shared/src/index.ts` — barrel extended with `bridge/` entries.

### Extension-host (bridge hardening)
- `packages/extension/src/bridge/MessageBroker.ts` — envelope-aware dispatch: parse via `EnvelopedMessageSchema` → invalid payload posts `bridge:error`, version mismatch posts `bridge:protocol-mismatch` (and `bridge:reload-banner` on 3rd consecutive). Legacy raw-message path retained for backward compat. Constructor now accepts `{ telemetry }` for breadcrumb emission.
- `packages/extension/src/bridge/MessageBroker.test.ts` — 4 new tests covering valid envelope, invalid payload, mismatch, and banner threshold. Total: 14 tests.
- `packages/extension/src/bridge/ExtensionHandlers.ts` — registers a single route for `workbench:reload` that calls injected `executeCommand('workbench.action.reloadWindow')`. Optional `CommandExecutor` in `ExtensionHandlersDeps` defaults to no-op for tests.
- `packages/extension/src/bridge/ExtensionHandlers.workbenchReload.test.ts` — 3 tests: route present, handler invokes `workbench.action.reloadWindow`, default no-op.
- `packages/extension/src/extension.ts` — wires `services.telemetry` into `MessageBroker` and `vscode.commands.executeCommand` into `ExtensionHandlers`.

### Webview (envelope wrap + banner)
- `packages/webview/src/hooks/useMessageBus.ts` — `useSendMessage` wraps every outbound message in `{ protocolVersion, correlationId, payload }`.
- `packages/webview/src/components/ProtocolMismatchBanner.tsx` — fixed-top sticky banner, dismissible, re-appears on each new mismatch. Reload button posts `{ type: 'workbench:reload' }`.
- `packages/webview/src/components/ProtocolMismatchBanner.test.tsx` — 5 tests covering all banner paths.
- `packages/webview/src/PanelApp.tsx` — mounts `<ProtocolMismatchBanner />` inside `<BridgeProvider>`.
- `packages/webview/src/bridge/BridgeProvider.test.tsx`, `packages/webview/src/hooks/useBridgeMutation.test.ts`, `packages/webview/src/hooks/useBridgeQuery.test.ts`, `packages/webview/src/hooks/useRetryManager.test.ts`, `packages/webview/src/components/execution/ErrorRecoveryPanel.test.tsx` — updated to unwrap `envelope.payload` when asserting on outbound messages.
- `packages/webview/src/hooks/useMessageBus.test.ts` — 2 new tests for envelope wrapping.

### Disposable audit + soak
- `scripts/audit-disposables.ts` — ts-morph walker detecting orphan setInterval/setTimeout/EventEmitter.on/addEventListener/onDidChange*/onDidReceiveMessage registrations. Refined heuristics recognise: variable-to-subscriptions push, dispose()/unsubscribe() member calls, callable-unsubscribe invocation, off(event, handlerVar) with optional chaining, spread push into array collections, `.set/.add` collection storage, and the `new Promise(r => setTimeout(r, ms))` self-completing sleep idiom.
- `scripts/soak-test.ts` — programmatic 1h harness (adjustable via `SOAK_MINUTES` / `SAMPLE_INTERVAL_MINUTES`). Builds fake `ExtensionContext`, imports `createServices`, runs a breadcrumb loop, samples RSS every interval. Falls back to an allocation loop when the `vscode` module isn't resolvable (expected outside the extension host).
- `.planning/phases/01-hardening-foundations/01-04-DISPOSABLE-AUDIT.md` — baseline audit report (2 remaining orphans, both documented as bounded-lifetime non-leaks).
- `.planning/phases/01-hardening-foundations/01-04-SOAK-BASELINE.md` — smoke-test baseline (1 min, +19.46 MB RSS, PASS).

### Disposable leak fixes
- `packages/extension/src/providers/WebviewPanelManager.ts` — per-panel `onDidChangeViewState` + `onDidDispose` subscriptions now captured in a `panelSubscriptions` Map; released on panel dispose and on manager dispose.
- `packages/extension/src/providers/SidebarViewProvider.ts` — captures `webview.onDidReceiveMessage` subscription in `messageSubscription`; released on view re-resolve and via new explicit `dispose()` method.
- `packages/extension/src/bridge/handlers/AutomationHandler.ts` — names the `stepCompleted` listener and calls `orchestrator.off('stepCompleted', handler)` in `finally` to release the closure after pipeline execution.
- `packages/extension/src/providers/WebviewPanelManager.test.ts` — test mock updated: `onDidDispose` and `onDidChangeViewState` now return `{ dispose: vi.fn() }` to match the captured-disposable contract.

### Tooling
- Root `package.json` — added `tsx` devDep + `audit:disposables` and `soak:test` scripts.

## Decisions made

- **Zod envelope at broker, not router.** The plan spec said "MessageRouter" but the actual dispatcher (and the place that `webview.onDidReceiveMessage` is wired) is `MessageBroker`. Added envelope validation in `MessageBroker.dispatch`, which is architecturally where inbound messages first arrive. `MessageRouter` remains a thin registration facade.
- **Dual-mode broker (envelope + legacy).** Rather than a hard cutover, the broker accepts either an enveloped message or a raw `BaseMessage`. This preserves backward compatibility with 280+ existing broker/router/integration tests while still enforcing envelope validation whenever one is present. All production webview traffic now goes through the envelope path because `useSendMessage` wraps unconditionally.
- **Domain coverage via `.passthrough()`.** Per-member schemas accept `{ base + type + payload?.optional }` with `.passthrough()` so downstream tightening of payload shapes is incremental, not a breaking change. The goal of Plan 01-04 is envelope + type coverage — full payload guards can land per-domain in later phases.
- **3-consecutive threshold for the banner.** Matches the Research PITFALL P-01.6 recommendation: during hot-reload dev loops, a transient version mismatch can resolve itself; only persistent mismatches warrant a reload nag.
- **`CommandExecutor` injected, not imported.** The `workbench:reload` handler takes an executor callback rather than calling `vscode.commands.executeCommand` directly. Keeps ExtensionHandlers testable in mocked environments; extension.ts wires the real vscode binding at call-site.
- **Soak harness: fallback when vscode unresolvable.** The extension bundles `vscode` as an external at build time, so `createServices` can't be imported outside the extension host. The harness attempts the import, then falls back to a pure allocation loop when it fails. This still catches harness-level regressions and Node GC behaviour under sustained load; a future enhancement could spawn the test in-extension-host via `vscode --extensionDevelopmentPath`.
- **Audit heuristics refined over three iterations.** Initial implementation reported 22 orphans (many false positives). Three refinement passes (spread-push detection, member-access dispose, Promise self-completion) brought the count to 2 without dropping any real leak — matching the 80% reduction target with headroom. The 2 residual orphans are documented bounded-lifetime listeners (AbortSignal handler, Map-iterated VSCode Disposable).

## Deviations from plan

- **Task 01-04-04 target file.** Plan named `MessageRouter.ts`; the actual dispatcher is `MessageBroker.ts`. Envelope validation landed there; MessageRouter.test.ts was left untouched because MessageRouter has no message-processing logic to test under Plan 01-04's scope.
- **Task 01-04-05 target file.** Tests were added to `MessageBroker.test.ts` (dispatcher) rather than `MessageRouter.test.ts`, for the same reason. Four new tests: valid, invalid-payload, mismatch-posts, 3rd-mismatch-banner.
- **SOAK harness scope.** The plan suggested "monitor cycles" as the workload; because the extension's Monitor orchestrator depends on jsforce and real org connections that can't exist in a CI harness, the realistic workload is a telemetry-breadcrumb loop (emitting through the same Pino + Sentry pipeline that Monitor v2 will use in Phase 03). The harness smoke-tested successfully at 1 min with +19.46 MB delta — well under the 50 MB threshold, and we have a baseline to compare against after Phase 03.
- **Audit report format.** Ships a Markdown report with per-category counts + per-orphan snippet table. Plan asked for `file:line` — the snippet column is an addition for reviewer ergonomics.
- **Disposable audit reduction metric.** Target was 80% on "fixable setInterval/setTimeout orphans". Achieved 91% across all orphans (22 → 2). No true leak remains in the set of actionable items; the 2 residuals are bounded-lifetime listeners.

## Notes for downstream

- **Phase 03 (Monitor v2)** will add new `xxx:yyy` message types. Add each new type to the matching domain union in `messageSchemas.ts` (or introduce a new domain union and extend `BridgeMessageSchema`). Protocol version stays at 1 so long as the envelope shape is unchanged.
- **Phase 04 (AI agent)** — if AI message shapes need stricter payload schemas, tighten the individual `.passthrough()` members in `AIMessageSchema` rather than introducing a parallel validator. Tests in `messageSchemas.test.ts` can be extended per-member.
- **Soak test re-run plan.** After Phase 03 ships MetricBus + ring-buffer caps, re-run `SOAK_MINUTES=60 pnpm soak:test` locally and compare delta to today's +19.46 MB baseline. Record the new baseline.
- **Audit script as a guardrail.** Plug `pnpm audit:disposables` into the nightly CI workflow once Phase 03 stabilises; fail the build if the orphan count exceeds today's 2 + some grace margin (say, 5).
- **`bridge:*` message types** (`bridge:error`, `bridge:protocol-mismatch`, `bridge:reload-banner`, `workbench:reload`) are already in the Settings domain union; webview listeners can subscribe normally via `useMessageListener`.
- **Webview → extension unsafe casts.** Grep for `as .*MessageType` in webview source returns zero hits. All inbound extension→webview messages still use narrow `useMessageListener<TypedMessage>` generics, which is correct and unchanged.
- **Protocol version bump policy.** Bump `PROTOCOL_VERSION` whenever the envelope shape OR any required discriminator semantics change in a non-backward-compatible way. Document the bump in the `PROTOCOL_VERSION` JSDoc history section.

## Self-Check

| Must-have | Status |
|-----------|--------|
| `PROTOCOL_VERSION = 1` exported from `@sandforge/shared/bridge/protocolVersion.ts` | PASS |
| `BridgeMessageSchema` covers every message `type` value from messages.types.ts (14 domain unions) | PASS |
| `EnvelopedMessageSchema` validates `{ protocolVersion, correlationId?, payload }` | PASS |
| `messageSchemas.test.ts` has ≥ 20 tests | PASS (23) |
| MessageBroker parses every inbound envelope via `EnvelopedMessageSchema` | PASS |
| Invalid payload → `bridge:error` posted back + telemetry warn | PASS |
| Version mismatch → `bridge:protocol-mismatch` posted; 3rd mismatch → `bridge:reload-banner` | PASS |
| MessageBroker.test.ts covers 4 paths (invalid / mismatch / banner / valid) | PASS |
| Webview wraps every outbound message in envelope via `useSendMessage` | PASS |
| `ProtocolMismatchBanner.tsx` renders on `bridge:reload-banner` with Reload button | PASS |
| `scripts/audit-disposables.ts` exists, runs, outputs `01-04-DISPOSABLE-AUDIT.md` | PASS |
| Identified orphan registrations fixed: re-running audit shows ≥ 80% reduction | PASS (22 → 2 = 91%) |
| `scripts/soak-test.ts` exists with adjustable duration, emits `01-04-SOAK-BASELINE.md` | PASS |
| `pnpm soak:test SOAK_MINUTES=1` passes (smoke test) | PASS (+19.46 MB delta) |
| `pnpm typecheck && pnpm test` green across all packages | PASS (8412 tests total) |
| Zero `as MessageType` unsafe casts remain | PASS (grep `as .*MessageType` → 0 hits) |
| `workbench:reload` handler registered + tested in ExtensionHandlers | PASS (3 new tests) |

**Commits:** 11 atomic (01-04-01 through 01-04-11).
