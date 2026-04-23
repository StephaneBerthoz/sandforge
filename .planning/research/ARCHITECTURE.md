# ARCHITECTURE.md — v1.3.0 Refactor & Best-Practice Patterns

**Context:** SandForge is a TypeScript pnpm monorepo (`shared` + `extension` + `webview`). Existing module count: ~80+ classes across monitor/compare/seed/sync/dataops/automation. v1.3 is the moment to harden boundaries before AI + real-time streaming arrive.

---

## Component Boundaries

### Layer model (enforce in v1.3)

```
 ┌─────────────────────────────────────────────┐
 │  WebView (React + Zustand)                  │  ← UI only, no business logic
 │  packages/webview/src/                      │
 └──────────────────┬──────────────────────────┘
                    │  postMessage (typed)
 ┌──────────────────▼──────────────────────────┐
 │  Bridge (MessageRouter, ExecutionHandler)   │  ← protocol + routing only
 │  packages/extension/src/bridge/             │
 └──────────────────┬──────────────────────────┘
                    │
 ┌──────────────────▼──────────────────────────┐
 │  Orchestrators (MonitorOrchestrator, etc.)  │  ← use cases, compose services
 │  packages/extension/src/modules/*/          │
 └──────────────────┬──────────────────────────┘
                    │
 ┌──────────────────▼──────────────────────────┐
 │  Services / Engines (pure or IO-isolated)   │  ← business logic
 │  packages/extension/src/core/, modules/*    │
 └──────────────────┬──────────────────────────┘
                    │
 ┌──────────────────▼──────────────────────────┐
 │  Adapters (jsforce, fs, Anthropic, Sentry)  │  ← only layer that talks to outside world
 │  packages/extension/src/adapters/ (NEW)     │
 └─────────────────────────────────────────────┘
```

### SOLID application

- **Single Responsibility:** Monitor module already has it (one tracker per domain). Enforce: no tracker talks to another tracker directly — they compose via `MonitorOrchestrator`.
- **Open/Closed:** Monitor probes should be registerable. Move `MonitorOrchestrator` from "know all trackers" to "runs registered probes." Each tracker becomes an `MonitorProbe` implementing `{ id, collect(ctx): Promise<Metric[]> }`.
- **Liskov:** Connector abstraction exists (CsvConnector, JsonConnector, SalesforceConnector for sync) — good. Verify all implement same contract; add `assertConnectorContract()` test.
- **Interface Segregation:** Current risk — `MonitorOrchestrator` may import everything. Split read-side (UI state) from collect-side (periodic trigger).
- **Dependency Inversion:** Orchestrators should accept services via constructor, not `new` them. This is the single biggest refactor win for testability.

### New folder: `adapters/`

Centralize external IO.

```
packages/extension/src/adapters/
  salesforce/          (wraps jsforce; handles retry, 429, session refresh)
  ai/                  (wraps Anthropic SDK; handles 529, token accounting)
  telemetry/           (wraps Sentry + pino)
  storage/             (wraps globalState/workspaceState/SecretStorage)
  fs/                  (wraps node:fs with safe-path guards)
```

**Rationale:** Makes services testable with fakes, enforces "no direct jsforce imports in monitor code," gives one place to add retry/circuit-breaker logic.

---

## Data Flow

### Monitor v2 target flow (event-driven)

```
Salesforce Org
  ├── Limits API (poll every 60s, backoff on 429)
  ├── Jobs API (poll every 30s while active jobs, 5min otherwise)
  ├── CDC Subscription (push, opt-in, per-object)
  └── Deploy Status (push via ToolingAPI subscription if available)
         │
         ▼
   MetricBus (EventEmitter, in-process)
         │
         ├── TimeSeriesStore (SQLite or rolling JSON — writes)
         ├── AnomalyDetector (reads recent window, emits AlertEvent)
         ├── AlertRouter (delivers to VSCode notifications / status bar)
         └── WebViewSync (debounced postMessage to UI)
```

**Key patterns:**

1. **EventEmitter for intra-process pub/sub** — decouples probes from consumers. Existing code likely uses direct method calls; introduce `MetricBus` as a single `EventEmitter` with typed events.
2. **CDC for push events** — subscribe via jsforce's Streaming API or Pub/Sub API. Opt-in per user because it counts against daily event allocation.
3. **Debounce WebView updates** — UI only needs 1 Hz max; batching reduces postMessage flood.
4. **Tab-visibility-aware scheduling** — when WebView panel is hidden, poll cadence drops 10x. See PITFALLS.md.

### WebView ↔ Extension Host protocol

Already mature (MessageRouter, ExecutionHandler). v1.3 additions:
- `metric.stream.start` / `metric.stream.stop` for subscription lifecycle
- `ai.diagnose` request/response with structured context
- `operation.abort` (already exists — expand)

All messages MUST be Zod-validated on both ends. Existing pattern if partial — audit.

---

## Build Order (recommended phase sequence for v1.3)

1. **Phase A — Hardening foundations (no new features)**
   - Introduce `adapters/` folder + migrate jsforce usage
   - Set up Sentry + pino end-to-end
   - Add Knip to CI
   - Zod-validate all WebView messages (audit + fill gaps)
   - Secret storage for Anthropic key

2. **Phase B — Monitor v2 core**
   - `MetricBus` + `TimeSeriesStore`
   - Refactor existing trackers into `MonitorProbe` interface
   - Debounced WebView sync
   - Report export (PDF/CSV)

