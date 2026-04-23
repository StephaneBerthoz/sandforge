# SandForge

## What This Is

SandForge is a VSCode extension that provides an all-in-one ETL toolkit for Salesforce sandboxes. It offers 6 core modules (Seed, Sync, Monitor, Compare, DataOps, Automation) plus AI assistance and Autopilot, all delivered through a 100% WebView React UI — zero Command Palette interaction. Target users are Salesforce admins and developers who need to provision, synchronize, compare, and maintain sandbox environments efficiently.

## Core Value

Sandbox provisioning and data management must be reliable, safe (CRUD/FLS enforced, production guards, encryption), and fast (Bulk API 2.0, parallel processing via Grappe system) — a single bad operation on a production-adjacent org can cause real damage.

## Requirements

### Validated

- ✓ AI-powered data generation with schema analysis, relationship resolution, and business personas — Phase 02
- ✓ Bidirectional ETL sync with delta detection, field mapping, transforms, and conflict resolution — Phase 03
- ✓ Real-time org health monitoring with governor limit tracking, predictive analytics, and alerts — Phase 04
- ✓ Metadata diff, permissions matrix, drift detection, impact analysis, and deploy-from-diff — Phase 05
- ✓ Backup/restore, GDPR/HIPAA/PCI-DSS compliance, anonymization, and data quality scanning — Phase 06
- ✓ Visual pipeline builder with 15 step types, scheduling, approval gates, and marketplace — Phase 07
- ✓ NL2SOQL, AI error resolver, smart suggestions, anomaly detection — Phase 08
- ✓ 6-language i18n (en, fr, de, es, ja, pt-BR), 4600+ tests, security hardening — Phase 09
- ✓ Core infrastructure: typed message bridge, connection pool, Grappe parallel processing, execution pipeline — Phase 00-01
- ✓ Autopilot: auto-provisioning with compliance profiles, dependency graph, execution waves — v3.0.0
- ✓ E2E testing: 162 Playwright specs, axe-core WCAG 2.1 AA, GitHub Actions CI — Milestone v1.0.0
- ✓ Marketplace publication: visual assets, user docs, release pipeline, published on Marketplace — Milestone v1.0.0
- ✓ Bridge wiring: correlationId, 70+ response type fixes, ghost type cleanup — Milestone v1.1.0
- ✓ Module execution: all 8 modules end-to-end functional, AI persistence — Milestone v1.1.0
- ✓ UX cleanup: Grappe sidebar removed, notifications, version footer, org auto-select, empty states — Milestone v1.1.0
- ✓ Robustness: Bulk API 2.0, retry with backoff, configurable timeouts, field validation — Milestone v1.1.0
- ✓ Monitor enrichment: competitor benchmark, 5 feature gaps, dashboard refresh UX — Milestone v1.1.0
- ✓ Gap closure: buildResponse migration for all 16 handlers (correlationId end-to-end), Phase 05 verified — Milestone v1.1.0
- ✓ Forge bugs: abort/pause wiring, dryRun, static prefix map, raw URL, dead checkboxes, wrong KPIs — Milestone v1.2.0
- ✓ Forge UX: auto-org, swap orgs, table view, log persistence, ETA, node search, template management, SidePanel refonte — Milestone v1.2.0
- ✓ Performance: Dagre layout separation, stable callbacks, memoized KPIs, adaptive heights — Milestone v1.2.0
- ✓ Backend hardening: structured errors, enriched preview, timeouts, lifecycle events, compliance wiring, real bulk IDs — Milestone v1.2.0
- ✓ Accessibility: ARIA tablist, aria-pressed, role="log", radiogroup, contrast fixes — Milestone v1.2.0
- ✓ Wire 5 dead backend services (ErrorLogMonitor, UserSessionMonitor, ApexLogAnalyzer, SandboxRefreshTracker, HealthCheck) — Milestone v1.2.1
- ✓ Alert system: default rules, persistence, VSCode notifications, history timeline — Milestone v1.2.1
- ✓ Unified health scoring: merged calculators, trend feedback, linear interpolation — Milestone v1.2.1
- ✓ Expanded limits: email, Platform Events, FileStorage, reset countdown — Milestone v1.2.1
- ✓ API efficiency: /limits 30s cache, OrgInfo 5min cache — Milestone v1.2.1
- ✓ Trend quality: real timestamps, CSV export, job trend accumulator fix — Milestone v1.2.1
- ✓ Governance wiring: CRUD, evaluate, AlertEngine pipeline — Milestone v1.2.1
- ✓ Sync scheduling with cron UI + schedule management — Milestone v1.2.3
- ✓ Sync history & audit log (past executions, replay, export) — Milestone v1.2.3
- ✓ Seed from CSV upload (column mapping, preview, validation) — Milestone v1.2.3
- ✓ Seed clone mode (org-to-org record copy, relationship remapping) — Milestone v1.2.3
- ✓ AI persona catalogue (10 pre-built personas, preview, customization) — Milestone v1.2.3
- ✓ Sync conflict resolution UI (diff viewer, per-field merge, bulk resolution) — Milestone v1.2.3
- ✓ CDC real-time sync (subscription UI, live stream, auto-sync, backend hardening) — Milestone v1.2.3
- ✓ Enterprise scaling (pagination, virtual scrolling, streaming, background ops, cache management) — Milestone v1.2.3
- ✓ Small project optimizations (smart actions, Just Do It mode, adaptive wizard, contextual help) — Milestone v1.2.3
- ✓ Existing feature polish (error recovery, skeleton screens, keyboard shortcuts, notification center) — Milestone v1.2.3

