---
phase: 1
status: human_needed
verified: 2026-03-17
---

# Phase 1: Bridge Wiring Fix -- Verification

## Must-Have Results

### Plan 01-01: CorrelationId Infrastructure

| Must-Have | Status | Evidence |
|-----------|--------|----------|
| BaseMessage interface has `correlationId?: string` field | PASS | `messages.types.ts` line 38: `correlationId?: string;` |
| buildMessage still works unchanged (no breaking changes) | PASS | `messageHelpers.test.ts` passes (5 tests) |
| useMessageResponse matches by correlationId when present, type fallback when absent | PASS | `useMessageResponse.ts` lines 118-122: correlationId check with fallback |
| Extension MessageBroker propagates correlationId from request to response | PARTIAL | `HandlerTypes.ts` exports `buildResponse()` which sets `correlationId: request.id` (line 86), BUT zero handlers actually call `buildResponse` -- all handlers manually construct responses without correlationId. Functionally non-breaking due to type-fallback in useMessageResponse. |
| All existing tests pass | PASS | 6822 tests pass (783 shared + 3908 extension + 2131 webview) |
| pnpm typecheck passes | PASS | All 3 packages pass tsc --noEmit |

### Plan 01-02: Audit & Fix All Response Type Mismatches

| Must-Have | Status | Evidence |
|-----------|--------|----------|
| Every useBridgeQuery/useBridgeMutation has responseType matching handler's actual response | PASS | Verified: settings:response, sync:execute:response, compare:start:response, monitor:data all match handler output |
| Settings update response received (mismatch fixed) | PASS | Both GET and UPDATE use `settings:response`; handler sends `settings:response` (lines 99, 116) |
| AI status queried on mount | PASS | `BridgeProvider.tsx` line 34: `sendMessage(buildMessage('ai:status'))` |
| No bridge timeout due to type mismatch | HUMAN NEEDED | Requires running extension with a real Salesforce org to confirm no timeouts |
| pnpm typecheck passes | PASS | Confirmed |
| pnpm test passes | PASS | Confirmed |

### Plan 01-03: Ghost Type Cleanup & Unhandled Message Warning

| Must-Have | Status | Evidence |
|-----------|--------|----------|
| messages.types.ts contains no types with zero handler AND zero UI consumer | PASS | `audit:*`, `governance:*`, `team:*`, `recovery:*` removed. `scheduler:*` kept (UI: SchedulerPanel.tsx), `realtime:*` kept (UI: RealTimeSyncPanel.tsx) -- both are CONSUMER-ONLY, correctly retained |
| Ghost domains removed | PASS | Zero matches for `audit:`, `governance:`, `team:`, `recovery:` in messages.types.ts |
| Unhandled messages logged as warnings | PASS | `MessageBroker.ts` line 140: `this.logFn?.('[MessageBroker] Unhandled message type: "${message.type}"')` with test coverage (MessageBroker.test.ts lines 366-391) |
| pnpm typecheck passes | PASS | Confirmed |
| pnpm test passes | PASS | Confirmed |

## Requirement Coverage

| Req ID | Deliverable | Status |
|--------|-------------|--------|
| BRG-01 | Response type audit complete; all useBridgeQuery/useBridgeMutation have matching responseTypes | PASS |
| BRG-02 | correlationId field on BaseMessage + buildResponse helper + useMessageResponse matching | PARTIAL -- helper exists but handlers do not use it (type-fallback makes this functionally OK) |
| BRG-03 | useMessageResponse matches by correlationId (primary) with type fallback | PASS |
| BRG-04 | Unhandled message warning in MessageBroker with test | PASS |

## Integration Checks

| Import/Export | Status | Notes |
|---------------|--------|-------|
| `BaseMessage.correlationId` (shared) -> useMessageResponse (webview) | PASS | useMessageResponse reads `eventData.correlationId` |
| `BaseMessage.correlationId` (shared) -> HandlerTypes.buildResponse (extension) | PASS | buildResponse sets `correlationId: request.id` |
| `buildResponse` (HandlerTypes.ts) -> actual handlers | GAP | No handler imports or calls buildResponse; all construct responses manually without correlationId |
| `buildMessage('ai:status')` in BridgeProvider -> AIChatHandler | PASS | AIChatHandler handles `ai:status` and sends `ai:status:response` |
| Unhandled message log in MessageBroker -> handlers returning false | PASS | MessageBroker checks handler map, logs when no handler found |

## Summary

**Score:** 16/18 must-haves verified automatically, 1 needs human testing, 1 partial

### Automated checks passed

- BaseMessage has correlationId field
- useMessageResponse matches correlationId with type fallback
- buildResponse helper exists and is tested
- Settings mismatch fixed (settings:response aligned)
- AI status queried on BridgeProvider mount
- Ghost types removed (audit, governance, team, recovery)
- Consumer-only types correctly retained (scheduler, realtime)
- Unhandled messages logged as warnings with test coverage
- pnpm typecheck passes (all 3 packages)
- pnpm test passes (487 test files, 6822 tests, 0 failures)

### Items needing human testing

- **No bridge timeout due to response type mismatch**: Requires running the extension against a live Salesforce org. Automated checks confirm the response types align between hooks and handlers, but runtime confirmation needs a manual test session.

### Partial item

- **correlationId propagation**: The `buildResponse` helper in `HandlerTypes.ts` correctly propagates correlationId, but NO handler actually calls it. All handlers construct response objects manually (e.g., `{ type: '...', id: this.deps.nextId(), timestamp: Date.now(), payload: ... }`) without including `correlationId`. The fallback in `useMessageResponse` (type-only matching when correlationId is absent) means this is functionally non-breaking -- the bridge works -- but the correlationId feature is not exercised end-to-end. This is a wiring gap that should be addressed in a future pass.

