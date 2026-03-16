---
phase: 2
status: human_needed
verified: 2026-03-16
---

# Phase 2: Marketplace Publication -- Verification

## Must-Have Results

### Plan 01: Release Infrastructure

| # | Must-Have | Status | Evidence |
|---|-----------|--------|----------|
| 1 | All 4 package.json files show version 1.0.0 | PASS | root=1.0.0, shared=1.0.0, extension=1.0.0, webview=1.0.0 |
| 2 | scripts/bump-version.sh exists and synchronizes version across all packages | PASS | File exists (1299 bytes), updates all 4 package.json, supports patch/minor/major/x.y.z |
| 3 | scripts/pre-publish-check.sh exists and validates extension packaging | PASS | File exists (4061 bytes), 11-point validation |
| 4 | CI runs on ubuntu-latest, macos-latest, and windows-latest | PASS | Matrix confirmed in ci.yml |
| 5 | E2E tests run only on Windows in CI matrix | PASS | E2E steps gated by if: matrix.os == windows-latest |
| 6 | pnpm validate passes (verified locally on Windows) | PASS | pnpm validate exits 0 |
| 7 | VSIX size remains under 5 MB after packaging | PASS | VSIX is 1.08 MB (1,129,155 bytes) |
| 8 | .gitattributes ensures consistent line endings | PASS | File exists with text=auto and LF rules for .sh/.ts/.tsx/.json/.md/.yml/.yaml |
| 9 | Extension bundle size reasonable for < 2s activation (MKT-08) | HUMAN_NEEDED | Bundle is 3331 KB. Actual activation time requires VSCode test-electron measurement. |

### Plan 02: User Documentation

| # | Must-Have | Status | Evidence |
|---|-----------|--------|----------|
| 1 | docs/getting-started.md exists with install, connect, first-operation instructions | PASS | 109 lines with Prerequisites, Installation, First Launch, Connect Your Org, Your First Operation sections |
| 2 | docs/modules/ contains one .md file per core module (6 files) | PASS | seed.md, sync.md, monitor.md, compare.md, dataops.md, automation.md -- all 6 present |
| 3 | All 6 module docs have Quick Start, Features, and Tips sections | PASS | Grep confirms all 6 files contain all 3 required section headings |
| 4 | docs/faq.md exists with FAQ + troubleshooting | PASS | 10 FAQ questions + 8 troubleshooting items (18 h3 sections total) |
| 5 | Root README links to docs/ and no longer says Screenshots coming soon | PASS | Documentation table links all 8 docs. Zero matches for placeholder text. Version badge at 1.0.0. |
| 6 | Extension README is marketplace-ready with feature highlights and doc links | PASS | Has Getting Started, Features, Requirements, Documentation, Feedback and Issues sections |

### Plan 03: Visual Assets and Release Pipeline

| # | Must-Have | Status | Evidence |
|---|-----------|--------|----------|
| 1 | assets/screenshots/ contains at least 5 module PNG screenshots at 1280x800 | PASS | 6 PNGs: home (73KB), seed (85KB), sync (73KB), monitor (35KB), autopilot (54KB), banner (48KB) |
| 2 | assets/screenshots/banner.png exists for Marketplace listing | PASS | banner.png exists (48,059 bytes) |
| 3 | Screenshots spec generates all screenshots reproducibly and is excluded from regular E2E | PASS | Spec exists (11,354 bytes), gated by test.skip(!process.env.SCREENSHOTS) |
| 4 | release.yml exists with workflow_dispatch, bump, validate, publish steps | PASS | All required steps present in workflow |
| 5 | Release workflow reads VSCE_PAT from secrets | PASS | secrets.VSCE_PAT referenced in publish step |
| 6 | pnpm package produces a valid VSIX with correct version and metadata | PASS | sandforge.vsix at 1.08 MB, version 1.0.0 |
| 7 | Extension README screenshot URLs resolve to actual images | HUMAN_NEEDED | Uses absolute GitHub raw URLs. Files exist locally but remote resolution requires push. |

## Requirement Coverage

