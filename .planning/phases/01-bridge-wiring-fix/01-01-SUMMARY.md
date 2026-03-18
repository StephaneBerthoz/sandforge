# Plan 01-01 Summary

**Completed:** 2026-03-17
**Phase:** 01 -- Bridge Wiring Fix

## What was built

Added correlationId infrastructure to the message bridge for reliable request/response matching. Previously useMessageResponse matched by type only, causing collisions when two queries of the same type were in flight.

## Key files

- `packages/shared/src/types/messages.types.ts`: Added optional `correlationId` field to BaseMessage interface
- `packages/extension/src/bridge/MessageBroker.ts`: Propagates correlationId from incoming request to outgoing response via buildResponse helper
- `packages/webview/src/hooks/useMessageResponse.ts`: Updated listener to match on correlationId (primary) with type-only fallback for backward compatibility
- `packages/shared/src/types/messages.types.test.ts`: Tests for correlationId on BaseMessage
- `packages/webview/src/hooks/useMessageResponse.test.ts`: Tests for correlationId matching, rejection, and fallback

## Decisions made

- correlationId is optional to maintain backward compatibility with any existing messages
- The request's `msg.id` serves as the correlation key — no new ID generation needed
- buildMessage unchanged — hooks pass msg.id as the expected correlationId
- Matching logic: if response has correlationId, it must match the request; if absent, falls back to type-only matching

## Deviations from plan

- Task 01-01-02 (update buildMessage) was a no-op — buildMessage already generates unique IDs that serve as correlation keys
