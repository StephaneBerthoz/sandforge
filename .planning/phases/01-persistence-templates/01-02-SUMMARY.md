# Plan 01-02 Summary

**Completed:** 2026-03-26
**Phase:** 01 -- Persistence & Templates Foundation

## What was built

Defined three pre-built seed templates (Sales Cloud Starter, Service Cloud Starter, Minimal Demo) as static constants in `packages/shared/src/constants/seed-templates.ts` with correct insertOrder chains, realistic faker-based field rules, reference rules for parent-child relationships, and proper record counts. Created a `useWebviewPersistedState` hook wrapping `vscode.getState()/setState()` with key-based merging, and integrated it into both `useSyncPageData` and `useSeedWizardState` for draft auto-save on state changes.

## Key files

- `packages/shared/src/constants/seed-templates.ts`: Exports SALES_CLOUD_STARTER (7 objects), SERVICE_CLOUD_STARTER (5 objects), MINIMAL_DEMO (3 objects), and PREBUILT_SEED_TEMPLATES array
- `packages/shared/src/constants/seed-templates.test.ts`: 36 tests validating insertOrder, referential integrity, record counts, and field rules
- `packages/webview/src/hooks/useWebviewPersistedState.ts`: Generic hook for key-scoped webview state persistence
- `packages/webview/src/hooks/useWebviewPersistedState.test.ts`: 7 tests for the persistence hook
- `packages/webview/src/pages/Sync/useSyncPageData.ts`: Integrated SyncDraftState auto-save/restore
- `packages/webview/src/pages/Seed/useSeedWizardState.ts`: Integrated SeedDraftState auto-save/restore
- `packages/shared/src/i18n/locales/en/seed.ts`: English i18n keys for template names/descriptions
- `packages/shared/src/i18n/locales/fr/seed.ts`: French i18n keys for template names/descriptions
- `packages/webview/src/i18n/locales/en.json`: English webview i18n keys
- `packages/webview/src/i18n/locales/fr.json`: French webview i18n keys

## Decisions made

- i18n keys stored as template `name`/`description` values (e.g., `seed.templates.salesCloudStarter.name`) -- the UI layer resolves them via `t()`
- PricebookEntry included as 7th object in Sales Cloud Starter at insertOrder 2 for OLI referential integrity
- Seed wizard restore uses handler replay (calling `handleOrgSelect`, `handleToggleObject`) since sub-hooks own their own state and don't accept initial values
- Sync wizard restore uses `useRef` to capture initial draft and initialize `useState` calls directly
- `SyncDraftState` includes `objectEntries`, `mappings`, `transforms` but excludes execution results, loading states, and error states
- `SeedDraftState` includes `selectedOrgId`, `selectedObjects`, `volumes`, `nl2soqlQuery` but excludes execution results, PII results, progress, and loading states
- i18n keys added to both shared TS files and webview JSON files (deviation from plan which mentioned only JSON files, since the project uses TS in shared)

## Deviations from plan

- Plan specified `packages/shared/src/i18n/locales/en/translation.json` and `fr/translation.json` but those files don't exist -- the project uses TypeScript files (`seed.ts`) in shared and JSON files in webview. Added keys to both `en/seed.ts`+`fr/seed.ts` and `en.json`+`fr.json`
- Seed wizard state restoration uses handler replay pattern instead of direct state initialization, because sub-hooks (`useSeedOrgSelection`, `useSeedObjectSelection`, etc.) encapsulate their own `useState` and don't accept initial values

## Notes for downstream

- One pre-existing test failure in `MonitorPage.test.tsx` (unrelated to this plan) -- the `/15/` regex matches both a countdown timer and a KPI value
- The `useWebviewPersistedState` hook is ready for use by any webview component needing panel-reload persistence
- Template i18n keys follow the pattern `seed.templates.[templateId].name` and `seed.templates.[templateId].description`
