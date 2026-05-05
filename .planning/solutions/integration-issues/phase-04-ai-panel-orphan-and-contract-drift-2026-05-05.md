---
title: Phase 04 AI panel orphan + 5 chained regressions exposed at install-time
date: 2026-05-05
category: integration-issues
module: AI Integration / cross-cutting
problem_type: integration_issue
severity: high
tags: [night-autopilot, contract-drift, orphan-route, i18n, pre-commit-guard, typecheck, vsce, minimatch]
---

# Phase 04 AI panel orphan + 5 chained regressions exposed at install-time

## Problem

Phase 04 (AI Integration) closed in night autopilot with 7/7 plan summaries, +149
extension tests passing, zero regressions claimed. When the user installed the
fresh VSIX and tried to use it, six independent regressions surfaced in
sequence — most of them already present BEFORE Phase 04 but masked by the
fact that night autopilot never ran `pnpm package` (which is the only path
that exercises the webview tsc, the i18n bundle, and the actual VSIX
production). The AI panel was unreachable, the Monitor empty state showed
raw i18n keys, and `vsce` itself crashed at packaging time.

## Symptoms

- VSIX `pnpm package` failed at the webview build with two `TS2344` errors:
  `AIChatPanel.tsx` line 67 + line 80 — ad-hoc inline message types for
  `ai:provider:status` / `ai:budget:state` did not extend `BaseMessage`
  (missing `id` + `timestamp`).
- `vsce` crashed during packaging with
  `(0 , minimatch_1.default) is not a function`.
- After installing the fresh build, the AI panel was nowhere in the UI — not
  in the sidebar, not in the activity bar, not in the command palette.
  `navigate('ai')` would not even typecheck.
- The user clicked Monitor and the empty state rendered raw i18n keys
  (`monitor.emptyState.title`, `monitor.emptyState.description`,
  `monitor.emptyState.cta`) instead of the localised text.
- The Monitor empty state branch fired because each panel has its own
  bridge — and even when the keys were eventually fixed, the AI flag
  `aiAvailable` stayed `false` because of a contract-drift mismatch on
  the `ai:status:response` payload.
- All of this passed every existing CI check. Extension vitest 4992 tests
  green, shared 967 tests green, webview vitest 2932 tests green — none
  of them exercised the production package path.

## What Didn't Work

- **Trusting the night autopilot summary.** SUMMARY.md for Plan 04-04 said
  "9 AIDiagnoseHandler tests + 8 ActionCard tests + zero regressions". All
  true. None of them caught that ActionCard was never integrated into
  `AIChatPanel`'s message list, that `AIPage` was never registered in the
  main `router.tsx`, that `'ai'` was missing from `ModuleRoute`, that no
  sidebar / topbar / command palette ever listed AI, and that the
  `sandforge.openAI` command wasn't registered.
- **Trusting `pnpm validate` ran.** The script `pnpm validate` IS defined
  and DOES include `pnpm typecheck` recursively — but night autopilot
  skipped it at the close of the phase. Phase 04 SUMMARY shipped without
  ever running it.
- **Re-running `pnpm package` to refresh the VSIX.** First retry crashed
  at the webview tsc errors. Second retry crashed at vsce / minimatch
  CJS interop.
- **The earlier `pnpm.overrides` security patch.** A prior side-quest had
  set `"minimatch@<3.1.4": ">=3.1.4"` to close a ReDoS GHSA. But minimatch
  3.1.4 does NOT exist on npm — last 3.x is 3.1.2 — so the override forced
  vsce's `^3.0.3` minimatch to resolve to 9.x or 10.x, which dropped the
  CJS default export that vsce's `__importDefault(require('minimatch'))`
  needs. Tightening the override to `<3.0.5` (the actual ReDoS-fix
  threshold per GHSA) and constraining replacement to `>=3.0.5 <4`,
  plus a path-scoped `"@vscode/vsce>minimatch": "3.1.2"` belt-and-braces,
  closed it.
- **Re-deploying the extension via `code --install-extension`.** Per the
  user's project memory, that command silently re-installs a stale
  version when VSCode is already open. Direct asset copy to
  `~/.vscode/extensions/stephaneberthoz.sandforge-1.2.5/` plus a
  Reload Window is the reliable path.

## Solution

Six independent fixes, applied in order, plus two systemic guardrails:

### 1. AIChatPanel.tsx — canonical message types

```tsx
// packages/webview/src/pages/AI/AIChatPanel.tsx
import type {
  AIProviderStatusMessage,
  AIBudgetStateMessage,
} from '@sandforge/shared';

useMessageListener<AIProviderStatusMessage>('ai:provider:status', (msg) => {
  setProviderStatus(msg.payload);
});

useMessageListener<AIBudgetStateMessage>('ai:budget:state', (msg) =>
  setBudgetState(msg.payload),
);
```

