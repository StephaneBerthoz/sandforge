# Phase 01: Bugs + Cleanup -- Research

**Researched:** 2026-03-20
**Phase goal:** Fix all broken behavior and remove dead code before building new features.
**Requirements in scope:** BUG-01..09, CLN-01..06, BE-08

---

## Don't Hand-Roll

| Problem | Recommended solution | Why |
|---------|---------------------|-----|
| Object resolution from record ID prefix | `conn.describeGlobal()` (already used in `ForgeHandler.handleForgePreview`) | The static `ID_PREFIX_MAP` in GraphDiscoveryService covers only 10 standard objects. Custom objects, Person Accounts, etc. all have org-specific prefixes. `describeGlobal` returns the authoritative `keyPrefix` for every object in the org. |
| Abort signal propagation | Use the native `AbortController` / `AbortSignal` already created in ForgeHandler | The pattern is correct for discover (line 299-306). The same pattern must be applied to execute. Do not hand-roll a custom cancellation mechanism -- `ForgeExecutor.abort()` already exists and integrates with `waitIfPaused()`. |

## Common Pitfalls

### Pitfall 1: Abort signal created but never passed to ForgeOrchestrator.execute

**What goes wrong:** `ForgeHandler.handleExecute` (line 347) creates `this.abortController = new AbortController()` and `handleAbort` (line 389-391) calls `this.abortController?.abort()`. However, `this.orchestrator.execute(graph, config)` at line 358 does NOT receive the signal. `ForgeOrchestrator.execute` (line 80-107) does NOT accept an abort signal parameter and does NOT pass one to `ForgeExecutor.execute`. The signal is created, the abort button fires, but the chain is broken between ForgeHandler -> ForgeOrchestrator -> ForgeExecutor.

**Why:** The discover flow correctly passes `signal` via `DiscoveryOptions` (line 305-306), but the execute flow was never wired the same way. `ForgeExecutor` has its own `isAborted` flag (line 82) and `abort()` method (line 102-105), but nobody calls it from above.

**How to avoid:** Two approaches:
1. **Direct reference approach** (simpler): Store a reference to the executor on ForgeOrchestrator (or expose it), then call `executor.abort()` / `executor.pause()` / `executor.resume()` directly from ForgeHandler. This requires ForgeOrchestrator to expose its executor or provide forwarding methods.
2. **Signal-based approach**: Pass `AbortSignal` through `ForgeOrchestrator.execute` to `ForgeExecutor.execute`, and have ForgeExecutor listen to the signal's `abort` event to set `isAborted = true`. This is cleaner but requires changing the execute signatures.

Either way, the key requirement is: `ForgeHandler.handleAbort` -> ForgeExecutor.abort(), `ForgeHandler.handlePause` -> ForgeExecutor.pause(), `ForgeHandler.handleResume` -> ForgeExecutor.resume().

### Pitfall 2: handlePause/handleResume only set a local boolean flag

**What goes wrong:** `ForgeHandler.handlePause` (line 378-381) sets `this.isPaused = true` and logs. `ForgeHandler.handleResume` (line 383-386) sets `this.isPaused = false`. Neither method calls ForgeExecutor's `pause()` or `resume()` methods. The `isPaused` getter (line 204) exists on ForgeHandler but is not consumed by any execution logic.

**Why:** ForgeExecutor already has correct pause/resume implementation with Promise-based waiting (lines 90-124). The wiring from ForgeHandler was simply never connected.

**How to avoid:** ForgeHandler needs a reference to ForgeExecutor (via ForgeOrchestrator) to call `pause()` and `resume()`. The simplest path: add `pause()` and `resume()` forwarding methods to ForgeOrchestrator that delegate to its internal executor.

### Pitfall 3: dryRun flag defined in message type but ignored in handler

**What goes wrong:** The `SeedExecuteRequest` message type (`packages/shared/src/types/messages.types.ts` line 354) declares `payload: { templateId: string; orgId: string; dryRun: boolean }`. However, `SeedOpsHandler.handleExecute` (line 132-265) extracts `payload` as `{ orgId: string; template: Record<string, unknown> }` -- it does not destructure `dryRun`. The entire execute method always performs real inserts.

