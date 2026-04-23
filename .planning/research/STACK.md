# STACK.md — v1.3.0 Technology Recommendations

**Milestone:** Hardening, Monitor v2, AI integration, Best Practices
**Scope:** Net-new libraries to add; existing stack stays (TS/React/Zustand/Vite/Vitest).

---

## Recommended Stack

### 1. AI Integration — `@anthropic-ai/sdk` + Zod tool helpers (HIGH confidence)

**Choice:** Direct Anthropic TypeScript SDK with `betaZodTool` helper for function calling.

**Rationale:**
- Official SDK, maintained, full TS types for all request/response shapes.
- `betaZodTool` lets you define tools with Zod schemas + a `run` handler — eliminates hand-rolled JSON schema generation and gives runtime validation for free.
- `ToolRunner` iterator supports multi-turn tool loops (model calls tool → SDK runs handler → model sees result) which is the exact shape SandForge needs for "AI diagnose this failed bulk job."
- SDK auto-retries 408/409/429/500+ with exponential backoff. No custom retry scaffolding needed for those codes.

**Do NOT use LangChain.js.** LangChain adds a heavy abstraction layer that hurts more than it helps for a single-provider, tool-use workflow. Community sentiment in 2026 has decisively moved toward lighter primitives (Vercel AI SDK, direct SDK + Zod). LangGraph only becomes worth its weight when you need multi-agent graphs — SandForge doesn't.

**Install:** `pnpm add @anthropic-ai/sdk zod` (Zod already present).

**API key handling:** VSCode `SecretStorage` API (not env vars) — use `context.secrets.store()` / `get()`. Never expose key in WebView or log output.

---

### 2. Observability — Sentry SDK + structured logging with Pino (HIGH confidence)

**Choice:**
- `@sentry/node` in the extension host (error tracking + breadcrumbs).
- `@sentry/browser` in the WebView (React error boundary integration).
- `pino` for structured logs (5–8x faster than Winston per Pino benchmarks; JSON-native; async worker threads).

**Rationale:**
- Sentry supports OpenTelemetry ingestion natively (`OTLPIntegration`) — forward-compatible if we later add OTEL tracing without forcing a migration.
- Pino emits NDJSON straight to stdout — perfect for the VSCode Output channel and external log collection. Winston's transport routing is overkill for an extension.
- Together they give: exceptions (Sentry), structured breadcrumbs (Pino), and user session telemetry (Sentry release health).

**Anti-pattern to avoid:** `console.log` everywhere with ad-hoc string formatting. Existing codebase likely has this debt — audit during hardening phase.

**Install:** `pnpm add @sentry/node @sentry/browser pino pino-pretty`

---

### 3. Refactoring tooling — `ts-morph` + `knip` (HIGH confidence)

**Choice:**
- `knip` for dead code / unused deps / orphan files detection. Replaces `ts-prune` (maintenance mode since 2024).
- `ts-morph` for programmatic AST refactors (renames, extract-to-file, codemod-style migrations).

**Rationale:**
- Knip uses a mark-and-sweep algorithm; reports unused exports, class members, enum members, dependencies AND devDependencies. It works out-of-box for most projects; monorepo config needed.
- ts-morph is the TypeScript-aware scripting layer for one-off refactors (e.g., "migrate all handlers from X pattern to Y pattern"). Safer than regex/sed.
- Both are dev-only — zero runtime cost.

**Install:** `pnpm add -D knip ts-morph`

**Usage pattern:** Add `pnpm knip` to CI as non-blocking report initially; promote to failing check in a later milestone.

---

### 4. Testing hardening — `stryker-mutator` + `fast-check` (MEDIUM confidence)

**Choice:**
- Stryker for mutation testing (`@stryker-mutator/core` + `@stryker-mutator/vitest-runner`).
- `fast-check` for property-based testing of critical pure functions (ErrorClassifier, DiffEngine, GovernorLimitPredictor, DeltaDetector).

**Rationale:**
- Coverage % lies. Mutation score reveals whether tests actually catch regressions. Highest ROI on pure-logic modules (comparison engines, predictors, transformers).
- fast-check excels at edge-case discovery in normalization / comparison / classification code — exactly the shape of code SandForge has most of.
- Vitest runner for Stryker is first-class in 2026 (StrykerJS supports Vitest natively).

**Caveat (MEDIUM):** Stryker runs are slow (mutants × test-suite runs). Scope to `packages/shared/` + core/monitor pure modules first. Do NOT mutate WebView React code — low signal, high wall-time.

