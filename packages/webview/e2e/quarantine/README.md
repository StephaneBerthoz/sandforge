# Quarantined E2E specs

These specs are excluded from the default Playwright run via `testIgnore` in
`playwright.config.ts`. They are kept, not deleted: each one documents a real
user journey worth covering, and the assertions inside are still the right
assertions. What broke is the surface they drive, not the intent.

**They were not failing loudly.** CI ran them, they timed out at 30 s each, and
the suite had been red long enough that the signal was ignored. Quarantining
them makes the default run mean something again: every spec left in `e2e/` can
fail for a real reason.

## Why each one is here

Measured on 2026-08-12, full suite: 45 passed / 129 failed before quarantine.
Every spec below scored **zero** passing tests.

| Spec                                  | Tests | Blocker                                                                                                                                                                                                                     |
| ------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai.spec.ts`                          | 18    | Waits for `ai-chat-panel`. The AI panel is gated behind `sandforge.ai.enabled`, which defaults to `false`; the fixture never enables it.                                                                                    |
| `seed.spec.ts`                        | 16    | Drives the pre-v1.9.0 Seed page through the sidebar removed in v1.8.0.                                                                                                                                                      |
| `automation.spec.ts`                  | 15    | 5 references to `getByTestId('sidebar')` — the nav tree removed in v1.8.0.                                                                                                                                                  |
| `compare.spec.ts`                     | 11    | Same removed sidebar (3 references).                                                                                                                                                                                        |
| `dataops.spec.ts`                     | 9     | Same removed sidebar (2 references).                                                                                                                                                                                        |
| `monitor.spec.ts`                     | 8     | Same removed sidebar (5 references).                                                                                                                                                                                        |
| `navigation.spec.ts`                  | 8     | Tests the removed navigation tree itself (9 references). This one may be obsolete rather than repairable — the surface it covered no longer exists.                                                                         |
| `quick-sync-conflict-resolve.spec.ts` | 2     | Drives `sync:conflict:detected` / `sync:conflict:resolve`, message types that appear in **no** file under `packages/shared/src` or `packages/extension/src`. Written against the E2E harness, never against a real channel. |
| `seed-ai-persona.spec.ts`             | 2     | Same: `forge:ai:generate` exists only in the harness.                                                                                                                                                                       |
| `ai-diagnose-apply-fix.spec.ts`       | 1     | Same: `ai:fix:apply` / `ai:fix:applied` exist only in the harness.                                                                                                                                                          |
| `cdc-subscription-event.spec.ts`      | 1     | Same: `cdc:subscribe` / `cdc:event` exist only in the harness. CDC is Phase 05, unshipped.                                                                                                                                  |

## Two distinct categories

**Repairable (rows 1–7).** These target pages that genuinely exist in
production. `ai.spec.ts` in particular needs only a fixture that enables the AI
setting. The rest need their navigation rewritten against the current surface
(`__SANDFORGE_MODULE__` + `panel-app`, the pattern in `axe-accessibility.spec.ts`).

**Harness-only (rows 8–11).** These post message types to themselves and then
assert their own re-render. They never touched production code and cannot
regress anything, so they prove nothing today. They become real when the
corresponding channels are implemented — at which point the assertions are a
head start, not a liability.

## Before restoring one

Move it back to `e2e/`, run it, and confirm it can **fail**: break the thing it
asserts and watch it go red. A spec that stays green against a broken app is
how this directory came to exist.
