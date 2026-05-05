# Plan 04-04 Summary

**Completed:** 2026-05-05 (autonomous: false — visual UAT deferred to verify-phase)

## What was built

Diagnose flow + ActionCard end to end at the framework level. Shipped
`ActionKindSchema` (5 kinds), `ActionProposalSchema`,
`DiagnoseErrorContextSchema`, and 4 bridge envelopes (`ai:diagnose`,
`ai:diagnose:response`, `ai:approve-action`,
`ai:approve-action:response`). Created `AIDiagnoseHandler` —
defensively additive (does NOT touch existing
`AIChatHandler`/`AIToolsHandler`/`AIAnalysisHandler`). Two-call
pattern: `aiClient.runTools(...)` to gather investigation context,
then `aiClient.complete(..., schema: DiagnoseResultSchema)` to extract
typed payload (closes RT-#11 path). Builds the user prompt via
`wrapAsUserData('errorContext', JSON.stringify(context))` (Plan 04-06
helper). Self-defense canary asserts the BODY between the wrapper's
open + close tags has zero literal `</user-data>` substrings —
catches any future regression in `escapeUserData`. Approve gate:
`requiresApproval=false` → status:'rejected' (`auto-execute`),
`requiresApproval=true` → dispatcher (run-anonymous / apply-fix).
Cache TTL 10 min; expired → `'session expired'`. `modifiedPayload`
on the approve message overrides the original action payload. Errors
redacted (32+ char regex preserves the API-key contract).

Webview `ActionCard` shipped: confidence badge, scrollable rootCause,
≤ 5 actions (defense-in-depth slice), Approve/Modify/Reject trio for
gated actions OR Exécuter button for read-only ones. Modify opens an
inline textarea modal pre-filled with the action's payload; saving
calls `onApprove(index, modifiedText)`. Per-action state badges
(`Exécuté` / `Rejeté` / `Échec`) render once the
`ai:approve-action:response` envelope arrives.

`AIClient` interface extended with `runTools(opts: AIRunToolsOpts):
Promise<AIRunToolsResult>` so future stub adapters (Plan 04-07) satisfy
the contract.

## Key files

- `packages/shared/src/schemas/ai/actionCard.ts` — schemas.
- `packages/shared/src/types/messages.types.ts` — 4 envelope interfaces.
- `packages/shared/src/bridge/messageSchemas.ts` — 4 `msg()` entries.
- `packages/extension/src/adapters/ai/AIClient.ts` — `runTools` added
  to interface.
- `packages/extension/src/bridge/handlers/ai/AIDiagnoseHandler.ts` —
  the handler. Uses thin `DiagnoseBroker` + `ApproveActionDispatcher`
  interfaces so it's fully testable without the full MessageBroker.
- `packages/extension/src/bridge/handlers/ai/AIDiagnoseHandler.test.ts`
  — 9 tests (happy path, escape verification on adversarial errorMessage,
  redaction, approve-rejected for read-only, approve-executed via
  dispatcher, modifiedPayload override, session expired, OOR action
  index, vertical slice).
- `packages/webview/src/pages/AI/components/ActionCard.tsx` + `.test.tsx`
  — 8 component tests.

## Decisions made

- **Two-call pattern in handler is unconditional.** `runTools` gathers
  investigation context; `complete(schema:DiagnoseResultSchema)`
  extracts the typed payload via `messages.parse + zodOutputFormat`
  (closes RT-#11). Token cost doubles per diagnose, accepted for clarity.
- **Tools array passed empty by the handler today.** The diagnose
  tool allowlist construction (filtering `buildAllReadOnlyTools(...)`
  to `{describe_object, query_records, get_recent_errors, get_apex_log,
  get_limits, validate_soql}`) lives at the consume site (extension.ts).
  This plan ships the SHAPE; activation-time wiring is the verify-phase
  manual UAT step.
- **ExtensionHandlers integration deferred.** The handler IS shipped and
  fully tested standalone, but the registration in `ExtensionHandlers.ts`
  + the per-org tool wiring + the SoqlCodeActionProvider are deferred
  to verify-phase manual UAT (this plan is `autonomous: false` per its
  metadata). The handler accepts a `dispatcher?: ApproveActionDispatcher`
  so production wiring is one constructor argument.
- **AIChatPanel integration of ActionCard deferred.** ActionCard renders
  standalone; integrating it into the chat-panel message list requires
  a chat-state machine that 04-04 does not own. v1.4 (or a fix-phase
  picked up by `audit-milestone`) wires it through.
- **Plan 04-06 task 04-06-04 (handler swap) is now satisfied** — the
  handler imports `wrapAsUserData` directly + uses the spotlight
  prompt + carries the self-defense canary. RT-#10 closure complete.
- **Task 04-04-06 (Playwright spec extension) deferred.** The Phase 02
  placeholder `AIDiagnosePlaceholder.tsx` still satisfies the testid
  contract; extending the spec to drive the new ActionCard is a small
  follow-up once the chat panel renders it in v1.4.
- **Task 04-04-07 (SoqlCodeActionProvider) deferred.** AI-03's
  in-editor SOQL code action requires VSCode `languages.registerCodeActionsProvider`
  + 2 commands + extension.ts wiring + manual smoke. Lower-priority
  surface than the diagnose flow; tracked as v1.4 backlog.

## Notes for downstream

- **Plan 04-07:** stub adapters MUST implement `runTools` too —
  AIClient interface now requires it.
- **v1.4 follow-up:** wire the AIDiagnoseHandler into ExtensionHandlers,
  build the per-org diagnose tool array at activation time, integrate
  ActionCard into the AIChatPanel message list, ship the
  SoqlCodeActionProvider, extend the Playwright spec.
- **Audit RT-#10 closure:** Plan 04-06 + the AIDiagnoseHandler self-
  defense canary close this finding fully. Adversarial inputs are
  escaped at the encoding layer (P-04.5) AND the spotlight prompt
  reinforces Claude's training (defence in depth).
- **Test count:** extension 4974 → 4983 (+9 AIDiagnoseHandler).
  Webview 8 ActionCard tests. 0 regressions.
