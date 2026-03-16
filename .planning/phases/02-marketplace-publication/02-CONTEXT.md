# Phase 2: Marketplace Publication - Context

**Gathered:** 2026-03-16
**Status:** Ready for planning

<domain>
## Phase Boundary

Publish SandForge on the VS Code Marketplace as v1.0.0 with visual assets, user documentation, cross-platform CI, and automated release pipeline. This is the first public release.

</domain>

<decisions>
## Implementation Decisions

### Version Strategy
- Bump from internal v3.2.0 to public v1.0.0 — first Marketplace publication, SemVer public starts here
- All 3 package.json files (root, shared, extension) + webview synchronized
- `preview: true` kept for initial publication — switch to stable after user feedback

### Visual Assets (MKT-01)
- Automated Playwright screenshots via dedicated `e2e/screenshots.spec.ts`
- Resolution: 1280x800 PNG, dark theme (matches galleryBanner dark theme)
- Minimum 5 screenshots: Home, Seed wizard, Sync mapping, Monitor dashboard, Autopilot graph
- Banner generated from same process (Home page with branding)
- Reproductible: screenshots regenerable at each release

### User Documentation (MKT-02, MKT-03)
- Location: `docs/` in repo, GitHub-rendered Markdown
- Structure:
  - `docs/getting-started.md` — install, connect org, first seed operation
  - `docs/modules/seed.md`, `sync.md`, `monitor.md`, `compare.md`, `dataops.md`, `automation.md` — 1 page per module
  - `docs/faq.md` — FAQ + troubleshooting combined
- Depth: practical how-to guides, not exhaustive API reference
- Language: English only (i18n docs deferred to future)
- Links from README.md (replace "Screenshots coming soon" placeholder)

### Release Pipeline (MKT-05, MKT-06)
- `scripts/bump-version.sh` — synchronizes version across all 3 package.json + root + changelog
- `.github/workflows/release.yml` — workflow_dispatch with `version` input (patch/minor/major)
  - Pipeline: bump → validate → build → package → publish via `vsce publish`
  - Auto-creates git tag `v1.0.0`
  - Reads `secrets.VSCE_PAT` for Marketplace auth
- No conventional-commit auto-release — manual dispatch avoids accidental publishes

### CI Cross-Platform (MKT-04)
- Extend existing `.github/workflows/ci.yml` from Windows-only to 3-OS matrix
- Runners: ubuntu-latest, macos-latest, windows-latest
- E2E tests run on Windows only (Playwright + Vite dev server), validate on all 3

### Pre-Publish Checks (MKT-07)
- Script validates: contributes.commands documented, when-clauses valid, clean install test
- Activation time target: < 2s (MKT-08)

### Marketplace Metadata (MKT-09)
- Publisher: `StephaneBerthoz`
- Categories: change from `["Other", "Data Science", "Testing", "Snippets"]` to `["Other", "Data Science", "Formatters"]`
- Keywords already comprehensive (15 terms)
- `preview: true` for initial release

### Claude's Discretion
- Exact screenshot composition (which page state to capture)
- Documentation depth per module (adapt to module complexity)
- Pre-publish check script implementation details
- CI matrix optimization (which steps run on which OS)

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `resources/icon.png` + `resources/icon.svg` — extension icon ready
- `resources/icons/toolkit.svg` — activity bar icon ready
- `packages/extension/package.json` — galleryBanner, publisher, keywords configured
- `pnpm package` script — already builds VSIX (1.07 MB)
- `changelog.md` — Keep a Changelog format, SemVer
- `README.md` — comprehensive feature list, needs screenshots + doc links
- `.github/workflows/ci.yml` — Windows CI from Phase 1, base for cross-platform extension

### Established Patterns
- E2E tests use `page.goto('/')` + `page.waitForSelector('[data-testid="..."]')` — screenshot spec follows same pattern
- `packages/extension/package.nls.en.json` — NLS localization pattern for extension manifest
- Vite dev server on port 5173 for E2E — screenshots use same infrastructure

### Integration Points
- `packages/extension/package.json` — version field, categories, preview flag
- `packages/shared/package.json` — version must stay in sync
- Root `package.json` — version must stay in sync
- `.github/workflows/` — ci.yml (extend) + release.yml (create)
- `README.md` — add screenshot images + doc links

</code_context>

<specifics>
## Specific Ideas

- Version 1.0.0 as first public release (not 3.3.0) — clean SemVer start for users
- Screenshots automated via Playwright for reproducibility across releases
- Preview mode first, stable after feedback
- Documentation practical and concise — users want to DO things, not read references

</specifics>

<deferred>
## Deferred Ideas

- i18n documentation (French, German, etc.) — future phase
- Static documentation site (VitePress/Docusaurus) — if user base grows
- Conventional-commit auto-release — if team grows

</deferred>

---
*Phase: 02-marketplace-publication*
*Context gathered: 2026-03-16*
