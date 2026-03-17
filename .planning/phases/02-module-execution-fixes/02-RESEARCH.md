# Phase 2: Module Execution Fixes -- Research

**Researched:** 2026-03-17
**Phase goal:** Every module works end-to-end with real Salesforce orgs.

## Don't Hand-Roll

| Problem | Recommended solution | Why |
|---------|---------------------|-----|
| Response message construction | Use `buildResponse()` from `HandlerTypes.ts` | Automatically propagates `correlationId`, generates `id`/`timestamp`. Hand-constructing responses (as all handlers currently do) silently drops correlationId, breaking the `useMessageResponse` matching on the webview side. |
| Error handling in catch blocks | Use `sendHandlerError()` from `HandlerTypes.ts` | Consolidates the `extractErrorMessage` + log + post pattern. Several handlers already use it; the rest should too. |
| Operation lifecycle messages | Use `sendOperationStarted/Progress/Completed/Failed()` from `HandlerTypes.ts` | These are already defined and working. BridgeProvider listens for `operation:started/completed/failed`. Do not invent module-specific lifecycle patterns. |
| Notification delivery | Use `sendNotification()` from `HandlerTypes.ts` | BridgeProvider already has a `notification` listener that dispatches to `useNotificationStore`. |
| AI conversation persistence | Use `ConfigStore` (already injected via `deps.configStore`) | Consistent with how backups, settings, and org configs are stored. No need for a separate storage mechanism. `getByCategory()` and `getKeysByPrefix()` already support namespaced lookups. |
| SOQL safety | Use `sanitizeSoqlObjectName()` from shared, `queryWithFieldsFallback()`, `checkApiLimits()` | These utilities are battle-tested across Seed, Sync, Monitor, DataOps handlers. Never construct raw SOQL strings. |

## Common Pitfalls

### Pitfall 1: Responses without correlationId break request-response matching

**What goes wrong:** Handlers construct response messages manually (e.g., `{ id: this.deps.nextId(), type: '...', timestamp: Date.now(), payload: ... }`) instead of using `buildResponse()`. The response arrives at the webview but `useMessageResponse` cannot match it to the originating request because `correlationId` is missing. The hook falls back to type-only matching, which is unreliable when multiple requests of the same type are in flight.

**Why:** `buildResponse()` was introduced during Phase 1 but none of the 6 handlers to migrate (SyncOpsHandler, AutopilotHandler, CompareHandler, MonitorOpsHandler, DataOpsHandler, AutomationHandler) use it yet. SeedOpsHandler also does not use it. ForgeHandler (old-style) is completely exempt from the DomainHandler pattern.

**How to avoid:** Every `this.deps.broker.postToWebview(response)` call in a handler's happy path and error path must use `buildResponse(this.deps, msg, responseType, payload)`. The `msg` parameter is the incoming request -- this is how `correlationId` gets set to the request's `id`. Do NOT pass a freshly constructed message as the request arg.

### Pitfall 2: ForgeHandler's dual-dispatch architecture

**What goes wrong:** `ForgeOpsHandler` (the DomainHandler wrapper) delegates to the old `ForgeHandler` by calling `this.forgeHandler.handle(msg.type, payload)`. This strips the original `BaseMessage` -- the old handler receives `(type: string, payload: unknown)` instead of `(msg: BaseMessage)`. This means `buildResponse()` cannot be used inside the old handler because it needs the original request `msg` for correlationId.

**Why:** ForgeHandler predates the DomainHandler refactor. It has its own `ForgeHandlerDeps` interface with a raw `postMessage: (message: unknown) => void` callback that has no concept of correlationId.

**How to avoid:** The refactor must either (a) rewrite ForgeHandler to implement DomainHandler directly (taking `BaseMessage` in `handle()`), or (b) pass the full `BaseMessage` through the delegation chain so that buildResponse can be used in the inner handler. Option (a) is cleaner and is what CONTEXT.md mandates.

### Pitfall 3: CompareHandler routes both `compare:execute` and `compare:start` to the same method

**What goes wrong:** CompareHandler's `handle()` method treats both `compare:execute` and `compare:start` as equivalent -- both go to `handleCompareStart()`. The response type is hardcoded to `compare:start:response`. If the webview sends `compare:execute`, `useBridgeQuery/useBridgeMutation` will be listening for `compare:execute:response` (the convention) but receive `compare:start:response` instead.

**Why:** The handler was written when only one message type existed, then a second was added without updating the response routing.