**Why:** The handler payload type was written for a different shape than what the message type declares. The handler expects `template` (the full template object), while the shared type says `templateId` + `dryRun`. Additionally, even if `dryRun` were extracted, no code path exists to skip the actual insert.

**How to avoid:** Extract `dryRun` from payload. When `dryRun === true`, skip the actual `orchestrator.execute()` call and return a synthetic result with `insertedIds: []` and a summary indicating dry run mode. Note: the Sync module has a `dryRun()` method on `SyncOrchestrator` (line 152) that can serve as a pattern reference.

### Pitfall 4: recordId raw URL sent to backend config

**What goes wrong:** In `ForgeInput.tsx` line 190, `handleDiscover` builds the config with `recordId: inputMode === 'record' ? recordId.trim() : undefined`. The `recordId` state is the raw user input (could be a full Salesforce URL like `https://myorg.lightning.force.com/lightning/r/Account/001XXXXXXXXXXXX/view`). The `extractRecordId()` function (lines 57-64) exists and correctly extracts the ID from URLs, but it is only called for preview, NOT for config building.

**Why:** The preview handler (line 161-169) correctly calls `extractRecordId(recordId)`. The discover handler (line 184-209) was written separately and missed applying the same extraction.

**How to avoid:** Call `extractRecordId(recordId)` at line 190 instead of `recordId.trim()`. The function already handles both plain IDs and URLs. If it returns null, `canDiscover` should already prevent this case.

### Pitfall 5: Module-level logIdCounter causes stale IDs across HMR and re-mounts

**What goes wrong:** `ForgeExecution.tsx` lines 31-35 declare `let logIdCounter = 0` at module scope. This counter persists across component mounts/unmounts and Vite HMR reloads. In a new forge execution, log IDs continue from the previous run's count.

**Why:** Module-level variables in React components survive across re-mounts. For a counter that generates keys for a list within a single component lifecycle, `useRef` is the correct pattern.

**How to avoid:** Convert to `const logIdRef = useRef(0)` inside the component. Reset to 0 on mount (which useRef does naturally). Update `nextLogId` to be a closure or inline that reads from `logIdRef.current`.

### Pitfall 6: LogStream has internal filter tabs that duplicate ForgeExecution's filter bar

**What goes wrong:** `ForgeExecution.tsx` lines 217-257 renders a custom filter bar (`log-filter-all`, `log-filter-errors`, `log-filter-warnings`) and passes `filter={logFilter}` to `<LogStream>`. But `LogStream.tsx` lines 102-119 ALSO renders its own internal filter tabs (`FILTER_TABS` with `logstream-filter-all`, `logstream-filter-error`, `logstream-filter-warn`). The user sees two overlapping filter controls.

**Why:** LogStream was designed as a standalone component with built-in filtering. ForgeExecution added its own filter bar for the split-view layout but still renders the full LogStream with its internal tabs visible.

**How to avoid:** Two options:
1. Remove the filter bar from ForgeExecution and let LogStream's internal filter control the display.
2. Add a prop to LogStream (e.g., `hideFilterBar?: boolean`) to suppress its internal tabs when the parent provides external filtering.
Option 2 is cleaner because ForgeExecution's filter bar matches the split-view layout style, while LogStream's internal bar has different styling.

### Pitfall 7: idRemaps equals inserted count (always wrong)

**What goes wrong:** `ForgeResults.tsx` line 53: `const idRemaps = useMemo(() => inserted, [inserted])`. This makes `idRemaps` always equal to `inserted` (total successfully inserted records). The actual remap count should come from `result.idRemapCount` (set by `ForgeOrchestrator.execute` from `summary.remapCount` at line 97 of ForgeOrchestrator.ts).

**Why:** The `result` object is available in the component (line 34) and has `idRemapCount`. Someone used `inserted` as a placeholder and never wired the real value.

**How to avoid:** Replace with `const idRemaps = result?.idRemapCount ?? 0`.

---

## Exact Code Locations

### BUG-01: Abort signal doesn't reach ForgeExecutor

