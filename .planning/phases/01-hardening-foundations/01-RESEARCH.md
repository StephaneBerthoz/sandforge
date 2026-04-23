# Phase 01: Hardening Foundations — Research

**Researched:** 2026-04-23
**Phase:** 01 — Hardening Foundations (HARD-01..07)
**Sources:** `.planning/research/{STACK,ARCHITECTURE,PITFALLS}.md`, Anthropic/Sentry/Pino/Knip 2026 docs, jsforce rate-limit best practices

---

## Don't Hand-Roll

### Retry + backoff for jsforce calls

**Don't build your own retry loop.** Use `p-retry` or `async-retry` — both battle-tested, both support `AbortSignal`, both give full-jitter backoff without bugs.

- **Rejected alternative:** hand-rolled `while(attempt < max) { await sleep(delay); delay *= 2 }` — missing jitter, racy with `AbortSignal`, no `Retry-After` support.
- **Use:** `p-retry` (lighter, supports `AbortSignal` natively in v6+). Combine with `p-limit` for concurrency gate.
- **Config:** `retries: 4`, `minTimeout: 2000`, `maxTimeout: 60000`, `factor: 2`, `randomize: true`.
- **Honor `Retry-After`:** if `err.retryAfter` present, override computed delay with header value × 1000.

### Event emitter with typed events

**Don't hand-roll a typed event emitter.** Node's built-in `EventEmitter` is fine with a typed wrapper, or use `@bluelibs/sentient-ts` or `strict-event-emitter`.

- **Rejected:** custom PubSub class with `Map<string, Set<Handler>>` — no types, easy to leak via forgotten unsubscribe.
- **Use:** thin typed wrapper over Node's `EventEmitter` OR `mitt` (~200 bytes) if you need browser-compatible code in the webview.
- **Phase 01 scope:** MetricBus scaffolding lives here but full wiring is Phase 03 — just establish the typed-event pattern now.

### Pino → Sentry breadcrumb transport

**Don't write a custom Sentry transport for Pino.** Use `pino-sentry-transport` (official-ish, maintained) or `@sentry/integrations` `LoggerIntegration`.

- **Rejected:** `on('data', ...)` hook that calls `Sentry.addBreadcrumb` — misses log levels, blocks event loop, loses structured fields.
- **Use:** `@sentry/node` v8's native integration with `loggerIntegration({ levels: ['info', 'warn', 'error'] })` pattern → NDJSON from Pino is consumed as breadcrumbs automatically.

### VSCode SecretStorage wrapper

**Don't write a secrets cache.** VSCode's `SecretStorage` is already session-scoped with the OS keychain. Wrapping with a Map cache breaks cross-window consistency.

- **Rejected:** `class SecretCache { private cache = new Map(); async get(key) { ... } }` — stale reads after other window updates secret.
- **Use:** direct `context.secrets.get()` / `set()` / `onDidChange`. If perf matters (rare), add `subscribeOnce` on `onDidChange` to invalidate.

### Knip config for monorepos

**Don't reinvent dead-code detection.** Knip is the 2026 standard (ts-prune is archived, unimported is abandoned).

- **Config quirk:** monorepo needs `workspaces` in `knip.json` with per-workspace entry points. Default heuristic catches 80% but extensions need explicit `entry` for `activate()` function.
- **Start non-blocking:** first CI run as informational; promote to failing check after first cleanup pass.

### Disposable audit via ts-morph

**Don't scan with regex.** `setInterval(` in a string literal or comment will false-positive.

- **Use:** `ts-morph` `Project().getSourceFiles()` → walk `CallExpression` nodes → filter by identifier name (`setInterval`, `setTimeout`, `on`, `addEventListener`, `onDidChange*`) → check parent context for matching `dispose()` or `push(context.subscriptions)` registration.
- **Output:** list of `file:line` orphans; human decides fix pattern per site.

### Zod schema for discriminated unions (bridge messages)

**Don't write one schema per message type.** 200+ handlers × one schema each = maintenance nightmare.

