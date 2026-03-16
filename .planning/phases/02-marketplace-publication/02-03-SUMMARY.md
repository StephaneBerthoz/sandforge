# Plan 02-03 Summary

**Completed:** 2026-03-16
**Phase:** 2 -- Marketplace Publication

## What was built

Created an automated Playwright screenshot spec that generates 6 Marketplace-ready screenshots (home, seed, sync, monitor, autopilot, banner) with realistic mock data injected via MockBridge and Zustand store manipulation. Updated both READMEs to reference actual screenshot files (relative paths for GitHub, absolute raw URLs for Marketplace rendering). Created a GitHub Actions release workflow with one-click version bump, validation, VSIX packaging, Marketplace publish, and GitHub Release creation. Verified the complete publish pipeline: pre-publish checks pass, VSIX is 1.08 MB, all 162 E2E tests pass with screenshots spec correctly excluded.

## Key files

- `packages/webview/e2e/screenshots.spec.ts`: On-demand screenshot generator (6 tests, gated by SCREENSHOTS=1 env var)
- `assets/screenshots/*.png`: 6 generated screenshots (home, seed, sync, monitor, autopilot at 1280x800; banner at 1440x480)
- `.github/workflows/release.yml`: workflow_dispatch release pipeline with version input (patch/minor/major)
- `README.md`: Root README with relative screenshot paths
- `packages/extension/README.md`: Extension README with absolute GitHub raw URLs for Marketplace

## Decisions made

- Screenshots spec gating: Used `SCREENSHOTS=1` env var instead of `testIgnore` in playwright config, because `testIgnore` prevents the spec from running even when explicitly targeted via `npx playwright test screenshots.spec.ts`. The env var approach allows on-demand generation while keeping regular E2E runs clean.
- Replaced references to non-existent `compare.png` and `automation.png` in READMEs with actual generated screenshots (sync.png and autopilot.png) that better showcase the product's capabilities.
- Release workflow commits and tags before publish, pushes only after successful Marketplace upload, preventing partial release states.

## Deviations from plan

- The plan suggested `testIgnore` in playwright.config.ts for excluding screenshots, but this makes the spec unreachable even with explicit targeting. Switched to `SCREENSHOTS=1` env var gating instead.
- Root README referenced `compare.png` which was never generated (not in the plan's screenshot list). Updated to reference `sync.png` and `autopilot.png` which are actual generated files.
- Extension README referenced both `compare.png` and `automation.png` which don't exist. Updated to match the 5 actual screenshots.

## Notes for downstream

- To regenerate screenshots: `cd packages/webview && SCREENSHOTS=1 npx playwright test screenshots.spec.ts`
- The only remaining manual step for Marketplace publish: configure `VSCE_PAT` secret in GitHub repository settings
- VSIX is 1.08 MB (well under 5 MB limit)
- Extension bundle is 3331 KB (warning threshold for activation time, but acceptable for first release)
- This completes Phase 2 -- all 3 plans (02-01, 02-02, 02-03) are now done