**File:** `packages/extension/src/bridge/handlers/ForgeHandler.ts`
- Line 347: `this.abortController = new AbortController()` -- created but signal not passed
- Line 358: `const result = await this.orchestrator.execute(graph, config)` -- no signal param
- Lines 388-392: `handleAbort` calls `this.abortController?.abort()` -- correct on handler side

**File:** `packages/extension/src/modules/forge/ForgeOrchestrator.ts`
- Line 80: `async execute(graph, config)` -- no signal/abort parameter accepted
- Line 84: `this.deps.executor.execute(graph, ...)` -- no abort mechanism passed

**File:** `packages/extension/src/modules/forge/ForgeExecutor.ts`
- Lines 82-83: `private isAborted = false` -- internal abort flag
- Lines 102-105: `abort()` method -- works correctly if called
- Lines 111-124: `waitIfPaused()` -- checks `isAborted` between batches

**Fix:** Add `abort()`, `pause()`, `resume()` forwarding methods on ForgeOrchestrator that delegate to `this.deps.executor`. In ForgeHandler, call `this.orchestrator.abort()` from `handleAbort`. Alternatively pass signal through execute chain.

**Risk:** If the executor is mid-insert (awaiting `this.deps.insertRecords`), abort won't interrupt the current batch -- it will take effect after the current batch completes, at the next `waitIfPaused()` call. This is acceptable behavior.

### BUG-02: Pause/Resume disconnected

**File:** `packages/extension/src/bridge/handlers/ForgeHandler.ts`
- Lines 378-381: `handlePause` sets `this.isPaused = true` only
- Lines 383-386: `handleResume` sets `this.isPaused = false` only
- Neither method touches ForgeExecutor

**Fix:** Same as BUG-01 -- add forwarding on ForgeOrchestrator. In `handlePause`, call `this.orchestrator.pause()`. In `handleResume`, call `this.orchestrator.resume()`.

**Risk:** None. ForgeExecutor's pause/resume is already battle-tested with Promise-based wait.

### BUG-03: dryRun flag ignored in SeedOpsHandler.handleExecute

**File:** `packages/extension/src/bridge/handlers/SeedOpsHandler.ts`
- Line 134: `payload` extracted as `{ orgId: string; template: Record<string, unknown> }` -- no `dryRun`
- The entire method (lines 132-265) performs real inserts with no dry-run branch

**File:** `packages/shared/src/types/messages.types.ts`
- Line 354: `payload: { templateId: string; orgId: string; dryRun: boolean }` -- contract says dryRun exists

**Fix:** Extract `dryRun` from payload. When true, skip `orchestrator.execute()`, return a result with zero inserts and a `dryRun: true` flag. Pattern reference: `SyncOrchestrator.dryRun()` at `packages/extension/src/modules/sync/SyncOrchestrator.ts:152`.

**Risk:** The payload shape mismatch (`template` vs `templateId`) suggests the handler and message type diverged. The planner needs to decide which shape is canonical. The handler currently receives the full template object, not just a templateId.

### BUG-04: Grappe hero still in SidePanel.tsx

**File:** `packages/webview/src/SidePanel.tsx`
- Lines 291-317: Full Grappe hero button block with Network icon, navigation to 'grappe', and i18n keys

**Fix:** Delete lines 291-317 (the entire `{/* Grappe Hero */}` block).

**Risk:** Check if `'grappe'` route is used elsewhere. If navigation to grappe is needed from other entry points, those are unaffected. The `Network` import may become unused after removal.

### BUG-05: LiveGraph onIncludeToggle not passed in ForgeExecution

**File:** `packages/webview/src/pages/Forge/ForgeExecution.tsx`
- Line 208: `<LiveGraph graph={graph as unknown as SharedForgeGraph} className="h-full" />` -- no `onIncludeToggle` prop

**File:** `packages/webview/src/pages/Forge/ForgeDiscovery.tsx`
- Line 149-152: `<LiveGraph graph={graph} onNodeClick={handleNodeClick} className="h-full" />` -- also missing `onIncludeToggle`

