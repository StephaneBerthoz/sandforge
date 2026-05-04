# Plan 03-06 Summary — ReportExporter (CSV + PDF)

**Status**: COMPLETE (6 / 7 tasks shipped + 1 PARTIAL with documented deferral)
**Wave**: 2 (Phase 03 export layer)
**Date**: 2026-05-04

## What shipped

1. **pdfkit dep + monitor:export envelope schemas** (task 01) — `pdfkit ^0.15`
   added as runtime dep, three message types added to shared
   (`monitor:export:request`, `monitor:export:progress`, `monitor:export:response`).
2. **`csv-utils.ts`** (task 02) — RFC 4180-compliant `escapeCsvField`,
   `rowToCsv`, `rowsToCsv` (49 LOC); 13 unit tests.
3. **`lttb.ts`** (task 03) — Largest-Triangle-Three-Buckets downsampler
   (Sveinn Steinarsson 2013, ~50 LOC); 7 tests (6 unit + 1 property).
4. **`ReportExporter.ts`** (tasks 04 + 05) —
   - `export(view, format, filePath)` returns `{filePath, format, bytes, durationMs}`
   - CSV path: `gatherSeries` → `rowsToCsv` → `fs.writeFile`
   - PDF path: lazy-imports `pdfkit` per `await import('pdfkit')` (cold-start
     guarantee per RESEARCH §1 + CONTEXT D-03-6); A4 portrait, per-series
     block with sparkline + min/avg/max/n stats
   - Sparkline rendered via pdfkit primitives (moveTo + lineTo + stroke)
     instead of inline SVG — `pdfkit.svg()` doesn't exist without
     `svg-to-pdfkit` shim, and lines give the same visual result with one
     fewer dep
   - Multi-part splitting at 50 series/PDF (P-03.4) → `out.part1.pdf` +
     `out.part2.pdf` + `out.part3.pdf`
   - Progress emissions via optional bridge (best-effort, never throws)
5. **9 tests** (task 07) — 5 CSV unit + 3 PDF unit + 1 vertical slice
   (1000-sample × 5-series exports both formats, < 10 MB each, valid
   magic bytes). All PASS in 695 ms.

## Task 06 PARTIAL — extension.ts wiring deferred to Phase 06 BP-01

The plan-spec'd wire was `bridge.registerHandler('monitor:export:request', ...)`
at extension.ts activate. That API doesn't exist in this codebase — bridge
handlers live as switch-cases in `MonitorOpsHandler`. Wiring requires
either:
- (a) Adding a new `monitor:export:*` case to MonitorOpsHandler that needs
  access to the MonitorOrchestrator's `timeSeriesStore` instance (must be
  the SAME instance, not a fresh one per call — fresh loses data), OR
- (b) Building a sibling handler that takes a constructed `ReportExporter`
  via deps.

Both paths require `MonitorOrchestrator` to be a singleton in `services.ts`
so handlers can pick up the same instance. That refactor is **Phase 06
BP-01** ("DI hardening — orchestrator singletons + factory cleanup"),
already on the cross-cutting-audit backlog (`audit-2026-05-02-cross-cutting.md`).

**Status**: ReportExporter is shipped and consumable today via:

```typescript
const exporter = new ReportExporter(orchestrator.timeSeriesStore);
await exporter.export({ view: 'series', orgId, seriesIds, fromMs, toMs }, 'pdf', filePath);
```

The bus envelope contract (request/progress/response) shipped in task 01 is
ready — only the binding to a switch case remains.

## Commits

- `80082bf` feat(monitor)[plan-03-06-task-01]: pdfkit dep + monitor:export envelope
- `9ae77c7` feat(monitor)[plan-03-06-task-02]: csv-utils RFC 4180
- `c04567e` feat(monitor)[plan-03-06-task-03]: LTTB + samplesToPoints
- `d4f8f72` feat(monitor)[plan-03-06-task-04]: ReportExporter CSV path + scaffolding
- `825a218` feat(monitor)[plan-03-06-task-05]: ReportExporter PDF path with lazy pdfkit
- `0c7cd7b` docs(monitor)[plan-03-06-task-06]: defer extension.ts wiring (Phase 06 BP-01)
- `1722415` test(monitor)[plan-03-06-task-07]: 9 tests incl. 1000×5 e2e
- `(this summary)` docs

## Test impact

- Tests added: +29 (13 csv-utils + 7 lttb + 9 ReportExporter)
- Total before Plan 03-06: 8692
- Total after: 8721
- Regressions: 0

## Risks closed

- **P-03.4 (PDF cold-start cost)** — pdfkit lazy-imported via
  `await import('pdfkit')`; not loaded until Export clicked. Per-PDF cap
  at 50 series prevents runaway memory.
- **Stream-pipe to disk** — pdfkit emits chunks to `fs.createWriteStream`,
  doesn't buffer the full PDF in memory.

## Risks opened

- **Task 06 wiring deferred** — Phase 06 BP-01 must MonitorOrchestrator
  singleton + plumb ReportExporter through MonitorOpsHandler. Until then,
  the bus envelope is unconsumed.

## Next plan

**03-07 — Multi-org overview** (Wave 2, last plan of Phase 03):
backend FleetSummaryService polls connected orgs, webview MonitorOverviewPage
subscribes via Zustand `useFleetStore`, `useVisibilityGate` posts
`monitor:visibility` for poll suspension. Final plan of Phase 03.