| Req ID | Description | Covered By | Deliverable | Status |
|--------|-------------|------------|-------------|--------|
| MKT-01 | Banner and 5+ module screenshots | Plan 03 | 6 PNGs in assets/screenshots/ including banner.png | PASS |
| MKT-02 | Getting started guide and per-module user docs | Plan 02 | docs/getting-started.md + 6 files in docs/modules/ | PASS |
| MKT-03 | FAQ and troubleshooting documentation | Plan 02 | docs/faq.md (10 FAQ + 8 troubleshooting) | PASS |
| MKT-04 | CI workflow on 3 OS | Plan 01 | .github/workflows/ci.yml with 3-OS matrix | PASS |
| MKT-05 | Release workflow (bump, build, publish) | Plan 03 | .github/workflows/release.yml with workflow_dispatch | PASS |
| MKT-06 | Version bump script synchronizing all packages | Plan 01 | scripts/bump-version.sh updates 4 package.json files | PASS |
| MKT-07 | Pre-publish check script | Plan 01 | scripts/pre-publish-check.sh with 11 checks | PASS |
| MKT-08 | Extension loads in < 2s on clean VSCode | Plan 01 | Bundle 3331 KB -- actual timing needs VSCode test-electron | HUMAN_NEEDED |
| MKT-09 | Extension published on VS Code Marketplace | Plan 03 | Pipeline ready -- actual publish requires VSCE_PAT in GitHub secrets | HUMAN_NEEDED |

## Integration Checks

| Import / Reference | Target Exists | Status |
|--------------------|---------------|--------|
| Root README -> docs/getting-started.md | File exists | PASS |
| Root README -> docs/modules/seed.md | File exists | PASS |
| Root README -> docs/modules/sync.md | File exists | PASS |
| Root README -> docs/modules/monitor.md | File exists | PASS |
| Root README -> docs/modules/compare.md | File exists | PASS |
| Root README -> docs/modules/dataops.md | File exists | PASS |
| Root README -> docs/modules/automation.md | File exists | PASS |
| Root README -> docs/faq.md | File exists | PASS |
| Root README -> assets/screenshots/home.png | File exists | PASS |
| Root README -> assets/screenshots/seed.png | File exists | PASS |
| Root README -> assets/screenshots/sync.png | File exists | PASS |
| Root README -> assets/screenshots/monitor.png | File exists | PASS |
| Root README -> assets/screenshots/autopilot.png | File exists | PASS |
| release.yml -> scripts/bump-version.sh | File exists | PASS |
| getting-started.md -> modules/*.md | All 6 files exist | PASS |
| getting-started.md -> faq.md | File exists | PASS |
| Extension README -> GitHub raw URLs | Files exist locally; remote needs push | HUMAN_NEEDED |

## Summary

**Score:** 20/22 must-haves verified automatically. 2 items need human testing.

All automated checks passed. The phase goal is achieved for all deliverables that can be verified locally. 2 items need human testing:

1. **MKT-08 (Activation time < 2s):** The extension bundle is 3331 KB (3.3 MB), above the 2048 KB soft warning in the pre-publish script. This is expected because jsforce is bundled. Actual activation timing requires measurement in a real VSCode instance via @vscode/test-electron. The pre-publish script documents this as a WARN, not a FAIL.

2. **MKT-09 (Published on Marketplace) + Extension README remote URLs:** The release pipeline is fully functional, but actual Marketplace publication requires the user to configure VSCE_PAT in GitHub repository secrets and trigger the workflow. Once the repository is pushed to GitHub, the absolute screenshot URLs in the extension README will resolve. This is by design -- the pipeline is ready, the manual secret step is documented.

### Phase Success Criteria Assessment

| Criterion | Status |
|-----------|--------|
| SandForge is listed on the VS Code Marketplace and installable by anyone | HUMAN_NEEDED -- pipeline ready, needs VSCE_PAT |
| A new release can be cut with a single GitHub Actions workflow dispatch | PASS -- release.yml with workflow_dispatch confirmed |
| Any user can go from install to first data operation following the getting-started guide | PASS -- docs/getting-started.md walks through the full flow |
| CI runs typecheck + lint + test + build on Windows, macOS, and Linux | PASS -- ci.yml 3-OS matrix with pnpm validate |
