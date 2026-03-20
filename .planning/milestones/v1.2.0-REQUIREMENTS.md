# Requirements: v1.2.0 — Forge UX & Reliability

## v1 — Must Ship

### Bugs (BUG-01..09)

- [x] **BUG-01** — Abort signal reaches ForgeExecutor (ForgeHandler.ts + ForgeOrchestrator.ts)
- [x] **BUG-02** — Pause/Resume wired end-to-end to ForgeExecutor
- [x] **BUG-03** — dryRun flag honored in SeedOpsHandler.handleExecute
- [x] **BUG-04** — Grappe hero removed from SidePanel.tsx
- [x] **BUG-05** — LiveGraph onIncludeToggle passed in ForgeExecution (or checkboxes hidden)
- [x] **BUG-06** — Dynamic object resolution via describeGlobal (replace static ID prefix map)
- [x] **BUG-07** — Extracted record ID sent to backend (not raw URL)
- [x] **BUG-08** — idRemaps KPI shows correct value in ForgeResults
- [x] **BUG-09** — Fix i18n key in ForgeNodeDetail (common.object → forge.fields)

### UX Quick Wins (UX-01..10)

- [x] **UX-01** — Auto-select source org from global selectedOrgId on mount
- [x] **UX-02** — Auto-detect org from pasted Salesforce URL domain
- [x] **UX-03** — Source === Target guard (prevent same org selection)
- [x] **UX-04** — Swap orgs button between source/target OrgCards
- [x] **UX-05** — Disabled CTA hint (show what's missing before Discover is enabled)
- [x] **UX-06** — "Execute Forge" label → "Review & Execute" in Discovery
- [x] **UX-07** — Depth chip tooltips explaining direct/full/custom
- [x] **UX-08** — Ctrl+Enter submit in SOQL/AI textareas
- [x] **UX-09** — Preview panel contextual message for non-Record tabs
- [x] **UX-10** — Remove redundant Preview button or transform to Refresh

### UX Enhancements (UX-11..23)

- [x] **UX-11** — Table/list view alternative to LiveGraph in Discovery
- [x] **UX-12** — Custom OrgCard dropdown (replace native select, match SidePanel quality)
- [x] **UX-13** — "Forge Again" keeps config (only resets results, not orgs/input/depth)
- [x] **UX-14** — Logs persisted to store, available in ForgeResults
- [x] **UX-15** — Copy all / Export logs buttons in LogStream
- [x] **UX-16** — Pause auto-scroll when user scrolls up
- [x] **UX-17** — ETA (estimated time remaining) in execution view
- [x] **UX-18** — Sort/Filter in ForgeResults table
- [x] **UX-19** — Duration + timestamp in ForgeResults
- [x] **UX-20** — Retry Discovery button on error state
- [x] **UX-21** — Select All / Deselect All nodes in Discovery
- [x] **UX-22** — Node search/filter in graph for large orgs
- [x] **UX-23** — Template management (create/delete/edit inline)

### Performance (PERF-01..06)

- [x] **PERF-01** — Dagre layout computed once, node status updates separate
- [x] **PERF-02** — Stable callbacks in LiveGraph (avoid useMemo bust)
- [x] **PERF-03** — KPIs memoized in ForgeExecution
- [x] **PERF-04** — Auto-scroll debounce with requestAnimationFrame
- [x] **PERF-05** — LogStream avoid array copy for "All" filter
- [x] **PERF-06** — Adaptive heights (replace hardcoded h-[480px], h-[400px], max-h-64)

### Backend Hardening (BE-01..08)

- [x] **BE-01** — Structured error payloads { message, code, retryable }
- [x] **BE-02** — Preview enriched: estimatedRecordCount, totalFieldCount, estimatedSize
- [x] **BE-03** — Timeouts on forge:plan, forge:compliance, forge:metadata-diff handlers
- [x] **BE-04** — Operation lifecycle events (started/completed) for plan/compliance/metadata-diff
- [x] **BE-05** — operationId included in forge:execute:response
- [x] **BE-06** — Compliance framework dropdown triggers backend request
- [x] **BE-07** — Real Bulk API 2.0 IDs instead of synthetic bulk-${i}
- [x] **BE-08** — Delete deprecated ForgeOpsHandler.ts

### Cleanup (CLN-01..06)

- [x] **CLN-01** — Remove MetadataDiffBanner placeholder call (diffs always [])
- [x] **CLN-02** — Wire estimated graph stats from preview response in ForgeInput
- [x] **CLN-03** — Deduplicate log filter bars (ForgeExecution vs LogStream internal)
- [x] **CLN-04** — Remove redundant canPreview (merge with auto-preview logic)
- [x] **CLN-05** — Convert logIdCounter from module-level to useRef
- [x] **CLN-06** — Clean stale plan/complianceReport from store on new config

### SidePanel Refonte (SP-01..06)

- [x] **SP-01** — Improved org switcher (sort connected first, show selected org status accurately)
- [x] **SP-02** — Compact mode for short viewports (collapse heroes)
- [x] **SP-03** — Simplify/collapse Quick Metrics section
- [x] **SP-04** — Fix favorites discovery (visible stars, not hover-only)
- [x] **SP-05** — Visual hierarchy improvements (section labels, hero sizing)
- [x] **SP-06** — Remove version badge clutter, move to Settings

### Accessibility (A11Y-01..07)

- [x] **A11Y-01** — ARIA roles on ForgeReview tabs (tablist/tab/tabpanel)
- [x] **A11Y-02** — aria-pressed on filter buttons (LogStream + ForgeExecution)
- [x] **A11Y-03** — role="log" + aria-live="polite" on LogStream container
- [x] **A11Y-04** — Depth chips as radiogroup with arrow-key navigation
- [x] **A11Y-05** — Fix LiveGraph container role (remove role="img" on interactive graph)
- [x] **A11Y-06** — ProgressNode checkbox uses onChange (not onClick)
- [x] **A11Y-07** — Contrast fix for skipped status in ForgeNodeDetail

## v2 — Next Milestone Candidates

- [ ] Monitor enrichment from OrgMonitor (8 features: email limits, processing quotas, platform events, configurable polling, threshold alerts, status bar, CLI interception, baseline+delta)
- [ ] Scheduler implementation (cron-based pipeline execution)
- [ ] Real-Time Sync via CDC/Streaming API

## Out of Scope

- Seed/Sync/Compare/DataOps/Automation page changes (except surgical BUG-03 fix in SeedOpsHandler)
- New modules or pages
- Monitor dashboard changes
- Non-Salesforce CRM support
