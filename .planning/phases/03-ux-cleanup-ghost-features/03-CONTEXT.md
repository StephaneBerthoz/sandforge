# Phase 3: UX Cleanup & Ghost Features - Context

**Gathered:** 2026-03-18
**Status:** Ready for planning

<domain>
## Phase Boundary

Deliver a clean, coherent user experience with no dead features or broken buttons. Every module shows a tailored first-launch empty state. All remaining ghost message types get basic handlers so their UI components become functional. Navigation, notifications, version display, and org selection all work correctly.

</domain>

<decisions>
## Implementation Decisions

### UX-01: Grappe Sidebar Removal
- Remove Grappe hero button from Sidebar.tsx (lines 214-230)
- Remove `grappe` from iconMap and router navigation
- Keep GrappeProgressPanel as execution overlay (already embedded in SyncPage, etc.)
- GrappePage.tsx can be kept for direct URL access but not in sidebar nav

### UX-02: Notifications Bell Wiring
- Bell button in TopBar.tsx has no onClick — wire it to NotificationCenter
- NotificationCenter already exists and is mounted in AppShell.tsx with `notificationsOpen` state
- Pass `setNotificationsOpen` callback from AppShell to TopBar via props
- Add unread badge count on bell using `selectUnreadCount` from useNotificationStore

### UX-03: Dynamic Version in StatusFooter
- Replace hardcoded `'3.0.0'` in StatusFooter.tsx line 72
- Use Vite `define` config or `import.meta.env.VITE_APP_VERSION` injected at build time
- Read from root package.json version field during Vite build
- Fallback: read from `@sandforge/shared` package version

### UX-04: Auto-Select First Connected Org
- Add useEffect in AppShell or BridgeProvider that runs after org:list response
- When `selectedOrgId` is null AND connected orgs exist, auto-select the first one
- Use existing `selectOrg()` from useOrgStore
- Only auto-select on mount (not on every org list update)

### UX-05: Empty States — Module-Specific Guidance
- Each module gets a tailored EmptyState with specific icon, title, description, and CTA
- Existing EmptyState component used as base
- Module-specific content:
  - Forge: "Discover your org schema" → CTA to select org
  - Monitor: "Start monitoring your org" → CTA to connect org and refresh
  - DataOps: "Protect and manage your data" → CTA to select org
  - Automation: "Build your first pipeline" → CTA to create pipeline or browse marketplace
  - Autopilot: "Auto-provision your sandbox" → CTA to select org and scan schema
- All strings via i18n t() function (en + fr minimum)
- Show empty state when: no org selected OR no data loaded yet

### GHO-01/02/03: Ghost Features — Implement Basic Handlers
- Scheduler (4 types): implement basic handlers using ConfigStore for persistence
  - scheduler:list → read saved schedules from ConfigStore
  - scheduler:upsert → save/update schedule to ConfigStore
  - scheduler:delete → remove schedule from ConfigStore
  - scheduler:toggle → enable/disable schedule in ConfigStore
  - Actual cron execution is NOT in scope — just CRUD for schedule definitions
- RealTime (5 types): implement basic handlers
  - realtime:start → start a polling-based sync watcher (simplified, no CDC)
  - realtime:stop → stop the watcher
  - realtime:status → return current watcher status
  - realtime:metrics → return basic sync metrics
  - realtime:resolve-conflict → apply conflict resolution strategy
  - Use polling as a simplified implementation — real CDC/Streaming deferred to v2
- Remove any remaining types with zero handler AND zero UI consumer
- Ensure messages.types.ts only contains types with both sender and receiver
- Clean any dead handler code (handlers sending responses nobody listens for)

### Claude's Discretion
- Empty state icon choices per module
- Scheduler ConfigStore key patterns
- RealTime polling interval (suggest: configurable, default 30s)
- Order of implementation within plans

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `EmptyState` component — already used in Seed/Sync/Compare pages, consistent API
- `useNotificationStore` — has `selectUnreadCount` selector ready to use
- `NotificationCenter` — fully implemented, just needs wiring to bell button
- `useOrgStore.selectOrg()` — exists, just needs auto-call on mount
- `ConfigStore` — proven persistence (settings, backups, AI conversations, forge templates)
- `DomainHandler` pattern — all handlers now follow it (Phase 2)
- `buildResponse()` — standard for all new handler responses

### Established Patterns
- AppShell.tsx manages layout state (sidebar collapsed, notifications open)
- TopBar receives callbacks via props from AppShell
- StatusFooter is a simple presentational component in layouts/
- Empty states pattern: check `orgs.length === 0` or `!selectedOrg` → render EmptyState
- i18n: keys follow `module.section.key` naming (e.g., `seed.emptyState.title`)

### Integration Points
- `packages/webview/src/layouts/Sidebar/Sidebar.tsx` — Grappe button removal
- `packages/webview/src/layouts/TopBar/TopBar.tsx` — Bell onClick wiring
- `packages/webview/src/layouts/StatusFooter/StatusFooter.tsx` — Version dynamic
- `packages/webview/src/layouts/AppShell.tsx` — Org auto-select + NotificationCenter bridge
- `packages/webview/src/pages/*/` — Empty states per module
- `packages/extension/src/bridge/handlers/` — New Scheduler + RealTime handlers
- `packages/extension/src/bridge/ExtensionHandlers.ts` — Register new handlers
- `packages/shared/src/types/messages.types.ts` — Type audit + cleanup

</code_context>

<specifics>
## Specific Ideas

- Empty states doivent etre specifiques par module — pas un template generique
- Scheduler: CRUD des definitions seulement, pas d'execution cron reelle
- RealTime: implementation simplifiee par polling, CDC/Streaming reporte a v2
- Flagship quality — chaque ecran vide doit guider l'utilisateur vers l'action suivante

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---
*Phase: 03-ux-cleanup-ghost-features*
*Context gathered: 2026-03-18*