## Current Milestone: v1.3.0 — Hardening & Monitor v2

**Goal:** Stabilize v1.2.x features with bug bash + targeted refactoring, extend Monitor with competitive-parity features, integrate AI for bug diagnosis and anomaly detection, and apply best-practice patterns across the codebase.

**Target themes:**
- Bug bash & regressions across all v1.2.x modules
- Targeted refactoring with context (SOLID, event-driven patterns, DI)
- Monitor v2: features identified from competitive scan (SF Inspector, ORGanizer, Gearset, Copado, Salto)
- AI integration: AI-assisted bug diagnosis, AI-powered anomaly narratives, AI code suggestions
- Observability: telemetry opt-in, structured logging, Sentry error reporting
- Best practices: mutation testing, property-based tests, dead code detection, perf pass

### Active

- [ ] Bug bash & hardening — v1.3.0
- [ ] Targeted refactoring audit — v1.3.0
- [ ] Monitor v2 competitive features — v1.3.0
- [ ] AI-assisted diagnosis — v1.3.0
- [ ] Observability opt-in — v1.3.0

### Recently Validated (v1.2.2)

- ✓ Quick Sync mode: 3-click flow with smart defaults, auto-field mapping, smart object suggestions, relationship detection — Milestone v1.2.2
- ✓ Sync Wizard polish: 3 pre-built sync templates, wizard reduced from 7 to 6 steps — Milestone v1.2.2
- ✓ Seed templates: 3 pre-built templates (Sales Cloud, Service Cloud, Minimal Demo), template gallery UI, 1-click seed — Milestone v1.2.2
- ✓ Config persistence: SyncConfigStore + SeedTemplateStore, CRUD bridge handlers, wizard draft auto-save — Milestone v1.2.2
- ✓ Onboarding: sandbox detection, contextual banners, WelcomePage update, guided first-step cards — Milestone v1.2.2
- ✓ Seed quality: locale-aware Faker (6 locales), geo-coherent addresses, VR-aware generation, contextual ranges — Milestone v1.2.2

### Deferred

- [ ] Advanced features: collaborative editing, multi-LLM, enterprise integrations (Slack, Datadog, PagerDuty) — future

### Out of Scope

- Native CLI tool — VSCode extension is the delivery mechanism, not a standalone CLI
- Multi-tenant SaaS hosting — this is a local extension, not a hosted service
- Non-Salesforce CRM support — SandForge is Salesforce-specific by design

## Context

- Monorepo pnpm with 3 packages: `shared` (types/schemas), `extension` (Node.js/esbuild), `webview` (React/Vite/Tailwind)
- v1.2.3 shipped as v1.2.4 on Marketplace — Scale & Complete (50 items delivered, 8320 tests passing, 1.24 MB VSIX)
- v1.2.2 shipped — Adoption-First: Sync & Seed Polish (30 items delivered, 7623 tests passing)
- v1.2.1 shipped — Monitor Enrichment & Wiring (25 items delivered)
- v1.2.0 shipped — Forge UX & Reliability (52 items delivered, 7149 tests passing)
- jsforce v3 for all Salesforce API interactions
- Strict TypeScript (no `any`), Zod validation on all external data, Winston logging

## Constraints

- **Tech stack**: pnpm monorepo, TypeScript strict, React 18, Vite, Tailwind, Shadcn/ui — locked
- **API**: jsforce v3, Bulk API 2.0 for >200 records, Composite API for parent/child — locked
- **Security**: CRUD/FLS mandatory before every DML, production guard with 3-tier safety — non-negotiable
- **i18n**: All user-visible strings via `t('key')`, 6 languages maintained — locked
- **Testing**: Every `.ts` has a `.test.ts`, build must stay green — locked
- **UI**: 100% WebView React, zero Command Palette commands — architectural choice

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| WebView-only UI | Richer UX than TreeViews/QuickPicks, full React ecosystem | ✓ Good |
| Monorepo with shared types | Single source of truth for types/schemas across extension and webview | ✓ Good |
| Zod for all validation | Runtime type safety, auto-inference, schema-first design | ✓ Good |
| Grappe system for parallelism | Handle thousands of records without blocking, partitioned processing | ✓ Good |
| jsforce v3 | Latest API support, better TypeScript types | ✓ Good |
| esbuild for extension | Fast builds, single output bundle | ✓ Good |
| 6-language i18n from Phase 09 | Marketplace reach, global user base | ✓ Good |

---
*Last updated: 2026-04-23 — Milestone v1.3.0 (Hardening & Monitor v2) started.*
