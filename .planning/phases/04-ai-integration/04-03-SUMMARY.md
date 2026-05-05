# Plan 04-03 Summary

**Completed:** 2026-05-05

## What was built

Shipped the read-only tool surface end to end. Created
`ToolErrorSchema` + `toolResultSchema(dataSchema)` discriminated union in
shared, plus 10 per-tool input/output Zod schemas (all `.strict()`).
Created `wrapTool` — the THROWS-AT-CONSTRUCTION fence that enforces (1)
the read-only naming regex `/^(describe|query|get|list|count|validate|
analyse|preview|fetch|read)_…/` and (2) a `READ-ONLY` substring in every
description; runtime contract: input parsed via Zod, output forced
through `toolResultSchema`, returns JSON-stringified payload, fires
`onTrace` with `start` / `success` / `error` (no payload data — privacy).
Built 10 read-only tool builders (`describe_object`, `query_records`,
`get_limits`, `get_recent_errors`, `get_apex_log`, `get_metadata`,
`get_alerts`, `get_anomalies`, `list_sobjects`, `validate_soql`); each
takes a generic `ToolDeps` so the consume site (Plan 04-04
`AIDiagnoseHandler`) wires actual SF/Monitor surfaces. `query_records`
and `validate_soql` additionally refuse DML keywords with code
`DML_FORBIDDEN`. Shipped a registry CI fence test (7 assertions) that
fails any future PR adding a write-verb tool. Added
`AnthropicAdapter.runTools()` driving `client.beta.messages.toolRunner`
with `for-await` streaming + UUID `runId`; routes through `runWithBreaker`
so a tool-loop 529 trips the same breaker. Shipped `ai:tool-trace` bridge
envelope (timings + status only — never payloads). Vertical slice: a
mocked toolRunner with 2 tool_use turns + 1 final text returns
`toolCalls=2`, `text='There are 142…'`, last-message usage wins.

## Key files

- `packages/shared/src/schemas/ai/tools.ts` — `ToolErrorSchema`,
  `toolResultSchema<T>`, 10 input/output schemas (all `.strict()`).
- `packages/extension/src/adapters/ai/tools/wrapTool.ts` — fence helper +
  contract enforcer; throws at construction on illegal verbs / missing
  `READ-ONLY`.
- `packages/extension/src/adapters/ai/tools/wrapTool.test.ts` — 9 tests.
- `packages/extension/src/adapters/ai/tools/readOnlyTools.ts` — 10
  builders + `READ_ONLY_TOOL_NAMES` + `buildAllReadOnlyTools(deps)`.
  `ToolDeps` interface decouples builders from the consume site.
- `packages/extension/src/adapters/ai/tools/index.ts` — barrel.
- `packages/extension/src/adapters/ai/tools/registry.test.ts` — 7-test CI
  fence (Pitfall #4 + DML_FORBIDDEN guards).
- `packages/extension/src/adapters/ai/AnthropicAdapter.ts` — `runTools()`
  + `randomUUID()` runId.
- `packages/shared/src/types/messages.types.ts` — `AIToolTraceMessage`.
- `packages/shared/src/bridge/messageSchemas.ts` — `msg('ai:tool-trace')`
  added to AI domain.
- `packages/extension/src/adapters/ai/AnthropicAdapter.test.ts` — +6
  runTools tests including vertical slice.

## Decisions made

- **Tool builders bundled in one file** (`readOnlyTools.ts`) rather than
  10 separate files. Keeps the diff manageable; the registry fence test
  guards naming + count, which is what matters for the contract.
- **Generic `ToolDeps` interface with optional callbacks.** Builders
  throw `'… not wired'` if a dep is missing — fails LOUD rather than
  silently returning empty results. Plan 04-04 wires real adapters.
- **DML refusal at TWO layers**: `validate_soql` AND `query_records`.
  The plan said only `validate_soql`, but adding the same regex in
  `query_records` is cheap defense in depth in case Claude tries the
  query path first.
- **`runId` via `crypto.randomUUID()`**, not external dep.
- **`onTrace` is wired through `wrapTool`, not via runTools directly.**
  The caller builds tools with `onTrace` already wired (e.g.,
  `(e) => bridge.send({ type: 'ai:tool-trace', payload: { runId, ...e } })`),
  then passes them to `runTools`. Documented in `runTools` JSDoc.
- **Last-message usage wins** in `runTools`. Anthropic's toolRunner
  emits per-step usage; the final answer's usage block reflects total
  context. Aggregating naively would double-count cached tokens.

## Notes for downstream

- **Plan 04-04 AIDiagnoseHandler:** when constructing diagnose tools,
  filter `buildAllReadOnlyTools(...)` down to the diagnose allowlist
  `{describe_object, query_records, get_recent_errors, get_apex_log,
  get_limits, validate_soql}`. Wire `onTrace` to broker.send.
- **Plan 04-06:** the existing `wrapTool` flows tool errors through
  `toolResultSchema` — if escapeUserData regresses, the canary in
  AIDiagnoseHandler still catches it because the prompt itself is
  built upstream.
- **Plan 04-07:** stub adapters (OpenAI / Custom) inherit the same
  `runTools` shape; no per-provider tool-trace divergence.
- **Test count:** extension 4907 → 4937 (+30 across wrapTool + registry
  + runTools blocks). Shared 967 unchanged. Webview 5 banner tests from
  04-02. 0 regressions.
