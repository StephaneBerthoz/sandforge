# Phase 04: AI Integration — Context

**Gathered:** 2026-05-04
**Mode:** standard
**Status:** Ready for planning

<domain>
## Phase Boundary

Build a defensible AI niche around in-editor EXPLAIN / DIAGNOSE flows
backed by **read-only** tools, **Zod-validated** structured output, and
**user-approved** mutations. Explicitly NOT a code generator (Copado owns
that). Requirements: AI-01, AI-02, AI-03, AI-04.

Phase 04 ships:

- An `AIAdapter` layer with Anthropic SDK, `betaZodTool` structured
  output, circuit-breaker on 529 throttles, and AbortController wired.
- A failed-job → structured-context → diagnosis flow that reaches the
  user behind an approve gate.
- A SOQL code action that returns analysis + optimization suggestions
  without auto-applying.
- Token-budget enforcement per session and a prompt-injection defense
  via context delimiters, verified adversarially.

Out of scope: anything that mutates an org without an approve gate,
multi-provider parity (defer to a later phase), Copilot-style code
completion.

</domain>

<decisions>
## Implementation Decisions

### AIAdapter API + multi-provider
- **Factory + 1 adapter per provider.** `AnthropicAdapter`,
  `OpenAIAdapter`, `CustomAdapter` implement a shared `AIClient` interface.
  A factory in `services.ts` resolves the active adapter from
  `settings.ai.provider`. Each provider keeps its native SDK (Anthropic
  Messages + betaZodTool, OpenAI responses.create, custom HTTP).
- **Circuit-breaker is per-provider.** A 529 storm on Anthropic does NOT
  degrade OpenAI or Custom. Breaker state lives on each adapter instance.
- **AbortController is per AI request.** Each chat / diagnose / tool call
  creates its own AbortController. Cancelling a single message aborts only
  that request — same pattern as `SalesforceAdapter.withLimit`.

### User-approve gate UX
- **Inline action card with Approve / Reject in the chat panel.** When the
  AI proposes an action (e.g. "apply this Apex fix"), the assistant
  renders a structured "Action proposée" block inside the chat with
  Approve / Reject / Modify buttons. Diff or preview lives inside the
  block. Matches the existing SandForge wizard interaction pattern.
- **Approve gate only fires for org-mutating actions.** Read-only tools
  (DESCRIBE, QUERY, GET-ERRORS, GET-LIMITS) execute silently. Any DML,
  Apex deploy, metadata change, or other write goes through the gate.
- **No approve memory.** Each action re-asks. No "remember choice" or
  "approve all similar". Maximum safety, simplest UX. Approve-all is a
  separate explicit flow if a future phase wants it.

### Tool surface granularity
- **Fine-grained — one tool per Salesforce API.** Expected tools:
  `describe_object`, `query_records`, `get_recent_errors`, `get_limits`,
  `get_apex_log`, `get_metadata`, etc. Roughly 10-15 tools. Claude
  orchestrates the multi-step internally. Each tool call produces one
  audit-log line.
- **All tools are strictly read-only.** Mutations are NEVER tool calls;
  they always go through the inline action card UX. Defense in depth.
- **Tool errors return Zod-validated structured payload.** A tool that
  catches an error returns `{ error: { code, message, hint } }` matching
  the same Zod schema as success responses. Claude can retry or propose
  a workaround. Mirrors the existing `ErrorResolver` contract.

### Token budget + prompt-injection defense
- **Budget is per panel-session.** A counter accumulates while the AI
  Assistant panel is open and resets on close. Surfaces in the panel's
  status bar via the existing `TokenUsageStats` interface.
- **Soft cap at 80 %, hard refuse at 100 %.** A toast warning fires at
  80 % of the budget. At 100 % the next request is refused with an
  explicit modal that links straight to the Settings → AI → Token
  Budget pane.
- **Record-content wrapped in XML-style `<user-data>…</user-data>` tags.**
  Anthropic explicitly recommends XML tags; Claude is trained to respect
  them; logs stay readable; widely-tested industry pattern. Adversarial
  test in the plan asserts a malicious "ignore previous instructions"
  payload inside `<user-data>` is treated as data, not as instructions.

### Agent's Discretion

- The exact Anthropic SDK version pin and `@anthropic-ai/sdk` peer-deps
  resolution.
- The chat panel's React component layout for the action card (icon,
  spacing, button order) — design system already constrains it.
- Exact Zod schemas for each tool's request / response — derive from the
  Salesforce API surface during implementation.
- Backoff curve for the 529 circuit-breaker (recommended:
  `60 → 120 → 240 → 600 s` matching `FleetSummaryService`).

</decisions>

