---
phase: 6
status: passed
verified: 2026-03-26
---

# Phase 6: Onboarding & First-Run -- Verification

## Must-Have Results

| Plan | Must-Have | Status |
|------|-----------|--------|
| 06-01 | SandboxBanner renders when orgType Sandbox, navigates to seed/sync | PASS - SandboxBanner.tsx uses useSandboxDetection, renders when hasSandbox, has onNavigate prop |
| 06-01 | WelcomePage Step 4 shows Seed + Sync buttons when orgType sandbox | PASS - Step 4 renders welcome-open-seed-btn and welcome-open-sync-btn |
| 06-01 | HomePage quick actions includes Populate Sandbox card navigating to seed | PASS - populate-sandbox-btn exists, onClick navigates to seed, uses i18n key onboarding.populateSandbox |
| 06-01 | SyncPage shows guided first-step card | PASS - SyncPage imports and renders GuidedFirstStepCard |

## Requirement Coverage

| Req ID | Deliverable | Status |
|--------|-------------|--------|
| ONBO-01 | useSandboxDetection.ts + SandboxBanner.tsx with sandbox detection | PASS |
| ONBO-02 | WelcomePage.tsx Step 4 with sandbox-specific Seed/Sync buttons | PASS |
| ONBO-03 | HomePage.tsx populate-sandbox-btn quick action | PASS |
| ONBO-04 | SyncPage.tsx and SeedPage.tsx import GuidedFirstStepCard | PASS |

## Integration Checks

| Import | Export exists | Status |
|--------|--------------|--------|
| HomePage imports SandboxBanner | SandboxBanner.tsx exports SandboxBanner | PASS |
| HomePage imports useSandboxDetection | useSandboxDetection.ts exports hook | PASS |
| SyncPage imports GuidedFirstStepCard | GuidedFirstStepCard.tsx exists | PASS |
| SeedPage imports GuidedFirstStepCard | GuidedFirstStepCard.tsx exists | PASS |

## Test File Coverage

| Source File | Test File | Status |
|-------------|-----------|--------|
| useSandboxDetection.ts | useSandboxDetection.test.ts | PASS |
| SandboxBanner.tsx | SandboxBanner.test.tsx | PASS |
| GuidedFirstStepCard.tsx | GuidedFirstStepCard.test.tsx | PASS |

## Summary

**Score:** 4/4 must-haves verified

All automated checks passed. Phase goal achieved. Sandbox detection is wired into the onboarding UX across all four touchpoints: contextual banner, welcome wizard step 4, home page quick action, and guided empty states on Sync/Seed pages.
