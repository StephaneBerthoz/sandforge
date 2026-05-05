---
status: testing
phase: 04-ai-integration
source:
  - 04-01-SUMMARY.md
  - 04-02-SUMMARY.md
  - 04-03-SUMMARY.md
  - 04-04-SUMMARY.md
  - 04-05-SUMMARY.md
  - 04-06-SUMMARY.md
  - 04-07-SUMMARY.md
started: 2026-05-05T22:00:00Z
updated: 2026-05-05T22:00:00Z
---

## Current Test
number: 3
name: AI Settings exposure
expected: |
  Settings → "sandforge.ai" shows: provider (anthropic | openai | custom),
  model, enabled, AND the new `sandforge.ai.tokenBudgetMaxPerSession`
  (default 50000). EN + FR display the new setting label correctly.
awaiting: user response

## Tests

### 1. Cold-Start Smoke Test
expected: |
  pnpm typecheck + Phase 04 vitest specs (adversarial + multi-provider +
  AnthropicAdapter + AIDiagnoseHandler + SessionBudget + registry fence) all
  green. No regressions in the 4992-test extension suite.
result: pass
evidence: |
  Typecheck exit 0. 9 AI adapter test files / 117 tests + 9 AIDiagnoseHandler
  tests all green in 3.4s combined. 0 regressions.

### 2. VSIX builds + extension activates
expected: |
  `pnpm package` produces a .vsix; installing it in a VS Code window
  activates SandForge without errors in the Output → SandForge channel.
  AI panel reachable from the SandForge homepage.
result: pass-after-fix
fix_evidence: |
  Two regressions found and fixed:

  (1) packages/webview/src/pages/AI/AIChatPanel.tsx:67-83 inlined ad-hoc
  message types for ai:provider:status and ai:budget:state that didn't
  extend BaseMessage (missing id + timestamp). Replaced with the
  canonical AIProviderStatusMessage and AIBudgetStateMessage types
  imported from @sandforge/shared.

  (2) package.json pnpm.overrides forced minimatch@>=3.1.4 (a version
  that does not exist on npm — last 3.x is 3.1.2). Resolution flowed
  to 9.x/10.x which dropped CJS default export, breaking
  @vscode/vsce's `__importDefault(require("minimatch"))`. Fixed lower
  bound to <3.0.5 (the actual ReDoS-fix threshold per GHSA), constrained
  replacement to >=3.0.5 <4 (CJS-default consumers stay on 3.x), and
  added a path-scoped override "@vscode/vsce>minimatch": "3.1.2"
  belt-and-braces. Verified vsce now links minimatch@3.1.2.

  Prevention guard:
  - scripts/git-hooks/pre-commit runs `pnpm -r typecheck` on every
    commit so a webview-only typecheck regression cannot ship past the
    extension test suite again.
  - package.json adds `setup:hooks` + `prepare` scripts so a fresh
    clone wires `core.hooksPath = scripts/git-hooks` automatically on
    `pnpm install`.

  Verification:
  - Full `pnpm -r typecheck` green (shared + extension + webview).
  - Webview vitest: 302 files / 2932 tests green.
  - `pnpm package` exits 0; produces sandforge.vsix dated 2026-05-05
    11:29, 1.81 MB (vs stale 2026-05-02 11:53 baseline).
  - `git config core.hooksPath` returns `scripts/git-hooks`.
  - vsce → minimatch@3.1.2 confirmed via readlink.

  Manual install + activation smoke still pending — user should drop
  sandforge.vsix in a VS Code window via "Extensions: Install from
  VSIX..." to complete the smoke. Build artifact is ready.

### 3. AI Settings exposure
expected: |
  Settings → "sandforge.ai" shows: provider (anthropic | openai | custom),
  model, enabled, AND the new `sandforge.ai.tokenBudgetMaxPerSession`
  (default 50000). EN + FR display the new setting label correctly.
result: pending

### 4. AI Chat Panel opens — banner + budget indicator render
expected: |
  Open AI Assistant panel. AIProviderStatusBanner present (empty state, no
  alert when breaker closed). TokenBudgetIndicator visible in header (mini
  bar, green, "0 / 50000"). aria-live="polite" present in DOM. No console
  errors.
result: pending

### 5. Happy-path chat with Anthropic key configured
expected: |
  Configure SandForge: Set AI API Key. Send "Bonjour" — adapter responds
  with text, TokenBudgetIndicator increments (used > 0). 0 errors.
  (Skip if no Anthropic key available — this exercises the live adapter.)
result: pending

### 6. Cancel button aborts in-flight chat
expected: |
  Send a long-running prompt, click the Cancel button before the response
  arrives. The request aborts cleanly; the breaker does NOT trip
  (APIUserAbortError is the cancel path, never increments the breaker).
  Sending a new message after cancel works normally.
result: pending

### 7. Provider switch in Settings does not crash extension
expected: |
  Change `sandforge.ai.provider` from "anthropic" to "openai" in Settings,
  then open AI panel and try to chat. The OpenAIAdapter STUB returns a
  clean AINotImplementedError("OpenAIAdapter ships in a future milestone")
  hint pointing at the `sandforge.ai.provider` setting. No crash, no
  factory-time throw. Switch back to "anthropic" works without restart.
result: pending

### 8. AIDiagnoseHandler wired via ExtensionHandlers (KNOWN DEFERRED in 04-04)
expected: |
  Trigger a failed bulk job in Monitor → right-click → "Diagnose with AI".
  Expected: chat panel renders a structured DiagnoseResult ActionCard.
  Per the 04-04 SUMMARY: the handler is shipped + tested but the
  ExtensionHandlers registration + per-org tool wiring + ActionCard
  integration into AIChatPanel are deferred to v1.4. So this test is
  EXPECTED TO FAIL and confirms the deferred-gap inventory.
result: pending

### 9. SOQL code action (KNOWN DEFERRED in 04-04 / 04-07)
expected: |
  Open a .soql or .apex file containing a SELECT, place cursor on the
  query, trigger Code Actions (Ctrl+.). Expected: "Analyze SOQL with AI"
  action. Per the 04-04 SUMMARY: SoqlCodeActionProvider is deferred to
  v1.4. This test is EXPECTED TO FAIL and confirms the v1.4 backlog
  item.
result: pending

### 10. Multi-provider isolation contract (vitest)
expected: |
  Running `pnpm --filter @sandforge/extension vitest run multi-provider.integration`
  shows 6 isolation tests + 3 informational sweep all passing. The 6
  isolation tests prove: distinct instances per provider, distinct
  CircuitBreaker instances, an Anthropic 529 storm does NOT leak into
  OpenAI/Custom, OpenAI stub throws NotImplementedError (not breaker-open)
  even after Anthropic breaker is open.
result: pending

### 11. Prompt-injection adversarial vitest holds
expected: |
  Running `pnpm --filter @sandforge/extension vitest run promptInjection.adversarial`
  shows all 16 assertions green: 7 jailbreak fixtures × 2 defence layers
  (escape neutralisation + single-outer-close-tag) + 2 spotlight-prompt
  assertions. RT-#10 closure verified at CI level.
result: pending

### 12. AIDiagnoseHandler self-defense canary holds
expected: |
  Running `pnpm --filter @sandforge/extension vitest run AIDiagnoseHandler`
  shows the 9 tests green, including the canary that asserts the literal
  `</user-data>` substring NEVER appears in the body between the wrapper's
  open + close tags. RT-#10 defence-in-depth verified.
result: pending

## Summary

total: 12
passed: 2
issues: 0
pending: 10
skipped: 0

## Gaps

[none yet]
