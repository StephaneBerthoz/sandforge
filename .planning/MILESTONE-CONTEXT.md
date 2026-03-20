---
version: v1.2.1
created: 2026-03-20
status: ready
---

# Milestone Context: v1.2.1 — Monitor Enrichment & Wiring

## Goals

- Wire the 5 dead backend services (ErrorLogMonitor, UserSessionMonitor, ApexLogAnalyzer, SandboxRefreshTracker, HealthCheck) end-to-end to bridge handlers + UI panels
- Build a functional alert system: seed default rules, wire AlertEngine.evaluate(), add persistence, VSCode native notifications for critical alerts
- Unify health scoring: merge HealthScoreCalculator (limits-only) and OrgHealthScoreCalculator (5-dimension) into one coherent scorer with trend feedback
- Expand governor limits coverage: email limits, Platform Events publish-side, FileStorageMB, reset countdown
- Fix API efficiency: cache /limits responses across the 3 redundant handler calls
- Improve trend data quality: real timestamps (not synthetic), historical export
- Wire GovernancePanel to backend (GovernanceEngine evaluate, GovernancePolicyStore CRUD)
- Integrate GovernanceEngine with AlertEngine (unified threshold system)

## Must-Have Features

### Wire Dead Services (WIRE-01..05)
- WIRE-01: ErrorLogMonitor → handler → ErrorLogsPanel in UI
- WIRE-02: UserSessionMonitor → handler → SessionsPanel in UI
- WIRE-03: ApexLogAnalyzer → handler → ApexInsightsPanel in UI
- WIRE-04: SandboxRefreshTracker → handler → RefreshPanel in UI
- WIRE-05: HealthCheck aggregator → wired into monitor:refresh flow

### Alert System (ALERT-01..05)
- ALERT-01: Seed default AlertDefinitions for critical limits (API 90%, Storage 85%, Async 90%)
- ALERT-02: Wire AlertEngine.evaluate() into monitor:refresh cycle
- ALERT-03: Persist alerts across extension restarts (ConfigStore)
- ALERT-04: VSCode native notifications (vscode.window.showWarningMessage) for critical/high severity
- ALERT-05: Alert history panel in UI (past triggered + resolved)

### Health Score (HEALTH-01..03)
- HEALTH-01: Unify HealthScoreCalculator + OrgHealthScoreCalculator into single scorer
- HEALTH-02: Feed trend data into health factor scoring (rising usage = lower score)
- HEALTH-03: Smooth scoring curve (replace cliff-effect step function with linear interpolation)

### Limits Coverage (LIMITS-01..04)
- LIMITS-01: Track email limits (DailyWorkflowEmails, MassEmail, SingleEmail)
- LIMITS-02: Track Platform Events publish-side (HourlyPublishedPlatformEvents, DailyStandardVolumePlatformMessages)
- LIMITS-03: Track FileStorageMB separately from DataStorageMB
- LIMITS-04: Reset countdown timer (midnight Pacific) in UI

### API Efficiency (PERF-01..02)
- PERF-01: Cache /limits response at handler level, shared across refresh/api-usage/health-score
- PERF-02: Deduplicate OrgInfoFetcher calls (already has 5-min cache, verify it's shared)

### Trend Quality (TREND-01..03)
- TREND-01: Store and use real timestamps in TrendStorage (not synthetic reconstruction)
- TREND-02: Export historical trend data (CSV with real timestamps)
- TREND-03: Fix OrgTrendAnalyzer.analyzeJobTrend single-point defect

### Governance Wiring (GOV-01..03)
- GOV-01: Wire GovernancePolicyStore CRUD to bridge handler
- GOV-02: Wire GovernanceEngine.evaluate() to bridge handler
- GOV-03: Integrate GovernanceEngine rules with AlertEngine (unified threshold → alert pipeline)

## Anti-Goals

None — no restrictions on scope. All Monitor improvements are in play.

## Constraints

- **Scope**: Solo, autonomous execution
- **Quality bar**: Production-grade — tests for every file, typecheck clean, lint clean, i18n
- **Architecture**: Monorepo pnpm, existing patterns (handler → orchestrator → service, bridge messages, Zustand stores)
- **Performance**: Use learnship workflow + parallel subagents for maximum throughput

## Open Questions

None — scope is fully defined from the exploration audit.