Replaces inline ad-hoc types that were missing `id` + `timestamp`. The
types live in `packages/shared/src/types/messages.types.ts` and are
re-exported via the shared barrel.

### 2. pnpm.overrides — minimatch CJS-default preserved

```json
"pnpm": {
  "overrides": {
    "minimatch@<3.0.5": ">=3.0.5 <4",
    "minimatch@>=9.0.0 <9.0.7": ">=9.0.7",
    "minimatch@>=10.0.0 <10.2.3": ">=10.2.3",
    "@vscode/vsce>minimatch": "3.1.2"
  }
}
```

The lower bound is `<3.0.5` (the actual ReDoS GHSA threshold), the
replacement is constrained to `<4` so CJS-default consumers like
`@vscode/vsce` keep working, and vsce specifically is pinned at 3.1.2
belt-and-braces. The previous `<3.1.4: >=3.1.4` was a non-existent
version that flipped vsce to 9.x/10.x silently.

### 3. AI panel routing — 11 files patched

| File | Change |
|---|---|
| `packages/webview/src/stores/useAppStore.ts` | `ModuleRoute` + `ALL_ROUTES` ← `'ai'` |
| `packages/webview/src/router.tsx` | `routeComponents.ai = AIPage` |
| `packages/webview/src/layouts/TopBar/TopBar.tsx` | `ROUTE_LABELS.ai = 'nav.ai'` |
| `packages/webview/src/layouts/Sidebar/Sidebar.tsx` | `moduleNav` + `iconMap` ← `Bot` |
| `packages/webview/src/SidePanel.tsx` | `MODULE_ITEMS` ← `Bot` fuchsia accent |
| `packages/webview/src/components/CommandPalette/CommandPalette.tsx` | `ROUTE_ICONS.ai = 'hubot'`, `ROUTE_LABEL_KEYS.ai = 'nav.ai'` |
| `packages/extension/src/extension.ts` | `moduleCommands` ← `sandforge.openAI` |
| `packages/extension/src/providers/SidebarViewProvider.ts` | `commandMap.ai = 'sandforge.openAI'` |
| `packages/extension/package.json` | `commands` ← `sandforge.openAI` with `$(hubot)` icon |
| `packages/extension/package.nls.json` | `command.openAI: "SandForge: Open AI Assistant"` |
| `packages/extension/package.nls.fr.json` | `command.openAI: "SandForge : Ouvrir l'Assistant IA"` |

There were TWO sidebars in the codebase, both needing the AI entry: the
narrow VSCode side panel (`SidePanel.tsx`) shown in the activity bar,
and the in-panel layout sidebar (`Sidebar.tsx`) shown inside a SandForge
module tab. Phase 04 missed both.

### 4. BridgeProvider.tsx — `enabled` vs `available` contract drift

```tsx
// packages/webview/src/bridge/BridgeProvider.tsx
import type { AIStatusResponse } from '@sandforge/shared';

useMessageListener<AIStatusResponse>('ai:status:response', (msg) => {
  useAppStore.getState().setAiAvailable(msg.payload.enabled);
});
```

The extension's `handleStatus` in `AIChatHandler.ts` builds the response
payload as `{ enabled, provider, model, usage }` (matching the canonical
`AIStatusResponse` interface in shared), but the webview was reading
`msg.payload.available` — silently `undefined`, which made
`setAiAvailable(undefined)` falsy, so `aiAvailable` stayed `false` even
when the API key was configured. The fix aligns the webview with the
canonical type.

### 5. i18n locale dedup — JSON.parse silent override

`packages/webview/src/i18n/locales/en.json` and `fr.json` both had three
duplicate top-level keys:

```
DUP en.json: monitor   first: line 110   second: line 1929
DUP en.json: dataops   first: line 811   second: line 1967
DUP en.json: execution first: line 2117  second: line 2139
DUP fr.json: monitor   first: line 110   second: line 1870
DUP fr.json: dataops   first: line 752   second: line 1908
DUP fr.json: execution first: line 2058  second: line 2080
```

`JSON.parse` silently keeps only the second value. The first `monitor`
block had ~130 keys (`title`, `limits`, `emptyState`, etc.); the second
had only `liveOps`. After parse, only `liveOps` survived for that module —
which is why `monitor.emptyState.title` returned the raw key as fallback.

Fix: a Node script that scans top-level keys, deep-merges first-occurrence
into second-occurrence (preserving both), then writes back stable JSON
formatting. Verified post-merge: `monitor.emptyState.title === "Start
Monitoring Your Org"` AND `monitor.liveOps.title === "Live Operations"`
both resolve.

### 6. Pre-commit hook — typecheck + i18n dup-key scan

