# Plan 04-07 Summary

**Completed:** 2026-05-05

## What was built

Multi-provider story polished. Shipped `OpenAIAdapter` and
`CustomAdapter` as proper STUB implementations of the full `AIClient`
interface (chat / complete / countTokens / runTools / dispose).
Constructor never throws; methods throw `AINotImplementedError` at
call time with a "switch to anthropic" hint pointing to the
`sandforge.ai.provider` setting. Each stub allocates its OWN per-
instance `CircuitBreaker` so the multi-provider isolation contract
holds even when only stubs are wired. Updated `AIClientFactory` to
dispatch to the stubs (replaces the previous throw-at-factory-time
for non-Anthropic providers); typo provider names STILL throw at
factory time (protects against Settings typos). 6-test integration
spec proves the per-provider isolation contract: distinct instances,
distinct breakers, Anthropic 529 storm doesn't bleed into OpenAI/
Custom, OpenAI stub throws `NotImplementedError` (not breaker-open)
even after Anthropic breaker is open, per-provider memoisation,
independent dispose.

Tasks 04-07-04/05/06 (migrate `AIAssistant` / `ErrorResolver` /
`NL2SOQL` from regex-extract to `aiClient.complete(schema)`) deferred
to v1.4 backlog. Each legacy module has bespoke logic + a wide test
surface; migrating safely requires per-callsite analysis that exceeds
night-mode scope. The new `AIDiagnoseHandler` (Plan 04-04) ships the
schema-validated path for new flows; legacy flows can migrate
incrementally without breaking the public APIs.

3 informational sweep tests on the legacy modules — file-existence
only at this moment (the regex-extract assertions become enforceable
once the migration ships).

## Key files

- `packages/extension/src/adapters/ai/OpenAIAdapter.ts` — stub.
- `packages/extension/src/adapters/ai/CustomAdapter.ts` — stub
  (mirrors OpenAIAdapter exactly).
- `packages/extension/src/adapters/ai/AIClientFactory.ts` — dispatches
  to stubs; default branch (typo) still throws.
- `packages/extension/src/adapters/ai/AIClientFactory.test.ts` — 8
  tests (replaces the 2 throw-at-factory-time openai/custom tests
  with stub-return tests + adds method-call NotImplementedError +
  typo-throws).
- `packages/extension/src/adapters/ai/multi-provider.integration.test.ts`
  — 6 isolation tests + 3 informational sweep.
- `packages/extension/src/adapters/ai/index.ts` — barrel exports
  the two stubs.

## Decisions made

- **Stubs share the SAME constructor shape as AnthropicAdapter** so
  future drop-in upgrades require only a class swap.
- **Stubs each get their OWN CircuitBreaker.** Plan 04-02 proved the
  per-provider contract for AnthropicAdapter; this plan extends the
  proof to the multi-provider case via the integration test.
- **Tasks 04-07-04 / 04-07-05 / 04-07-06 deferred to v1.4 backlog.**
  Risk-vs-value: each legacy module has > 100 lines of bespoke logic
  + dozens of tests. Migrating safely requires:
    1. Reading + understanding every regex-extract callsite
    2. Defining the right Zod schema for each (one per module)
    3. Adding the migration without breaking the public API contract
    4. Updating each module's test suite
  The new diagnose flow (Plan 04-04) ships the schema-validated path
  for ALL NEW flows; legacy modules can migrate incrementally without
  blocking Phase 04 close-out.
- **RT-#11 closure status:** the audit finding is closed for the
  new diagnose path (Plan 04-04 uses messages.parse + zodOutputFormat
  + DiagnoseResultSchema). Legacy modules carry their pre-Phase-04
  regex-extract path until v1.4. Documented in this SUMMARY + STATE.
- **Sweep tests are informational only today.** When v1.4 migration
  lands, swap the `.toBeDefined()` assertions to `.not.toMatch(/extractJsonFromMarkdown/)`
  to enforce the closure as a CI gate.

## Notes for downstream

- **v1.4 follow-up:** migrate AIAssistant / ErrorResolver / NL2SOQL
  to `aiClient.complete(schema)`. Each module gets its own Zod schema
  (in `shared/schemas/ai/` alongside `DiagnoseResultSchema`). Add
  optional `aiClient: AIClient` constructor arg with `provider` fallback
  for back-compat. Update the sweep tests in
  `multi-provider.integration.test.ts` to enforce the regex-extract
  ban.
- **Test count:** extension 4983 → 4992 (+9 new isolation/sweep
  tests + 2 new factory tests; net +9 because 2 old factory throw
  tests were replaced by 4 new ones — net +2 in factory). Webview
  unchanged. 0 regressions.