**How to avoid:** Either (a) use a single canonical message type (remove the duplicate), or (b) send responses with the correct type based on which request was received. Option (a) is simpler -- decide on `compare:execute` as the canonical type and remove `compare:start` from both the handler and the router registration.

### Pitfall 4: AutopilotHandler uses notification-only error reporting

**What goes wrong:** When autopilot operations fail, the handler sends a `sendNotification()` but does NOT send a typed error response message. The webview component waiting for `autopilot:schema-result` or `autopilot:plan-ready` will time out after 30 seconds instead of getting an immediate error.

**Why:** The handler was written to use notifications as the error channel, which works for human feedback but not for programmatic request-response flows.

**How to avoid:** Every error path must send BOTH a notification (for the toast) AND a typed error response (for the hook). Pattern: `sendHandlerError(deps, context, 'autopilot:error', err)` alongside the notification.

### Pitfall 5: Handler responses constructed without correlationId are silently accepted

**What goes wrong:** The current `useMessageResponse` hook accepts responses that lack `correlationId` (falls back to type-only matching). This means after migration, old-style responses and new-style responses can both be consumed, hiding bugs where `buildResponse()` was missed.

**Why:** The fallback was added for backward compatibility during Phase 1.

**How to avoid:** After all handlers are migrated, the planner should consider tightening the fallback (or at least logging a warning in dev mode when type-only matching is used). For Phase 2, the immediate fix is to audit every response path and confirm it uses `buildResponse()`.

### Pitfall 6: AI conversation persistence -- key collision and data size

**What goes wrong:** ConfigStore stores everything as JSON strings via `globalState.update()`. AI conversations can grow large (hundreds of messages). Storing them all under a single key (e.g., `ai:conversations`) will hit VSCode's `globalState` size limit (around 512KB total across all keys).

**Why:** VSCode extension `globalState` uses a single JSON blob under the hood.

**How to avoid:** Use per-conversation keys: `ai:conversation:{conversationId}` with a separate index key `ai:conversations:index` listing all conversation IDs. This distributes the data. Also cap conversation message count (e.g., 100 messages) and prune oldest messages when the cap is reached.

### Pitfall 7: Missing test files for 4 out of 6 handlers to migrate

**What goes wrong:** CompareHandler, AutomationHandler, AutopilotHandler, and MonitorOpsHandler have no test files. Without tests, the buildResponse migration cannot be verified automatically.

**Why:** These handlers were created without corresponding test files.

**How to avoid:** Create test files following the existing pattern in `SyncOpsHandler.test.ts` -- specifically the `createMockDeps()` factory and the "returns false for unhandled" / "returns true for handled" test structure. Test that responses include `correlationId` matching the request's `id`.

### Pitfall 8: ForgeHandler stores templates and history in memory only

**What goes wrong:** `ForgeHandler` stores `this.templates` and `this.history` as in-memory arrays. When the extension host reloads, all templates and history are lost. This is inconsistent with the requirement that modules work end-to-end reliably.

**Why:** The handler was written before ConfigStore was available for handler-level persistence.

**How to avoid:** During the ForgeHandler refactor, migrate templates to `deps.configStore.set('forge:templates', ...)` and history to `deps.configStore.set('forge:history', ...)`, same pattern as DataOps backup storage.

## Existing Patterns in This Codebase

- **DomainHandler interface** (`packages/extension/src/bridge/handlers/HandlerTypes.ts`): All modern handlers implement `DomainHandler { handle(msg: BaseMessage): Promise<boolean> }`. The return value indicates whether the message was claimed. Handler registration in `ExtensionHandlers.ts` uses `router.route(type, (msg) => { handler.handle(msg); })`.

- **Type set + switch dispatch** (all handlers): Each handler defines `const X_TYPES = new Set([...])` at module level, checks `if (!X_TYPES.has(msg.type)) return false` at the top of `handle()`, then uses a `switch (msg.type)` to route to private methods. This pattern is consistent across SeedOpsHandler, SyncOpsHandler, MonitorOpsHandler, DataOpsHandler, CompareHandler, AutomationHandler, AutopilotHandler, AIHandler.

- **Lazy service import** (SeedOpsHandler, SyncOpsHandler, AutomationHandler): Heavy module dependencies are imported dynamically inside handler methods: `const { SeedOrchestrator } = await import('../../modules/seed/SeedOrchestrator.js')`. This keeps extension activation fast.

- **Test mock factory** (`SyncOpsHandler.test.ts`, `ForgeHandler.test.ts`): `createMockDeps()` returns a minimal `HandlerDeps` with `vi.fn()` for broker, log, orgManager, configStore, and a counter-based `nextId`. `ForgeHandler.test.ts` also has `createMockGraph()`, `createMockConfig()`, `createMockResult()` factories.

