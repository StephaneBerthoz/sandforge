# Changelog

All notable changes to SandForge will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-03-20

### Stabilisation & Real-World Readiness

This release focuses on making every module work end-to-end with real Salesforce orgs, cleaning up ghost features, and adding production-grade robustness.

### Added

- **Competitor Benchmark** — Comparison matrix against SF Inspector, ORGanizer, Org Monitor across 14 features
- **StorageBreakdownPanel** — Per-object record count donut chart via EntityDefinition SOQL
- **DeploymentTimeline** — Recent deployments with status indicators via DeployRequest query
- **ApiUsagePanel** — Per-category API usage with ProgressBars and warning/critical badges
- **LimitExportButton** — CSV export of governor limits via Blob API
- **Dashboard Refresh UX** — Panel-level loading overlays, stale data indicator, error retry banner, connection loss warning with auto-reconnect
- **Empty States** — Tailored first-launch experience with guidance and CTA for all 5 modules (Forge, Monitor, DataOps, Automation, Autopilot)
- **Bulk API 2.0** — Automatic switch for operations > 200 records (Seed, Sync) via BulkApiExecutor
- **RetryableOperation** — Exponential backoff with smart record-level vs connection-level error classification
- **TimeoutManager** — Configurable timeout with AbortController for long-running operations
- **FieldTypeValidator** — Source-to-target field type compatibility checking before Sync upsert
- **Robustness Config** — Zod-validated configuration for timeouts, retry, and bulk thresholds

### Fixed

- **CorrelationId propagation** — All 16 handlers now use buildResponse with correlationId for reliable request/response matching (122 total calls)
- **Response type mismatches** — Audit and fix of all useBridgeQuery/useBridgeMutation response types across 70+ message types
- **Ghost features cleaned** — Removed dead message types (audit, governance, team, recovery), added "Coming Soon" overlays for Scheduler (v1.2) and RealTime Sync (v2.0) with NoOpHandler
- **Notifications bell** — Bell button in TopBar now opens NotificationCenter with unread badge
- **Version footer** — StatusFooter reads version from build-time env, no longer hardcoded
- **Org auto-select** — First connected org automatically selected on mount
- **Grappe sidebar** — Removed from sidebar navigation (kept as execution overlay)
- **AI guidance** — Clear empty state with Settings link when AI API key not configured
- **AI persistence** — Conversations persisted to ConfigStore, survive extension reloads
- **Unhandled messages** — MessageBroker logs warnings for unhandled message types

### Stats

- 7042 tests passing across 230+ test files
- 27 requirements delivered across 6 phases
- Zero TODO/FIXME/PLACEHOLDER in source code

## [3.2.0] — 2026-03-13

### Added

- **LiveOperationTracker** — Real-time DML operation dashboard with per-object throughput and live progress events
- **MaskingTemplateService** — Pre-built anonymization templates (GDPR, HIPAA, PCI DSS) with custom field-level masking rules
- **ConfigProfileManager** — Save, load, and share configuration profiles for repeatable sandbox provisioning
- **CrudFlsGuard** — CRUD and FLS permission pre-checks before every Salesforce DML operation
- **DmlOperationTracker** — Governor limit-aware DML operation counting across all modules
- **sforceLimitParser** — Sforce-Limit-Info header parsing with threshold alerts and org tier awareness
- **MessageBroker Zod validation** — All incoming WebView messages validated by Zod schemas before dispatch
- **E2E testing** — Playwright setup with 47 tests across 6 spec files (home, navigation, a11y, i18n, theme, responsive)

### Security

- CRUD/FLS enforcement on all DML paths via CrudFlsGuard
- Zod validation on all bridge message payloads
- Sanitized stack traces (no secrets in error logs)

### Performance

- VSIX optimized to 1.07 MB via .vscodeignore tuning
- Proactive API throttling via sforceLimitParser
- Event-driven progress streaming in LiveOperationTracker

### Fixed

- MessageBroker accepting malformed messages without validation
- Missing CRUD/FLS checks in Seed, Sync, DataOps, and Compare handlers
- API limit headers silently ignored on bulk operations

## [3.1.0] — 2026-03-07

### Added

