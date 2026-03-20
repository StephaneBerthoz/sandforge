# Plan 03-01 Summary

**Completed:** 2026-03-20
**Phase:** 3 -- UX Enhancements + Performance

## What was built

Added four UX enhancements to the ForgeDiscovery phase for improved large-org usability: (1) a table/list view alternative to the graph with sortable columns and include toggles, (2) a retry button on discovery errors that re-sends the discover request with the current config, (3) bulk Select All / Deselect All buttons for graph nodes, and (4) a search input that filters nodes by objectApiName (with auto-select in graph view and row filtering in table view).

## Key files

- `packages/webview/src/pages/Forge/ForgeTableView.tsx`: New sortable table component displaying graph nodes with checkbox toggles, status badges, PII count, and search filtering
- `packages/webview/src/pages/Forge/ForgeTableView.test.tsx`: 8 test cases covering rendering, row click, checkbox toggle, sort, search filter, empty state, highlight, and PII display
- `packages/webview/src/pages/Forge/ForgeDiscovery.tsx`: Integrated view toggle toolbar, search input, retry button in error state, and Select All/Deselect All in action bar
- `packages/webview/src/pages/Forge/ForgeDiscovery.test.tsx`: Added 5 new test cases for retry, view toggle, select all, deselect all, and search input (17 total)
- `packages/webview/src/stores/useForgeStore.ts`: Added `setAllNodesIncluded(included: boolean)` action
- `packages/webview/src/stores/useForgeStore.test.ts`: Added 3 test cases for the new action (34 total)
- `packages/webview/src/i18n/locales/en.json`: 7 new forge keys (tableView, graphView, retryDiscovery, selectAll, deselectAll, searchNodes, noMatchingNodes)
- `packages/webview/src/i18n/locales/fr.json`: 7 matching French translations

## Decisions made

- ForgeTableView uses `fireEvent.click` (not `fireEvent.change`) for checkbox toggle tests due to jsdom behavior
- Search auto-select in graph view uses a useEffect that finds the first case-insensitive match on objectApiName
- ForgeTableView renders a "no matching objects" empty state when search query yields zero results
- Fixed ForgePage.test.tsx mock to include `clearLogs`, `addLog`, `logs`, `forgeAgain`, `addTemplate`, `updateTemplate` from concurrent plan changes (required for full test suite green)

## Deviations from plan

- ForgePage.test.tsx required mock updates due to concurrent plan 02-02 adding `clearLogs`/`addLog`/`logs`/`forgeAgain` to the store -- fixed as part of this plan to keep the test suite passing
- The store file was modified by concurrent plan 02-02 (adding ForgeLogEntry, logs, addLog, clearLogs, forgeAgain, addTemplate, updateTemplate) -- `setAllNodesIncluded` was integrated alongside these changes

## Notes for downstream

- 3 pre-existing test failures in `ForgeInput.test.tsx` from concurrent plan changes (template management) -- not related to this plan
- The `ForgeTableView` component accepts a `searchQuery` prop for filtering; in graph mode, the search auto-selects the first matching node instead
- `setAllNodesIncluded` operates on all nodes regardless of current filter/search state