**File:** `packages/webview/src/pages/Forge/ForgeReview.tsx`
- Line 60: `<LiveGraph graph={graph} onIncludeToggle={toggleNodeIncluded} />` -- correctly passes it (only place)

**File:** `packages/webview/src/components/graph/LiveGraph.tsx`
- Line 56: `onIncludeToggle?: (objectName: string) => void` in `buildFlowNodes` -- passed to `ProgressNode` data
- Line 96: `onIncludeToggle` set on node data -- if undefined, ProgressNode checkboxes are presumably non-functional

**Fix:** Two options:
1. Pass `onIncludeToggle` in ForgeExecution (allows toggling during execution -- questionable UX)
2. Hide checkboxes when `onIncludeToggle` is not provided (ProgressNode should conditionally render)
The requirement says "passed or checkboxes hidden". During execution, toggling inclusion makes no sense (records are being inserted). Best approach: hide checkboxes in ProgressNode when no callback is provided.

**Risk:** Changing ProgressNode affects all graph views. Need to ensure ForgeReview (which passes the callback) still shows checkboxes.

### BUG-06: Static ID prefix map in GraphDiscoveryService

**File:** `packages/extension/src/modules/forge/GraphDiscoveryService.ts`
- Lines 292-303: `const ID_PREFIX_MAP` with only 10 entries
- Lines 309-312: `resolveObjectFromId()` uses this map, returns `'Unknown'` for anything not listed
- Line 267: `resolveRootObject()` calls `resolveObjectFromId()` for record-mode discovery

**Fix:** Replace `resolveObjectFromId` with a function that uses `describeGlobal` (via a new dep or a passed-in connection). `ForgeHandler.handleForgePreview` (lines 242-247) already shows the correct pattern: call `conn.describeGlobal()`, then `.find(s => s.keyPrefix === prefix)`.

**Risk:**
- Requires adding a `describeGlobal` dependency to `GraphDiscoveryDeps` or to `resolveRootObject` directly.
- This is an async operation. `resolveRootObject` is currently sync. The method must become async.
- `describeGlobal` is already called in the same flow by `ForgeHandler.handleForgePreview` for preview. For discover, it would be a second API call unless cached. Consider caching the result.
- The `SOQL` path (`parseObjectFromSOQL`) is unaffected.

### BUG-07: Raw URL sent to backend in ForgeInput.tsx

**File:** `packages/webview/src/pages/Forge/ForgeInput.tsx`
- Line 190: `recordId: inputMode === 'record' ? recordId.trim() : undefined`
- The `extractRecordId` function exists at lines 57-64 and is used for preview (line 161) but not here

**Fix:** Change line 190 to: `recordId: inputMode === 'record' ? (extractRecordId(recordId) ?? recordId.trim()) : undefined`
Or more safely: `recordId: inputMode === 'record' ? extractRecordId(recordId) ?? undefined : undefined`
The `canDiscover` guard at line 156 already checks `hasInput()` which checks `recordId.trim().length > 0`, but does NOT check that `extractRecordId` succeeds. May want to tighten `canDiscover` as well.

**Risk:** Minimal. The function is already used and tested in the same file.

### BUG-08: idRemaps === inserted in ForgeResults.tsx

**File:** `packages/webview/src/pages/Forge/ForgeResults.tsx`
- Line 53: `const idRemaps = useMemo(() => inserted, [inserted])` -- always equals total inserted count

**Fix:** Replace with `const idRemaps = result?.idRemapCount ?? 0`. The `result` variable is already accessed at line 34 and its type (`ForgeExecutionResult`) includes `idRemapCount` (set at ForgeOrchestrator.ts line 97).

**Risk:** None. Pure data wiring fix.

### BUG-09: Wrong i18n key in ForgeNodeDetail

**File:** `packages/webview/src/pages/Forge/ForgeNodeDetail.tsx`
- Line 78: `{node.fieldCount} {t('common.object')}` -- "object" makes no sense for a field count display

**Fix:** Change to `{t('forge.fields')}` or the appropriate i18n key for "fields". Check that the key exists in the locale files.