- **UI Redesign** — "Forge" Design System with VSCode theme integration, Framer Motion animations, glassmorphism
- **New Components** — BentoGrid, KPICard, CommandPalette, LiveGraph, FieldMapper, HealthGauge, TrendChart, OrgSwitcher
- **Page Redesigns** — HomePage, MonitorPage, SeedPage, SyncPage, ComparePage, DataOpsPage, AutomationPage
- **Accessibility** — ARIA attributes, keyboard navigation, focus traps, skip links across all components
- **i18n** — Full coverage for 6 languages (en, fr, de, es, ja, pt-BR)

### Fixed

- Framer Motion event-handler type conflicts
- Tailwind colors now reference VSCode CSS variables
- Skeleton loading states replace Spinner across all pages

## [3.0.0] — 2026-03-07

### Added

- **Autopilot Module** — Full-auto sandbox provisioning with schema scan, dependency graph, compliance engine, smart anonymizer
- **Grappe Engine** — Parallel processing for large datasets with 7 partitioning strategies
- **TypedEventEmitter** — Generic typed event emitter with listener isolation

### Fixed

- 8 critical fixes (SecretVault, BatchProcessor, CircuitBreaker, OrgManager, RetryStrategy, RateLimiter, ExecutionPipeline, BulkApiManager)
- 26 moderate fixes across Zod schemas, utilities, and React components

## [2.0.0] — 2026-03-06

First public release on the VSCode Marketplace.

### Modules

- **Seed** — AI-powered test data generation with 8-step wizard, Faker profiles, CSV import, record cloning, dependency resolution, and batch execution with rollback
- **Sync** — Bidirectional org ETL with 4 sync modes, 7 mapping types, 13 transforms, 5 conflict strategies, dry-run preview, and cron scheduling
- **Monitor** — Real-time API limits dashboard, Apex/Bulk job tracking, alert system, trend charts, and composite health score
- **Compare** — Side-by-side metadata diff, permission matrix, drift detection, impact graph, and deployment builder
- **DataOps** — Backup/restore, anonymization (GDPR/CCPA/HIPAA/PCI DSS), data cleaner, quality scanner, DSR workflows, and compliance checker
- **Automation** — Visual pipeline builder with 15 step types, 6 trigger types, conditional routing, scheduler, retry policies, and execution history
- **Autopilot** — Full-auto sandbox provisioning: schema scan, dependency graph, compliance engine, smart anonymizer, execution plan generator, and compliance reporting
- **Reports** — 10 report types, analytics dashboard, audit trail, data lineage graph, and multi-format export (JSON, CSV, HTML, Markdown)
- **AI Assistant** — Chat interface with Anthropic/OpenAI/Ollama providers, error resolution, and contextual suggestions

### Grappe Engine (Cluster Mode)

- Parallel processing engine for large datasets (10K+ records)
- 7 partitioning strategies: round-robin, by-record-type, by-parent, by-date-range, by-hash, by-volume, dependency-aware
- Worker management with configurable concurrency and back-pressure (pause, throttle, drop-priority)
- Full integration in Seed, Sync, and Autopilot orchestrators with progress events
- Real-time GrappeProgressPanel in all execution views
- Bridge message protocol: `grappe:started`, `grappe:partitionProgress`, `grappe:backPressure`, `grappe:completed`
- Settings: enable/disable toggle and threshold configuration

### UI & UX

- 100% WebView React UI — zero Command Palette dependency
- Sidebar launcher with org switcher, favorites, and quick navigation
- Full i18n coverage (English + French) from day one
- Dark theme optimized for VSCode with CSS custom properties
- Keyboard shortcuts for all modules (Ctrl+Shift+M/D/Y/K/O/A/G)
- Onboarding wizard, contextual help, and About dialog
- Loading skeletons, error boundaries, breadcrumbs, and toast notifications

### Architecture

- Monorepo with pnpm workspaces: `shared`, `extension`, `webview`
- TypeScript strict mode, Zod validation, JSDoc on all public APIs
- Extension-WebView bridge with typed messages and MessageBroker
- Zustand stores for all state management
- 6000+ tests across 432 test files
- esbuild for extension, Vite for webview, Tailwind + Shadcn/ui

---

## [0.1.0] — 2026-02-20

### Added

- Initial development release
- Project scaffolding and monorepo structure
- Basic extension activation and WebView rendering

---

> *Some features are better discovered than documented. Try being persistent...*