- **Use:** `z.discriminatedUnion('type', [...])` with every message type's shape as a member. Single `parse` call on inbound message validates type + payload.
- **Pattern:** keep per-domain unions (e.g., `SyncMessage`, `SeedMessage`) and compose at router boundary. Avoids one mega-union.

---

## Common Pitfalls

### P-01.1 — `p-limit` applied at wrong layer

**Symptom:** concurrency gate wraps individual SOQL calls but multiple adapter methods fire independent limiters → effective concurrency = N × 8.

**Fix:** single `p-limit(8)` instance owned by `SalesforceAdapter`. Every method that hits jsforce goes through it. Don't construct `pLimit()` inside method bodies.

### P-01.2 — `setInterval` + `context.subscriptions`

**Symptom:** `setInterval` result (NodeJS.Timeout) isn't a `Disposable`. Pushing it directly doesn't work.

**Fix:** wrap in `{ dispose: () => clearInterval(handle) }` before pushing, or use `vscode.Disposable.from(() => clearInterval(handle))`.

### P-01.3 — Sentry `init()` called twice

**Symptom:** webview + extension host both init Sentry on same DSN → double-reporting, exhausted rate limits.

**Fix:** separate DSNs per project (`@sentry/node` extension host vs `@sentry/browser` webview). Tag with `environment: 'extension-host'` / `environment: 'webview'` for Sentry UI filtering.

### P-01.4 — `SecretStorage.onDidChange` fires on every write

**Symptom:** naive listener re-reads every secret on every change → thrash during migration.

**Fix:** filter by `event.key` against known keys before re-fetching. Debounce if migrating in batch.

### P-01.5 — Zod parse on hot path

**Symptom:** bridge handlers validate every message → 50-200 µs per parse × many messages/sec adds up.

**Fix:** compile schemas once at module load (`z.object(...)` is already cached internally), but don't re-construct schema in handler closure. Also: reject payload > 1 MB without parsing (DoS guard).

### P-01.6 — Protocol version mismatch during hot reload

**Symptom:** dev workflow rebuilds webview without extension restart → webview comes back with new `protocolVersion`, extension still on old one → every message fails.

**Fix:** on mismatch, log `warn` with both versions, show banner only after 3 consecutive mismatches (avoid spamming dev). Reload button calls `workbench.action.reloadWindow`.

### P-01.7 — Pino `redact` with nested wildcards

**Symptom:** `redact: ['*.apiKey']` doesn't match `req.body.config.apiKey` — Pino's wildcard is shallow by default.

**Fix:** use `redact: { paths: ['*.apiKey', '**.apiKey'], censor: '[REDACTED]' }` — the double-star enables deep match. Verify with a unit test.

### P-01.8 — Knip false positives on `extension.ts` activate/deactivate

**Symptom:** Knip flags `activate` / `deactivate` as unused — they're entry points called by VSCode, not imported by code.

**Fix:** declare them in `knip.json` `entry: ['packages/extension/src/extension.ts']`. Same for `main` field from `package.json` (`dist/extension.js`).

### P-01.9 — Composition root Circular Dependency

**Symptom:** `createServices` tries to instantiate `MonitorOrchestrator` which needs `TelemetryAdapter` which needs `StorageAdapter` — if declared in wrong order, runtime error.

**Fix:** construct adapters in pure-DAG order inside `createServices`. Adapters first (no mutual dependencies), then orchestrators that consume them. If two services genuinely need each other, use late-bound setter injection (antipattern — refactor instead).

### P-01.10 — `p-limit` starvation under long-tail latency

**Symptom:** one slow SOQL holds a slot for 30s; 7 other fast calls queue behind. Other callers think adapter is broken.

**Fix:** per-method category queues (e.g., `limit-query`, `limit-meta`, `limit-tooling`) so fast categories don't starve on slow ones. Add `AbortSignal.timeout(30_000)` default at call site.

---

## Existing Patterns in This Codebase

