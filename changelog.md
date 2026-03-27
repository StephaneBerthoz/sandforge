# Changelog

All notable changes to SandForge will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.3] - 2026-03-27

### Added

**Seed Extensions — CSV Import & Clone from Org**
- `CsvFieldMapper` — Auto-maps CSV column headers to Salesforce fields using case-insensitive, underscore-tolerant matching with type conversion (numeric, boolean, date, datetime)
- `CsvValidator` — Validates CSV records against Salesforce field metadata: type mismatches, missing required fields, length violations, invalid picklist values, duplicate external IDs (capped at 100 errors)
- `FileDropZone` — Reusable drag-and-drop file upload component with file size validation
- `CsvUploadWizard` — 4-step wizard: Upload → Map Columns → Validate → Execute
- `CsvColumnMapper` — Visual column mapping with auto-match, manual override via Select dropdowns, and mapped/unmapped/incompatible status indicators
- `CsvPreview` — First 10 rows preview with DataTable and total row count
- `CsvValidationPanel` — Inline validation errors grouped by type with accordion sections and "Proceed Anyway" gated by <10% error rate
- `useCsvImport` — React hook managing full CSV import lifecycle: file parsing (papaparse, BOM stripping), column mapping, validation, and execution
- `CloneRecordFetcher` — Cursor-based pagination via queryMore for fetching records from source orgs (2000/batch)
- `CloneReferenceLinker` — Topological sort for relationship-ordered insert with cycle detection and self-referential two-pass handling
- `CloneWizard` — 4-step wizard: Source Org → Select Objects → Preview → Execute
- `CloneSourcePicker` — Source/target org picker with visual direction indicator, excludes current target from source list
- `CloneObjectSelector` — Searchable object list with checkboxes and per-object SOQL WHERE filter
- `ClonePreviewPanel` — Insert order visualization, record counts, and sample records in accordions
- `CloneResultsPanel` — Per-object results with ID mapping table, pagination, and CSV export
- `useClone` — React hook managing clone lifecycle: source org selection, object configuration, preview, and execution
- SeedPage mode selector: 3 cards (AI Generate, CSV Upload, Clone from Org) with card-based selection
- 42 i18n keys in en.json and fr.json under `seed.csv.*`, `seed.clone.*`, and `seed.modeSelect.*` namespaces

### Performance

- 8156 tests passing (shared: 904, extension: 4459, webview: 2793)

## [1.2.2] - 2026-03-27

### Added

**Quick Sync — 3 Clicks to Data**
- `QuickSyncCard` — Prominent entry point on SyncPage that bypasses the full wizard
- 3-screen flow: pick source/target orgs → multi-select objects → preview & execute
- Auto-field mapping: same-name fields matched automatically (no manual mapping step)
- Smart defaults: direction=source_to_target, mode=full, conflict=source_wins, batchSize=200, operation=upsert
- `QuickSyncPreviewEstimator` — Pre-execution preview with object count, estimated records, and API calls
- `SmartObjectSuggester` — Top 5 most-used objects (Account, Contact, Opportunity, Case, Lead) suggested after org selection
- `RelationshipDetector` — Auto-detects parent objects from reference fields and suggests adding them

**Quick Seed — 1-Click to Realistic Data**
- Template gallery UI on SeedPage with card grid (name, description, object count, total records, tags)
- `TemplateCustomizeModal` — Adjust record counts per object before execution (pre-filled with template defaults)
- 1-click seed: select template → select target org → execute (no field config step)
- Quick Seed uses Smart Suggest defaults for all field rules automatically
- Progress and results reuse existing Step7/Step8 components

**Pre-Built Templates**
- 3 Seed templates: Sales Cloud Starter (7 objects, 7601 records), Service Cloud Starter (5 objects, 3800 records), Minimal Demo (3 objects, 350 records)
- 3 Sync templates: Full Account Hierarchy, Opportunities + Products, Cases + Attachments
- `SyncTemplatePicker` — Card grid for template selection in the sync wizard

**Seed Data Quality**
- Locale-aware data generation: FakerFallback supports 6 locales (en_US, fr_FR, de_DE, es_ES, ja_JP, pt_BR)
- `GeoCoherentGenerator` — City + State + Country + Zip always consistent (no more "Paris, Texas, Japan")
- `ContextualRanges` — Object-specific amount/date ranges (Opportunity.Amount: 5K-500K, CloseDate: +30 to +180 days)
- Picklist-aware Smart Suggest: passes ALL active picklist values without truncation
- `VRAutoAdjuster` — Auto-adjusts field rules to satisfy high-risk validation rules (ISBLANK, ISPICKVAL, LEN, REGEX)

**Onboarding & First-Run**
- `useSandboxDetection` — Detects sandbox orgs and triggers contextual guidance
- `SandboxBanner` — Dismissible banner "Your sandbox is empty — populate it with Seed or Sync"
- Welcome wizard Step 4 now suggests Seed/Sync for sandbox orgs instead of Forge
- `GuidedFirstStepCard` — Reusable onboarding component on SyncPage and SeedPage empty states
- Home dashboard: "Populate Sandbox" quick action card linking to template gallery

