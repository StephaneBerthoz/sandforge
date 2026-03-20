# Plan 01-02 Summary

**Completed:** 2026-03-20
**Phase:** 01 -- Bugs + Cleanup

## What was built

Five surgical UI bug fixes across the webview package. Removed the non-functional Grappe hero button from SidePanel, made ProgressNode checkboxes conditional on the onIncludeToggle callback being provided, fixed handleDiscover to extract record IDs from full Salesforce URLs, corrected the idRemaps KPI to read from result.idRemapCount instead of mirroring inserted count, and fixed the wrong i18n key in ForgeNodeDetail field count display.

## Key files

- `packages/webview/src/SidePanel.tsx`: Removed Grappe hero block (lines 291-317) and unused Network import
- `packages/webview/src/components/graph/ProgressNode.tsx`: Conditionally render checkbox only when onIncludeToggle is provided
- `packages/webview/src/pages/Forge/ForgeInput.tsx`: Use extractRecordId() in handleDiscover config builder
- `packages/webview/src/pages/Forge/ForgeResults.tsx`: Replace `useMemo(() => inserted)` with `result?.idRemapCount ?? 0`
- `packages/webview/src/pages/Forge/ForgeNodeDetail.tsx`: Change `t('common.object')` to `t('forge.fields')`
- `packages/webview/src/i18n/locales/en.json`: Added `forge.fields = "Fields"`
- `packages/webview/src/i18n/locales/fr.json`: Added `forge.fields = "Champs"`

## Decisions made

- Kept `navigate` function in SidePanel (used by forge hero and module navigation)
- Kept `useMemo` import in ForgeResults.tsx (still used by 5 other computed values)
- Used `extractRecordId(recordId) ?? undefined` pattern to convert null to undefined, matching existing type contract

## Deviations from plan

- None

## Notes for downstream

- The `canPreview` variable in ForgeInput.tsx is still present (plan explicitly notes CLN-04 handles that in Plan 01-03)
- ForgeResults mock now includes `idRemapCount: 42` -- downstream tests should include this field in mock results