**Install:** `pnpm add -D @stryker-mutator/core @stryker-mutator/vitest-runner fast-check`

---

### 5. Dependency Injection — Vanilla factory pattern (HIGH confidence; contrarian)

**Choice:** Do NOT adopt InversifyJS or tsyringe. Use vanilla factory/composition-root pattern.

**Rationale:**
- VSCode's `ExtensionContext` already acts as a natural composition root. Extensions that adopted Inversify (e.g., vscode-python) did so for reasons that don't apply here (>500 services, plugin system, multi-team ownership).
- Inversify adds `reflect-metadata` (runtime cost + tsconfig `emitDecoratorMetadata` requirement) and decorator-based boilerplate.
- tsyringe is lighter but still requires decorators and a container.
- SandForge has ~20–40 services. A single `createServices(context)` factory in `extension.ts` that wires dependencies and returns a typed `Services` object is faster to write, easier to reason about, and trivially testable via parameter swapping.

**Counter-consideration:** If v1.4+ introduces a plugin system for user-contributed monitors/analyzers, revisit. Not now.

---

### 6. State management — Zustand slices pattern (HIGH confidence)

**Choice:** Keep single Zustand store; refactor into slices.

**Rationale:**
- Official Zustand recommendation for >3 logical domains. Each slice is a `StateCreator<Root, [], [], SliceSlice>` — domain isolation without fragmenting the store.
- Prevents the "I need data from 2 stores to render this component" problem.
- Middlewares (persist, devtools, subscribeWithSelector) apply once at the combined-store level — avoids double-wrapping issues.
- Only export custom hooks / selector functions, never the raw store — prevents accidental full-store subscriptions.

**Slice shape for SandForge:** `orgSlice`, `monitorSlice`, `seedSlice`, `syncSlice`, `compareSlice`, `aiSlice`, `uiSlice`, `telemetrySlice`.

---

## Alternatives Considered

| Rejected | Why |
|----------|-----|
| LangChain.js | Heavy abstraction, multi-provider overhead not needed, community moved to direct SDKs |
| Winston | 5–8x slower than Pino, transport complexity not needed for extension |
| ts-prune | Maintenance mode; Knip is strictly superior |
| InversifyJS | Decorators + reflect-metadata overhead; composition root is simpler |
| tsyringe | Same as above, marginally lighter but still decorator-based |
| OpenTelemetry SDK directly | Heavier than needed for v1.3; Sentry's OTEL integration is forward-compatible |
| jest | Already on Vitest; no reason to switch |
| Vercel AI SDK | Optimized for edge/web apps, SSE streaming patterns; extension host is Node — direct Anthropic SDK is cleaner |

---

## What NOT to Use

- **`any` types** — already banned by project rules; enforce via `@typescript-eslint/no-explicit-any: error`.
- **Raw `fetch` to Anthropic API** — use SDK; handles retries, types, streaming correctly.
- **`console.log` in production paths** — route through pino → Sentry breadcrumbs.
- **Synchronous log writes** — blocks extension host event loop.
- **`setInterval` polling > every 5s without visibility guards** — drains battery on hidden tabs (see PITFALLS.md).
- **Multiple Zustand stores** — use slices in one store.
- **Embedding API keys in WebView** — always route AI calls through extension host.

---

## Versions (as of April 2026)

| Package | Version | Notes |
|---------|---------|-------|
| `@anthropic-ai/sdk` | `^0.40.x` | Supports `betaZodTool`, streaming, tool runner |
| `zod` | `^3.23.x` | Already in project |
| `@sentry/node` | `^8.x` | v8 supports OTEL integration |
| `@sentry/browser` | `^8.x` | React error boundary helper |
| `pino` | `^9.x` | Worker-thread transports |
| `pino-pretty` | `^11.x` | Dev-only |
| `knip` | `^5.x` | Monorepo-aware |
| `ts-morph` | `^23.x` | TS 5.4+ support |
| `@stryker-mutator/core` | `^8.x` | Vitest runner GA |
| `@stryker-mutator/vitest-runner` | `^8.x` | |
| `fast-check` | `^3.x` | |

---

## Confidence Summary

- **HIGH:** Anthropic SDK, Sentry+Pino, Knip, ts-morph, vanilla DI, Zustand slices
- **MEDIUM:** Stryker scope (slow on large suites), fast-check adoption curve
- **LOW:** None — all recommendations are ecosystem-standard
