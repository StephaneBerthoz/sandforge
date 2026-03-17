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

### Active

- [ ] Advanced features: real-time sync (CDC/Streaming), collaborative editing, multi-LLM, enterprise integrations — Phase 12

### Out of Scope

- Native CLI tool — VSCode extension is the delivery mechanism, not a standalone CLI
- Multi-tenant SaaS hosting — this is a local extension, not a hosted service
- Non-Salesforce CRM support — SandForge is Salesforce-specific by design

## Context

- Monorepo pnpm with 3 packages: `shared` (types/schemas), `extension` (Node.js/esbuild), `webview` (React/Vite/Tailwind)
- 558 source files, 487+ test files, 1045+ total files across packages
- v1.0.1 current — phases 00-11 complete, published on VS Code Marketplace, phase 12 planned
- VSIX package at 1.07 MB, well within marketplace limits
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
*Last updated: 2026-03-17 — Milestone v1.0.0 archived, published as v1.0.1*
