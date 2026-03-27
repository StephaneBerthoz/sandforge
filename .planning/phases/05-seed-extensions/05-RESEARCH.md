# Phase 05: Seed Extensions (CSV + Clone) -- Research

**Researched:** 2026-03-27
**Phase goal:** Add CSV upload and org-to-org clone as two new seed modes alongside the existing AI-generated seed wizard.

## Don't Hand-Roll

| Problem | Recommended solution | Why |
|---------|---------------------|-----|
| CSV parsing in WebView | `papaparse` v5 (already installed in webview + `@types/papaparse`) | Handles encoding, quoted fields, streaming large files, header detection, type inference. The hand-rolled `CsvConnector` in sync module is fine for small backend use but lacks encoding detection, BOM handling, and progress callbacks needed for UI file uploads. |
| Topological sort for clone insert order | Reuse `ReferenceLinker.resolveInsertOrder()` from seed module | Already handles DAG with cycle detection. Clone needs the same parent-before-child ordering. However, Clone uses `AutopilotEdge[]` for relationship metadata, not `SeedObjectConfig.fieldRules` -- will need an adapter or a new topo-sort that works with edges. |
| ID remapping (source org -> target org) | Reuse `RecordIdRemapper` from autopilot module | Already handles register + remap + self-referential lookups. Clone is the exact same use case as Autopilot's org-to-org transfer. |
| Bulk insert execution | Reuse `BulkApiExecutor` + `BulkApiManager` from core/engine | Already wired in `SeedOpsHandler.handleExecute()` with retry, progress tracking, and Bulk API 2.0 threshold logic. Clone and CSV execution should reuse the same `insertFn` factory pattern. |
| File reading in WebView (VSCode context) | Use `<input type="file">` with `FileReader` API | WebView runs in an iframe -- standard browser file APIs work. Do NOT use `vscode.workspace.openTextDocument` from WebView side; file selection must happen in-browser. For drag-and-drop, use standard HTML5 drag events (`onDragOver`, `onDrop`) on a drop zone div. |

## Common Pitfalls

### Pitfall 1: CSV type coercion destroys Salesforce IDs
**What goes wrong:** Papaparse's `dynamicTyping: true` converts Salesforce 15/18-char IDs that start with digits (e.g., `001...`) into numbers, truncating them.
**Why:** JS `Number("001xx...")` returns NaN but papaparse may still attempt type conversion on shorter numeric-looking values. External IDs like `EXT-001` are safe, but pure numeric external IDs get mangled.
**How to avoid:** Use `dynamicTyping: false` for the initial parse (keep everything as strings). Apply type conversion AFTER column mapping, using the Salesforce field metadata (type from `describe`) to determine the correct conversion. Only convert columns mapped to Number/Currency/Percent fields.

### Pitfall 2: CSV encoding and BOM
**What goes wrong:** Files exported from Excel on Windows have UTF-8 BOM (`\xEF\xBB\xBF`) prepended. If not stripped, the first header column name becomes `\uFEFFName` instead of `Name`, breaking auto-mapping.
**Why:** `FileReader.readAsText()` preserves BOM bytes.
**How to avoid:** Strip BOM before parsing: `text.replace(/^\uFEFF/, '')`. Papaparse does NOT strip BOM by default -- you must do it yourself or set `skipEmptyLines: true` (which does not fix the BOM issue).

### Pitfall 3: Clone needs TWO simultaneous org connections
**What goes wrong:** The current seed flow works with a single target org. Clone requires querying a SOURCE org and inserting into a TARGET org -- two different jsforce connections.
**Why:** `getJsforceConnection(orgId, ...)` gets a connection for one org. Clone handlers need to call it twice with different orgIds.
**How to avoid:** The `getJsforceConnection` helper already supports any orgId via `OrgRegistry` + `ConnectionPool`. The Clone handler just needs to call it twice: once for `sourceOrgId`, once for `targetOrgId`. No new connection infrastructure needed. The `ConnectionPool` already caches by UUID.