**Risk:** Minimal. Need to verify the key `forge.fields` exists in `en.json` (and other locales).

### CLN-01: Remove MetadataDiffBanner placeholder call

**File:** `packages/webview/src/pages/Forge/ForgeDiscovery.tsx`
- Line 142: `<MetadataDiffBanner diffs={[]} />` -- always passes empty array, comment says "placeholder, always hidden for now"

**Fix:** Remove line 142. Consider also removing the `MetadataDiffBanner` import (line 8) if it becomes unused. The component itself should remain (it will be wired in a future phase with real data).

**Risk:** None.

### CLN-02: Wire estimated graph stats from preview in ForgeInput.tsx

**File:** `packages/webview/src/pages/Forge/ForgeInput.tsx`
- Lines 530-553: Estimated graph stats section -- all four values show em-dash (`'\u2014'`) as placeholders

**Fix:** The preview response from `forge:preview` does not currently include graph estimates (it returns `objectApiName`, `objectLabel`, `recordId`, `fields`). Two options:
1. Compute rough estimates client-side from the preview data (e.g., one object, N fields known)
2. Enrich the `forge:preview:response` in the backend to include estimated counts (this is BE-02 from the requirements)
For Phase 01 (cleanup), the simplest fix: show what we know from the preview (1 object, field count from preview) and leave deeper estimates for the discovery phase. Replace em-dashes with available data when preview is loaded.

**Risk:** If BE-02 (preview enrichment) is in Phase 04, we may only be able to show partial data now. The planner should decide what level of wiring is appropriate for this cleanup phase.

### CLN-03: Deduplicate log filter bars

**File:** `packages/webview/src/pages/Forge/ForgeExecution.tsx`
- Lines 217-257: Inline filter bar with 3 buttons (all/errors/warnings) -- custom styles matching split-view

**File:** `packages/webview/src/components/ui/LogStream.tsx`
- Lines 102-119: Internal `FILTER_TABS` rendering its own filter bar inside the component

**Fix:** Add a `hideFilterBar?: boolean` prop to `LogStreamProps`. When `true`, skip rendering the internal filter section. In ForgeExecution, pass `hideFilterBar` since it provides its own external filter bar. Update LogStream tests if any assert on the filter bar.

**Risk:** Other LogStream consumers may rely on the internal filter. Search for LogStream usages to verify.

### CLN-04: Remove redundant canPreview in ForgeInput.tsx

**File:** `packages/webview/src/pages/Forge/ForgeInput.tsx`
- Line 157: `const canPreview = extractRecordId(recordId) !== null && sourceOrgId.length > 0 && !previewLoading`
- Lines 172-181: `useEffect` for auto-preview -- already checks `extractRecordId(recordId)` and `sourceOrgId` and `!previewLoading`

**Fix:** `canPreview` is used for the explicit Preview button (if one exists in the UI). If the Preview button is being removed or auto-preview is the only trigger, delete `canPreview`. Check the rest of the component template for any `canPreview` references. If the Preview button stays (for manual refresh), keep `canPreview` but do not duplicate the conditions.

**Risk:** Need to verify if `canPreview` is referenced anywhere in the JSX before removing.

### CLN-05: Convert logIdCounter from module-level to useRef

**File:** `packages/webview/src/pages/Forge/ForgeExecution.tsx`
- Lines 31-35: Module-level `let logIdCounter = 0` and `nextLogId()` function

**Fix:** Inside the component:
```
const logIdRef = useRef(0);
const nextLogId = useCallback(() => { logIdRef.current += 1; return `log-${logIdRef.current}`; }, []);
```
Update `addLog` callback (line 82-86) to use the new `nextLogId`.

**Risk:** The `addLog` callback at line 82 is already inside the component. The only change is that `nextLogId` becomes a ref-based closure instead of a module-level function. Ensure `addLog` captures the new `nextLogId` correctly (it should, since `nextLogId` reads from a ref).

### CLN-06: Clean stale plan/complianceReport on new config

**File:** `packages/webview/src/stores/useForgeStore.ts`
- Lines 138-140: `setConfig(config)` just does `set({ config })` -- does not clear stale plan, complianceReport, or graph

