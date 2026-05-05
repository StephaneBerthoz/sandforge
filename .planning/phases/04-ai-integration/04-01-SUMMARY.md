# Plan 04-01 Summary

**Completed:** 2026-05-05

## What was built

Foundation for the Phase 04 AI substrate. Bumped `zod` to `^3.25` (helpers
in the Anthropic SDK require `zod/v4`), pinned `@anthropic-ai/sdk` at
exact `0.93.0`, shipped the provider-agnostic `AIClient` interface, the
`AnthropicAdapter` happy path (chat / complete / countTokens / dispose
with lazy SecretStorage read + per-call API-key redaction + preserved
`APIUserAbortError`), the per-provider memoised `AIClientFactory`, and
wired `services.aiClient(provider?)` into `createServices()`. A
vertical-slice integration test proves
`services.aiClient('anthropic').complete({prompt, schema:
DiagnoseResultSchema})` round-trips through a mocked SDK to a typed
payload — replacing the regex-extract JSON pattern (RT-#11 closure path
opens; full closure ships in 04-07).

## Key files

- `packages/extension/package.json` — `@anthropic-ai/sdk@0.93.0`
  (exact pin), `zod@^3.25.0`.
- `packages/shared/package.json` — `zod@^3.25.0`.
- `packages/shared/src/schemas/ai/diagnose.ts` — `AIUsageSchema`,
  `aiCallResultSchema<T>`, `DiagnoseResultSchema` (`.strict()`).
- `packages/shared/src/schemas/ai/index.ts` — barrel.
- `packages/extension/src/adapters/ai/AIClient.ts` — interface + opts/result
  types + `AINotImplementedError`.
- `packages/extension/src/adapters/ai/AnthropicAdapter.ts` — happy path
  using `messages.create` / `messages.parse + zodOutputFormat` /
  `messages.countTokens`. Lazy SecretStorage. 4-field usage breakdown.
  API-key redaction in re-thrown errors. Preserves `APIUserAbortError`.
- `packages/extension/src/adapters/ai/AIClientFactory.ts` — memoised per
  provider; openai / custom currently throw `AINotImplementedError`
  (replaced by stubs in Plan 04-07).
- `packages/extension/src/adapters/ai/index.ts` — barrel.
- `packages/extension/src/services.ts` — `Services.aiClient(provider?)`
  added; reads `sandforge.ai.provider` + `sandforge.ai.model` from VSCode
  settings on each factory call.
- `packages/extension/src/adapters/ai/AnthropicAdapter.test.ts` — 9 tests
  + Plan 04-01 vertical slice.
- `packages/extension/src/adapters/ai/AIClientFactory.test.ts` — 6 tests.
- `packages/extension/src/services.test.ts` — +3 tests (memoisation, lazy
  SecretStorage, services.aiClient vertical slice).

## Decisions made

- **Telemetry adapter signature mismatch resolved by adapting calls.**
  Plan assumed `addBreadcrumb({category, message, data})`; real API is
  `addBreadcrumb(message, category, level)`. AnthropicAdapter inlines
  the data into the message string (token totals only, no PII).
- **`messages.countTokens` over `beta.messages.countTokens`.** The
  non-beta surface exists in 0.93.0 and is sufficient for preflight in
  Plan 04-05.
- **Reused the existing `CircuitBreaker` API as-is.** Plan 04-02 will
  layer per-provider breaker state without modifying the breaker class.
- **Kept the AIClientFactory openai/custom branches as throws (not
  stubs) for now.** Plan 04-07 ships proper `OpenAIAdapter` /
  `CustomAdapter` stubs that satisfy the interface.

## Notes for downstream

- **Plan 04-02:** wraps `runWithBreaker` in `AnthropicAdapter`, adds the
  per-provider EventEmitter, per-AI-request AbortController, and the
  `ai:provider:status` envelope. Note the existing `CircuitBreaker`
  uses `'half_open'` (snake_case), not `'half-open'` — adjust the
  envelope's discriminator accordingly OR map at the boundary.
- **Plan 04-03:** `wrapTool` and the 10 read-only tools live under
  `adapters/ai/tools/`. `runTools()` becomes a new `AnthropicAdapter`
  method that uses `client.beta.messages.toolRunner` with `for-await`
  streaming.
- **Plan 04-04:** `AIDiagnoseHandler` is a NEW file; existing
  `AIChatHandler` / `AIToolsHandler` / `AIAnalysisHandler` are
  untouched. Use the `wrapAsUserData` helper from 04-06 directly (no
  TODO).
- **Plan 04-05:** `SessionBudget` lives on the AIChatPanel lifecycle
  (panel-open / panel-close), passed into the adapter via a mutable
  field — the factory key stays `${provider}` to preserve breaker
  state across sessions.
- **Plan 04-06:** ships before 04-04 in this phase ordering so 04-04
  imports `wrapAsUserData` directly.
- **Plan 04-07:** replaces the openai/custom factory throws with stub
  adapter constructors that satisfy the interface (constructor never
  throws; methods do).
- **Test count:** extension suite: 4865 → 4883 (+18). 0 regressions.
- **NLS keys:** none added in this plan; Plan 04-02 / 04-04 / 04-05 add
  banner / action-card / budget copy.
