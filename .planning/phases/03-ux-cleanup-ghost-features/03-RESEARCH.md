# Phase 3: UX Cleanup & Ghost Features -- Research

**Researched:** 2026-03-18
**Phase goal:** Clean, coherent user experience with no dead features or broken buttons.

## Don't Hand-Roll

| Problem | Recommended solution | Why |
|---------|---------------------|-----|
| Version injection at build time | Vite `define` with `JSON.stringify(require('./package.json').version)` | The codebase already uses `define` in `vite.config.ts` (line 31). Adding `__APP_VERSION__` there is trivial. Do NOT read package.json at runtime -- webview runs in a sandboxed iframe with no filesystem access. |
| Unread notification badge count | Use existing `selectUnreadCount` from `useNotificationStore` (line 108) | Already exported as a stable external selector for reactive use with `useNotificationStore(selectUnreadCount)`. Do not recompute in TopBar. |
| "Coming soon" disabled overlay | Use the existing `Badge` component with a new variant or existing `'default'` variant | Badge is already imported in both SchedulerCalendar and RealTimeSyncPanel. Adding a banner overlay with `pointer-events-none` and `opacity` is 5 lines of CSS, not a new component. |
| Auto-select first org | Zustand `subscribe` with `fireImmediately: false` in BridgeProvider | Do not add a separate useEffect polling for org changes -- Zustand's subscribe pattern is cleaner and already used elsewhere in the codebase. |

## Common Pitfalls

### Pitfall 1: Vite `define` requires JSON.stringify for string values

**What goes wrong:** Using `define: { __APP_VERSION__: version }` (without `JSON.stringify`) injects the raw string as a JavaScript identifier, causing a `ReferenceError` at runtime.
**Why:** Vite's `define` performs a textual replacement. If the value is `1.0.1`, Vite inserts the literal token `1.0.1` which is not valid JS.
**How to avoid:** Always wrap with `JSON.stringify`: `define: { __APP_VERSION__: JSON.stringify(version) }`. The current `vite.config.ts` already does this for `process.env.NODE_ENV` on line 31 -- follow the same pattern.

### Pitfall 2: TopBar notification bell -- prop threading vs. store direct access

**What goes wrong:** CONTEXT.md says "pass `setNotificationsOpen` callback from AppShell to TopBar via props". But TopBar currently accepts only `className` as a prop (line 28). Adding an onClick prop means threading state through AppShell to TopBar, which is fragile.
**Why:** AppShell owns the `notificationsOpen` state (useState on line 22) and NotificationCenter receives it as `open` prop. TopBar needs to toggle this boolean.
**How to avoid:** Two clean options: (a) Add `onNotificationsToggle?: () => void` prop to TopBar and pass from AppShell -- this matches the existing pattern where AppShell orchestrates layout state. (b) Move `notificationsOpen` to `useAppStore` so TopBar and NotificationCenter both read/write from the global store. Option (a) is lower-risk since AppShell already owns this state. The planner should pick one and be consistent.

### Pitfall 3: Auto-select org fires before orgs are loaded

**What goes wrong:** If auto-select runs in a useEffect that depends on `selectedOrgId === null`, it fires immediately on mount when orgs array is still empty, selecting nothing. Then when orgs arrive, the effect does not re-run because `selectedOrgId` is still null but the dependency did not change.
**Why:** The org list arrives asynchronously via `org:list:response` listener in BridgeProvider (line 38-43). The auto-select logic must watch the `orgs` array, not just `selectedOrgId`.
**How to avoid:** The effect/subscription should depend on BOTH `orgs.length > 0` AND `selectedOrgId === null`. Place it inside the `org:list:response` listener callback in BridgeProvider, right after `setOrgs()` -- this guarantees it runs exactly when fresh org data arrives:
```
const state = useOrgStore.getState();
if (!state.selectedOrgId && msg.payload.orgs.length > 0) {
  const connected = msg.payload.orgs.filter(o => o.status === 'connected');
  if (connected.length > 0) state.selectOrg(connected[0].id);
}
```

### Pitfall 4: EmptyState `module` type does not include 'forge' or 'autopilot'

