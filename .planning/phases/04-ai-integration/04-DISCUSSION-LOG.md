# Phase 04: AI Integration — Discussion Log

**Date:** 2026-05-04
**Mode:** standard
**Workflow:** discuss-phase 04

---

## Selected Areas

User selected all 4 gray areas: AIAdapter API + multi-provider, User-approve
gate UX, Tool surface granularity, Token budget + injection defense.

---

## Area 1 — AIAdapter API + multi-provider

### Q1.1 Forme du AIAdapter
- **Options considered:**
  - **(Recommended, picked)** Factory + 1 adapter per provider —
    `AnthropicAdapter`, `OpenAIAdapter`, `CustomAdapter` implement
    `AIClient`. Resolved via factory.
  - Adapter unique avec switch interne — single dispatch class.
  - Anthropic-only Phase 04, multi-provider later.
- **User choice:** Factory + 1 adapter per provider.
- **Rationale:** Each provider keeps its native SDK; betaZodTool is
  Anthropic-specific; OpenAI uses responses.create; custom HTTP stays
  isolated.

### Q1.2 Circuit-breaker scope
- **Options considered:**
  - **(Recommended, picked)** Per-provider — independent breaker state.
  - Global — one breaker for all providers.
- **User choice:** Per-provider.
- **Rationale:** A 529 storm on Anthropic shouldn't degrade other
  providers. Coherent with the factory pattern.

### Q1.3 AbortController scope
- **Options considered:**
  - **(Recommended, picked)** Per AI request.
  - Per conversation.
  - Per session/panel.
- **User choice:** Per AI request.
- **Rationale:** Mirrors `SalesforceAdapter.withLimit`. Granular cancel
  without surprising the user.

---

## Area 2 — User-approve gate UX

### Q2.1 Approve gate UI
- **Options considered:**
  - **(Recommended, picked)** Inline action card with Approve / Reject /
    Modify in the chat panel.
  - VS Code modal natif (`showInformationMessage`).
  - Side-panel preview with Apply button.
- **User choice:** Inline action card.
- **Rationale:** Matches the existing SandForge wizard interaction
  pattern; diff/preview lives in the same view as the chat.

### Q2.2 Approve scope
- **Options considered:**
  - **(Recommended, picked)** Approve gate only for org-mutating actions;
    read-only tools execute silently.
  - Always — even for read-only.
  - Configurable per safety tier (production / sandbox / scratch).
- **User choice:** Org-mutating only.
- **Rationale:** Aligns with audit + compliance posture without flooding
  the user with confirms on harmless DESCRIBE / QUERY calls.

### Q2.3 Approve memory
- **Options considered:**
  - **(Recommended, picked)** Per-action only — each action re-asks.
  - Session-scoped "approve similar" checkbox.
  - Persistent per-org whitelist.
- **User choice:** Per-action only.
- **Rationale:** Maximum safety, simplest UX. A separate explicit
  "approve all" can ship later if friction proves real.

---

## Area 3 — Tool surface granularity

### Q3.1 Granularity
- **Options considered:**
  - **(Recommended, picked)** Fine-grained — 1 tool per Salesforce API
    (~10-15 tools).
  - Coarse-grained — 3-4 high-level tools (`analyze_org`,
    `diagnose_failure`, etc.).
  - Hybrid — 5-6 mid-level tools.
- **User choice:** Fine-grained.
- **Rationale:** Each tool call = one audit-log line. Claude orchestrates
  the multi-step internally. Easier to unit-test and reason about.

### Q3.2 Tool side-effects
- **Options considered:**
  - **(Recommended, picked)** Read-only strict — tools never mutate.
  - Read-only + write-with-confirm tools.
- **User choice:** Read-only strict.
- **Rationale:** Coherent with the ROADMAP's "read-only tools" promise.
  Mutations always go through the inline action card (defense in depth).

### Q3.3 Tool error budget
- **Options considered:**
  - **(Recommended, picked)** Tool error returns Zod-validated payload to
    Claude — `{ error: { code, message, hint } }`.
  - Tool throw → break the conversation.
- **User choice:** Zod-validated structured error.
- **Rationale:** Mirrors the existing `ErrorResolver` pattern. Claude can
  retry or propose a workaround.

---

## Area 4 — Token budget + injection defense

### Q4.1 Token budget scope
- **Options considered:**
  - **(Recommended, picked)** Per panel-session — counter resets on close.
  - Per conversation — resets on "New conversation".
  - Daily rolling 24 h.
- **User choice:** Per panel-session.
- **Rationale:** Coherent with the existing `TokenUsageStats` interface;
  visible in the panel status bar.

### Q4.2 Token cap behavior
- **Options considered:**
  - **(Recommended, picked)** Soft cap at 80 % (warn), hard refuse at
    100 % (modal with link to settings).
  - Hard refuse only.
  - Soft warn only, never refuse.
- **User choice:** Soft cap + hard refuse.
- **Rationale:** Best balance of user-friendliness and budget safety.

### Q4.3 Injection defense delimiters
- **Options considered:**
  - **(Recommended, picked)** XML-style `<user-data>…</user-data>` tags.
  - JSON envelope `{type: 'user-data', content: '…'}`.
  - ANSI escape sequences as exotic markers.
- **User choice:** XML tags.
- **Rationale:** Anthropic explicitly recommends XML tags; Claude is
  trained to respect them; logs stay readable; industry standard.

---

## Wrap

User answered "Ready" — proceed to write CONTEXT.md and commit.

## Deferred

- Approve memory variants → revisit after dogfood.
- Hybrid coarse-grained tools → optimization for later.
- Daily rolling token budget → can roll up later from per-session counter
  without breaking UI.
- Anthropic-only ramp → factory ships with all 3 from day one (others as
  scaffolds returning `NotImplementedError`).
