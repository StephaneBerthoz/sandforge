# Changelog

All notable changes to SandForge will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-03-16

### Added
- First public release on VS Code Marketplace
- 162 Playwright E2E tests with WCAG 2.1 AA accessibility compliance
- GitHub Actions CI on Windows, macOS, and Linux
- Automated release pipeline with marketplace publishing

### Changed
- Version reset from internal 3.2.0 to public 1.0.0

## [3.2.0] - 2026-03-13

### Added

**New Services**
- `LiveOperationTracker` — Real-time DML operation monitoring dashboard with per-object stats, throughput tracking, and live progress events
- `MaskingTemplateService` — Pre-built and custom anonymization templates (GDPR, HIPAA, PCI DSS) with field-level masking rules and preview
- `ConfigProfileManager` — Save, load, switch, and share configuration profiles for repeatable sandbox provisioning across teams

**Security & Governance Utilities**
- `CrudFlsGuard` — Pre-operation CRUD and FLS permission verification with per-field granularity and actionable error messages
- `DmlOperationTracker` — Centralized DML operation counting and governor limit tracking across all modules
- `sforceLimitParser` — Parser for `Sforce-Limit-Info` response headers with threshold alerting and org tier awareness
- `queryLimits` — Org-tier-aware API limit thresholds (Developer, Developer Pro, Partial, Full sandbox tiers)

**MessageBroker Hardening**
- Zod schema validation on all incoming WebView messages in `MessageBroker`
- Invalid message payloads are now rejected with structured error responses before handler dispatch

**E2E Testing Infrastructure**
- Playwright configuration (`playwright.config.ts`) with Chromium, Firefox, and WebKit browsers
- 6 E2E spec files with 47 test cases: `home-page`, `navigation`, `accessibility`, `i18n`, `theme`, `responsive`
- Custom test fixtures and page object helpers for WebView interaction
- Scripts: `pnpm e2e`, `pnpm e2e:ui`, `pnpm e2e:report`

### Security

- CRUD and FLS checks enforced before every Salesforce DML operation via `CrudFlsGuard`
- Input validation hardened with Zod on all bridge message payloads
- Production guard safety tiers validated against org tier metadata
- Secrets no longer logged in error traces (sanitized stack traces)

### Performance

- `DmlOperationTracker` prevents governor limit violations by tracking cumulative DML across batch operations
- `sforceLimitParser` enables proactive throttling before hitting API ceilings
- `LiveOperationTracker` streams progress via events instead of polling, reducing WebView redraws
- `.vscodeignore` optimized — VSIX reduced to 1.07 MB (excludes source maps, type declarations, test files, build intermediates)

### Bug Fixes

- Fixed `MessageBroker` accepting malformed messages without validation (now rejects with Zod errors)
- Fixed missing CRUD/FLS checks in Seed, Sync, DataOps, and Compare handlers
- Fixed API limit headers being silently ignored on bulk operations
- Fixed configuration drift when switching between org tiers

### Documentation

- Phase documentation completed for phases 00 through 12
- Phase 09 updated with v3.2.0 audit hardening details
- Phase 10 updated with Playwright E2E setup status
- Phase 11 updated with marketplace preparation progress
- All changelogs synchronized across root and extension packages

### Testing

- 47 Playwright E2E tests across 6 spec files (home page, navigation, accessibility, i18n, theme, responsive)
- Unit tests added for all new services (LiveOperationTracker, MaskingTemplateService, ConfigProfileManager, CrudFlsGuard, DmlOperationTracker, sforceLimitParser)
- MessageBroker Zod validation covered with rejection and error path tests

## [3.1.0] - 2026-03-07

### Added

**UI Redesign — "Forge" Design System**
- Design tokens mapped to VSCode CSS variables for automatic theme support
- Surface scale, module accent colors (7 modules), Inter Display typography
- Framer Motion presets (spring, fadeIn, slideUp, cardHover, buttonPress, staggerContainer)
- LazyMotion/domAnimation for tree-shaking (reduces bundle by ~30kb)
- Glassmorphism `.glass-overlay` with backdrop-filter blur

