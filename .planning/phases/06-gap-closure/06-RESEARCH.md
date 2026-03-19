# Phase 06 Research: Gap Closure

## Don't Hand-Roll

- **buildResponse pattern** — Already exists in `HandlerTypes.ts:76`. All 10 domain handlers use it. Follow the exact same pattern: `buildResponse(this.deps, request, responseType, payload)`. Do NOT create a new helper or modify buildResponse.
- **correlationId test pattern** — Already established in Phase 2 test files (112 assertions). Use `expect(response.correlationId).toBe(request.id)` pattern.

## Common Pitfalls

1. **ForgeHandler has 2 `deps.nextId()` calls for operationIds** — These are NOT response constructions. They generate unique `forge-discover-{id}` and `forge-execute-{id}` strings. Do NOT migrate these to buildResponse.
2. **SettingsHandler has the most manual constructions (9)** — includes plugins:*, telemetry:*, connectivity:* responses. Each needs careful type matching.
3. **Error responses also need buildResponse** — Many handlers have try/catch blocks that construct error responses manually. These must also be migrated.
4. **Import path must use `.js` extension** — ESM requires `import { buildResponse } from './HandlerTypes.js'` (not `.ts`).
5. **Test files for 4 handlers don't exist** (SettingsHandler, OrgHandler, MigrationHandler, AIToolsHandler) — Keep new test scope focused on correlationId verification only (gap closure, not full test suite).
