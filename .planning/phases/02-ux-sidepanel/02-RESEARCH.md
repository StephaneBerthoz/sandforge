# Phase 02 Research: UX Quick Wins + SidePanel Refonte

## Current State Analysis

### ForgeInput.tsx (641 lines)

**Org Selection (lines 106-107)**
- `sourceOrgId` and `targetOrgId` are initialized as empty strings `useState('')`
- No auto-selection from global `selectedOrgId` — user must manually pick both orgs every time
- `useOrgStore` is imported but only `orgs` is consumed (line 95); `selectedOrgId` is not read

**URL Domain Detection (UX-02)**
- `extractRecordId()` (lines 57-64) already extracts the record ID from a Salesforce URL
- But there is NO logic to match the URL domain (e.g., `myorg.lightning.force.com`) to a connected org's `instanceUrl`
- The `SalesforceOrg.instanceUrl` field is available (e.g., `https://src.salesforce.com`)

**Source === Target Guard (UX-03)**
- Line 156: `canDiscover` only checks `hasInput() && sourceOrgId.length > 0 && targetOrgId.length > 0`
- No check that `sourceOrgId !== targetOrgId` — user can pick the same org as source and target

**Swap Orgs Button (UX-04)**
- Lines 213-233: The org cards row uses a grid with `ArrowRight` icon in the center
- No swap button exists — just a static arrow icon

**Disabled CTA Hint (UX-05)**
- Lines 458-473: The discover button is disabled when `!canDiscover` but shows NO hint about what is missing
- The user sees a grayed-out button with no explanation

**Depth Chip Tooltips (UX-07)**
- Lines 382-414: Depth chips render labels via i18n but have NO `title` attribute or tooltip
- Current i18n keys: `forge.depthDirect` = "Direct only", `forge.depthFull` = "Full tree", `forge.depthCustom` = "Custom depth"
- Missing keys for tooltip descriptions

**Ctrl+Enter Submit (UX-08)**
- Lines 311-324 (SOQL textarea), lines 357-370 (AI textarea): Standard `<textarea>` with no `onKeyDown` handler
- No keyboard shortcut to trigger discovery

**Preview Panel Contextual Message (UX-09)**
- Lines 477-527: The preview panel shows record data or a placeholder with "Record ID (e.g. 001...)" or "No org selected"
- When user is on SOQL/AI/Template tab, the preview panel still shows the Record-specific placeholder, which is confusing
- Should show a tab-specific contextual message

**Preview Button (UX-10)**
- Lines 285-300: There is a manual preview button (magnifying glass icon) next to the record input
- Lines 171-180: Auto-preview fires on a 400ms debounce timer
- The manual button is redundant since auto-preview exists; could be transformed to a refresh button

### ForgeDiscovery.tsx (228 lines)

**Execute Button Label (UX-06)**
- Line 224: `{t('forge.executeForge')}` renders as "Execute Forge"
- i18n key `forge.executeForge` = "Execute Forge" (en.json line 1240)
- Should be changed to "Review & Execute" (the button goes to `review` phase, not execution)
- Need to add a new i18n key or update existing one

### SidePanel.tsx (436 lines)

**Org Switcher (SP-01)**
- Lines 186-248: Dropdown lists orgs in array order (no sorting)
- Connected orgs are NOT sorted first — disconnected/error orgs may appear above connected ones
- Status dot (line 206-209) uses a simple 1.5px dot with binary green/gray
- Selected org badge (line 146-177) shows green when ANY org is connected, not when the SELECTED org is connected

**Compact Mode (SP-02)**
- No responsive behavior for short viewports
- The Forge hero (lines 264-289) takes significant vertical space (~80px)
- Quick metrics (lines 252-261) take ~60px
- On short viewports (e.g., 600px), content overflows with no collapse mechanism

**Quick Metrics (SP-03)**
- Lines 252-261: Shows "Orgs" count and "Ops" count in a 2-column grid
- These are basic counts with no interactivity — low value, high visual weight
- Could be collapsed or simplified to a single inline row

**Favorites Discovery (SP-04)**
- Lines 338-349: Star button on module items has `opacity-0 group-hover:opacity-100`
- Stars are INVISIBLE unless the user hovers over a module row
- Already-favorited items show `opacity-100` but unfavorited stars are completely hidden
- Users cannot discover the feature without accidentally hovering