**New Components**
- `BentoGrid` / `BentoTile` — Responsive tile grid with motion hover effects
- `KPICard` — Metric card with sparklines, trend arrows, progress bars
- `CommandPalette` — cmdk-based Ctrl+K fuzzy search with navigation, actions, recent searches
- `LiveGraph` — ReactFlow wrapper with ProgressNode and AnimatedEdge components
- `FieldMapper` — Interactive drag-and-drop field mapping canvas
- `Skeleton` — Animate-pulse loading placeholders (text/card/circle/rect variants)
- `HealthScoreCard` / `HealthGauge` — Radial SVG gauge with health report modal
- `TrendChart` — Recharts AreaChart with period selector (24h/7d/30d)
- `OrgSwitcher` — Compact org selector for TopBar
- `TopBar` — Redesigned header with logo, search trigger, org switcher, notifications

**Page Redesigns**
- `HomePage` — Bento command center with KPI row, Forge hero, quick actions, health summary
- `MonitorPage` — Bento layout with health gauge, API/storage KPIs, trend charts, jobs table, governor limits
- `SeedPage` — Simplified from 8 to 4 wizard steps with progressive disclosure
- `SyncPage` — Interactive FieldMapper canvas integrated into sync workflow
- `ComparePage` — 6 tabs: diff, permissions, snapshots, drift, impact, deploy
- `DataOpsPage` / `AutomationPage` / `ReportsPage` — Visual lift with BentoGrid and KPICards

**Bridge & Architecture**
- `useMessageResponse` — Shared hook for bridge message lifecycle (mountedRef, timeout, cleanup)
- `useBridgeQuery` / `useBridgeMutation` — Refactored to share useMessageResponse, public API unchanged
- `MonitorHandler` / `SeedHandler` / `SyncHandler` — Domain-specific bridge handlers
- `ServiceFactory` — Centralized dependency wiring for all domain handlers
- `AI_CONFIG` / `AI_PROVIDER` — Extracted AI constants to shared package

**Accessibility**
- ARIA attributes, keyboard navigation, aria-live regions across all interactive components
- `SkipLink` component for keyboard-only navigation
- Focus traps in Dialog, Command Palette, modals
- DataTable keyboard navigation (arrow keys, enter to select)

**i18n**
- All hardcoded strings replaced with `t()` calls
- Full en.json and fr.json coverage for all new components and pages

### Fixed
- Framer Motion event-handler type conflicts (onDrag/onAnimationStart) in Button/Card
- Tailwind surface/text/border colors now reference VSCode CSS variables instead of hardcoded hex
- Double Card+BentoTile nesting causing inconsistent backgrounds in Monitor page
- Skeleton loading states replace Spinner-based loading across all pages

### Changed
- Generic `Wizard` component with `testIdPrefix` pattern replaces per-module wizards
- Stagger animation on DataTable rows via motion.tbody/motion.tr

## [3.0.0] - 2026-03-07

### Added

**Autopilot Module (Extension)**
- `SchemaScanner` — Scans source + target orgs, auto-discovers dependencies, counts records
- `DependencyGraphBuilder` — Tarjan SCC cycle detection, topological sort, level-based layout
- `ComplianceEngine` — 4 built-in compliance profiles (GDPR, CCPA, HIPAA, PCI-DSS), rule generation, audit reports with checksums
- `SmartAnonymizer` — PersonaRegistry for cross-object coherent anonymization, 10 methods (fake, mask, hash, nullify, redact, shuffle, truncate, preserve_format, age_band, generalize)
- `ExecutionPlanGenerator` — Groups objects into parallelizable waves, estimates duration and API calls
- `RecordIdRemapper` — Source-to-target ID mapping for lookup remapping across objects
- `AutopilotExecutor` — Wave-by-wave execution with pause/resume/skip, real-time progress events
- `AutopilotGrappeAdapter` — Partitions large objects for parallel processing above configurable threshold
- `AutopilotOrchestrator` — Central coordinator for full scan, graph, compliance, plan, execute flow
- `ExtensionHandlers` — 7 autopilot message handlers for WebView bridge