**Persistence & Auto-Save**
- `SyncConfigStore` — Save, load, list, delete named sync configurations via ConfigStore
- `SeedTemplateStore` — Save, load, list, delete custom seed templates via ConfigStore
- 8 new bridge handlers for CRUD operations on sync configs and seed templates
- `useWebviewPersistedState` — Generic hook for WebView state persistence across panel reloads
- Wizard draft auto-save on every step change (survives page refresh, form data only)

### Changed

- Sync wizard reduced from 7 to 6 steps (merged org selection + object selection into one screen)
- `SeedTemplateManager` now delegates persistence to `SeedTemplateStore` (write-through cache pattern)
- `SmartFieldGenerator` upgraded with contextual ranges and multipicklist flag
- `VRPreChecker` gained `extractConstraints()` for formula parsing

### Performance

- VSIX size: 1.16 MB (up from 1.07 MB with 30 new features)
- 7623 tests passing (shared: 874, extension: 4310, webview: 2439)

## [1.2.1] - 2026-03-26

### Added

**Service Wiring**
- Wired 5 dead backend services end-to-end: ErrorLogMonitor, UserSessionMonitor, ApexLogAnalyzer, SandboxRefreshTracker, HealthCheck
- Each service now has a dedicated UI panel in the Monitor dashboard

**Alert System**
- Default alert rules for API limits, storage, and error rates
- Alert persistence via ConfigStore with AlertStateStore
- VSCode notification integration (info/warning/error severity)
- Alert history timeline in Monitor dashboard

**Health Scoring**
- Unified health scorer merging all calculator outputs
- Trend feedback with linear interpolation
- Health score displayed in Monitor dashboard and Home KPI row

**Limits & Trends**
- Expanded limits coverage: email invocations, Platform Events, FileStorage, sandbox reset countdown
- API caching: /limits 30s TTL, OrgInfo 5min TTL
- Real timestamps in trend data (replaces index-based)
- CSV export for trend data

**Governance**
- Governance rule CRUD operations
- Rule evaluation engine
- AlertEngine pipeline integration

## [1.2.0] - 2026-03-20

### Fixed

- Abort/pause/resume wired end-to-end in Forge execution
- DryRun flag now properly honored during execution
- Dynamic object resolution for Forge templates
- Static prefix map for relationship fields
- Raw URL handling in Forge node display
- Dead checkbox states in Forge wizard
- Wrong KPI calculations in Forge dashboard

### Added

**UX Improvements (23)**
- Auto-org detection on extension activation
- Swap source/target orgs button
- Table view for object lists
- Log persistence across sessions
- ETA calculation for long-running operations
- Template CRUD management
- Node search in Forge graph
- SidePanel refonte: compact mode, improved org switcher, collapsible metrics

**Performance**
- Dagre layout calculation separated from render cycle
- Stable callbacks preventing unnecessary re-renders
- Memoized KPI computations
- Adaptive row heights in data tables

**Backend Hardening**
- Structured error responses across all handlers
- Enriched preview data in Forge
- Configurable timeouts for all API calls
- Lifecycle events for operation tracking
- Compliance wiring in DataOps
- Real Bulk API 2.0 job IDs in responses

**Accessibility**
- ARIA tablist on tabbed interfaces
- aria-pressed on toggle buttons
- role="log" on live output panels
- radiogroup patterns for exclusive selections
- Contrast fixes for WCAG 2.1 AA compliance

## [1.1.0] - 2026-03-19

### Fixed

- CorrelationId bridge infrastructure: all 16 handlers use buildResponse with correlationId
- Ghost features removed: Grappe sidebar, placeholder modules, dead routes
- Bulk API 2.0 properly wired with retry and exponential backoff

### Added

- All 8 modules functional end-to-end (Seed, Sync, Monitor, Compare, DataOps, Automation, AI, Autopilot)
- AI persistence: conversations saved across sessions
- Dashboard refresh UX with error recovery
- Competitor benchmark analysis and 5 Monitor feature gaps addressed
- 7042 tests passing

## [1.0.0] - 2026-03-16

### Added

- First public release on VS Code Marketplace
- 6 core modules: Seed (AI-powered data generation), Sync (bidirectional ETL), Monitor (org health), Compare (metadata diff), DataOps (backup/compliance), Automation (visual pipelines)
- AI Assistant: NL2SOQL, error resolver, schema advice, 10 business personas
- Autopilot: auto-provisioning with compliance profiles, dependency graph, execution waves
- Grappe Engine for parallel processing of large datasets
- Production Guard with 3 safety tiers and CRUD/FLS enforcement
- Full i18n support (en, fr, de, es, ja, pt-BR)
- 162 Playwright E2E tests with WCAG 2.1 AA accessibility compliance
- GitHub Actions CI on Windows, macOS, and Linux
- VSIX optimized to 1.07 MB