**What goes wrong:** The `EmptyStateModule` type on line 5 of `EmptyState.tsx` is: `'seed' | 'sync' | 'monitor' | 'compare' | 'dataops' | 'automation'`. It does NOT include `'forge'` or `'autopilot'`. Passing these values will not render the module illustration.
**Why:** The type and `MODULE_ILLUSTRATIONS` record (lines 33-81) were created before Forge/Autopilot empty states were needed.
**How to avoid:** Extend the `EmptyStateModule` union type to include `'forge' | 'autopilot'` and add corresponding SVG illustrations to `MODULE_ILLUSTRATIONS`. The existing SVGs are simple geometric shapes (circle border + thematic fill), so matching the style is straightforward.

### Pitfall 5: Removing Grappe from sidebar but leaving router route

**What goes wrong:** Removing the Grappe hero button from Sidebar.tsx is necessary, but the `'grappe'` route still exists in `useAppStore` (ModuleRoute union), `router.tsx` (routeComponents), and `TopBar.tsx` (ROUTE_LABELS). If these are left dangling, TypeScript won't complain (no exhaustiveness check on routes), but the code is dirty.
**Why:** The CONTEXT.md says "GrappePage.tsx can be kept for direct URL access but not in sidebar nav." This means the `'grappe'` route should stay in the router but be hidden from navigation. The `iconMap` in Sidebar.tsx (line 34) still has `grappe` -- this should be removed to avoid confusion.
**How to avoid:** Remove from Sidebar.tsx: the hero button (lines 214-230) and `grappe` from `iconMap` (line 34). Do NOT remove from `router.tsx`, `useAppStore.ModuleRoute`, or `TopBar.ROUTE_LABELS` -- those need to stay so direct navigation to Grappe still works.

### Pitfall 6: Scheduler/RealTime no-op handler -- unregistered message types cause MessageBroker warnings

**What goes wrong:** The `scheduler:*` and `realtime:*` message types are in the WebViewToExtensionMessage union (lines 227-235 of messages.types.ts) but have NO routes registered in `ExtensionHandlers.registerAll()`. When the SchedulerPanel or RealTimeSyncPanel send messages, the MessageBroker logs `Unhandled message type: "scheduler:list"` (line 139 of MessageBroker.ts).
**Why:** These are ghost features from v1.0 that were typed but never implemented on the extension side.
**How to avoid:** Register no-op handlers for `scheduler:*` and `realtime:*` prefixes in `ExtensionHandlers.registerAll()`. Use `buildResponse()` to return a `{ success: false, error: 'Feature not available' }` response. This prevents unhandled warnings AND gives the webview a clean error state to display.

### Pitfall 7: i18n keys must be added to ALL 6 locale files

**What goes wrong:** Adding new i18n keys to `en.json` and `fr.json` but forgetting `de.json`, `es.json`, `ja.json`, `pt-BR.json` causes missing translation warnings in development and blank strings for users of those locales.
**Why:** The i18n setup uses `fallbackLng: 'en'` (line 29 of i18n/index.ts), so missing keys fall back to English. But this only works if the key structure exists. If the planner adds deeply nested new sections (e.g., `emptyState.forge.title`), the fallback still works -- but the other locale files diverge from en.json structure.
**How to avoid:** For this phase, add keys to `en.json` and `fr.json` (the two languages specified by the user). For the other 4 locale files, add the same keys with English values as placeholders (this is the existing pattern -- the non-en/fr locale files already contain English placeholder text).

### Pitfall 8: StatusFooter test (line 58) asserts exact hardcoded version string

**What goes wrong:** The existing test `expect(screen.getByText('SandForge v3.0.0'))` in `StatusFooter.test.tsx` line 58 will fail after making the version dynamic.
**Why:** The test hardcodes the old value.
**How to avoid:** Update the test to either mock `__APP_VERSION__` via vitest globals or use a regex matcher like `/SandForge v\d+\.\d+\.\d+/`.

## Existing Patterns in This Codebase

- **EmptyState component:** Located at `packages/webview/src/components/ui/EmptyState.tsx`. Rich API with `module` (for SVG illustrations), `icon`, `title`, `description`, `actionLabel`, `onAction`, `docLabel`, `onDocClick`, `tourLabel`, `onTourClick`, `encouragement`. Already used in 22 files across all module pages. The `module` prop triggers built-in SVG illustrations. The `actionLabel` + `onAction` props create a styled CTA button.