**Visual Hierarchy (SP-05)**
- Section labels use `text-[10px] font-semibold uppercase tracking-widest text-text-muted`
- Forge hero (lines 264-289) is a large card with gradient — dominates the visual hierarchy
- Module items and tool items have identical styling — no visual distinction
- Branding section (lines 126-133) shows "v1.0" hardcoded (line 132) — stale version

**Version Badge (SP-06)**
- Line 132: `<span className="...">v1.0</span>` is hardcoded in the branding header
- Takes space and provides no value — should be moved to Settings page

### useOrgStore.ts (81 lines)

- `selectedOrgId` is `string | null` (line 7)
- `selectOrg` (line 49) sets it directly
- External selectors exist: `selectConnectedOrgs`, `selectSelectedOrg`, `selectConnectedCount`
- No sorting logic in the store — orgs are in insertion order

### useForgeStore.ts (245 lines)

- `ForgePhase` type: `'input' | 'discovery' | 'review' | 'execution' | 'results'` (line 51)
- `setConfig` clears plan/complianceReport/metadataDiffs/result but NOT graph (line 139)
- No action for swapping source/target org IDs — config stores them as strings

### ProgressNode.tsx (195 lines)

- Not directly impacted by Phase 02 requirements
- Already has proper structure with status icons, badges, checkboxes

## i18n Keys Needed

### ForgeInput (en.json, forge section)
- `forge.noOrgSelected` — currently missing from i18n file (used at line 524 with inline text)
- `forge.livePreview` — currently missing
- `forge.estimatedGraph` — currently missing
- `forge.piiWarning` — currently missing (uses count interpolation)
- `forge.piiWarningHint` — currently missing
- `forge.depthDirectTooltip` — NEW: "Only directly related child objects"
- `forge.depthFullTooltip` — NEW: "Entire dependency tree, all levels"
- `forge.depthCustomTooltip` — NEW: "Specify maximum relationship depth"
- `forge.swapOrgs` — NEW: "Swap source and target"
- `forge.hintNoSource` — NEW: "Select a source org"
- `forge.hintNoTarget` — NEW: "Select a target org"
- `forge.hintNoInput` — NEW: "Enter a record ID, SOQL query, or prompt"
- `forge.hintSameOrg` — NEW: "Source and target must be different"
- `forge.soqlPreviewHint` — NEW: "Preview available in Record tab"
- `forge.templatePreviewHint` — NEW: "Select a template to see its config"
- `forge.aiPreviewHint` — NEW: "AI will generate the graph on discover"
- `forge.reviewAndExecute` — NEW: "Review & Execute" (replaces executeForge in discovery)
- `forge.refreshPreview` — NEW: "Refresh preview"

### SidePanel (en.json, sidePanel section)
- `sidePanel.version` — NEW: not needed (version moves to Settings, removed from SidePanel)

## Risks and Pitfalls

1. **OrgCard is a sub-component inside ForgeInput.tsx** — the swap button goes BETWEEN two OrgCard instances (line 222-223, the ArrowRight icon area). Must replace the static arrow with an interactive swap button.

2. **Auto-select on mount (UX-01)** must NOT overwrite if the user navigates back from Discovery with orgs already set. Use a `useEffect` with a guard: only set sourceOrgId if it is still empty.

3. **URL domain matching (UX-02)** must handle Lightning URLs (`*.lightning.force.com`) and Classic URLs (`*.salesforce.com`). The `instanceUrl` in `SalesforceOrg` is the API endpoint (e.g., `https://na1.salesforce.com`), not the Lightning URL. Need to extract the subdomain/pod from both formats and compare.

4. **Ctrl+Enter (UX-08)** must trigger `handleDiscover` only when `canDiscover` is true. Must not interfere with normal Enter behavior in textareas (new line).

5. **SidePanel compact mode (SP-02)** — detecting viewport height in a VSCode webview panel. Can use `window.innerHeight` or CSS `max-height` media queries. The SidePanel is in a separate webview from the main editor.

6. **Test files exist** for all 3 components — ForgeInput.test.tsx (239 lines), ForgeDiscovery.test.tsx (209 lines), SidePanel.test.tsx (194 lines). New tests must be added for each UX change.

7. **i18n dual maintenance** — both `en.json` and `fr.json` must be updated for every new key.

8. **Some forge.* i18n keys are used with inline defaults** (e.g., line 524: `t('forge.noOrgSelected')` — the key may not exist in the JSON file yet). The `t()` function returns the key itself when missing. Need to add all missing keys.