- **ConfigStore** (`packages/extension/src/core/ConfigStore.ts`) — wraps `globalState` with typed access. Mirror this pattern for `StorageAdapter` — don't reinvent.
- **MessageRouter** (`packages/extension/src/bridge/MessageRouter.ts`) — already routes by `type`. Add Zod parse at its boundary, not inside each handler.
- **BackgroundOperationRegistry** (`packages/extension/src/core/engine/BackgroundOperationRegistry.ts`) — good reference for an EventEmitter-backed registry with typed events. Shipped in v1.2.4.
- **NotificationCenter** (`packages/extension/src/core/NotificationCenter.ts`) — consumer of telemetry events; wire as Sentry breadcrumb source.
- **WebviewPanelManager** (`packages/extension/src/providers/WebviewPanelManager.ts`) — has visibility tracking; leverage for visibility-aware adapter pausing in later phases.
- **jsforce imports** — ~40+ direct imports across `packages/extension/src/modules/**`. Migration target for HARD-01. Gradual per-module strategy per CONTEXT.md.
- **Zustand store** — single store currently; slice refactor is Phase 06 (BP-01), not this phase. Don't preemptively restructure in Phase 01.

---

## Recommended Approach

### Plan split (3-4 plans)

1. **Plan 01-01 (Wave 1, autonomous):** Adapters scaffolding — `SalesforceAdapter`, `TelemetryAdapter`, `StorageAdapter`, `FsAdapter` class definitions + tests. NO wiring in `extension.ts`. No orchestrator changes. Purely additive — exports only.

2. **Plan 01-02 (Wave 1, autonomous, parallel with 01-01):** Knip CI + dead-code cleanup. `knip.json`, `.github/workflows/knip.yml`, cleanup commits per category (unused files, unused exports, unused deps).

3. **Plan 01-03 (Wave 2, depends on 01-01):** DI wiring. `createServices(context)` in `services.ts`, refactor `extension.ts` activate, refactor 6 orchestrators to accept injected services. Include SecretStorage migration runner (HARD-06 completion).

4. **Plan 01-04 (Wave 2, depends on 01-01):** Bridge hardening + leak audit. Zod schemas for all messages via discriminated unions, `protocolVersion` envelope, reload-banner on mismatch. Disposable audit script + fix identified leaks. 1h soak test baseline.

**Why this split:**
- 01-01 and 01-02 have zero file conflicts → true parallel Wave 1.
- 01-03 requires adapters to exist → Wave 2.
- 01-04 touches bridge + misc source files that aren't modified by 01-03 → parallel with 01-03 in Wave 2.
- Every plan fits in one focused session (< 4 hrs of executor work).

### Task-level checklist per plan

- YAML frontmatter: `wave`, `depends_on`, `files_modified`, `autonomous`.
- Every task has `file`, `action`, `verify`, `done`.
- Every task that modifies a source file must have a co-located test (project rule: `.test.ts` paired with `.ts`).
- Must-haves section: observable + testable (file exists, import resolves, test count delta, contract test passes).

### Verification priorities

- Every HARD-01..07 requirement maps to at least one task.
- Plans honor CONTEXT.md decisions (gradual migration, composition root, VSCode telemetry gate, Knip non-blocking, etc.).
- No cross-wave file conflicts.
- Existing v1.2.4 tests stay green (no breaking changes in Wave 1 adapters).

### Confidence levels

- **HIGH:** p-retry + p-limit, Pino + Sentry wiring, Knip config, ts-morph audit pattern, discriminated-union Zod schemas.
- **MEDIUM:** soak test baseline (depends on ambient system load at measurement), composition root ordering (possible circular deps surface during refactor).
- **LOW:** None.

---

## Citations

- Anthropic SDK docs (via STACK.md): https://github.com/anthropics/anthropic-sdk-typescript
- Sentry OTEL integration: https://docs.sentry.io/platforms/javascript/guides/node/opentelemetry/
- Pino redaction docs: https://github.com/pinojs/pino/blob/main/docs/redaction.md
- Knip monorepo setup: https://knip.dev/guides/workspaces
- `p-retry` with AbortSignal: https://github.com/sindresorhus/p-retry
- `p-limit`: https://github.com/sindresorhus/p-limit
- jsforce rate limit guidance (STACK.md): SF concurrent API cap = 25 (prod/sandbox), jsforce default = 10
- 529 vs 429 handling (PITFALLS.md P-3): https://www.aifreeapi.com/en/posts/claude-529-overloaded-error
