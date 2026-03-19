# Plan 06-01 Summary

**Completed:** 2026-03-19
**Phase:** 06 -- Gap Closure: buildResponse Migration & Verification

## What was built

Migrated all 6 infrastructure handlers from manual response object construction to the `buildResponse()` helper function, completing BRG-02 correlationId propagation across the entire handler layer. Every response message now carries a `correlationId` matching the incoming request's `id`, enabling the webview's `useMessageResponse` hook to match responses to their triggering requests. Created 4 new test files and updated 2 existing ones with correlationId assertions.

## Key files

- `packages/extension/src/bridge/handlers/ConfigHandler.ts`: 4 manual constructions replaced
- `packages/extension/src/bridge/handlers/SettingsHandler.ts`: 9 manual constructions replaced
- `packages/extension/src/bridge/handlers/OrgHandler.ts`: 4 manual constructions replaced (threaded `msg` through private dispatch methods)
- `packages/extension/src/bridge/handlers/MigrationHandler.ts`: 4 manual constructions replaced
- `packages/extension/src/bridge/handlers/ai/AIAnalysisHandler.ts`: 6 manual constructions replaced
- `packages/extension/src/bridge/handlers/ai/AIToolsHandler.ts`: 9 manual constructions replaced
- `packages/extension/src/bridge/handlers/SettingsHandler.test.ts`: NEW -- 10 tests covering correlationId propagation
- `packages/extension/src/bridge/handlers/OrgHandler.test.ts`: NEW -- 3 tests covering correlationId propagation
- `packages/extension/src/bridge/handlers/MigrationHandler.test.ts`: NEW -- 3 tests covering correlationId propagation
- `packages/extension/src/bridge/handlers/ai/AIToolsHandler.test.ts`: NEW -- 8 tests covering correlationId propagation

## Decisions made

- OrgHandler: Threaded `msg` parameter through `handleSfdxImport(msg)` and `handleUsernamePassword(msg, payload)` private methods so they have access to the original request for correlationId propagation. `handleOAuthWeb` was not changed as it does not construct response messages directly.
- ForgeHandler was correctly excluded -- its `deps.nextId()` calls generate operationIds, not response messages.

## Deviations from plan

None

## Notes for downstream

- All 36 manual response constructions across the 6 infrastructure handlers now use `buildResponse()`.
- The only remaining `deps.nextId()` calls in handler files are in `HandlerTypes.ts` (the utility functions themselves) and `ForgeHandler.ts` (operationId generation).
- Total test count increased from approximately 7018 to 7042 (24 new test cases across 4 new files + updated assertions in 2 existing files).
- BRG-02 requirement is now fully satisfied across the entire handler layer.
