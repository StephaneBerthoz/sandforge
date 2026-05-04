# Changelog

All notable changes to SandForge will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — Phase 03 Monitor v2 Core (2026-05-04)

**Architecture**: Probe → MonitorRegistry (single-tick) → MetricBus
(typed Zod-validated pub/sub) → TimeSeriesStore + AnomalyEngine +
DriftDetector + ReportExporter + FleetSummaryService.

- **MetricBus** (`@sandforge/shared/monitor` + `extension/modules/monitor/MetricBus`):
  in-process typed event bus with 5 discriminated event subtypes
  (`monitor:metric`, `monitor:metrics:batch`, `monitor:drift:detected`,
  `monitor:anomaly:detected`, `monitor:fleet:summary`); auto-validates
  every emit through Zod and routes to the bridge for webview consumers.
- **TimeSeriesStore** (`extension/modules/monitor/TimeSeriesStore`):
  per-(orgId, seriesId) ring-buffered MetricSample store with 50 MB LRU
  cap, 7-day retention, opt-in disk persistence
  (`sandforge.monitor.persistTimeSeries` setting), 5-min flush + 15-min
  per-org rate limit, corruption recovery (P-03.10) that drops + breadcrumbs
  without throwing. 50K-sample × 5-org × 20-series vertical slice in 115 ms.
- **MonitorRegistry + 8 Probes**: single-tick scheduler with per-probe
  in-flight gate, drift-safe scheduling, hard timeout, visibility
  gating. All 8 trackers (Limits, Job, ApexLog, SandboxRefresh,
  ErrorLog, UserSession, Health, Governance) wrapped as thin probes.
  `DescribeCache` (per-org TTL + LRU) closes audit Perf #1.
- **DriftDetector v2**: field-level + permission-level deltas, canonical
  sort, debounced emission. New `DriftFeed` virtualized React component
  with filter chips. 60 tests + 1 Playwright spec (3 E2E scenarios,
  28 s wall-time).
- **AnomalyEngine**: pure-function rolling 24h std-dev detector with
  30-sample / 6-h warmup gate. Bridges anomalies into the existing
  AlertEngine as synthetic AlertInstances (no new AlertDefinitions).
- **ReportExporter** (CSV + lazy-pdfkit PDF): `await import('pdfkit')`
  keeps cold start light, sparklines via LTTB downsampling
  (Steinarsson 2013), 50-series-per-PDF cap with multi-part split.
  Stream-pipe to disk so a 5K-sample × 50-series report doesn't buffer
  in memory. 1000-sample × 5-series vertical slice exports both
  formats < 10 MB with valid magic bytes.
- **FleetSummaryService + MonitorOverviewPage**: multi-org fleet
  default landing — backend uses `ConnectionPool` reuse + `p-limit(3)` +
  60-s per-org cache + exponential backoff (60→120→240→600 s).
  Webview Zustand `useFleetStore` keyed as `Record<orgId, summary>`
  (audit M5 fix — Map ban). `useVisibilityGate` posts `monitor:visibility`
  on `document.visibilitychange` so the extension pauses polling when
  the panel is hidden (audit M1).

**Test impact**: 8412 → 8745, +333 tests, 0 regressions.

**Audit findings closed**: Perf #1, M1, M5, H7, P-03.1, P-03.2, P-03.4,
P-03.5, P-03.6, P-03.7, P-03.10.

**Deferred to Phase 06 BP-01**:
- ReportExporter bridge wire — needs `MonitorOrchestrator` singleton in
  `services.ts` so handlers see the same `timeSeriesStore` instance
  across calls.
- FleetSummaryService bridge wire — same dependency.
- Stryker mutation testing — `stryker.conf.json` pins `vitest.dir =
  packages/shared/`, extension-side mutants are never exercised
  (Phase 06 BP-04).

