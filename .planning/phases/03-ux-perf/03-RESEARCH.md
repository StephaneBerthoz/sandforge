# Phase 03 Research: UX Enhancements + Performance

## Current State Analysis

### ForgeDiscovery.tsx (228 lines)

**Graph-only view (UX-11)**
- Lines 142-169: Renders a single `SplitView` with `LiveGraph` on the left and `ForgeNodeDetail` on the right
- The `h-[480px]` class (line 142) is hardcoded — no table/list alternative exists
- Graph is the sole view mode; users with 50+ nodes cannot scan objects in a flat list
- The `SplitView` component supports ratio `60/40` (current), `50/50`, and `70/30`

**Error state (UX-20)**
- Lines 119-131: The error/no-graph block shows the error message and a Back button
- NO retry button — user must go back to input and click Discover again
- The `error` state variable holds the message from `forge:discover:error`
- Need: a "Retry" button that re-sends `forge:discover` with the current config from the store

**Select All / Deselect All (UX-21)**
- `toggleNodeIncluded` is called per-node (line 76-79)
- No bulk toggle action exists in the store or component
- Need: two buttons (Select All / Deselect All) in the stats bar or action bar
- Store needs `setAllNodesIncluded(included: boolean)` action

**Node search/filter (UX-22)**
- No search input exists in ForgeDiscovery
- Graph can have 30+ nodes for large orgs — visual scanning is difficult
- Need: a search input above the graph that filters or highlights nodes by objectApiName
- Approach: text input that sets selectedNodeName when a match is found, or filters visible nodes

### ForgeExecution.tsx (341 lines)

**Logs in local state only (UX-14)**
- Line 51: `const [logs, setLogs] = useState<LogEntry[]>([]);` — logs are component-local
- When phase transitions to `results`, logs are lost — ForgeResults has no access
- Need: persist logs to `useForgeStore` so ForgeResults can display them

**ETA calculation (UX-17)**
- Lines 133-140: KPIs compute `doneCount`, `runningCount`, `queuedCount` on every render — no memoization
- `elapsed` state tracks time since execution start (line 54)
- ETA formula: `(elapsed / doneCount) * (totalNodes - doneCount)` when doneCount > 0
- Need: display ETA next to elapsed timer in the top bar

**Hardcoded heights (PERF-06)**
- Line 203: `h-[400px]` on the SplitView wrapper
- Line 142 in ForgeDiscovery: `h-[480px]`
- LogStream line 130: `max-h-64` (256px)

### ForgeResults.tsx (284 lines)

**"Forge Again" resets everything (UX-13)**
- Line 134: `handleForgeAgain` calls `reset()` which sets ALL state to `INITIAL_STATE` (store line 243)
- This erases orgs, input mode, depth, options — user must re-enter everything
- Need: a `softReset()` that clears only result, graph, plan, complianceReport, metadataDiffs but keeps config

**No sort/filter on results table (UX-18)**
- Lines 186-229: A static `<table>` with no sort headers or filter controls
- Table columns: Object, Records, Status, Errors
- Need: clickable column headers for sort (by objectApiName, recordCount, status) and a status filter dropdown

**No duration/timestamp (UX-19)**
- The `result` object has `duration: number` (ms) and `timestamp: string` (ISO)
- Neither is displayed in ForgeResults
- Need: show formatted duration and timestamp in the KPI area or above the table

**No logs in results (UX-14)**
- ForgeResults has no access to execution logs
- After persisting logs to store, add a collapsible log section with the same LogStream component

### LiveGraph.tsx (161 lines)

**Full Dagre re-layout on every render (PERF-01)**
- Line 125: `useMemo(() => buildFlowNodes(graph, onNodeClick, onIncludeToggle), [graph, onNodeClick, onIncludeToggle])`
- `graph` changes every time a node status is updated (the store creates a new graph object)
- This means Dagre `layout()` runs on every forge:progress message (~every 500ms during execution)
- Need: separate layout computation (depends only on node names + edges) from data overlay (depends on status/progress)

**Callback stability (PERF-02)**
- Line 125: `useMemo` depends on `onNodeClick` and `onIncludeToggle`
- ForgeDiscovery creates `handleNodeClick` with `useCallback([], [])` (stable) and `handleToggleIncluded` with `useCallback([selectedNodeName, ...]` (changes on selection)
- ForgeExecution passes no `onNodeClick`/`onIncludeToggle` (undefined) — stable
- In Discovery, when a node is selected, `handleToggleIncluded` changes identity, busting the memo

**Role attribute (already flagged A11Y-05)**
- Line 139: `role="img"` on an interactive graph container — should be removed or changed

### LogStream.tsx (164 lines)

**Array copy for "All" filter (PERF-05)**
- Line 60: `filterEntries` returns `[...entries]` (spread) for the `'all'` case
- This creates a new array on every call even when all entries are shown — unnecessary allocation
- Need: return `entries` as-is for the `'all'` case (cast to mutable if needed)

**No pause auto-scroll (UX-16)**
- Line 91-95: `autoScroll` prop is boolean, defaults to true
- Scrolls to bottom on every `visibleEntries` change
- No detection of user scrolling up — scrollbar fights the user
- Need: detect `scrollTop < scrollHeight - clientHeight` (user scrolled up), pause auto-scroll, resume when user scrolls back to bottom

**No copy/export (UX-15)**
- No toolbar or buttons for copying or exporting log content
- Need: Copy All button (clipboard), Export button (download as .log file)

**Hardcoded max-h-64 (PERF-06)**
- Line 130: `max-h-64` (16rem = 256px) — does not adapt to parent container
- Should use flex-1 or a prop-driven height

### ForgeInput.tsx (741 lines)

