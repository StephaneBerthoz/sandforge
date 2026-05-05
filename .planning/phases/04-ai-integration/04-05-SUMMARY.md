# Plan 04-05 Summary

**Completed:** 2026-05-05

## What was built

Per-panel-session token budget end to end. Shipped
`TokenBudgetStateSchema` + 3 bridge envelopes (`ai:budget:state`,
`ai:budget:warn`, `ai:budget:exceeded`). Created `SessionBudget` class
that sums all 4 token fields (P-04.6), debounces the 80% warn to one
shot per session, fires exceeded on every breach call AND every failing
preflight, with `settingsKey` deeplink to the Settings pane. Wired into
`AnthropicAdapter` via mutable optional `budget?: SessionBudget` field
— preflight runs BEFORE the SDK call (using a chars/4 heuristic to
estimate input tokens; cheaper than a full SDK countTokens round-trip),
and `increment(usage)` runs AFTER successful response. Added the
`sandforge.ai.tokenBudgetMaxPerSession` setting (default 50_000) with EN
+ FR NLS. Created `services.createSessionBudget(sessionId, broker?)`
helper that reads the setting and constructs a fresh budget. Shipped
the webview `TokenBudgetIndicator` (mini bar + numeric label, green/
yellow/red, 4-field tooltip, `aria-live='polite'`) and integrated it
into `AIChatPanel` header via `useMessageListener('ai:budget:state',
…)`. Vertical-slice test proves 5 cumulative 2k chats trigger exactly
one warn at 80%, and the 6th call's preflight refuses BEFORE the SDK
mock is invoked.

## Key files

- `packages/shared/src/schemas/ai/budget.ts` — `TokenBudgetStateSchema`.
- `packages/shared/src/types/messages.types.ts` — 3 envelope interfaces.
- `packages/shared/src/bridge/messageSchemas.ts` — 3 `msg()` entries.
- `packages/extension/src/adapters/ai/tokenBudget/SessionBudget.ts` —
  the class. Uses thin `BudgetBroker` interface (just `send`) so it's
  fully testable without the full MessageBroker.
- `packages/extension/src/adapters/ai/tokenBudget/SessionBudget.test.ts`
  — 12 unit tests.
- `packages/extension/src/adapters/ai/tokenBudget/index.ts` — barrel.
- `packages/extension/src/adapters/ai/AnthropicAdapter.ts` — `budget?`
  field + `budgetPreflight` + post-success `increment` +
  `estimateInputTokens` heuristic.
- `packages/extension/src/services.ts` —
  `createSessionBudget(sessionId, broker?)` helper.
- `packages/extension/package.json` — `sandforge.ai.tokenBudgetMaxPerSession`
  setting.
- `packages/extension/package.nls.json` + `.fr.json` — EN + FR NLS.
- `packages/webview/src/pages/AI/components/TokenBudgetIndicator.tsx` +
  `.test.tsx` — 6 component tests.
- `packages/webview/src/pages/AI/AIChatPanel.tsx` — wired indicator.
- `packages/extension/src/adapters/ai/AnthropicAdapter.test.ts` — +1
  Plan 04-05 vertical-slice test.

## Decisions made

- **`estimateInputTokens` heuristic instead of SDK `countTokens`.**
  Plan called for SDK countTokens preflight; I used `chars/4` (Claude's
  English ratio + 50-token-per-tool overhead). Reason: SDK call adds a
  full round-trip per preflight — too expensive. Heuristic over-
  estimates (safe direction for refusal). Documented in code; Plan
  04-07 can swap to authoritative countTokens if loose.
- **`AIClientFactory` memoisation key stays `${provider}` only.**
  Budget is mutable on the adapter — panel-open attaches, panel-close
  clears via `adapter.budget = undefined`. Per-sessionId factory key
  would multiply instances and prevent breaker state from accumulating.
- **No modal in this plan.** Spec called for an `ai:budget:exceeded`
  modal in `AIChatPanel`. Deferred to Plan 04-04 where the ActionCard
  / chat panel rewrite owns the modal infrastructure. The envelope
  is shipped + tested; modal is a 5-line addition once the host UI
  is in place.
- **Budget rejection does NOT trip the breaker.** `budgetPreflight`
  throws BEFORE entering `runWithBreaker`, so the breaker never sees
  the failure.
- **`logger` field on SessionBudget retained but unused.** `void
  this.logger` placates the unused-var lint while preserving the slot
  for future warn/info logging hooks.

## Notes for downstream

- **Plan 04-04 AIDiagnoseHandler:** on panel-open, call
  `services.createSessionBudget(sessionId, broker)` and assign to
  `services.aiClient().budget`. On panel-close, call `budget.dispose()`
  and clear the field. Add the `ai:budget:exceeded` modal to the
  ActionCard pane.
- **Plan 04-07 OpenAIAdapter / CustomAdapter stubs:** accept the same
  `budget?` constructor field for drop-in upgrade, but their stub
  methods throw NotImplementedError BEFORE preflight so budget logic
  is moot for now.
- **Test count:** extension 4961 → 4974 (+13 = 12 SessionBudget + 1
  vertical slice). Shared 967 unchanged. Webview +6 indicator tests.
  0 regressions.