**Deferred to v1.4 polish**:
- Playwright E2E for `MonitorOverviewPage` (component + 6 unit tests
  already cover the paths; the data-testid contract matches the future
  spec's expectations).

### Fixed (post-Phase-03 hygiene)

- **`ReportExporter.writePdfPart` stream listeners** — replaced
  `stream.on('finish', …)` + `stream.on('error', …)` with `stream.once(…)`
  so the audit-disposables script accepts them as one-shot sinks
  (was 2 orphans, now 0). pdfkit's stream is one-shot per part anyway,
  so the semantic is unchanged; this is the right primitive.

### Security (autonomous-improvement Round 1 — 2026-05-02)

- **UUID hardening sweep across 11 modules**: extends the audit C3/L1 fix
  beyond the 3 originally-touched files. Replaces the hand-rolled
  `'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, …Math.random…)`
  pattern (and the segments-loop variant) with `globalThis.crypto.randomUUID()`
  in `PipelineVersioning`, `PipelineOrchestrator`, `PipelineMarketplace`,
  `PipelineBuilder`, `ApprovalGate`, `core/grappe/GrappePartitioner`,
  `migration/UniversalImporter`, `migration/SfdmuImporter`,
  `migration/GearsetImporter`, `core/telemetry/TelemetryService.generateBatchId`,
  and `core/audit/AuditTrailService.generateId`. Removes birthday-paradox
  collision risk on long-running pipelines / approval flows / partition
  graphs / import batches.
- **`packages/shared/src/utils/string-utils.generateId`** uses the first 8
  hex chars of `crypto.randomUUID()` instead of `Math.random().toString(36)`.
  Public format `{base36-ts}-{8hex}` preserved.
- **`MessageBroker.nextControlId`** drops the unreachable Math.random
  fallback. Engines block already pins `node>=20` and the VS Code webview
  exposes `globalThis.crypto.randomUUID` — the runtime feature-detect was
  dead code.

### Fixed (test regressions surfaced post-audit)

- **`extension.test.ts`** mock context now exposes
  `extension.packageJSON = { version: '1.2.5' }`. The audit Sprint 1 C4
  fix added a `context.extension.packageJSON.version` read in `activate()`
  but did not update the test mock, leaving 6 `extension.test.ts` cases
  failing with `TypeError: Cannot read properties of undefined`.
- **`providers/WebviewPanelManager.test.ts`** nonce regex broadened from
  `[A-Za-z0-9]{32}` to `[A-Za-z0-9_-]{32}`. The audit C3 fix moved nonces
  to base64url which uses `-` and `_`, but the test assertion was not
  updated.
- **`pages/Monitor/MonitorPage.test.tsx`**: 2 NARROW NO-BREAK SPACE
  (U+202F) characters at lines 342, 343 inside a regex character class
  were tripping eslint `no-irregular-whitespace`. Replaced with U+0020.

### Fixed (resource hygiene)

- **`SalesforceAdapter.sleep` AbortSignal listener leak**: the abort
  callback was registered with `{ once: true }` so it self-removed on
  abort, but stayed bound to the signal forever on the resolve path.
  Long-lived shared signals (e.g. one per pipeline run) accumulated one
  bound listener per `sleep()` call. Now removes the listener explicitly
  from inside the timer callback before resolving. Surfaced by
  `pnpm audit:disposables`.

### Performance

- **`QuickSyncObjectStep`**: the `suggestions` array fallback
  `suggestionsQuery.data ?? []` was creating a fresh `[]` reference on
  every render, propagating into the downstream `availableForSearch`
  `useMemo` and re-running it each render. Wrapped in `useMemo` so the
  fallback is stable. Closes one of the 7 `react-hooks/exhaustive-deps`
  warnings flagged by `pnpm -r lint`.

### Security (devDep CVE chain — Round 2)

- **`pnpm.overrides`**: forces `picomatch ≥ 4.0.4` (closes ReDoS
  GHSA-c2c7-rcm5-vvqj, transitive via `knip` → `fast-glob` →
  `micromatch` → `picomatch`) and `lodash ≥ 4.18.0` (closes code
  injection GHSA-r5fr-rjxr-66jc, transitive via `@vscode/vsce` →
  `@secretlint`). Both are devDep-only — they don't ship in the
  marketplace VSIX — but `pnpm audit --audit-level high` flagged them
  on every CI run. Resolves 6 of 17 high-severity findings (34 → 28
  total).

### CI / Tooling

- **`scripts/audit-disposables.ts`** now `process.exit(1)` when
  orphans > 0 and is wired into `pnpm validate`. CI (`.github/workflows/ci.yml`
  runs `pnpm validate`) will now fail PRs that introduce a listener /
  timer leak without a disposable sink.
- **`test/FIXTURES-README.md`** removed (Phase 2 planning artifact —
  described `test/helpers/sf-mock.ts` and other paths that never got
  created; actual mocks live colocated with their consumers).

### Chore

- **Workspace versions synced to 1.2.5**: root `package.json` was at 1.2.4
  while the marketplace artifact (`packages/extension/package.json`) was
  at 1.2.5. `packages/shared` and `packages/webview` also bumped for
  consistency.
- **`packages/webview` drops unused `zod` dependency** (knip + grep
  confirm zero `from 'zod'` imports webview-side; schema validation
  happens extension-side via the bridge).
- **`.gitignore`** now excludes `.omc/` (transient session state from the
  oh-my-claudecode tooling, was generating untracked-file noise at every
  status check) and `*.bak` / `*.bak.*` (prevents recurrence of the
  stale `CLAUDE.md.bak.<unix-ts>` files the cross-cutting audit had to
  remove manually).
- **`AUDIT.md`** prepended a deprecation banner — the v2.0.0 / 4 600-test
  numbers in the body are from 2026-02-26 and predate the public v1.2.5
  baseline. New audits live in `.planning/audit-YYYY-MM-DD-*.md`.
- **`SECURITY.md`** (new): responsible disclosure flow for the
  marketplace extension, in-scope/out-of-scope surfaces, SLA expectations.
- **`scripts/audit-disposables.ts`**: `stored` heuristic regex now
  recognizes the `Map.set(key, [dispA, dispB])` sink pattern. Closes a
  false positive on `WebviewPanelManager.openPanel` (disposables ARE
  tracked via `panelSubscriptions` and disposed in `onDidDispose`).
  Audit now reports 0 orphans.

### Security (post-audit hardening — 2026-05-02)

- **CSP nonce now uses `crypto.randomBytes(24).toString('base64url')`** instead of
  `Math.random()` in `WebviewPanelManager` and `SidebarViewProvider`. The previous
  PRNG was predictable enough that an adversary deriving the seed could bypass CSP.
- **Bridge control IDs use `crypto.randomUUID()`** in `MessageBroker.nextControlId`
  to eliminate birthday-paradox collisions at ~4 K IDs that the prior 6-hex-char
  Math.random scheme allowed under load.
- **`CloneRecordFetcher` now validates the SOQL identifier and WHERE clause** in
  every interpolation site (`buildSoql`, `countRecords`, `fetchSample`). The new
  `assertSafeWhereClause` mirrors the Forge schema defense (rejects `--`, `/*`,
  `*/`, trailing `;`, length cap 512). Closes a SOQL injection vector that the
  Clone wizard / CLI bypassed because validation only existed on the Forge side.
- **`sandforge-clone --remap-csv` now resolves the path against `cwd` and refuses
  anything that escapes**, plus enforces a `.csv` extension and refuses to
  overwrite an existing file. Closes a path-traversal that allowed arbitrary
  file write (e.g. `..\..\Users\victim\.ssh\authorized_keys`) when the CLI was
  invoked from CI with attacker-controlled args.

### Fixed (post-audit hardening)

- **`MonitorPage.test.tsx` API Calls KPI test** narrowed `getByText(/12/)` →
  `/12[,\s ]?450/` (and `/15/` → `/\/\s?15[,\s ]?000/`) so the assertion
  matches the formatted KPI value uniquely instead of any rendered "12" /
  "15" substring (was matching multiple elements and flaking the suite).
- **`extension.ts` `currentVersion`** now reads from
  `context.extension.packageJSON.version` instead of being hardcoded to
  `'1.0.0'`. The What's New onboarding modal will fire correctly across
  version bumps; previously every user was permanently marked "v1.0.0 seen".
- **`SyncExecutionLogger` and `PipelineVersioning`** use `structuredClone(...)`
  instead of `JSON.parse(JSON.stringify(...))`. Preserves `Date` / `Map` /
  `undefined` properly in config snapshots.
- **`useCDCMetricsStore` listener registration** is now HMR-safe (idempotent
  registration + Vite hot-dispose). Previously a hot reload stacked N copies
  of the listener, duplicating every metric N times.
- **`useForgeStore.addLog` caps the log buffer at 500 entries**. Long Forge
  runs no longer cause O(N²) memory churn from unbounded array spread.

### Chore (post-audit cleanup)

- Removed two stale `CLAUDE.md.bak.*` files at the repo root (untracked
  noise from a prior `/save-memory` operation).
- Removed `phases/phase-00-bootstrap.md` at repo root (duplicate of the
  canonical `docs/phases/phase-00-bootstrap.md`).
- Lint sweep: `TelemetryAdapter` Sentry require eslint-disable widened to
  cover both `no-require-imports` and `no-var-requires`; `ForgeExecutor`
  `let remapped` → `const remapped`; intentional diagnostic `console.*`
  calls in `ForgeExecutor` + `GraphDiscoveryService` carry inline
  `eslint-disable-next-line no-console` (matches existing rationale comments).

### Added (Forge module — Wave 2 mini: orphan FK handling + RecordType mapping)

- **`ExecuteOptions.referenceFallback: 'nullify' | 'keep'`** — controls what
  happens when a reference field on a cloned record points to a record that
  was never cloned (User, Owner, an excluded parent, …). Defaults to
  `'nullify'` in scoped mode (so the insert is accepted with the FK left
  empty), `'keep'` outside scoped mode for legacy back-compat.
- **`ExecuteOptions.recordTypeMappings`** — accepts a list of
  `RecordTypeMapping` (built from the existing Sync `RecordTypeMapper`
  matched by `DeveloperName`) and applies it to every cloned record's
  `RecordTypeId` before insert. Records whose RecordTypeId has no mapping
  keep the source value (Salesforce will reject if not shared). The recipe
  pre-loads RecordTypes from both orgs and surfaces the mapping count in
  Phase B (e.g. `268 RecordType mapping(s) resolved` for MUT-UAT2 ↔ MUT-SBER).
- **`ExecuteOptions.maxRecordsPerObject`** — optional per-object hard cap
  appended as `LIMIT N` to every scoped query. Keeps dev-sized clones
  bounded even when a node's natural scope pulls thousands of rows
  (typically `InsurancePolicyCoverage` / activity history on Mutuaide).
  Default: no cap.

### Added (Forge module — Wave 2 v3: 2-pass cycle FK update)

The previous waves nullified orphan FKs at insert time so cycle members
(`Account ↔ Contact`, `Asset → Account` when Account hasn't been cloned
yet, …) wouldn't trip `INVALID_CROSS_REFERENCE_KEY`. That left the
records correctly inserted but disconnected. Wave 2 v3 closes the
loop with a second pass.

- **`ExecutorDeps.updateRecords`** — optional dep mirroring `insertRecords`
  but for bulk UPDATE. Production wiring uses `conn.sobject(name).update(...)`.
- **`nullifyOrphanedFks` returns the list of nullified FKs** (field name
  + source-side ID + target object set) so the executor can replay them
  in pass 2.
- **`pendingFkUpdates` queue** — per insert success, every nullified FK
  is queued with its target-org record ID. After the main loop completes,
  the executor groups updates by `(objectApiName, newId)`, looks up each
  source ref in the IdRemapper, and dispatches one batched UPDATE per
  object via `deps.updateRecords`.
- **Pass-2 errors are surfaced via `ExecutionObjectError` with
  `objectApiName: '__pass2__'`** so the wizard panel groups them
  separately from regular insert failures. Unresolved FKs (parent never
  cloned at all) are reported with a clear "could not be resolved"
  message instead of silently disappearing.
- **3 new ForgeExecutor tests** cover the round-trip (Account ↔ Contact
  cycle), the no-op case (no nullified FKs), and the unresolved-FK error
  reporting.

### Added (Forge module — Cross-org picklist value strip)

- **`FieldInfo.picklistValues`** — for picklist / multipicklist fields the
  describe wiring now collects the *active* set of values on the target
  org. The cleaned-record step drops any source-side value that doesn't
  appear in the target's whitelist before insert, replacing the runtime
  `INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST` rejection seen on Mutuaide
  Case clones (`UncertainContract`, `Contrat non certain`, etc.) with a
  silent strip. Empty / missing whitelist = no validation, so non-restricted
  picklists are unaffected.

### Added (Forge module — Wave 2.6 hardening from second real-org run)

Second Wave 3 run on a fresh Case (D00002635) revealed four more error
classes; this commit fixes them all.

- **`ReferenceDataMapper`** (new file) — instead of cloning canonical
  reference-data tables (BusinessHours, OperatingHours, ServiceOffer__c,
  ServiceTerritory…) the executor now resolves source IDs to existing
  target IDs via `WHERE Name IN (…)` (or `DeveloperName` when more
  appropriate) and feeds the result into the `IdRemapper`. Avoids the
  `FIELD_INTEGRITY_EXCEPTION: Name is already in use` rejection seen on
  the first real-org run, and stops duplicating singletons. Wired into
  `ExecuteOptions.referenceDataObjects` (default
  `['BusinessHours', 'OperatingHours']`).
- **`ExecutorDeps.isObjectCreatable`** — optional pre-flight check the
  executor consults before describing/querying a node. When the target
  org refuses inserts on the entity (read-only system tables like
  `CaseHistory`/`CaseHistory2`, audit logs, etc.), the node is skipped
  with a clean `stage: 'scope'` error report. Default in production wiring
  treats `meta.createable !== false` as creatable to avoid false-skips
  when jsforce omits the flag.
- **Strip Person Account `__pc` and `Name` fields when not a Person
  Account** — `__pc`-suffixed fields and the auto-computed `Name` are
  rejected on Business Account inserts (or vice-versa). The cleaned-record
  step now omits them when `IsPersonAccount !== true`.
- **`FieldInfo.nillable`** — added to the executor field metadata so that
  required-FK satisfiability can be reasoned about.
- **`ExecutionObjectError.stage = 'scope'`** is now also used for
  read-only entity skips and for `ReferenceDataMapper` "unmatched" rows
  (target row not found by Name).

#### Validation runs on Mutuaide UAT2 → MUT-SBER

Two consecutive Wave-3 runs proved the fixes work end-to-end:

| Object | Wave 3 v2 | Wave 3 post-fixes |
|---|---|---|
| Case | ✓ inserted | DUPLICATE_VALUE on existing v2 record (expected) |
| Contact | ✓ 50/50 | ✓ 1/1 (Person Account `Name` strip works) |
| Account | ✗ 0/3 (`__pc`/`Name` errors) | ✓ 1/3 (Business Account succeeds; Person Account `Name` errors gone — remaining 2 fail on locale-restricted picklists, a Mutuaide-specific schema constraint) |
| BusinessHours | ✗ FIELD_INTEGRITY (duplicate) | ✓ Mapped via reference-data lookup (1 resolved) |
| CaseHistory2 | ✗ entity not insertable | Skipped via `isObjectCreatable` |
| InsurancePolicy | n/a | REQUIRED_FIELD_MISSING surfaced as structured error (NameInsuredId required) — Wave 2 sampling-cap+orphan-record-skip will harden this next |

Tests: 205/205 forge across 14 files (8 new `ReferenceDataMapper` tests +
3 new `RecordType-mapping` tests + 4 new orphan-FK tests). No regressions.

### Added (Forge module — Wave 3 fixes from real-org learnings)

- **Schema-drift defence** — the executor now also `describeFields` on the
  *target* org and intersects with the source createable set before
  building the insert payload. Previously a custom field present on UAT2
  but missing on SBER (e.g. `TriggeringEvent2__c`) would surface as
  `INVALID_FIELD: No such column …` and fail the entire object's batch.
- **Omit nullified FKs** — orphaned reference fields (no remap entry,
  e.g. `OwnerId` pointing at a User that was never cloned) are now
  *omitted* from the payload instead of being sent as explicit `null`.
  Salesforce was rejecting `OwnerId: null` with
  `INVALID_CROSS_REFERENCE_KEY: Owner ID: owner cannot be blank`; omitting
  the key lets the platform auto-assign the running user.
- **`ExecutionSummary.errors`** + **`ForgeExecutionResult.errors`** —
  per-object error reports `{ stage, failedCount, attemptedCount, samples }`
  surfaced from the executor up through the orchestrator and exposed in
  the `forge:execute:response` payload so the wizard can render an error
  panel grouped by object/stage.

#### Wave 3 first real-org run on Mutuaide UAT2 → MUT-SBER (Case 500AP00000fXeQsYAK)

- 1st attempt: 0/52 ✓ — 3 systemic bugs found (above two + ref data).
- 2nd attempt after fixes: **52/58 ✓ inserted on SBER** — Case (1/1),
  Contact (50/50), GlobalContext__c (1/1). 6 remaining failures fall into
  3 known categories that map to upcoming Wave 2 hardening: Reference
  data (BusinessHours already exists → needs ReferenceDataMapper), FLS
  schema drift on Person Account `__pc` fields, and read-only system
  objects (`CaseHistory2`).

### Added (Forge module — record-scoped clone, Wave 1 POC)

- **`RecordScopeCache`** — per-execution cache (`Map<objectApiName, Set<recordId>>`) that records IDs collected from each wave so downstream nodes can scope their queries to the transitive closure of the root record.
- **`ScopedSoqlBuilder`** — emits SOQL with `WHERE Id = '<rootId>'` for the root, `WHERE Id IN (...)` for objects already cached (including parent FK values seeded from earlier records), `WHERE FK IN (...)` for children of cached parents, or a zero-result query when no scoping path exists. Excluded targets (User, RecordType, ChangeEvent…) are filtered out so they never participate in scope SOQL.
- **`ForgeExecutor` scoped + dry-run modes** — new `ExecuteOptions { rootRecordId, rootObjectApiName, dryRun }` parameter. When `rootRecordId` is set the executor switches to scoped mode: seeds the cache with the root, brings the root to the front of the topo order (so cycle waves don't starve the cache), uses `ScopedSoqlBuilder` per node, and propagates FK values from each query into the cache for multi-hop downstream scoping. `dryRun: true` runs every query but skips inserts — used by the recipe to preview cloning before any write.
- **`FieldInfo.referenceTo`** — optional field on the executor describe contract so scope reasoning knows which parent each lookup points at (polymorphic-aware).
- **`tools/recipe-forge-grappe.ts` Phase B** — read-only scoped dry-run report. Replaying the production executor against MUT-UAT2 → MUT-SBER for Case `500AP00000fXeQsYAK`: **261 858 records → 358** (−99.86%), 19 scoped queries, 0 write, 2 out-of-scope nodes correctly skipped.
- **`.planning/improvements/forge-record-scoped/PLAN.md`** — roadmap for Wave 2 hardening (IN chunking, reverse-lookup propagation, cycle handling, orphan strategies, sampling cap) and Wave 3 real execution.

### Fixed (Forge module)

- **Phantom 49-node SCC** in `GraphDiscoveryService` — `field.referenceTo` and `child.childRelationships` were emitting two edges per relationship in opposing directions, fooling Tarjan SCC into treating most of the graph as a single cycle. Edges are now unified as `parent→child` and deduped by `(source, target)`, with master-detail preferred over lookup on conflict.
- **Wave plan ordered backwards** — `ForgePlanGenerator` was grouping by BFS depth (`node.level`), which placed Account/Contact in the *same* wave as Case (their child). Plan now groups by topological level computed via Kahn's algorithm on the included subgraph; nodes participating in a cycle are bucketed at `maxLevel + 1` so they execute after acyclic dependencies.
- **Edges to excluded objects polluting cycle analysis** — `User`, `RecordType`, `ChangeEvent`, `History`, `Feed`, `Share` etc. were skipped from BFS traversal but still emitted as edge targets, inflating the edge count and confusing SCC. `addEdge` now filters excluded sources/targets at emission time.

### Added (Forge module)

- **`ForgeGraph.truncated` flag** — set to `true` when the BFS hit `DEFAULT_MAX_NODES` cap and the graph is incomplete; surfaced in the discovery result so callers can warn the user that some objects were skipped.
- **`tools/recipe-forge-grappe.ts`** — read-only Phase A recipe script that replays the production discovery + plan pipeline against real orgs (sf CLI tokens), used to validate Forge behaviour against partial-copy sandboxes without writing to the target.

## [1.2.3] - 2026-03-28

**Scale & Complete** — Enterprise foundation, real-time sync, conflict resolution, AI personas, streaming execution, and three new seed modes.

### Added

**CSV Import (Seed)**
- Drag-and-drop CSV file upload with automatic BOM stripping and file size validation
- Auto column mapping: case-insensitive, underscore-tolerant matching to Salesforce fields with manual override
- Inline validation: type mismatches, missing required fields, length exceeded, invalid picklist values, duplicate external IDs
- 4-step wizard: Upload → Map Columns → Validate → Execute
- Preview of first 10 rows before execution

**Clone from Org (Seed)**
- Clone records between Salesforce orgs with full relationship integrity
- Source org picker with visual source → target direction indicator
- Object selector with searchable list and per-object SOQL WHERE filters
- Relationship-ordered insert via topological sort with cycle detection
- Self-referential handling (e.g., Account.ParentId) via two-pass insert
- Cursor-based pagination (2000/batch) for large datasets
- ID mapping table (source ID → new ID) with CSV export
- 4-step wizard: Source Org → Select Objects → Preview → Execute

**Seed Mode Selector**
- SeedPage now offers 3 modes via card-based selector: AI Generate, CSV Upload, Clone from Org

**CDC Real-Time Sync**
- Change Data Capture subscriptions with start/stop per object
- Live event feed with virtual scrolling (ring buffer, 5000 events)
- Event batching (150ms window) for high-throughput scenarios
- Auto-sync toggle per object with configurable conflict strategy
- Watchdog reconnection on sleep/wake with replay ID persistence
- Metrics dashboard: throughput sparkline, event lag, counters, uptime

**Conflict Resolution**
- Side-by-side diff viewer with 2-way and 3-way comparison (using base value)
- Per-field conflict resolution with source/target/manual choice
- Bulk resolution actions (accept all source, accept all target)
- Conflict list with DataTable, pagination, and severity/object/status filters
- Sync Page "Conflicts" tab with live badge count

**Sync History & Scheduling**
- Full execution history with FIFO retention (500 entries)
- History detail view with re-run capability
- Cron-based scheduling with visual builder, raw expression, and timezone support
- Schedule persistence across VSCode restarts
- Sleep/wake resilient execution (overdue jobs run once, not per missed interval)
- VSCode notifications on schedule completion/failure
- Sync Page tabs: Active Syncs, History, Schedules

**AI Personas (Seed)**
- Persona gallery with 10 industry-specific cards featuring icons and locale badges
- Preview popover showing 5 AI-generated sample records per persona
- Customization panel with editable field patterns per persona
- Persona field patterns auto-applied to Seed wizard field rules
- AI mode fork: choose between persona-guided or free-form generation

**Smart Actions**
- SmartActionAnalyzer: automatic record count analysis on 5 standard objects (Account, Contact, Opportunity, Case, Lead)
- SmartActionCard on Home Dashboard: contextual recommendations with "Just Do It" one-click CTA
- Decision priority: clone > quick-seed > sync > none (based on source data presence)

**Adaptive Seed Wizard**
- Auto-advance: skip Configure step when selecting fewer than 5 objects
- Category grouping: accordion layout when selecting more than 20 objects (Standard, Custom, Managed Package)
- InfoTooltip: dismissible contextual help persisted via localStorage

**Streaming Execution**
- StreamingPipeline: async generator-based chunk processing with abort support
- ChunkedBulkExecutor: multi-upload Bulk API 2.0 with 2000 records/chunk
- Automatic streaming for operations exceeding 10,000 records per object
- Progress callbacks with per-chunk tracking (chunksProcessed / totalChunks)
- Error cap at 100 entries to prevent memory growth during large operations

**Background Operations**
- BackgroundOperationRegistry: detached operation lifecycle with running/completed/failed/aborted states
- Abort support via AbortController for any running background operation
- Operation events: started, progress, completed, failed, aborted with subscriber pattern
- WebView visibility tracking via onDidChangeViewState
- VSCode native notifications when operations complete while panel is hidden
- ExecutionHandler: query operation status, list active operations, abort by ID
- Sync and Seed handlers automatically detach to background for streaming operations

**Enterprise Foundation**
- Pagination component with page size selector and keyboard navigation
- Virtual scrolling via @tanstack/react-virtual for large lists and tables
- Skeleton loading states for tables, cards, and panels
- Keyboard shortcuts: Ctrl+1..6 for direct module navigation
- Notification center with severity filters and mark-as-read
- Bulk job progress tracker with per-object progress bars
- Error recovery panel with retry, exponential backoff, and skip options
- Cache manager with automatic org-switch invalidation

### Changed

- SeedPage restructured with mode selector and AI persona fork (was wizard-only)
- Sync Page reorganized with tabbed layout (Active Syncs, History, Schedules, Conflicts, Real-Time)
- Seed and Sync handlers refactored: streaming pipeline for large datasets, background detachment for long-running ops
- Home Dashboard now shows SmartActionCard with contextual recommendations

### Performance

- Virtual scrolling for all large data tables (10,000+ rows)
- Ring buffer for CDC events (constant memory, no array growth)
- Org-switch cache invalidation (no stale data between orgs)
- Streaming execution for datasets > 10K records (async generator, 2000/chunk)
- Background operation detachment: UI stays responsive during long-running ops
- VSIX size: 1.23 MB
- 8320 tests passing (shared: 912, extension: 4533, webview: 2875)
- i18n: all new features translated in 6 languages (en, fr, de, es, ja, pt-BR)

## [1.2.2] - 2026-03-27

**Adoption-First: Sync & Seed Polish** — Making it dead simple to populate any Salesforce sandbox.

### Added

**Quick Sync**
- 3-click flow: pick source/target orgs → multi-select objects → preview & execute
- Auto-field mapping: same-name fields matched automatically (no manual mapping step)
- Smart defaults: source-to-target direction, full mode, source-wins conflict, 200 batch size, upsert operation
- Pre-execution preview with estimated record counts and API call estimates
- Smart object suggestions: top 5 most-used objects (Account, Contact, Opportunity, Case, Lead)
- Relationship auto-detection: adding "Opportunity" auto-suggests "Account" as parent

**Quick Seed**
- 1-click seed from pre-built template gallery (no field configuration step)
- Template gallery UI with card grid showing name, description, object count, total records, and tags
- Customize record counts per object before execution

**Pre-Built Templates**
- 3 Seed templates: Sales Cloud Starter (7 objects, 7601 records), Service Cloud Starter (5 objects, 3800 records), Minimal Demo (3 objects, 350 records)
- 3 Sync templates: Full Account Hierarchy, Opportunities + Products, Cases + Attachments

**Seed Data Quality**
- Locale-aware data generation in 6 locales (en, fr, de, es, ja, pt-BR) with geo-coherent addresses
- Contextual ranges: object-specific amounts and dates (e.g., Opportunity.Amount: 5K-500K)
- Validation Rule auto-adjuster: detects ISBLANK, ISPICKVAL, LEN, REGEX rules and adjusts field values
- Picklist-aware generation: passes all active picklist values without truncation

**Onboarding**
- Sandbox detection with contextual guidance for new users
- Guided first-step cards on Sync and Seed empty states
- "Populate Sandbox" quick action on Home dashboard
- Welcome wizard updated for sandbox orgs

**Persistence**
- Save, load, and manage named sync configurations
- Save, load, and manage custom seed templates
- Wizard draft auto-save on every step change (survives page refresh)

### Changed

- Sync wizard reduced from 7 to 6 steps (merged org + object selection)

### Performance

- VSIX size: 1.16 MB
- 7623 tests passing (shared: 874, extension: 4310, webview: 2439)

## [1.2.1] - 2026-03-26

**Monitor Enrichment & Wiring** — Live backend services, alerting, and governance.

### Added

**Service Wiring**
- 5 previously dead backend services wired end-to-end with dedicated UI panels: Error Log Monitor, User Session Monitor, Apex Log Analyzer, Sandbox Refresh Tracker, Health Check

**Alert System**
- Default alert rules for API limits, storage, and error rates
- Alert persistence with configurable thresholds and severity levels
- VSCode native notifications (info/warning/error) on alert triggers
- Alert history timeline in Monitor dashboard

**Health Scoring**
- Unified health score aggregating all metric calculators
- Trend feedback with linear interpolation
- Health score displayed in Monitor dashboard and Home KPI row

**Limits & Trends**
- Expanded limits coverage: email invocations, Platform Events, FileStorage, sandbox reset countdown
- API response caching: /limits 30s TTL, OrgInfo 5min TTL
- Real timestamps in trend data (replaces index-based)
- CSV export for trend data

**Governance**
- Governance rule CRUD operations with custom rule definitions
- Rule evaluation engine with AlertEngine pipeline integration

## [1.2.0] - 2026-03-20

**Forge UX & Reliability** — Bug fixes, UX polish, performance, accessibility.

### Fixed

- Abort/pause/resume wired end-to-end in Forge execution
- DryRun flag properly honored during execution
- Dynamic object resolution for Forge templates
- Relationship field prefix map for correct reference handling
- Dead checkbox states in Forge wizard
- KPI calculation errors in Forge dashboard

### Added

**UX Improvements**
- Auto-org detection on extension activation
- Swap source/target orgs button
- Table view for object lists
- Log persistence across sessions
- ETA calculation for long-running operations
- Template CRUD management (create, edit, delete, duplicate)
- Node search in Forge dependency graph
- SidePanel redesign: compact mode, improved org switcher, collapsible metrics

**Backend Hardening**
- Structured error responses across all message handlers
- Configurable timeouts for all API calls
- Lifecycle events for operation tracking (started, progress, completed, failed)
- Real Bulk API 2.0 job IDs in responses

**Accessibility**
- ARIA tablist on tabbed interfaces
- aria-pressed on toggle buttons
- role="log" on live output panels
- Radiogroup patterns for exclusive selections
- Contrast fixes for WCAG 2.1 AA compliance

### Performance

- Dagre layout calculation separated from render cycle
- Memoized KPI computations
- Adaptive row heights in data tables
- 7149 tests passing

## [1.1.0] - 2026-03-19

**Stabilisation & Real-World Readiness** — Every module working end-to-end.

### Fixed

- CorrelationId bridge infrastructure: all message handlers use typed request/response with correlationId
- Ghost features removed: Grappe sidebar, placeholder modules, dead routes
- Bulk API 2.0 properly wired with retry and exponential backoff

### Added

- All 8 modules functional end-to-end: Seed, Sync, Monitor, Compare, DataOps, Automation, AI, Autopilot
- AI conversation persistence across sessions
- Dashboard refresh UX with error recovery
- Competitor benchmark analysis and 5 Monitor feature gaps addressed
- 7042 tests passing

## [1.0.0] - 2026-03-17

**Marketplace-Ready Release** — First public version.

### Added

- 6 core modules: Seed (AI-powered data generation), Sync (bidirectional ETL), Monitor (org health), Compare (metadata diff), DataOps (backup/compliance), Automation (visual pipelines)
- AI Assistant: NL2SOQL, error resolver, schema advice, 10 business personas
- Autopilot: auto-provisioning with compliance profiles, dependency graph, execution waves
- Grappe Engine for parallel processing of large datasets
- Production Guard with 3 safety tiers and CRUD/FLS enforcement
- Full i18n support (en, fr, de, es, ja, pt-BR)
- 162 Playwright E2E tests with WCAG 2.1 AA accessibility compliance
- GitHub Actions CI on Windows, macOS, and Linux
- VSIX optimized to 1.07 MB
- Published on VS Code Marketplace