- **ConfigStore category pattern** (`DataOpsHandler.ts` lines 196-199): Backups use `configStore.set(backupKey, data, 'backups')` with `configStore.get<T>(key)` for retrieval. The category parameter enables `getByCategory()` bulk queries.

- **Operation lifecycle dual-dispatch** (SeedOpsHandler, SyncOpsHandler, AutomationHandler): Handlers send BOTH operation lifecycle messages (`sendOperationStarted/Progress/Completed/Failed`) AND module-specific response messages (`seed:execute:response`, `sync:execute:response`). BridgeProvider consumes the lifecycle messages for global loading state; page components consume the module-specific responses for result display.

- **Sub-handler delegation** (AIHandler): AIHandler delegates to 3 sub-handlers (AIChatHandler, AIAnalysisHandler, AIToolsHandler) by iterating `this.subHandlers` and calling `handle()` on each until one returns `true`. This pattern could be reused if ForgeHandler needs sub-handler decomposition.

- **Production guard check pattern** (SeedOpsHandler, SyncOpsHandler, DataOpsHandler): Before DML operations, check `deps.infraServices?.productionGuard` and throw if blocked. Uses `orgTypeToGuardTier()` to convert org type strings.

- **BridgeProvider as global listener** (`packages/webview/src/bridge/BridgeProvider.tsx`): Listens for cross-cutting concerns only: org state, notifications, operation lifecycle, AI status, grappe progress, onboarding. Module-specific responses are handled by page components via `useMessageListener`, `useBridgeQuery`, or `useBridgeMutation`.

- **AI status flow** (already wired): BridgeProvider sends `ai:status` on mount, listens for `ai:status:response`, and sets `useAppStore.aiAvailable`. AIChatHandler.handleStatus checks `secretVault.hasSecret('ai-api-key')` and whether `aiAssistant` is injected. This is already partially functional for AI-01.

## Key Files Reference

| File | Relevance |
|------|-----------|
| `packages/extension/src/bridge/handlers/HandlerTypes.ts` | `buildResponse()`, `sendHandlerError()`, `DomainHandler` interface, `HandlerDeps` type |
| `packages/extension/src/bridge/ExtensionHandlers.ts` | Handler registration, DI wiring, service injection methods |
| `packages/extension/src/bridge/handlers/ForgeHandler.ts` | OLD pattern to refactor (own DI, raw postMessage, no correlationId) |
| `packages/extension/src/bridge/handlers/ForgeOpsHandler.ts` | Current wrapper that delegates to ForgeHandler -- will be replaced |
| `packages/extension/src/bridge/handlers/SeedOpsHandler.ts` | Reference DomainHandler (but does not yet use buildResponse) |
| `packages/extension/src/bridge/handlers/ai/AIChatHandler.ts` | AI conversation CRUD, status, key save -- needs persistence addition |
| `packages/extension/src/core/storage/ConfigStore.ts` | Key-value store with categories, prefix queries, backend persistence |
| `packages/webview/src/hooks/useMessageResponse.ts` | CorrelationId matching logic -- fallback to type-only if absent |
| `packages/webview/src/bridge/BridgeProvider.tsx` | Global listeners for lifecycle, notifications, AI status |
| `packages/webview/src/hooks/useBridgeQuery.ts` | Auto-fire on mount, uses `buildMessage()` which sets request `id` |
| `packages/webview/src/hooks/useBridgeMutation.ts` | Fire on `mutate()`, same correlationId-aware response matching |

## Recommended Approach

Migrate handlers in order of complexity: start with the simplest handlers (MonitorOpsHandler, CompareHandler) to validate the buildResponse migration pattern, then move to medium-complexity (SyncOpsHandler, DataOpsHandler, AutopilotHandler, AutomationHandler), and tackle ForgeHandler last as a full rewrite. For each handler, the migration is mechanical: replace every manual response construction with `buildResponse(this.deps, msg, type, payload)`, ensuring the original `msg` (not a new message) is passed as the request parameter. AI persistence (AI-02) should be implemented in AIChatHandler using per-conversation ConfigStore keys with a `'ai'` category. The AI "not configured" guidance (AI-03) is a webview-only change in AIPage.tsx that reads `useAppStore.aiAvailable` and conditionally renders guidance text -- no handler changes needed.

---
*Phase: 02-module-execution-fixes*
*Research completed: 2026-03-17*
