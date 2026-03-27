---
version: v1.2.3
created: 2026-03-27
status: ready
---

# Milestone Context: v1.2.3

## Goals

- **Complete the v2 backlog**: ship all 7 deferred features from v1.2.2 (sync scheduling, sync history, CSV seed, seed clone, AI personas, conflict resolution, CDC real-time sync)
- **Scale for enterprise**: pagination, streaming for 100K+ records, chunked execution, memory management — make SandForge work on massive orgs without breaking a sweat
- **Simplify for small projects**: fewer clicks, smarter auto-detection, progressive disclosure — trailblazers and solo devs should never feel overwhelmed
- **Optimize & harden**: performance pass on existing features, backend reliability improvements, error recovery, caching, resource management

## Must-Have Features

### Sync Scheduling (SCHED-xx)
- Cron-based sync scheduling UI (backend exists, wire the UI)
- Schedule management: create, edit, pause, resume, delete schedules
- Schedule history: past executions with status, duration, record counts
- Timezone support and calendar-based exclusions

### Sync History & Audit Log (HIST-xx)
- Past sync executions with timestamps, durations, and per-object results
- Filterable/searchable audit log
- Re-run from history (replay a past sync config)
- Export history as CSV/JSON

### Seed from CSV (CSV-xx)
- CSV upload UI in Seed wizard (ruleType exists in backend)
- Column mapping: CSV columns → Salesforce fields
- Preview imported data before execution
- Validation errors shown inline (bad types, missing required fields)

### Seed Clone Mode (CLONE-xx)
- Copy existing records from one org to another via Seed
- Object selection + filter (SOQL WHERE clause)
- Relationship remapping (parent IDs re-linked in target)
- Delta clone: only new/modified records since last clone

### AI Persona Catalogue (PERSONA-xx)
- Pre-built persona library (Startup, Enterprise, Healthcare, Finance, Education, Retail, Manufacturing, Government, Non-Profit, Tech)
- Persona preview: sample data generated before committing
- Persona customization: adjust field weights, value distributions
- Persona applied per-object or globally in Seed wizard

### Sync Conflict Resolution UI (CONFLICT-xx)
- Manual merge screen for bidirectional sync conflicts
- Side-by-side diff viewer (source vs target record)
- Per-field resolution: pick source, pick target, or edit manually
- Bulk resolution: "apply source to all" / "apply target to all"
- Conflict history log

### CDC Real-Time Sync (CDC-xx)
- Change Data Capture subscription UI (backend exists)
- Real-time event stream viewer (live changes as they happen)
- Auto-sync on change: configure objects to sync automatically on CDC events
- Backend hardening: reconnection, replay, error recovery, backpressure
- Pause/resume live stream

### Scale & Performance (SCALE-xx)
- Pagination on all list views (objects, records, configs, templates, history) — handle 1000+ items
- Streaming execution for 100K+ record syncs (chunked, memory-efficient)
- Virtual scrolling on large data tables
- Background execution: long operations run without blocking the UI
- Memory management: dispose unused resources, garbage-collect stale caches
- Progress streaming via Server-Sent Events or WebSocket (replace polling)

### Small Project Optimizations (SIMPLE-xx)
- Auto-detection of recommended actions based on org state (empty sandbox → suggest seed, stale data → suggest sync)
- "Just Do It" mode: single button that picks the best action automatically
- Reduced wizard steps for simple cases (< 5 objects → skip review step)
- Smart defaults everywhere: auto-select the most likely option at each step
- Contextual help tooltips for first-time users

### Existing Feature Polish (POLISH-xx)
- Error recovery: retry failed operations with exponential backoff in UI
- Caching audit: review all TTLs, add cache invalidation on org switch
- Loading states: skeleton screens everywhere (no spinners)
- Keyboard shortcuts for power users (navigate modules, trigger actions)
- Batch operation progress: per-record granularity instead of per-batch
- Notification center: centralized view of all alerts, completions, errors

## Anti-Goals

None — full scope, no restrictions.

## Constraints

- **Scope**: Solo developer, no deadline pressure
- **Quality bar**: Production-grade (tests, i18n, a11y, error handling)
- **Off-limits areas**: None
- **Architecture constraints**: Existing monorepo structure, TypeScript strict, Zod validation, jsforce v3

## Open Questions

- CDC backend: how mature is the existing implementation? May need significant hardening.
- Conflict resolution: needs a proper diff algorithm — evaluate existing libraries vs custom.
- Streaming execution: WebSocket vs Server-Sent Events vs chunked postMessage — evaluate tradeoffs.