**OrgCard uses native select (UX-12)**
- Lines 698-740: `OrgCard` renders a native `<select>` element (line 718-732)
- Native select appearance varies by OS and does not match the SidePanel's styled dropdown
- Need: replace with a custom dropdown (Radix Popover or custom component) that shows org alias, username, status dot

**Template tab is read-only (UX-23)**
- Lines 403-428: Template tab shows a list of templates with click-to-select
- No create, edit, or delete controls exist
- `removeTemplate` exists in the store but is not wired in the UI
- Need: "Create Template" button, inline edit (name/description), delete button with confirmation

### useForgeStore.ts (245 lines)

**reset() is total (UX-13)**
- Line 242-244: `reset()` replaces everything with `INITIAL_STATE` + empty templates/history
- Need: a `forgeAgain()` or `softReset()` that preserves config, templates, history

**No logs field (UX-14)**
- Store has no `logs` field — logs are local to ForgeExecution
- Need: `logs: LogEntry[]`, `addLog(entry)`, `clearLogs()` actions

**No bulk toggle (UX-21)**
- Only `toggleNodeIncluded(objectName)` exists — no bulk action
- Need: `setAllNodesIncluded(included: boolean)` action

## Dependency Analysis

### File Conflict Matrix

| File | Plan 01 | Plan 02 | Plan 03 | Plan 04 |
|------|---------|---------|---------|---------|
| ForgeDiscovery.tsx | W | - | - | R (heights) |
| ForgeExecution.tsx | - | W | - | W (memo, heights) |
| ForgeResults.tsx | - | W | - | - |
| LiveGraph.tsx | - | - | - | W |
| LogStream.tsx | - | - | W | W (scroll, filter) |
| ForgeInput.tsx | - | - | W | - |
| useForgeStore.ts | W (setAllNodes) | W (logs, softReset) | - | - |

**Conflicts:**
- useForgeStore.ts is modified by Plan 01 (setAllNodesIncluded) and Plan 02 (logs, softReset). Different actions, different sections — can be Wave 1 parallel if careful. However, both add new actions to the same interface + implementation. **Safer to keep parallel but specify non-overlapping sections.**
- LogStream.tsx is modified by Plan 03 (copy/export, pause scroll) and Plan 04 (PERF-04 debounce, PERF-05 filter, PERF-06 heights). **Plan 04 must be Wave 2 after Plan 03.**
- ForgeExecution.tsx is modified by Plan 02 (logs, ETA) and Plan 04 (memoization, heights). **Plan 04 must be Wave 2 after Plan 02.**

### Wave Assignment

- **Wave 1:** Plans 01, 02, 03 (parallel — distinct primary files, additive store changes)
- **Wave 2:** Plan 04 (depends on final state of LogStream, ForgeExecution, ForgeDiscovery)

## i18n Keys Needed

All keys go under the `"forge"` section in en.json/fr.json:

### Plan 01 (Discovery UX)
- `forge.tableView` / `forge.graphView` — view mode toggle labels
- `forge.retryDiscovery` — retry button label
- `forge.selectAll` / `forge.deselectAll` — bulk toggle labels
- `forge.searchNodes` — search placeholder
- `forge.noMatchingNodes` — empty search result

### Plan 02 (Execution + Results UX)
- `forge.eta` — "ETA" label
- `forge.etaCalculating` — "Calculating..."
- `forge.sortBy` — sort dropdown label
- `forge.filterByStatus` — filter dropdown label
- `forge.executionDuration` — duration label
- `forge.executionTimestamp` — timestamp label
- `forge.executionLogs` — logs section label
- `forge.forgeAgainKeepConfig` — tooltip for Forge Again behavior

### Plan 03 (LogStream + OrgCard + Templates)
- `forge.copyAllLogs` — copy button label
- `forge.exportLogs` — export button label
- `forge.logsCopied` — notification after copy
- `forge.logsExported` — notification after export
- `forge.createTemplate` — button label
- `forge.editTemplate` — button label
- `forge.deleteTemplate` — button label
- `forge.deleteTemplateConfirm` — confirmation message
- `forge.templateName` — input label
- `forge.templateDescription` — input label
- `forge.templateCreated` — notification
- `forge.templateDeleted` — notification

## Risks and Pitfalls

1. **Dagre layout separation (PERF-01)** — The key insight is that `buildFlowNodes` takes the full `graph` object as dependency. Since `updateNodeStatus` creates a new graph object every time, the useMemo busts. Solution: split into two memos — one for positions (keyed on node names + edge list) and one for data overlay (keyed on full graph). The position memo runs only when graph topology changes (never during execution).

2. **Log persistence (UX-14)** — Moving logs to the store means every log entry triggers a store update. For high-frequency logging (10+ entries/sec during execution), this could cause perf issues. Mitigation: batch log additions (collect in a ref, flush every 500ms) or use `immer` for efficient updates.

3. **OrgCard custom dropdown (UX-12)** — Must handle keyboard navigation (arrow keys, escape, enter), focus management, and click-outside-to-close. Using Radix `Select` or `Popover` is recommended over building from scratch.

4. **Template management (UX-23)** — The store has `removeTemplate` but no `addTemplate` or `updateTemplate`. Need to add these actions. Template creation needs a form with name/description inputs and must generate a unique ID.

5. **Auto-scroll pause (UX-16)** — The scroll event fires frequently during auto-scroll itself. Need to distinguish "user scrolled" from "programmatic scroll". Approach: track whether the container is at the bottom before a scroll event. Use a tolerance threshold (e.g., 20px) for the "at bottom" check.

6. **Performance plan (Wave 2) must not break tests** — After Plans 01-03 add features and tests, Plan 04 refactors internals. All existing tests must continue to pass after performance changes.