```bash
# scripts/git-hooks/pre-commit
set -e

echo "→ pre-commit: pnpm -r typecheck"
pnpm -r typecheck

echo "→ pre-commit: locale dup-key scan"
node -e "
const fs=require('fs'),path=require('path');
const dir='packages/webview/src/i18n/locales';
const files=fs.readdirSync(dir).filter(f=>f.endsWith('.json'));
let bad=0;
for(const f of files){
  const text=fs.readFileSync(path.join(dir,f),'utf8');
  const seen={};
  for(const line of text.split('\n')){
    const m=line.match(/^  \"([^\"]+)\":/);
    if(m){if(seen[m[1]]){console.error('DUP top-level key in',f,'->',m[1]);bad++;}else seen[m[1]]=true;}
  }
}
process.exit(bad?1:0);
"

echo "✓ pre-commit: typecheck + i18n dup scan green"
```

Wired into the repo via:

```json
// package.json
{
  "scripts": {
    "setup:hooks": "git config core.hooksPath scripts/git-hooks",
    "prepare": "pnpm setup:hooks"
  }
}
```

The `prepare` lifecycle runs on every `pnpm install`, so a fresh clone
auto-wires `core.hooksPath = scripts/git-hooks` without manual setup.

## Why This Works

The root cause was not five separate bugs — it was a single systemic gap:
**night autopilot shipped phase summaries without ever running the
production package path**. The vitest suites ran. The shared / extension
typecheck ran. But the webview tsc never ran, the VSIX never got built,
and the actual user-facing wiring (sidebar, topbar, command map, NLS,
nav route type, panel route map, command registration) was never
exercised end-to-end.

The five surface-level fixes close the existing damage. The pre-commit
hook closes the systemic gap by forcing `pnpm -r typecheck` (catches
webview tsc) AND a locale dup-key scan (catches the JSON.parse silent
override) on EVERY commit. The hook lives in `scripts/git-hooks/`
(checked into the repo) and is auto-wired on `pnpm install` via the
`prepare` lifecycle, so future clones get the guard for free without
human intervention.

The contract-drift on `enabled` vs `available` is a different class of
bug: it's typecheck-clean (TypeScript saw `payload.available` as a
property of `BaseMessage & { payload: { available: boolean } }`, the
inline type the webview declared) but runtime-broken (the actual
payload had `enabled`, not `available`, so the property read returned
`undefined`). The fix is to import the canonical message type from
`@sandforge/shared` so the webview's listener and the extension's
sender share the same source of truth — once `AIStatusResponse` is
the type contract, an `enabled` rename in shared would break both
sides at compile time, not just one.

## Prevention

- **Pre-commit hook** scripts/git-hooks/pre-commit runs `pnpm -r typecheck`
  AND a locale dup-key scan on every commit. Wired via
  `core.hooksPath = scripts/git-hooks` and auto-installed on `pnpm install`
  via the `prepare` script in root `package.json`.
- **Always import canonical message types from `@sandforge/shared`** in
  webview message listeners. Inline ad-hoc types like
  `BaseMessage & { payload: { ... } }` are a code smell — they decouple
  the listener from the sender and let contract drift land silently.
  `useMessageListener<AIStatusResponse>(...)` is the right shape.
- **At phase close-out, run `pnpm package` end-to-end** as the final gate.
  This exercises shared typecheck, extension typecheck, webview typecheck,
  webview Vite build, and vsce packaging — all the surfaces that
  individual `pnpm test:*` calls miss.
- **For UI features, the close-out checklist must include "verify the
  feature is reachable from a user-facing nav surface"**. Phase 04
  shipped a complete AI backend with no UI entry point. The plan-level
  `must_haves` need to include nav/route wiring as a first-class
  requirement, not an "autonomous: false" deferral.
- **Run `code --install-extension sandforge.vsix --force` is unreliable
  when VSCode is open** — it silently installs a stale version. The
  reliable deploy path during development is to copy the build assets
  directly into `~/.vscode/extensions/stephaneberthoz.sandforge-<version>/`
  and Reload Window. The user's project memory already documents this
  gotcha; future automation should respect it.

## Related

- `.planning/phases/04-ai-integration/04-UAT.md` — UAT log capturing the
  six findings as Test 2 deferred / pass-after-fix.
- `.planning/phases/04-ai-integration/04-04-SUMMARY.md` — original Plan
  04-04 summary that explicitly listed `ExtensionHandlers` registration
  + `SoqlCodeActionProvider` + ActionCard / chat-panel integration as
  v1.4 deferrals. The orphan nav state was the consequence of those
  deferrals not being scoped at the phase level.
- `.planning/audit-2026-05-02-cross-cutting.md` — the cross-cutting
  audit that originally introduced the `pnpm.overrides` block. The
  minimatch range typo (`<3.1.4`) was a regression in that audit's
  Round 1 commits.
- `packages/shared/src/types/messages.types.ts:1022` — canonical
  `AIStatusResponse` interface with `payload.enabled`.
- `packages/extension/src/bridge/handlers/ai/AIChatHandler.ts:347` —
  `handleStatus` impl that builds the response with `enabled`.
