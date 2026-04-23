# Phase 01: Hardening Foundations - Context

**Gathered:** 2026-04-23
**Status:** Ready for planning
**Mode:** Autopilot (decisions made autonomously based on research + codebase context)

## Phase Boundary

Ship the invisible-but-compounding plumbing that makes every subsequent phase safer and easier:
adapters layer for external IO centralization, composition-root DI, opt-in observability
(Sentry + Pino), dead-code cleanup (Knip), Zod validation for all WebView messages,
SecretStorage migration for credentials, and a disposable-hygiene leak audit.

**In scope:** HARD-01..07 (7 requirements)
**Out of scope:** Monitor v2 features (Phase 03), AI integration (Phase 04), CDC (Phase 05), BP-01..04 (Phase 06)

## Implementation Decisions

### HARD-01 — Adapters Layer & SalesforceAdapter

- **Folder structure:** `packages/extension/src/adapters/{salesforce,ai,telemetry,storage,fs}/` — one folder per IO domain, each with its own adapter class + tests
- **Migration strategy:** Gradual. Create `SalesforceAdapter` first, route NEW calls through it, migrate existing callers incrementally over Phase 01 by module (monitor → seed → sync → compare → dataops → automation). Each migration is its own task with its own commit for easy rollback.
- **Concurrency gate:** `p-limit(8)` — below jsforce default (10) for headroom. Wrap ALL jsforce calls, no exceptions.
- **Backoff:** exponential 2s → 4s → 8s → 16s, cap 60s, full jitter. `Retry-After` header overrides backoff when present.
- **Pre-flight check:** call `/limits` once on adapter init, pause non-essential probes if `DAILY_API_REQUESTS` usage > 80% and emit visible warning via telemetry adapter.

### HARD-02 — Composition Root

- **Pattern:** vanilla factory `createServices(context: vscode.ExtensionContext): Services` in `packages/extension/src/services.ts`. NO Inversify, NO tsyringe, NO decorators.
- **Typed Services interface:** every orchestrator + adapter exported as a field. Tests construct with fakes by calling `createServices` with a fake context and substituting fields.
- **Constructor injection:** orchestrators receive dependencies via constructor; no `new SomeService()` inside business logic.
- **Scope:** refactor MonitorOrchestrator, SeedOrchestrator, SyncOrchestrator, CompareOrchestrator, DataOpsOrchestrator, AutomationOrchestrator to accept injected dependencies. MessageRouter/ExecutionHandler stay as-is (already DI-friendly).

### HARD-03 — Sentry + Pino Observability

- **Opt-in default:** follows VSCode's `telemetry.telemetryLevel` setting. If setting is `off` or `crash`, Sentry is disabled. If `error` or `all`, Sentry is enabled. NO custom SandForge opt-in setting — reuse VSCode's.
- **Sentry projects:** TWO separate projects — `@sentry/node` for extension host, `@sentry/browser` for WebView. Distinct DSNs. Tagged with `orgId` (hashed SHA-256) + `moduleName` for faceted analysis.
- **Pino config:** NDJSON stdout only (no file writes — route through VSCode Output channel). `pino-pretty` in dev, raw NDJSON in prod. Redact fields: `['req.headers.authorization', 'config.apiKey', '*.accessToken', '*.refreshToken', '*.secret']`.
- **Breadcrumbs:** pino → custom Sentry transport wires `info` level and above as breadcrumbs; `error`+ captured as events.
- **Release tag:** pulled from `packages/extension/package.json#version` at build time via esbuild `define`.
- **`beforeSend` hook:** strip record values (PII risk) and OAuth tokens unconditionally.

### HARD-04 — Knip in CI

- **Adoption stance:** non-blocking report initially. Add `pnpm knip` to CI that publishes findings as a comment / artifact but does NOT fail the build. Promote to blocking check in v1.4 after the initial cleanup pass.
- **Config:** monorepo-aware config with explicit entry points per package (`packages/*/src/index.ts` + webview `main.tsx`); `ignoreBinaries: ['esbuild', 'vsce']` for tooling.
- **Initial cleanup:** scoped task — run Knip locally, triage findings, delete obvious dead code and unused devDependencies, PR each category as a distinct commit for easy review.

### HARD-05 — Zod WebView Message Validation + Protocol Version

- **Audit scope:** every handler in `packages/extension/src/bridge/handlers/*.ts` + every `postMessage` caller in webview.
- **Protocol version:** add `protocolVersion: number` field to all request/response message envelopes. Start at `1`.
- **Mismatch handling:** on version mismatch (webview ↔ extension), display user-friendly banner "SandForge was updated. Please reload the window to apply." with a button that calls `vscode.commands.executeCommand('workbench.action.reloadWindow')`.
- **Migration:** add schema for any message that currently lacks one; run contract test that exercises every route with valid + invalid payloads.
- **Removal of unsafe casts:** zero `as MessageType` without Zod parse. Replace with `schema.parse(raw)`.

