# Requirements: v1.2.1 — Monitor Enrichment & Wiring

## v1 — Must Ship

### Wire Dead Services (WIRE-01..05)

- [ ] **WIRE-01** — ErrorLogMonitor wired to bridge handler + ErrorLogsPanel in Monitor UI
- [ ] **WIRE-02** — UserSessionMonitor wired to bridge handler + SessionsPanel in Monitor UI
- [ ] **WIRE-03** — ApexLogAnalyzer wired to bridge handler + ApexInsightsPanel in Monitor UI
- [ ] **WIRE-04** — SandboxRefreshTracker wired to bridge handler + RefreshPanel in Monitor UI
- [ ] **WIRE-05** — HealthCheck aggregator wired into monitor:refresh flow

### Alert System (ALERT-01..05)

- [ ] **ALERT-01** — Default AlertDefinitions seeded for critical limits (API 90%, Storage 85%, Async 90%, Email 80%, FileStorage 85%)
- [ ] **ALERT-02** — AlertEngine.evaluate() called on every monitor:refresh cycle
- [ ] **ALERT-03** — Alert state persisted across extension restarts (ConfigStore)
- [ ] **ALERT-04** — VSCode native notifications (showWarningMessage/showErrorMessage) for critical/high severity alerts
- [ ] **ALERT-05** — Alert history panel in Monitor UI (triggered, acknowledged, resolved timeline)

### Health Score Unification (HEALTH-01..03)

- [x] **HEALTH-01** — Merge HealthScoreCalculator + OrgHealthScoreCalculator into single unified scorer
- [x] **HEALTH-02** — Trend data feeds into health factor scoring (rising usage trend = lower sub-score)
- [x] **HEALTH-03** — Smooth scoring curve (linear interpolation replaces cliff-effect step function)

### Limits Coverage (LIMITS-01..04)

- [ ] **LIMITS-01** — Email limits tracked: DailyWorkflowEmails, MassEmail, SingleEmail displayed in ApiUsagePanel
- [ ] **LIMITS-02** — Platform Events publish-side tracked: HourlyPublishedPlatformEvents, DailyStandardVolumePlatformMessages
- [ ] **LIMITS-03** — FileStorageMB tracked separately from DataStorageMB with dedicated display
- [ ] **LIMITS-04** — Reset countdown timer (midnight Pacific) displayed in Monitor header

### API Efficiency (PERF-01..02)

- [x] **PERF-01** — /limits response cached at handler level, shared across monitor:refresh, monitor:api-usage, monitor:health-score
- [x] **PERF-02** — OrgInfoFetcher 5-min cache verified shared across handler calls (no duplicate SOQL)

### Trend Quality (TREND-01..03)

- [ ] **TREND-01** — TrendStorage stores real timestamps; TrendCharts uses real timestamps on x-axis
- [ ] **TREND-02** — Export historical trend data as CSV with real timestamps via LimitExportButton
- [x] **TREND-03** — Fix OrgTrendAnalyzer.analyzeJobTrend single-point defect (accumulate history, not single snapshot)

### Governance Wiring (GOV-01..03)

- [ ] **GOV-01** — GovernancePolicyStore CRUD wired to bridge handler (create/read/update/delete/export/import)
- [ ] **GOV-02** — GovernanceEngine.evaluate() wired to bridge handler, results displayed in GovernancePanel
- [ ] **GOV-03** — GovernanceEngine threshold violations feed into AlertEngine (unified threshold → alert pipeline)

## v2 — Next Milestone Candidates

- [ ] CDC/Streaming API integration for real-time limit change events
- [ ] Per-user / per-integration API consumption breakdown
- [ ] PDF export and scheduled email reports
- [ ] External monitoring integration (Datadog, PagerDuty, Slack webhooks)
- [ ] Cross-org comparison dashboard
- [ ] Unused metadata detection (Salesforce Optimizer parity)

## Out of Scope

- Forge/Seed/Sync/Compare/DataOps/Automation module changes
- New modules or pages (Monitor enrichment only)
- UI redesign of Monitor layout (enrich existing panels, add new ones in same layout)
- Multi-tenant / hosted monitoring service
