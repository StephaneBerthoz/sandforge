# 0002: Message contract zero-drift

**Status:** Accepted
**Date:** 2026-08-03

## Context

The webview ↔ extension bridge is the widest boundary in the product, and
it drifted more than once: ad-hoc inline message types in the webview
(missing `BaseMessage`'s `id`/`timestamp`) compiled in isolation and broke
at runtime; a listener read `payload.available` while the canonical payload
field was `enabled`: typecheck-clean, runtime-broken (both in the 1.2.6
changelog). A single hand-maintained message file scaled poorly and made
drift invisible.

## Decision

One contract, two mechanically-linked faces, both in `@sandforge/shared`:

- **Types split by domain**: every message is an
  `export interface … extends BaseMessage { type: 'domain:verb' }` in
  `packages/shared/src/types/messages/<domain>.messages.ts`, wired into the
  directional unions (`WebViewToExtensionMessage`,
  `ExtensionToWebViewMessage`) in `types/messages/index.ts`.
- **Zod schemas by domain**: every literal also appears as a
  `msg('domain:verb')` member of a domain union in
  `packages/shared/src/bridge/messageSchemas.ts`.
- **Bidirectional anti-drift test**:
  `packages/shared/src/types/messages/coverage.test.ts` structurally walks
  both sides: every interface belongs to a directional union, every Zod
  `msg()` literal maps to a TS interface and vice versa, and literals are
  unique across domains. The escape hatch `KNOWN_CONTRACT_GAPS` is an
  empty-by-law allowlist: an entry needs grep-verified producer AND
  consumer evidence plus a justification comment.

**Rule for any new message:** add the interface (domain file + union
membership) and the Zod literal in the same change. The coverage test is
the fence: an orphan on either side fails the suite.

## Consequences

- Renaming or re-typing a message breaks both sides at compile/test time;
  silent drift of the 1.2.6 kind is no longer reachable.
- New messages have exactly one obvious place to go, per domain.
- Producers/consumers may import the canonical interface instead of
  redeclaring inline types. Inline redeclaration is treated as a defect.
