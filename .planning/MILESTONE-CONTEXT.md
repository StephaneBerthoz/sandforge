---
version: v1.2.0
created: 2026-03-20
status: ready
---

# Milestone Context: v1.2.0

## Goals

- Fix all 9 identified bugs in the Forge module (abort/pause disconnected, dryRun ignored, Grappe hero leak, dead checkboxes, static ID prefix map, raw URL sent to backend, wrong KPI, wrong i18n key)
- Deliver 23 UX improvements making Forge a polished, friction-free experience (auto-org detection, swap orgs, table view, persistent logs, ETA, node search, template management, etc.)
- Resolve 6 performance issues (Dagre layout separation, stable callbacks, memoized KPIs, scroll debounce, adaptive heights)
- Harden 8 backend paths (structured error codes, enriched preview, timeouts, operation lifecycle events, abort/pause wiring, bulk ID fix)
- Clean up 6 dead code items (MetadataDiffBanner stub, empty stats panel, double filter bars, deprecated handler, redundant canPreview, module-level counter)
- Refonte complète du SidePanel VSCode (Grappe removal, org switcher amélioré, compact mode, simplified metrics, visual hierarchy)
- Full accessibility pass on all Forge components (ARIA roles, aria-pressed, aria-live, role="log", keyboard navigation, contrast fixes)

## Must-Have Features

- B1: Abort signal reaches ForgeExecutor
- B2: Pause/Resume wired end-to-end
- B3: dryRun flag honored in SeedOpsHandler
- B4: Grappe hero removed from SidePanel
- B6: Dynamic object resolution via describeGlobal (replace static prefix map)
- B7: Extracted record ID sent to backend (not raw URL)
- U1: Auto-select source org from global store
- U2: Auto-detect org from pasted Salesforce URL domain
- U3: Source === Target guard
- U11: Table/list view alternative to LiveGraph
- U14: Logs persisted to store, available in ForgeResults
- P1: Dagre layout computed once, node data updates separate
- K1: Structured error payloads { message, code, retryable }
- K6: Compliance framework dropdown actually triggers backend request
- SidePanel refonte: new layout, improved org switcher, compact mode

## Anti-Goals

- **No Monitor enrichment** — deferred to v1.3.0 (8 OrgMonitor features identified, parked)
- **No new modules** — no new-module scaffolding, no new pages
- **No CDC/Real-Time Sync** — stays Coming v2.0
- **No Scheduler** — stays Coming v1.2 overlay (may renumber to v1.3)
- **No Seed/Sync/Compare/DataOps/Automation changes** — only Forge module + SidePanel + shared components (LogStream, LiveGraph)
- **Exception**: B3 (dryRun) and K7 (bulk IDs) touch SeedOpsHandler — minimal, surgical fixes only

## Constraints

- **Scope**: Solo developer, no hard deadline
- **Quality bar**: Production-grade — every touched file gets a .test.ts, build stays green, i18n for all new strings
- **Architecture**: LiveGraph (React Flow + Dagre) is kept — table view is an alternative mode, not a replacement
- **SidePanel**: Full refonte (not just bugfix) — new layout, org switcher rework, compact mode, Grappe removal, metric simplification
- **Accessibility**: Included — ARIA roles, keyboard navigation, contrast, screen reader support on all Forge components
- **Off-limits**: Seed wizard, Sync wizard, Compare page, DataOps page, Automation canvas, Monitor dashboard (except shared components like LogStream/LiveGraph used by Forge)
- **Tech stack**: Same as v1.1.0 — React 18, Vite, Tailwind, Shadcn/ui, Zustand, React Flow, Dagre

## Open Questions

- Should the SidePanel org switcher expose source+target (Forge-aware) or stay single-org (module-agnostic)?
- Should ForgeResults persist across extension reload (ConfigStore) or only in-memory (Zustand)?
- K7 (bulk IDs): Is it feasible to retrieve real IDs from Bulk API 2.0 job results, or is a synthetic mapping acceptable?