<specifics>
## Specific Ideas

- Reuse the existing `AIAssistant` orchestrator (already in
  `packages/extension/src/modules/ai/`) as the call site for AIAdapter.
- Reuse `ErrorResolver` to seed the diagnosis flow's structured error
  context.
- The audit `audit-2026-05-02-cross-cutting.md` already flagged
  prompt-injection defense as a Phase 04 concern (RT-#10) and AI response
  Zod-validation as RT-#11 — this phase closes both.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

- `.planning/audit-2026-05-02-cross-cutting.md` (Phase 04 backlog —
  RT-#10 prompt-injection, RT-#11 AI response Zod validation).
- `packages/extension/src/modules/ai/AIAssistant.ts` (current orchestrator
  shape — `AICallResult`, `TokenUsageStats`, `Conversation`).
- `packages/extension/src/modules/ai/ErrorResolver.ts` (existing
  error-resolution contract that Phase 04 builds on).
- `packages/extension/src/modules/ai/NL2SOQL.ts` (existing SOQL analysis
  surface — Phase 04 adds the code action wrap).
- `packages/extension/package.json` `contributes.configuration.properties`
  (`sandforge.ai.enabled`, `sandforge.ai.provider`, `sandforge.ai.model`
  already exposed; Phase 04 wires the runtime).
- Anthropic SDK Messages API + betaZodTool docs (latest stable on npm at
  plan-time).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `AIAssistant`: chat orchestrator with `Conversation`, `ChatMessage`,
  `AICallResult`, `TokenUsageStats` types. Phase 04 plugs the new
  AIAdapter under it.
- `ErrorResolver`: structured error analysis pipeline. Diagnosis flow
  feeds its output into Claude as the "context" payload.
- `NL2SOQL`: SOQL analyzer + favorite store. The new SOQL code action
  is a thin wrapper that surfaces `NL2SOQL.analyze()` through the
  `AIClient.tool('query_records')` route.
- `AIPersonaManager`, `SchemaAdvisor`, `SmartActionAnalyzer`,
  `AnomalyDetector`, `PipelineGenerator` — already-shipped AI surfaces
  the new adapter must keep working without behavioral changes.

### Established Patterns
- **Service factories in `services.ts`** — orchestrators are built via
  factories with optional `services?: CoreServices` injection. The new
  AIAdapter follows the same shape, exposed via
  `services.aiAdapter(deps)` rather than a global singleton.
- **`SecretVault` for credentials** — Anthropic API key lives in
  `vscode.SecretStorage` per the existing convention. AIAdapter reads
  it through `services.storage` / SecretVault, never from process.env.
- **Circuit-breaker pattern** — `CircuitBreaker` already exists at
  `packages/extension/src/core/connection/CircuitBreaker.ts`. AIAdapter
  composes one per-provider instance.
- **AbortController per request** — `SalesforceAdapter.withLimit` shows
  the canonical wiring for cancel propagation.
- **Zod-validated bridge envelopes** — every webview ↔ extension message
  is parsed via the shared message schema. AI requests / responses join
  this contract.

### Integration Points
- Webview chat panel: `packages/webview/src/pages/AI/` (existing surface
  to extend with the inline action card UI).
- Bridge handler: a new `AIToolsHandler` (or extend the existing
  `AIChatHandler` already at `packages/extension/src/bridge/handlers/ai/`)
  routes `ai:diagnose`, `ai:explain-soql`, `ai:approve-action` envelopes.
- Settings UI: `sandforge.ai.*` already exposes provider + model + enabled
  + (new in Phase 04) `tokenBudgetMaxPerSession`.

</code_context>

<deferred>
## Deferred Ideas

- **Approve memory** ("session-scoped" or "persistent per-org") — not
  shipping in Phase 04 per the per-action-only decision; revisit if user
  friction is real after dogfooding.
- **Hybrid coarse-grained tools** — mid-level tools like `analyse_org` or
  `diagnose_failure` weren't picked. They could come back as a Phase 04+
  optimization if the fine-grained surface produces too many round trips
  on common diagnose flows.
- **Quotidien (rolling 24 h) token budget** — not chosen for Phase 04,
  but the per-panel-session counter persists in globalState in a way that
  could later roll up to a daily budget without breaking the UI.
- **Anthropic-only first ramp** — implicitly deferred: factory ships
  with all 3 providers from day one (AnthropicAdapter functional,
  OpenAIAdapter + CustomAdapter as thin scaffolds with `NotImplementedError`
  if the adapter isn't ready). Plan can choose to ship only Anthropic
  if scope creeps.

</deferred>

---
*Phase: 04-ai-integration*
*Context gathered: 2026-05-04*