**Autopilot Module (WebView)**
- `useAutopilotStore` — Zustand store with full state management (step, orgs, objects, graph, plan, rules, execution status, live stats)
- `AutopilotWizard` — 4-step wizard (Connect, Objects, Compliance, Review)
- `AutopilotGraph` — Interactive ReactFlow dependency graph with level-based layout
- `ObjectNode` — Custom node with progress bar, status colors, PII icon, pulse animation
- `RelationEdge` — Custom edge (solid/dashed/curved by relationship type)
- `GraphLegend` + `GraphControls` — Graph overlay components
- `ControlPanel` — Tesla-style side panel with NodeDetail, LiveStats, AnonymizationPreview, ComplianceStatus
- `ComplianceReport` + `ComplianceTimeline` — Audit report viewer
- `AutopilotPage` — Main layout switching between wizard and execution views
- Sidebar navigation entry for Autopilot module
- Full i18n coverage (en + fr) for all autopilot UI strings

**Shared Types and Schemas**
- `autopilot.types.ts` — AutopilotNode, AutopilotEdge, AutopilotGraph, ExecutionPlan, ExecutionWave, CycleResolution, GraphStats, AutopilotConfig, AutopilotEvent, ComplianceFrameworkType, AnonymizationMethod, AnonymizationRule, PIIFieldDetection, PIICategory, AnonymizedPersona
- `compliance.types.ts` — ComplianceRule, ComplianceProfile, ComplianceReport, ComplianceReportEntry, ComplianceObjectSummary
- `messages.types.ts` — 14 new autopilot message types
- `autopilot.schema.ts` + `compliance.schema.ts` — Zod validation schemas with full test coverage

**Infrastructure**
- `TypedEventEmitter` — Generic typed event emitter with listener isolation (try/catch per listener)

### Fixed

**Critical (8)**
- `SecretVault` — JSON parse safety with try/catch for corrupted vault data
- `BatchProcessor` — Error isolation per batch item (one failure no longer kills the batch)
- `CircuitBreaker` — halfOpenInFlight concurrency guard preventing multiple simultaneous half-open attempts
- `OrgManager` — try/catch around event emission preventing listener errors from breaking core flow
- `RetryStrategy` — Jitter calculation correctness for exponential backoff
- `RateLimiter` — Sliding window token cleanup preventing stale token accumulation
- `ExecutionPipeline` — Step error propagation with proper status tracking
- `BulkApiManager` — Bulk job status polling edge case handling

**Moderate (26)**
- All Zod schemas aligned with TypeScript types (pipeline, sync-config, seed-config, grappe, settings)
- Utility edge cases hardened (`isValidApiName`, `formatBytes`, `truncate`, `isValidCron`, `estimateApiCalls`)
- `SeedPage` — Missing dependency in useEffect
- `FloatingToasts` — Stable callback references preventing re-renders
- `useKonamiCode` — Cleanup function for event listeners
- `Dialog` — Controlled open state with onOpenChange handler
- `StatusFooter` — Memoized connection count selector
- `OrgManagerPage` — Stable callbacks with useCallback
- `useVSCodeApi` — Guarded window.acquireVsCodeApi call
- `useSettingsStore` — Proper Zustand selector pattern
- `messageHelpers` — Timestamp-based unique message IDs
- `DataTable` — Stable column definitions with useMemo
- `SoqlBuilder` — useCallback for event handlers
- `useNotificationStore` — Fixed selector returning derived state
- `useOrgStore` — Added derived selectors (selectConnectedOrgs, selectSelectedOrg)
- `DependencyResolver` — Self-reference edge handling in topological sort

**Suggestions (15)**
- All hardcoded UI labels replaced with i18n `t()` calls
- `OrgEditDialog` — tierOptions/colorOptions moved inside component with translations
- `OrgConnectDialog` — authOptions/loginUrlOptions moved inside component with translations
- 20+ new translation keys added to en.json and fr.json under org.* and auth.* namespaces
- Router updated with autopilot route
- `useAppStore` — ModuleRoute union extended with 'autopilot'

### Changed

- Minimum version bumped from 2.0.0 to 3.0.0 across all packages

## [2.0.0] - 2026-03-06

Initial release of SandForge with 6 modules: Seed, Sync, Monitor, Compare Org, DataOps, Automation.