- **Empty state guard pattern:** Existing modules follow this pattern at the top of their page component: `if (orgs.length === 0) { return <EmptyState ... />; }`. See `AutomationPage.tsx` line 80-88 and `MonitorPage.tsx` (uses custom OrgSelectCard list when no selectedOrg). The planner should follow this established guard pattern.

- **AppShell state ownership:** `AppShell.tsx` owns `notificationsOpen` via useState (line 22). It renders `<NotificationCenter open={notificationsOpen} onClose={() => setNotificationsOpen(false)} />`. TopBar is rendered as `<TopBar />` with no props passed from AppShell currently.

- **DomainHandler + buildResponse pattern:** All extension handlers implement `DomainHandler.handle()` (from `HandlerTypes.ts`) and use `buildResponse()` to create correlated responses. The no-op handler for scheduler/realtime should follow this same pattern.

- **MessageRouter.route() for handler registration:** In `ExtensionHandlers.registerAll()` (lines 176-253), the pattern is `route(['type:a', 'type:b'], this.someHandler)`. The no-op handler should be registered the same way.

- **i18n key naming:** Keys follow `module.section.key` (e.g., `automation.noPipelines`, `org.noOrgs`, `monitor.jobs`). Empty state keys should be `module.emptyState.title`, `module.emptyState.description`, `module.emptyState.cta`.

- **Badge component:** Used for notification counts and status indicators throughout. Located at `packages/webview/src/components/ui/Badge.tsx`. Variants include `default`, `success`, `warning`, `error`, `info`. Suitable for "Coming Soon" badges on ghost features.

- **Sidebar navigation structure:** The sidebar uses three arrays: `mainNav` (Home, Orgs), `moduleNav` (Monitor, Compare, DataOps, Automation), and `bottomNav` (Reports, Settings, Help). Forge and Grappe are separate "hero" buttons between mainNav and moduleNav. Removing Grappe means deleting lines 214-230 and its `iconMap` entry.

- **Vite config define block:** Already has `define: { 'process.env.NODE_ENV': JSON.stringify('production') }` on line 31 of `vite.config.ts`. Adding `__APP_VERSION__` here is the natural location.

## Key Files by Requirement

| Requirement | Primary files to modify | Test files to update |
|-------------|------------------------|---------------------|
| UX-01 (Grappe removal) | `Sidebar.tsx` | `Sidebar.test.tsx` |
| UX-02 (Bell wiring) | `TopBar.tsx`, `AppShell.tsx` | `TopBar.test.tsx`, `AppShell.test.tsx` |
| UX-03 (Dynamic version) | `StatusFooter.tsx`, `vite.config.ts` | `StatusFooter.test.tsx` |
| UX-04 (Auto-select org) | `BridgeProvider.tsx` | `BridgeProvider.test.tsx` |
| UX-05 (Empty states) | 5 module pages + `EmptyState.tsx` + `en.json` + `fr.json` | 5 module test files + `EmptyState.test.tsx` |
| GHO-01/02 (Ghost cleanup) | `messages.types.ts`, `SchedulerCalendar.tsx`, `RealTimeSyncPanel.tsx`, `SchedulerPanel.tsx` | Corresponding test files |
| GHO-03 (No-op handlers) | `ExtensionHandlers.ts` + new handler file | `ExtensionHandlers.test.ts` |

## Recommended Approach

Given that this phase covers 8 requirements with varying complexity (from simple one-liner fixes to multi-file empty state additions), the work divides naturally into 3 plans: (1) Layout fixes -- Sidebar, TopBar, StatusFooter, auto-select org -- these are small, independent changes to layout components with clear test updates; (2) Empty states -- requires extending EmptyState type, adding illustrations, creating module-specific content with i18n keys for all 5 modules; (3) Ghost feature cleanup -- auditing messages.types.ts, adding "coming soon" overlays to SchedulerCalendar/RealTimeSyncPanel/SchedulerPanel, registering no-op handlers. Plans 1 and 2 are parallelizable since they touch different files. Plan 3 depends on understanding the message type audit but is otherwise independent of the UX work.

---
*Phase: 03-ux-cleanup-ghost-features*
*Research completed: 2026-03-18*
