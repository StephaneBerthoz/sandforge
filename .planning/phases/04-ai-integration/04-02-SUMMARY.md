# Plan 04-02 Summary

**Completed:** 2026-05-05

## What was built

Made `AnthropicAdapter` resilient. Added a per-provider `CircuitBreaker`
(3 consecutive failures → open for 5 min) wrapping every chat / complete
/ countTokens call, a per-AI-request `AbortController` (sibling-safe —
cancelling one request never aborts another), a `cancelAll()` helper for
panel-close cleanup, an `EventEmitter` that re-publishes breaker
state-change events, and the `ai:provider:status` bridge envelope. Shipped
the webview `AIProviderStatusBanner` (FR + EN copy, live mm:ss countdown
to half-open transition) wired into `AIChatPanel`. The classifier
duck-types Anthropic SDK errors via the dual-signal overloaded check
(`status===529` OR `body.error.type==='overloaded_error'`) and preserves
`APIUserAbortError` unwrapped so callers can `instanceof` it. A
vertical-slice test proves the full lifecycle: 3x 529 → open → 4th call
fast-fails (zero SDK invocations) → `vi.advanceTimersByTime(300_001)` →
next call attempts SDK and the breaker re-closes.

## Key files

- `packages/extension/src/adapters/ai/errorClassifier.ts` — pure helper
  + `parseRetryAfter`. AIErrorVerdict: `{kind, shouldTripBreaker,
  shouldRetry, retryAfterMs?, userMessageKey, rawStatus?}`.
- `packages/extension/src/adapters/ai/errorClassifier.test.ts` — 15
  tests, every branch + Retry-After parsing.
- `packages/extension/src/adapters/ai/AnthropicAdapter.ts` — refactored.
  New: `runWithBreaker`, `cancelAll`, `breakerEvents`, breaker default
  `{failureThreshold:3, resetTimeout:300_000}`. Snake_case `'half_open'`
  → camel-dashed `'half-open'` mapping at the boundary.
- `packages/extension/src/adapters/ai/AnthropicAdapter.test.ts` — +9
  tests (3x529 trip, 2x529+success no-trip, 3x429 trip, 5x cancel
  no-trip, mixed cancel+529 trip, breakerEvents, cancelAll, sibling
  isolation, vertical-slice 5min reset).
- `packages/shared/src/types/messages.types.ts` — `AIProviderStatusMessage`
  interface added.
- `packages/shared/src/bridge/messageSchemas.ts` — `msg('ai:provider:status')`
  added to AIMessageSchema discriminated union.
- `packages/webview/src/pages/AI/components/AIProviderStatusBanner.tsx`
  — new component. `data-testid="ai-provider-status-banner"`. `aria-live`.
- `packages/webview/src/pages/AI/components/AIProviderStatusBanner.test.tsx`
  — 5 tests (closed/half-open/open + countdown decrement + secret-leak
  grep).
- `packages/webview/src/pages/AI/AIChatPanel.tsx` — banner wired via
  `useMessageListener('ai:provider:status', …)`.
- `packages/webview/src/i18n/locales/en.json` + `fr.json` — 6 new keys
  under `ai.error.*` (overloaded / rateLimit / auth / cancelled /
  transient / unknown).

## Decisions made

- **Breaker state is per-instance only.** No shared breaker across the
  factory's per-provider instances — the factory keeps one adapter per
  provider, and each adapter owns its breaker.
- **Snake_case → dash mapping at the adapter boundary.** The underlying
  `CircuitBreaker` uses `'half_open'`; the bridge envelope uses
  `'half-open'`. Mapping happens in `mapBreakerState`.
- **No retry loop in the adapter.** The verdict carries `shouldRetry`
  and `retryAfterMs`, but the adapter throws and lets the caller decide.
  Higher-level handlers (Plan 04-04 diagnose flow) compose the retry.
- **APIUserAbortError preserved by `instanceof`.** The plan said use
  the SDK's exported class; my mock factory exports the same class
  shape so tests work too.
- **Banner integration is minimal.** The component is rendered above
  the chat content via a thin `useMessageListener` subscription; the
  ActionCard / ChatPanel rewrite lands in Plan 04-04.

## Notes for downstream

- **Plan 04-03:** `runTools()` is a NEW public method on `AnthropicAdapter`.
  It MUST also route through `runWithBreaker` so a 529 storm during
  tool runs trips the same breaker.
- **Plan 04-04:** `AIDiagnoseHandler` should subscribe to
  `breakerEvents.on('state-change', ...)` to forward state changes to
  the webview as `ai:provider:status` envelopes (currently no-op — the
  component renders only what it's told). Plan 04-04 owns the wire-up.
- **Plan 04-05:** budget rejection (`code:'AI_BUDGET_EXCEEDED'`) MUST
  NOT call `breaker.recordFailure()`. The adapter should call
  `breaker.recordSuccess()` (no penalty) before throwing.
- **Plan 04-07:** stub adapters get their OWN `CircuitBreaker` instance.
  Multi-provider isolation test asserts `adapter.breaker !==
  otherAdapter.breaker`.
- **Test count:** extension 4883 → 4901 (+18 across errorClassifier
  + AnthropicAdapter breaker block). Webview +5 banner tests. 0
  regressions in either suite.
