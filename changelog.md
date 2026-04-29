# Changelog

All notable changes to SandForge will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added (Forge module — record-scoped clone, Wave 1 POC)

- **`RecordScopeCache`** — per-execution cache (`Map<objectApiName, Set<recordId>>`) that records IDs collected from each wave so downstream nodes can scope their queries to the transitive closure of the root record.
- **`ScopedSoqlBuilder`** — emits SOQL with `WHERE Id = '<rootId>'` for the root, `WHERE Id IN (...)` for objects already cached (including parent FK values seeded from earlier records), `WHERE FK IN (...)` for children of cached parents, or a zero-result query when no scoping path exists. Excluded targets (User, RecordType, ChangeEvent…) are filtered out so they never participate in scope SOQL.
- **`ForgeExecutor` scoped + dry-run modes** — new `ExecuteOptions { rootRecordId, rootObjectApiName, dryRun }` parameter. When `rootRecordId` is set the executor switches to scoped mode: seeds the cache with the root, brings the root to the front of the topo order (so cycle waves don't starve the cache), uses `ScopedSoqlBuilder` per node, and propagates FK values from each query into the cache for multi-hop downstream scoping. `dryRun: true` runs every query but skips inserts — used by the recipe to preview cloning before any write.
- **`FieldInfo.referenceTo`** — optional field on the executor describe contract so scope reasoning knows which parent each lookup points at (polymorphic-aware).
- **`tools/recipe-forge-grappe.ts` Phase B** — read-only scoped dry-run report. Replaying the production executor against ORG-UAT → ORG-DEV for Case `500AP00000fXeQsYAK`: **261 858 records → 358** (−99.86%), 19 scoped queries, 0 write, 2 out-of-scope nodes correctly skipped.
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
