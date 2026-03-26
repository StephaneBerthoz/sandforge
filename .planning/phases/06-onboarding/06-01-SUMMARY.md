# Plan 06-01 Summary

**Completed:** 2026-03-26
**Phase:** 06 -- Onboarding & First-Run Sandbox Guidance

## What was built
Implemented a complete onboarding UX flow for sandbox users: sandbox detection hook, contextual SandboxBanner (dismissible, localStorage-persisted), reusable GuidedFirstStepCard component, updated Welcome wizard Step 4 to suggest Seed+Sync instead of Forge for sandbox orgs, added "Populate Sandbox" quick action on HomePage, and added guided first-step cards on SyncPage and SeedPage empty states. Also added `seed` and `sync` as first-class ModuleRoute entries with router wiring.

## Key files
- `packages/webview/src/hooks/useSandboxDetection.ts`: Hook detecting sandbox orgs from useOrgStore
- `packages/webview/src/components/ui/SandboxBanner.tsx`: Contextual banner for sandbox orgs with Seed/Sync navigation
- `packages/webview/src/components/ui/GuidedFirstStepCard.tsx`: Reusable onboarding card with colored border variant
- `packages/webview/src/pages/Welcome/WelcomePage.tsx`: Step 4 now shows Seed+Sync for sandbox orgs
- `packages/webview/src/pages/Home/HomePage.tsx`: SandboxBanner + Populate Sandbox quick action
- `packages/webview/src/pages/Sync/SyncPage.tsx`: GuidedFirstStepCard above QuickSyncCard
- `packages/webview/src/pages/Seed/SeedPage.tsx`: GuidedFirstStepCard above TemplateGallery
- `packages/webview/src/stores/useAppStore.ts`: Added seed/sync to ModuleRoute
- `packages/webview/src/router.tsx`: Added seed/sync route mappings

## Decisions made
- Added `seed` and `sync` as first-class ModuleRoute entries (they were missing from the router despite having full page implementations)
- Added `openForge` i18n key that was referenced but missing from translation files
- SandboxBanner dismissal is persisted to localStorage key `sandforge-sandbox-banner-dismissed`
- GuidedFirstStepCard on SeedPage has a no-op onAction since the gallery is directly below

## Deviations from plan
- Had to add `seed` and `sync` to `ModuleRoute` type, `ALL_ROUTES` array, router, and TopBar route labels -- these were not mentioned in the plan but required for navigation to work
- Had to add localStorage mocks to `router.test.tsx`, `AppShell.test.tsx`, and `App.test.tsx` to support SandboxBanner's localStorage usage
- Updated `useAppStore.test.ts` to expect 14 routes instead of 12

## Notes for downstream
- The pre-existing test failure in `MonitorPage.test.tsx` (line 326, regex `/12/` match) is unrelated to this plan
- All 7623 tests pass across shared (874), extension (4310), and webview (2439)
