# Changelog

All notable changes to SandForge will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.5] - 2026-05-02

**Forge Hardening Pass** — 23 audit findings resolved (security, performance, correctness) + CLI feature parity with the wizard. Phase 02 (Test Hardening) closed with 5 Playwright E2E specs covering critical user flows.

### Added

**Forge CLI (sandforge-clone)**
- `--upsert` flag — use external Id upsert when available, skipping `DUPLICATE_VALUE` on re-runs of the same source records
- `--expand-orphans` flag — single-hop expand orphan parent FKs (clones missing parents so child FKs resolve)
- `--skip-preflight` flag — bypass the new pre-execute target row count
- `--json` flag — machine-readable JSON summary on stdout for CI integration
- `--exclude <obj.field>` (repeatable) — strip a specific field on a specific object before insert. BA opt-out for noisy long-text fields, calculated fields, or fields the target org doesn't have
- `--owner-map <src=tgt>` (repeatable) — remap OwnerId from a source User Id to a target User Id. Use case: clone records authored by ex-employees onto a sandbox where their User no longer exists (otherwise INVALID_OWNER)
- Pre-execute preflight showing existing rows in the target org for the first 30 nodes (with ⚠ flag for >1000 rows) so users know the blast radius before pulling the trigger

**ForgeConfig (cross-sandbox dev/BA flow)**
- `fieldExclusions: Record<string, string[]>` — per-object field skip list (Zod-validated, max 200 fields per object). Exposed via wizard config and CLI `--exclude`
- `ownerMappings: Record<string, string>` — per-record OwnerId remap (Zod-validated, both sides must be 15/18-char Salesforce IDs, max 200 entries). Exposed via wizard config and CLI `--owner-map`
- `objectSoqlFilters: Record<string, string>` — per-object SOQL WHERE filter appended via `AND (...)` to the scope clause. Lets BAs narrow a clone to a subset (e.g. `Status = 'Open' AND CreatedDate > LAST_N_DAYS:30`) without changing graph topology. Zod-validated: max 512 chars per filter, max 50 filters, comment markers (`--`, `/*`, `*/`) and trailing semicolons rejected to block statement chaining. Exposed via wizard config and CLI `--filter`
- `fieldMappings: Record<string, Record<string, string>>` — per-object source→target field rename for schema drift (managed-package re-key, namespace change, `__c`/`__pc` variant). Source key is dropped, value written under target name. Zod-validated: SF field-name regex on both sides, max 200 fields per object, max 50 objects. Exposed via wizard config and CLI `--map`

**ForgeOrchestrator**
- `dispose()` method — clears the discovery cache and listeners on extension shutdown / org disconnect

**ForgeHandler**
- New `forge:target-preflight:request` message type — webview can request per-object existing-row counts on the target before execute. Backend uses sequential SELECT COUNT() (parallel bursts trip rate limits on big orgs), 30 s timeout, max 100 objects per request, sentinel `existing: -1` for per-object failures so the whole batch isn't aborted by FLS issues. Powers the same preflight surface as the CLI

**ExecutionSummary.remapTable**
- New `remapTable: Record<string, string>` field on every execute summary — the full source→target ID mapping table. BA reconciliation: post-clone audit, "where did source X go on the target sandbox?", CSV export, checkpoint persistence
- CLI: new `--remap-csv <file>` flag writes `sourceId,targetId` CSV (double-quoted, one mapping per row, header included)
- CLI: `--json` output now embeds `result.remapTable` for CI consumers

**Tests**
- 22 regression tests pinning the audit-fix invariants (`audit-fixes.regression.test.ts`)
- 5 Playwright E2E specs (Plan 02-03) covering: AI persona seed → execute, sync conflict resolve, monitor refresh + CSV export, CDC subscribe + event stream, AI diagnose + apply fix
- 9 fixture factories + `MockBridge.stream()` helper for multi-event flows

### Changed

**Forge security (Zod hardening)**
- `forgeConfigSchema.recordId` now regex-validated against the strict 15/18-char Salesforce ID pattern
- `forgeConfigSchemaStrict` enforces the inputMode→required-field contract via cross-field refine
- `forgeGraphNodeSchema.objectApiName` and `forgeGraphEdgeSchema.{sourceObject,targetObject}` regex-validated against the SObject API name pattern
- `forgeGraphSchema` bounded to 2000 nodes / 20000 edges (defense-in-depth against DoS payloads)
- `metadataDiffRequestPayloadSchema.objectApiNames` capped at 100 (was 500) to block API-limit DoS
- `ForgeOrchestrator.cacheKeyFor` includes `targetOrgId`, `anonymizePII`, `expandOrphanParents`, `maxRecordsPerObject` so cache hits never silently swap configurations

**Forge performance**
- `ForgePlanGenerator` Tarjan SCC rewritten as iterative — no stack overflow on deep graphs (5000+ node chain verified)
- `SchemaCache.estimateSize` now uses an O(1) structural heuristic (fields × 250 + childRel × 150) instead of `JSON.stringify`; `describeCache` byte cap restored to 200 MB, `describeGlobalCache` to 50 MB (eliminates the OOM risk introduced by the previous Infinity workaround while keeping the event loop unblocked)
- `GraphDiscoveryService` adds `setImmediate`-based event-loop yield between BFS waves, with `setTimeout(0)` polyfill for non-Node test environments
- Cold path breadcrumb (warns when `resolveRootObject` exceeds 2 s)
- `parseObjectFromSOQL` now strips parens to fixed point so deeply nested subqueries don't trick the parser into picking the wrong root object
- `IdRemapper.remapRecord` uses a single Map.get instead of has+get (3M lookups hot path on 50K-record / 30-field clones)

**Forge correctness**
- `orphanExpansionsUsed` counter now increments only on successful expansions, so a string of misses doesn't silently exhaust the budget before the eligible list has had a chance to succeed
- Pass-2 dedup uses an explicit current/updated pattern with collision detection on the same field
- `bringRootToFront` throws a clear error if the scoped root is missing or excluded (was silently producing disconnected clones)
- Orphan expand syncs the scope cache so multi-hop children that pivot through the expanded parent stay in scope
- `pickUpsertField` logs the chosen field and falls back to insert (instead of an unsafe alphabetical pick) when no candidate is non-null + unique across the batch
- `summarizeRecordForError` handles `undefined` and objects via JSON.stringify-truncated output
- `EXPANSION_EXCLUDED_OBJECTS` now mirrors the BFS-side exclusion list (BusinessProcess, DandBCompany, ProcessInstance, …) — orphan-expand stops burning API on system-managed entities
- `sandforge-clone` CLI forces `referenceFallback='nullify'` (was 'keep' by default, which preserved invalid source IDs on cross-org clones)

**Forge UX**
- `handleDiscover` flushes throttled progress on the catch path so the wizard never freezes on stale counts after an abort
- `handleExecute` reorders unsubscribe before flush so the terminal event delivers cleanly
- `handleAbort` nulls the controller refs after `.abort()` to close a small race between sequential operations

### Fixed

- Tests: `recordId` test fixtures across `ForgeHandler.test.ts`, `ForgeOrchestrator.test.ts`, `GraphDiscoveryService.test.ts`, and `forge.schema.test.ts` now use 15-char strict IDs to satisfy the new regex (no behavior change — they were stand-ins anyway)

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
