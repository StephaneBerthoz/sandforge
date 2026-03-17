# Phase 1: Bridge Wiring Fix - Context

**Gathered:** 2026-03-17
**Status:** Ready for planning

<domain>
## Phase Boundary

Fix the message bridge so every module's request/response cycle works end-to-end. Add correlationId for robust matching. Audit and fix ALL response type mismatches across every module. Clean ghost message types from shared types.

This is the foundation — no module can work without reliable message routing.

</domain>

<decisions>
## Implementation Decisions

### Correlation ID
- Add `correlationId` field to BaseMessage in shared types
- Extension handlers MUST copy `correlationId` from incoming request to outgoing response
- `useMessageResponse` matches by `correlationId` (primary) with `type` as fallback
- `buildMessage` auto-generates correlationId (can reuse existing `id` field or add new field)

### Audit + Fix scope
- Audit EVERY useBridgeQuery/useBridgeMutation call across ALL pages to find type mismatches
- Fix mismatches in the SAME phase (not deferred)
- Known mismatches: Sync expects `operation:completed` instead of `sync:execute:response`

### Global message dispatch (dual dispatch)
- KEEP the current dual dispatch pattern: handlers send both `operation:started/completed/failed` (global loading) AND module-specific responses
- BridgeProvider continues to listen for `operation:*` for global loading state
- Module hooks listen for their specific response types for data
- This preserves backward compat and gives a unified loading indicator

### Ghost type cleanup
- Clean NOW in Phase 1 (not deferred to Phase 3)
- Audit `messages.types.ts`: remove all types that have zero handler AND zero sender
- Ghost domains to remove: `audit:*`, `governance:*`, `scheduler:*`, `team:*`, `realtime:*`, `recovery:*`
- If a type has a handler but no UI consumer, keep it (it's just unused, not broken)

### Claude's Discretion
- Whether to use `id` as correlationId or add a separate `correlationId` field — pick the cleanest approach
- Handler-by-handler fix strategy (order, grouping)
- Test approach for verifying fixes

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `useMessageResponse` hook: already has `activeRequestId` tracking, timeout, cleanup — just needs correlationId matching
- `buildMessage`: already generates unique `id` per message — candidate for correlationId
- `useMessageListener`: used by BridgeProvider for global listeners, separate from query/mutation pattern
- `useBridgeQuery`/`useBridgeMutation`: both default to `{requestType}:response` pattern — convention is solid

### Established Patterns
- Webview hooks do their OWN response listening via `window.addEventListener('message', ...)` — BridgeProvider doesn't need to relay module responses
- BridgeProvider handles ONLY: org state, global loading, notifications, grappe, AI error resolution, onboarding
- Extension handlers follow consistent pattern: receive message → process → `sendMessage(response)` with `{type}:response` naming

### Integration Points
- `packages/shared/src/types/messages.types.ts` — BaseMessage interface, all type definitions
- `packages/webview/src/hooks/useMessageResponse.ts` line 114 — where type matching happens (add correlationId here)
- `packages/extension/src/bridge/MessageBroker.ts` — where extension sends responses (add correlationId propagation)
- Every handler in `packages/extension/src/bridge/handlers/*.ts` — must propagate correlationId

</code_context>

<specifics>
## Specific Ideas

- User wants this to be a flagship product for the Salesforce community — no half-measures
- "Fait au mieux" — quality bar is best-in-class, not just working
- Every module must feel polished and reliable when used with real orgs

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---
*Phase: 01-bridge-wiring-fix*
*Context gathered: 2026-03-17*