### Pitfall 4: Clone pagination -- queryMore vs offset
**What goes wrong:** Using `OFFSET` in SOQL is limited to 2000 and degrades performance on large sets.
**Why:** Salesforce SOQL `OFFSET` has a hard 2000 limit. For larger datasets, you must use `queryMore()` (cursor-based pagination).
**How to avoid:** Use `conn.query(soql)` which returns a `QueryResult` with `done`, `nextRecordsUrl`, and `records`. When `done === false`, call `conn.queryMore(nextRecordsUrl)` to get the next batch. jsforce v2 supports this natively. Do NOT use `LIMIT/OFFSET` patterns -- use cursor-based queryMore.

### Pitfall 5: Self-referential lookups in Clone (e.g., Account.ParentId)
**What goes wrong:** If Account references itself via `ParentId`, you can't remap parent IDs before the parent accounts are inserted in the target org -- but they're in the same object batch.
**Why:** Topo sort puts Account before its children, but Account's self-reference creates a cycle within a single object.
**How to avoid:** Two-pass insert: (1) insert all records with self-referential lookups set to NULL, (2) after all records are inserted and ID mappings registered, UPDATE the self-referential fields. `RecordIdRemapper` already handles the remap step; the Clone handler needs to detect self-referential edges and do the two-pass logic. The `AutopilotEdge` type already has `from === to` detection possible.

### Pitfall 6: Column auto-mapping false positives
**What goes wrong:** Auto-matching CSV column `Name` to Salesforce field `Name` works, but `Id` column should NOT map to the `Id` field (which is not createable). Similarly, `CreatedDate`, `LastModifiedDate` etc. are non-createable.
**Why:** Naive name matching ignores field `createable` attribute.
**How to avoid:** The `seed:describe-object` handler already filters `f.createable === true`. The auto-mapper must only match against createable fields. Also apply case-insensitive + underscore-tolerant matching (e.g., `Account_Name` -> `Account_Name__c` or `AccountName` -> `Account_Name__c`).

### Pitfall 7: Large CSV files blocking the UI
**What goes wrong:** Loading a 50MB CSV with `FileReader.readAsText()` blocks the main thread, freezing the WebView.
**Why:** FileReader is synchronous once the `onload` fires; papaparse processes the entire string in one shot.
**How to avoid:** Use papaparse's streaming mode: `Papa.parse(file, { step: ..., complete: ... })` which reads the File object directly (no need for FileReader). For preview, use `preview: 10` option to stop after 10 rows. For full parse, use `worker: true` to run in a Web Worker (papaparse supports this natively).

### Pitfall 8: WebView message size limits for clone data
**What goes wrong:** Sending 2000+ records per batch through `postMessage` between WebView and extension can hit serialization limits or cause lag.
**Why:** The clone pipeline (query source -> remap -> insert target) should run entirely in the EXTENSION, not the WebView. Only progress events and results should flow to WebView.
**How to avoid:** The Clone orchestration must happen in the extension backend (SeedOpsHandler or a new CloneOpsHandler). The WebView only sends the clone configuration (source org, target org, objects, filters) and receives progress updates. Same pattern as `seed:execute`.

## Existing Patterns in This Codebase

- **SeedOpsHandler (`packages/extension/src/bridge/handlers/SeedOpsHandler.ts`):** The definitive pattern for how seed-domain messages flow from WebView to extension. Handles `seed:execute`, `seed:describe-global`, `seed:describe-object`, template CRUD. CSV and Clone handlers should follow the same `DomainHandler` interface and message routing pattern. Key insight: the `insertFn` factory pattern (lines 303-350) that switches between Bulk API and REST based on record count should be extracted and reused.

- **SeedOrchestrator (`packages/extension/src/modules/seed/SeedOrchestrator.ts`):** Takes a `SeedTemplate` + `orgId`, validates, builds plan, generates data, inserts in dependency order. CSV execution should convert mapped CSV rows into the same pipeline. Clone needs its own orchestrator (different flow: query -> remap -> insert, no data generation).

- **RecordIdRemapper (`packages/extension/src/modules/autopilot/RecordIdRemapper.ts`):** Maps `objectApiName -> Map<sourceId, targetId>`. Methods: `registerMappings()`, `remapRecords(records, edges, objectApiName)`, `getTargetId()`. Requires `AutopilotEdge[]` for the edge graph. Clone can use this directly.

