## What & why

<!-- One short paragraph. Link the issue if any: Closes #123 -->

## Checklist

- [ ] `pnpm validate` is green locally (build:shared + typecheck + lint + test + audit:disposables + check:i18n + build)
- [ ] New logic has colocated `*.test.ts` (vitest, one test file per source file)
- [ ] User-facing strings go through i18next in **all 6 locales** (`en`, `fr`, `de`, `es`, `ja`, `pt-BR`); extension-side strings use `package.nls.*.json`
- [ ] New bridge messages have **both** the Zod schema (`packages/shared/src/bridge/messageSchemas.ts`) **and** the TS interface (`packages/shared/src/types/messages/<domain>.messages.ts`) — zero-drift rule, ADR 0002
- [ ] New listeners / timers have a disposal sink (`pnpm audit:disposables` passes)
- [ ] Commits follow Conventional Commits (`<type>(<scope>): <subject>`)
- [ ] User-visible change? Both changelogs updated (`changelog.md` + `packages/extension/CHANGELOG.md`)

## Security-sensitive areas

<!-- Delete if N/A. Per CONTRIBUTING.md, flag explicitly if this PR touches:
credentials, SOQL construction, CSP nonces, or the webview ↔ extension bridge. -->
