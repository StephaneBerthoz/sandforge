# Plan 05-04 Summary

**Completed:** 2026-03-27
**Phase:** 05 -- Seed Extensions (CSV + Clone)

## What was built

Built the complete Clone UI for the Seed module: a 4-step wizard (Source Org -> Select Objects -> Preview -> Execute & Results) with useClone state management hook, CloneSourcePicker with two-column source/target org display, CloneObjectSelector with searchable checkboxes and per-object SOQL WHERE filter, ClonePreviewPanel showing insert order and record counts with large-clone warnings, and CloneResultsPanel with per-object ID mapping tables and CSV export. Integrated into SeedPage replacing the clone placeholder from Plan 03.

## Key files

- `packages/webview/src/pages/Seed/Clone/useClone.ts`: State management hook for clone pipeline (source/target org, objects, WHERE filters, preview, execute)
- `packages/webview/src/pages/Seed/Clone/CloneSourcePicker.tsx`: Two-column org picker with directional arrow (source -> target)
- `packages/webview/src/pages/Seed/Clone/CloneObjectSelector.tsx`: Searchable object list with checkboxes and per-object WHERE clause inputs
- `packages/webview/src/pages/Seed/Clone/ClonePreviewPanel.tsx`: Insert order, record counts, sample records with large-clone warning
- `packages/webview/src/pages/Seed/Clone/CloneResultsPanel.tsx`: Per-object results with paginated ID mapping table and CSV export
- `packages/webview/src/pages/Seed/Clone/CloneWizard.tsx`: 4-step wizard orchestrator using Wizard component and useClone hook
- `packages/webview/src/pages/Seed/SeedPage.tsx`: Updated to render CloneWizard in clone mode (replacing placeholder)
- `packages/webview/src/i18n/locales/en.json`: Added seed.clone.* i18n keys (29 keys)
- `packages/webview/src/i18n/locales/fr.json`: Added seed.clone.* French translations (29 keys)
- `packages/shared/src/i18n/locales/en/seed.ts`: Added clone sub-namespace to shared English locale
- `packages/shared/src/i18n/locales/fr/seed.ts`: Added clone sub-namespace to shared French locale

## Decisions made

- Used `_t` prefix for unused TFunction parameter in useClone (reserved for future error message localization)
- CloneWizard uses `clone-wizard-container` as outer div testId to avoid collision with Wizard's auto-generated `clone-wizard` testId
- Badge component does not support data-testid passthrough, so selected count badge uses text content assertions in tests
- Reused existing Wizard component with `testIdPrefix="clone"` for consistent step navigation UX
- CloneResultsPanel uses fixed page size of 25 for ID mapping pagination
- Large clone warning threshold set at 10,000 records

## Deviations from plan

- Task 05-04-03 SeedPage integration: Plan 03 (CSV UI) had already modified SeedPage with the mode selector and clone placeholder. The replacement of the placeholder with CloneWizard and i18n additions were committed as part of the concurrent plan execution on the same branch. The final state is correct (CloneWizard renders in clone mode).

## Notes for downstream

- The useClone hook syncs mutation results into local state via render-time checks (not useEffect). This is intentional to avoid stale closures with the bridge mutation pattern.
- Clone messages use `seed:clone:describe-source`, `seed:clone:preview`, and `seed:clone:execute` -- backend handlers for these need to exist in the extension's SeedDomainHandler.
- The export ID mapping feature creates a CSV blob URL for download; in VSCode WebView context, this may need the `vscode.env.openExternal` API for file save dialogs in a future enhancement.