- **AutopilotExecutor (`packages/extension/src/modules/autopilot/AutopilotExecutor.ts`):** The closest existing pattern to Clone. Executes wave-by-wave with query -> anonymize -> remap -> insert -> register mappings. Clone is essentially AutopilotExecutor minus the anonymization step. Key types: `QueryFn`, `InsertFn` (note: InsertFn returns `sourceIds[]` alongside `successIds[]` for mapping registration).

- **ReferenceLinker.resolveInsertOrder (`packages/extension/src/modules/seed/ReferenceLinker.ts`):** Topo sort for `SeedObjectConfig[]` based on `fieldRules[].config.referenceObject`. Clone needs similar topo sort but based on `AutopilotEdge[]` (from/to relationships). Consider adding a generic topo sort utility or creating `CloneReferenceLinker`.

- **getJsforceConnection (`packages/extension/src/core/connection/ConnectionHelper.ts`):** Creates/caches jsforce connections with token refresh, circuit breaker, connection pool. Accepts any `orgId` -- Clone just needs to call it for both source and target org.

- **BulkApiExecutor (`packages/extension/src/core/engine/BulkApiExecutor.ts`):** Handles Bulk API 2.0 job lifecycle. Returns `BulkExecutionResult` with `successIds[]`. Used in SeedOpsHandler's insertFn.

- **SeedPage (`packages/webview/src/pages/Seed/SeedPage.tsx`):** Currently has two modes: Template Gallery (QuickSeed) and full Wizard (4 steps). CSV and Clone should be added as additional entry points. The page already has a `Divider` between gallery and wizard -- CSV/Clone could be tab-based or card-based mode selection.

- **CsvConnector (`packages/extension/src/modules/sync/CsvConnector.ts`):** Backend-only CSV parser (hand-rolled, no streaming). Used in sync module. For CSV-01..04, the PARSING should happen in WebView (using papaparse) since that's where the file picker lives. The extension only needs the mapped records for insertion. CsvConnector is NOT the right tool for the UI side.

- **Existing UI components:** `Select`, `Input`, `Button`, `Badge`, `Card`, `Accordion`, `DataTable`, `Wizard`, `Skeleton`, `EmptyState`, `ErrorBanner`, `PageHeader`, `OrgBadge`, `Pagination`, `VirtualList`. No existing file upload or drag-and-drop component -- this needs to be created.

- **useSeedWizardState hook (`packages/webview/src/pages/Seed/useSeedWizardState.ts`):** Composable state management using sub-hooks (`useSeedOrgSelection`, `useSeedObjectSelection`, `useSeedFieldConfig`, etc.). CSV and Clone modes should follow the same pattern: separate state hooks composed into a main hook.

- **Message type registry (`packages/shared/src/types/messages.types.ts`):** All WebView-extension messages are typed here. New types needed: `seed:csv:execute`, `seed:clone:execute`, `seed:clone:query-preview`, etc.

- **HandlerTypes (`packages/extension/src/bridge/handlers/HandlerTypes.ts`):** `DomainHandler` interface, `buildResponse`, `sendOperationStarted/Progress/Completed/Failed` helpers. Clone and CSV handlers must follow this pattern.

## Recommended Approach

Split this phase into two independent tracks: **CSV (WebView-heavy)** and **Clone (extension-heavy)**.

For CSV: build a `FileDropZone` component with drag-and-drop + file picker, use papaparse with `worker: true` for parsing, create a `ColumnMapper` component that auto-matches by name against `describe` results (createable fields only), validate using field metadata (type, length, required, picklist values), then send mapped rows to extension via a new `seed:csv:execute` message that reuses the existing `insertFn` factory from SeedOpsHandler.

For Clone: model it closely on `AutopilotExecutor` (query -> remap -> insert loop), reuse `RecordIdRemapper` directly, create a `CloneOrchestrator` that handles two-org connections and wave-by-wave execution with self-referential two-pass logic, and expose it through a new `CloneOpsHandler` (or extend SeedOpsHandler). The WebView side needs a source-org picker (reuse existing `Select` + org list), object selector (reuse `Step2_SelectObjects`), and optional SOQL WHERE filter input.

Both tracks converge on the SeedPage where mode selection (AI Generate / CSV Upload / Clone from Org) should be the first user decision, before entering the respective wizard flow.