3. **Phase C — AI integration**
   - `adapters/ai/` with Anthropic SDK + betaZodTool
   - AI failure diagnosis flow (explain bulk job errors)
   - AI code review for SOQL / Apex snippets (inline code action)
   - Guardrails: token budget, output validation, "user-approve" gates

4. **Phase D — CDC / real-time (opt-in)**
   - Pub/Sub subscription layer
   - Per-object CDC toggles in UI
   - Event retention / replay on reconnect

5. **Phase E — Test hardening**
   - Stryker mutation testing on shared + core
   - fast-check on ErrorClassifier, DiffEngine, GovernorLimitPredictor
   - E2E: Playwright flows for critical paths

Phases A + B + E can overlap. C depends on A. D depends on C for AI-over-events (or can run parallel if AI is deferred).

---

## Integration Points

### AI (Anthropic) — how it plugs in

```
User action (e.g., "Diagnose this failure")
  → WebView dispatches `ai.diagnose` with contextId
  → ExtensionHost AIAdapter gathers context:
      • failed job JSON
      • last N lines of debug log
      • relevant SchemaAnalyzer output
      • ErrorClassifier verdict
  → Builds system prompt (role, constraints, output schema)
  → Calls Anthropic SDK with tools: [fetch_soql, fetch_metadata, read_file]
  → Iterates ToolRunner until model emits final_diagnosis
  → Validates response against Zod schema
  → Returns to WebView for rendering
```

**Prompt design:**
- **System prompt:** role ("Salesforce ETL troubleshooting assistant"), hard rules (never suggest destructive DELETE without confirmation; never fabricate record IDs; always return Zod-shaped output), available tools.
- **User prompt:** structured context block + user's ask.
- **Tool schemas:** Zod, so SDK + runtime validation match.
- **Guardrails:** token budget per session (5K input max initially), cancel button wired to `AbortController`, visible "AI is thinking" state.

### Sentry — how it plugs in

- `@sentry/node` `init()` in extension activation, **opt-in** telemetry (respect `telemetry.telemetryLevel` VSCode setting).
- Breadcrumbs from pino via custom transport.
- Tag every event with `orgId` (hashed) + `moduleName` for faceted analysis.
- Separate Sentry project for WebView (`@sentry/browser`) to distinguish main-thread vs webview errors.
- Release health via SDK's `release` field tied to `package.json#version`.

### CDC / Pub/Sub — how it plugs in

- New adapter `adapters/salesforce/CdcSubscriber.ts`.
- Respects user's event allocation (query `PlatformEventUsageMetric` on startup, warn if > 80%).
- Replay-ID persisted in `globalState` per org for resume-after-disconnect.
- 3-day retention window — older events unrecoverable; make this visible in UI.

---

## State Management Architecture

### Zustand slice pattern

Move from (presumed) monolithic store to:

```typescript
// packages/webview/src/store/index.ts
export const useStore = create<RootState>()((...a) => ({
  ...createOrgSlice(...a),
  ...createMonitorSlice(...a),
  ...createSeedSlice(...a),
  ...createSyncSlice(...a),
  ...createCompareSlice(...a),
  ...createAiSlice(...a),
  ...createUiSlice(...a),
  ...createTelemetrySlice(...a),
}));
```

Each slice in its own file, own `StateCreator` type, own selectors. Selectors exported as hooks: `useOrgList()`, `useActiveMonitorMetrics()`, etc. — never the raw `useStore`.

Middlewares applied ONCE at the root level: `devtools`, `subscribeWithSelector`, optional `persist` scoped via `partialize`.

### Error boundaries

Wrap each major route/panel in a `react-error-boundary` with module-scoped fallback UI. Don't wrap the root app only — a Monitor render error shouldn't blank the entire sidebar.

Log boundary catches to Sentry with the module tag. Show a "Reload this panel" button that resets the boundary.

**Known limitation:** Error boundaries don't catch errors in event handlers, async code (Promises), or during SSR. For async: wrap message-handler effects in try/catch → setState error → boundary re-renders.

---

## Dependency Injection — composition root

```typescript
// packages/extension/src/services.ts
export interface Services {
  salesforce: SalesforceAdapter;
  ai: AIAdapter;
  telemetry: TelemetryAdapter;
  storage: StorageAdapter;
  monitorOrchestrator: MonitorOrchestrator;
  seedOrchestrator: SeedOrchestrator;
  // ...
}

export function createServices(context: vscode.ExtensionContext): Services {
  const telemetry = new TelemetryAdapter(context);
  const storage = new StorageAdapter(context);
  const salesforce = new SalesforceAdapter(storage, telemetry);
  const ai = new AIAdapter(storage, telemetry);
  const monitorOrchestrator = new MonitorOrchestrator({ salesforce, telemetry });
  // ...
  return { salesforce, ai, telemetry, storage, monitorOrchestrator, ... };
}
```

Pass `Services` (or relevant slice) into handlers. Tests construct with fakes. No container, no decorators, no reflect-metadata.

---

## Confidence

- **HIGH:** Layer model, EventEmitter MetricBus, composition-root DI, Zustand slices, AI adapter shape.
- **MEDIUM:** Phase ordering (depends on ProductOps priorities), CDC integration complexity (depends on jsforce Pub/Sub API maturity in 2026).
- **LOW:** SQLite vs rolling-JSON for TimeSeriesStore — benchmark needed; both viable.
