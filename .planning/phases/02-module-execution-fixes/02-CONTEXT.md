# Phase 2: Module Execution Fixes - Context

**Gathered:** 2026-03-17
**Status:** Ready for planning

<domain>
## Phase Boundary

Make every module work end-to-end with real Salesforce orgs. This means: every UI action that sends a bridge message gets a proper response, every response reaches the webview, and every handler follows the DomainHandler pattern with buildResponse() for correlationId propagation.

Modules in scope: Seed (verify), Sync, Forge, Autopilot, Compare, Monitor, DataOps, Automation, AI.

</domain>

<decisions>
## Implementation Decisions

### Forge Handler Refactor
- Full refactor of ForgeHandler to DomainHandler pattern
- Replace old `handle(type, payload)` signature with `handle(msg: BaseMessage): Promise<boolean>`
- Replace raw `postMessage()` callback with `broker.postToWebview()` via deps
- Use `buildResponse()` for all response messages
- Keep existing business logic (discover, execute, pause, resume, abort, templates, history)

### Missing Handlers — Implement Real Logic
- Compare: implement `compare:permissions`, `compare:snapshots`, `compare:drift` with real Salesforce API calls
- Automation: implement `pipeline:list`, `pipeline:templates`, `pipeline:history` with ConfigStore persistence
- These are full feature implementations, not stubs

### buildResponse Migration — All Handlers
- Migrate ALL 6 remaining handlers to use `buildResponse()` helper from HandlerTypes.ts
- Handlers to migrate: SyncOpsHandler, AutopilotHandler, CompareHandler, MonitorOpsHandler, DataOpsHandler, AutomationHandler
- This ensures correlationId propagation works end-to-end across every module
- After migration, type-only fallback in useMessageResponse becomes a safety net, not the primary path

### AI Conversation Persistence (AI-02)
- Store conversations in Extension ConfigStore (same as settings/backups)
- Key pattern: `ai:conversations:{orgId}` or similar namespace
- Load on mount, save on each message exchange
- Survive extension reload and VSCode restart

### AI API Key Guidance (AI-03)
- When `aiAvailable` is false, show clear guidance in AIPage
- Include: what's needed (API key), where to configure it (Settings), link/button to Settings
- No modal/blocker — inline guidance within the AI page

### Claude's Discretion
- AI conversation persistence: ConfigStore chosen (simplest, consistent with existing patterns)
- Plan grouping: how to split work across plans (by module, by concern, or hybrid)
- Test strategy for new handlers (unit tests for each, integration optional)
- Order of handler migration (suggest: simplest first to establish pattern, Forge last as most complex)

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `buildResponse()` in HandlerTypes.ts — auto-copies correlationId, generates id/timestamp
- `DomainHandler` interface — established pattern all handlers should follow
- `HandlerDeps` type — standardized dependency injection (broker, configStore, connectionPool, nextId, sendNotification, sendOperationStarted/Progress/Completed)
- `CrudFlsGuard` — permission checking before DML operations
- `DmlOperationTracker` — deduplication of concurrent operations
- `checkApiLimits()` — governor limit checking before expensive operations
- `PIIDetector` — PII scanning service (used by Seed, Sync, DataOps)
- `TrendStorage` — historical data storage (used by Monitor)

### Established Patterns
- Handler registration: `broker.on('type', handler.handle.bind(handler))` in ExtensionHandlers.ts
- Dual dispatch: handlers send both `operation:started/completed/failed` (global) AND module-specific responses
- Lazy service injection: handlers receive services via deps, create instances on first use
- Response naming: `{requestType}:response` convention (default in useBridgeQuery/useBridgeMutation)
- ConfigStore for persistence: settings, backups, org configs all stored here

### Integration Points
- `packages/extension/src/bridge/handlers/ExtensionHandlers.ts` — handler registration (add new handlers here)
- `packages/extension/src/bridge/handlers/HandlerTypes.ts` — buildResponse helper, HandlerDeps type
- `packages/webview/src/pages/*/` — each module's page components and hooks
- `packages/shared/src/types/messages.types.ts` — message type definitions (may need new types for missing handlers)
- `packages/extension/src/bridge/MessageBroker.ts` — message routing with unhandled warning

</code_context>

<specifics>
## Specific Ideas

- User wants flagship quality — every module must feel polished with real orgs
- Full DomainHandler consistency across all handlers (no legacy patterns)
- correlationId must work end-to-end (not just infrastructure — actually used)
- Real handler implementations preferred over stubs (even if more work)

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---
*Phase: 02-module-execution-fixes*
*Context gathered: 2026-03-17*