### HARD-06 — SecretStorage Migration

- **Target:** Anthropic API key + all Salesforce OAuth tokens (access + refresh per org).
- **Migration flow:** on extension activation, check `globalState` for legacy keys; if found, silently move to `SecretStorage`, delete from `globalState`, log migration to telemetry (event only, no key content).
- **API:** centralize via `StorageAdapter.getSecret(key)` / `setSecret(key, value)` with scoped key format `sandforge.${orgId}.${field}`.
- **Anthropic key UX:** Settings page in WebView prompts for key once, stores via bridge message → `StorageAdapter.setSecret('sandforge.ai.anthropic.key', value)`.

### HARD-07 — Disposable Hygiene Audit

- **Audit targets:** every `EventEmitter`, `setInterval`, `setTimeout`, `onDidChange*`, `onDidReceiveMessage`, `workspace.onDid*`.
- **Fix pattern:** every such registration returns a `Disposable` pushed to `context.subscriptions`. Scan for orphan registrations via custom ts-morph script.
- **Soak test protocol:** boot extension with Monitor + 1 org subscription; measure RSS at t=0 and t=1h with no user interaction. Delta must be < 50 MB. Repeat after Monitor v2 MetricBus ships (Phase 03) for regression check.
- **Ring buffers:** any in-memory metric history capped at 1000 entries per metric; older goes to TimeSeriesStore (Phase 03 dependency — stub the store for now, real impl in Phase 03).
- **React:** audit webview for raw `useStore()` at component root (bad — full store subscription); enforce selector-only access.

### Claude's Discretion (delegated)

- ts-morph script shape for the disposable audit (write custom visitor or reuse existing pattern)
- Exact Zod schema composition (one schema per message vs shared message discriminator union — implementer's call based on ergonomics)
- Pino transport wiring details (worker thread vs sync in dev)
- Knip config granularity (aggressive vs conservative initial pass)

## Specific Ideas

- **PR per adapter domain** during HARD-01 migration so reviewers can verify each module's migration independently. Downstream planner should split tasks by module (6 modules = 6 migration tasks) + 1 scaffolding task.
- **Single migration helper** for HARD-06 secrets — don't write per-key migration logic; generic `migrateLegacyKey(oldKey, newKey)` that handles the pattern.
- **Soak test automation**: record RSS via `process.memoryUsage()` at activation + every 10min; emit to telemetry for observability of baselines in production.

## Canonical References

**Downstream agents MUST read these before planning or implementing.**

- `.planning/research/ARCHITECTURE.md` — Layer model diagram, adapters/ folder shape, composition-root pattern, MetricBus preview
- `.planning/research/STACK.md` — Confirms lib choices (Anthropic SDK direct, Sentry + Pino, Knip, composition root, NO Inversify/LangChain/Winston)
- `.planning/research/PITFALLS.md` — Sections P-1 (memory leaks), P-2 (API rate limits), P-4 (refactor breaks), P-7 (secret leakage) directly guide this phase
- `.planning/research/SUMMARY.md` — Strategic context for "why Hardening before AI/Monitor v2"

## Existing Code Insights

### Reusable Assets

- `packages/extension/src/bridge/MessageRouter.ts` — already has routing; needs Zod schema integration + protocolVersion envelope
- `packages/extension/src/bridge/handlers/*.ts` — 16+ domain handlers; each needs message schema audit
- `packages/extension/src/core/engine/BackgroundOperationRegistry.ts` — recently shipped (v1.2.4), good pattern reference for adapter-style APIs
- `packages/shared/src/types/messages.types.ts` — 1700+ lines of message types; needs protocolVersion field addition + Zod schemas per message

### Established Patterns

- Zod is already in `packages/shared/` — just need to use it everywhere
- `context.subscriptions` pattern is already used in some places — just needs audit for completeness
- Zustand store is already a single store (ready for slice refactor in Phase 06)
- `ConfigStore` wraps globalState with typed access — good pattern to mirror for `StorageAdapter`
- jsforce is imported directly in many places — this is the biggest refactor surface

### Integration Points

- `extension.ts` activation function → becomes `createServices(context)` call site
- All orchestrators → constructor-injected with Services
- MessageRouter → Zod validates every inbound message, rejects with protocol mismatch if version differs
- NotificationCenter (existing) → Sentry user feedback mechanism can layer on top

## Deferred Ideas

- **Pino pretty-print in Output Channel** (nice-to-have UX — defer to post-v1.3 polish)
- **`gitleaks` in CI** for secret scan (noted in pitfalls P-7; add to Phase 02 Test Hardening if scope allows)
- **OpenTelemetry direct integration** (beyond Sentry's OTel integration) — v1.4+ candidate; Sentry's OTel compatibility forward-protects us
- **Plugin-system extension point for monitor probes** — deferred to v1.4 per research recommendation; composition root already supports future addition

---
*Phase: 01-hardening-foundations*
*Context gathered: 2026-04-23 (autopilot mode)*