**Fix:** When `setConfig` is called (indicating a new forge run), also clear `plan`, `complianceReport`, `metadataDiffs`, `result`, and `graph`:
```
setConfig(config) { set({ config, plan: null, complianceReport: null, metadataDiffs: [], result: null, graph: null }); }
```
Or alternatively, only clear plan and complianceReport (they are review-phase artifacts from the previous config).

**Risk:** Clearing `graph` in `setConfig` would cause the discovery phase to start fresh (correct behavior). But if `setConfig` is called during other flows (e.g., config tweaks without re-discover), it could inadvertently wipe the graph. Check all `setConfig` call sites.

### BE-08: Delete deprecated ForgeOpsHandler.ts

**File:** `packages/extension/src/bridge/handlers/ForgeOpsHandler.ts`
- Already an empty deprecated stub (lines 1-10, just `export {}`)

**Files referencing ForgeOpsHandler:**
- `packages/extension/dist/` -- build artifacts only (4 files), will regenerate on next build
- No source-level imports remain (confirmed by grep)

**Fix:** Delete `packages/extension/src/bridge/handlers/ForgeOpsHandler.ts` and its test file if one exists.

**Risk:** None. The file is already an empty stub. Build artifacts will be cleaned on next build.

---

## Existing Patterns in This Codebase

- **AbortController + signal pattern:** Used correctly in `ForgeHandler.handleDiscover` (line 299-311). The signal is passed via `DiscoveryOptions` to `GraphDiscoveryService.discover`. The same pattern should be extended to the execute path.

- **ForgeExecutor pause/resume/abort:** Already fully implemented with Promise-based waiting (lines 90-124). The mechanism works -- it just needs to be called from above.

- **buildResponse + correlationId:** All handler responses use `buildResponse(this.deps, msg, ...)` which preserves the request correlationId. This is the locked-in pattern from v1.1.0 Phase 02.

- **DomainHandler interface:** All handlers implement `handle(msg: BaseMessage): Promise<boolean>`. ForgeHandler is directly registered (no wrapper needed since v1.1.0).

- **describeGlobal for prefix resolution:** Already implemented in `ForgeHandler.handleForgePreview` lines 242-247. Use `globalDesc.sobjects.find(s => s.keyPrefix === prefix)`.

- **extractRecordId utility:** Already exists in ForgeInput.tsx lines 57-64. Handles both plain IDs and Salesforce URLs with regex.

- **Zustand store reset pattern:** `INITIAL_STATE` object at lines 68-79 of useForgeStore.ts. The `reset()` method (line 242-244) spreads `INITIAL_STATE` plus clears templates/history. `setConfig` should follow a similar partial-reset pattern.

- **LogStream external filtering:** `LogStream` accepts `filter?: LogFilter` prop and `entries: LogEntry[]`. The filtering is already done internally via `useMemo` in LogStream. ForgeExecution also filters on its side, creating a double-filter situation.

---

## Recommended Approach

Split into 3 plans as ROADMAP.md suggests:

1. **bugs-critical** (BUG-01, BUG-02, BUG-03, BUG-06): These are backend/execution bugs that prevent core forge functionality from working correctly. BUG-01 and BUG-02 are tightly coupled (both need ForgeOrchestrator to expose executor control methods). BUG-06 requires a dep signature change on GraphDiscoveryService. BUG-03 is an isolated handler fix.

2. **bugs-medium** (BUG-04, BUG-05, BUG-07, BUG-08, BUG-09): These are UI/webview bugs. All are surgical fixes in specific components with no cross-dependencies. Each is a 1-5 line change.

3. **cleanup** (CLN-01 through CLN-06, BE-08): Dead code removal and store hygiene. CLN-03 requires adding a prop to LogStream. CLN-06 requires deciding which fields to reset in setConfig. BE-08 is a file deletion.

BUG-01 and BUG-02 should be done together since they share the same wiring gap (ForgeHandler -> ForgeOrchestrator -> ForgeExecutor). BUG-06 is the riskiest item due to the async signature change and API call addition.
