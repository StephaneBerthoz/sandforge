# Plan 02-04 Summary

**Completed:** 2026-03-17
**Phase:** 02 -- Module Execution Fixes

## What was built

Added AI conversation persistence to ConfigStore using per-conversation keys (`ai:conversation:{id}`) with a separate index key (`ai:conversations:index`) under the `ai` category. All AIChatHandler responses now use `buildResponse()` for correlationId propagation. A 200-message cap with automatic pruning was implemented. The AIPage now shows inline guidance with a "Go to Settings" button when `aiAvailable` is false, and loads the persisted conversation list on mount.

## Key files

- `packages/extension/src/bridge/handlers/ai/AIChatHandler.ts`: Full persistence layer with ConfigStore, message pruning, buildResponse migration, and new `ai:conversation:list` handler
- `packages/webview/src/pages/AI/AIPage.tsx`: Guidance UI when AI not configured, conversation list loading on mount, conversation loaded message listener
- `packages/shared/src/types/messages.types.ts`: Added `AIConversationListRequest`, `AIConversationListResponse`, `AIConversationDeletedResponse` types
- `packages/webview/src/i18n/locales/en.json`: Added `ai.notConfigured.*` keys (en)
- `packages/webview/src/i18n/locales/fr.json`: Added `ai.notConfigured.*` keys (fr)
- `packages/extension/src/bridge/handlers/ai/AIChatHandler.test.ts`: 18 tests covering persistence, correlationId, message cap, list/load/delete
- `packages/webview/src/pages/AI/AIPage.test.tsx`: 11 tests covering configured and unconfigured states

## Decisions made

- Used per-conversation ConfigStore keys instead of a single blob to avoid globalState size limits (as recommended by Research Pitfall 6)
- Message cap set at 200 (plan suggested 200, research suggested 100 -- went with plan specification)
- Pruning keeps system messages plus most recent non-system messages
- `ai:conversation:load` falls back to ConfigStore when AIAssistant has no in-memory copy (supports reload persistence)
- `ai:conversation:delete` now sends a `ai:conversation:deleted` response (was fire-and-forget before)
- Added `ai:conversation:list` handler for the webview to load persisted conversations on mount
- AIPage uses `useAppStore.navigate('settings')` for the guidance button (consistent with existing navigation patterns)

## Deviations from plan

- Added `ai:conversation:list` and `ai:conversation:list:response` message type to `messages.types.ts` (not in original plan's `files_modified` but required for the list handler)
- Added `ai:conversation:deleted` response type (delete was previously fire-and-forget, now sends confirmation)
- AIPage also listens for `ai:conversation:loaded` response to populate messages when loading a persisted conversation (was missing from original implementation)

## Notes for downstream

- The `ai:conversation:list` message should be sent on AIPage mount to load persisted conversations
- BridgeProvider does not need changes -- AI status already sets `aiAvailable` which gates the page
- Other locale files (de, es, ja, pt-BR) do not have the `notConfigured` keys yet -- they will fall back to the English defaults via i18n
