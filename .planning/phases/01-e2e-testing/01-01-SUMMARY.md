# Plan 01 Summary

**Completed:** 2026-03-16

## What was built

MockBridge test helper that wraps the existing VSCode API mock pattern with auto-correlated request/response messaging. Shared fixtures extracted from duplicated mock data across specs (mock orgs, response factories for org list, preview, describe, AI chat, NL2SOQL, error resolver, autopilot schema/plan/progress). Installed `@axe-core/playwright` for accessibility testing.

## Key files
- `e2e/helpers/MockBridge.ts`: MockBridge class with setup(), waitForMessage(), respond(), respondToNext(), getMessages()
- `e2e/helpers/index.ts`: Barrel export + backward-compatible re-exports of legacy helpers
- `e2e/fixtures/mock-orgs.ts`: DEV_SANDBOX, QA_SANDBOX, MOCK_ORGS, MOCK_EMPTY_ORGS, createMockOrg()
- `e2e/fixtures/mock-responses.ts`: Response factories for all module message types
- `e2e/fixtures/index.ts`: Barrel export

## Decisions made
- MockBridge uses `page.waitForFunction()` instead of `waitForTimeout(200)` for reliability
- Legacy helpers (`injectVSCodeApiMock`, `sendExtensionMessage`) re-exported for backward compatibility — existing specs not modified
- Fixtures use local `MockOrg` interface rather than importing from `@sandforge/shared` to avoid tsconfig complexity in E2E context

## Notes for downstream
- Plans 02 and 03 should import from `./helpers` and `./fixtures` exclusively
- `bridge.respondToNext('org:list', 'org:list:response', { orgs: MOCK_ORGS })` replaces the `resolveOrgListLoading` pattern
- All 105 existing tests still pass (1.9 min)
