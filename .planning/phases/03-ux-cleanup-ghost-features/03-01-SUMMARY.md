# Plan 03-01 Summary

**Completed:** 2026-03-18
**Phase:** 3 -- UX Cleanup & Ghost Features

## What was built

Fixed 4 independent layout UX issues in the webview. Removed the Grappe hero button from the sidebar navigation while preserving its route for direct URL access. Wired the bell button in TopBar to toggle the NotificationCenter panel from AppShell, with a reactive unread badge using the existing selectUnreadCount selector. Replaced the hardcoded version string '3.0.0' in StatusFooter with a build-time injected __APP_VERSION__ from Vite define config. Added auto-select logic for the first connected org in the org:list:response listener in BridgeProvider.

## Key files

- `packages/webview/src/layouts/Sidebar/Sidebar.tsx`: Removed Grappe hero button and Network import
- `packages/webview/src/layouts/TopBar/TopBar.tsx`: Added onNotificationsToggle prop, unread badge with selectUnreadCount
- `packages/webview/src/layouts/AppShell.tsx`: Passes notification toggle callback to TopBar
- `packages/webview/src/layouts/StatusFooter/StatusFooter.tsx`: Uses __APP_VERSION__ instead of hardcoded '3.0.0'
- `packages/webview/vite.config.ts`: Defines __APP_VERSION__ from package.json version
- `packages/webview/src/vite-env.d.ts`: TypeScript declaration for __APP_VERSION__
- `packages/webview/vitest.config.ts`: Test-time __APP_VERSION__ define
- `packages/webview/src/bridge/BridgeProvider.tsx`: Auto-select first connected org in org:list:response

## Decisions made

- Used prop threading (onNotificationsToggle) from AppShell to TopBar instead of moving state to global store -- matches existing pattern where AppShell owns layout state
- Used `readFileSync` to read package.json in vite.config.ts since the config is ESM and `require` is not available
- Used `variant="error"` for the notification badge to make it visually prominent (red dot)
- Placed auto-select logic inside the org:list:response listener callback, not a standalone useEffect, to avoid race conditions (Pitfall 3)

## Deviations from plan

- Fixed a pre-existing test failure in router.test.tsx where MonitorPage's empty state guard was rendering EmptyState instead of the expected 'Select an org to monitor' text. Updated assertion to check for empty-state testid.
- Sidebar.test.tsx had no Grappe-specific assertions to remove (plan suggested there might be some).

## Notes for downstream

- The `monitor.emptyState.title`, `monitor.emptyState.description`, and `monitor.emptyState.cta` i18n keys are used in MonitorPage but do not exist in the locale files yet. Plan 03-02 (empty states) should add these keys.
- The __APP_VERSION__ test mock is set to '0.0.0-test' in vitest.config.ts -- any test asserting the exact version should use a regex pattern.
