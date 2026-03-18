# Phase 5: Monitor Enrichment - Context

**Gathered:** 2026-03-18
**Status:** Ready for planning

<domain>
## Phase Boundary

Make Monitor best-in-class. Competitor benchmark documented, top 5 feature gaps implemented, dashboard refresh UX polished with loading states, error recovery, and stale data indicators.

</domain>

<decisions>
## Implementation Decisions

### MON-01: Competitor Benchmark
- Document comparison vs Salesforce Inspector, ORGanizer, Org Monitor in a benchmark report
- Write to .planning/phases/05-monitor-enrichment/05-BENCHMARK.md
- Compare: limits display, health scoring, storage breakdown, deployment tracking, API profiling, multi-org, alerts
- Current SandForge Monitor has 8 dashboard sections, 15+ backend analyzers, but gaps in storage/deployment/export

### MON-02: Top 5 Feature Gaps
Based on competitor analysis and existing backend infrastructure:

1. **Storage Breakdown Panel** -- Query EntityDefinition or EntityParticle for per-object storage usage. Add donut chart + table panel to MonitorPage.
2. **Deployment History Timeline** -- DeploymentTracker.ts already exists but not wired to UI. Create DeploymentTimeline panel using Timeline component. Wire via new message type monitor:deployments.
3. **Limit History Export** -- TrendStorage already stores snapshots. Add CSV export button to TrendCharts section. Extend period selector to 90d.
4. **API Usage Analytics** -- Parse Sforce-Limit-Info headers (already done by sforceLimitParser.ts). Create API breakdown table showing per-category usage.
5. **monitor:health-score Handler Route** -- Fix pending todo: register handler route so OrgHealthPanel's scan button actually works.

Key: Most backends exist, this is primarily UI wiring + new panel components.

### MON-03: Dashboard Refresh UX
- Loading overlays per panel (dim + mini spinner) during refresh
- Error retry banner: "Failed to refresh — [Retry] [Details]"
- Stale data indicator after 2 minutes: Badge "Data from Xm ago — [Refresh now]"
- Partial refresh: if one section fails, still show others (non-blocking)
- Connection loss detection: warning after 3 consecutive auto-refresh failures

### Claude's Discretion
- Chart library choice for donut/pie (Recharts already used for area charts)
- Deployment timeline detail level
- Export CSV format
- Stale threshold timing

</decisions>

<code_context>
## Existing Code Insights

### Backend Ready (Just Need UI Wiring)
- `DeploymentTracker.ts` -- tracks deployments, not wired to UI
- `TrendStorage.ts` -- stores historical limit snapshots
- `sforceLimitParser.ts` -- parses Sforce-Limit-Info headers
- `OrgInfoFetcher.ts` -- fetches org metadata counts
- `ApexLogAnalyzer.ts` -- debug log analysis (not exposed)
- `ChangeDataCaptureListener.ts` -- CDC events (not exposed)

### Current Monitor Dashboard
- 8 sections: KPIs, OrgInfo, LiveOps, Trends, Jobs, Limits, Anomalies, Predictions, Alerts
- 16 component files in pages/Monitor/
- useMonitorPageData.ts: central data hook with auto-refresh (30s)
- Recharts for area charts, custom SVG for gauges
- 36+ i18n keys under monitor.*

### UI Components Available
- Timeline component -- for deployment history
- KPICard -- for additional metrics
- Badge -- for stale data warning
- Skeleton -- for loading states
- ErrorBanner -- for error display
- ProgressBar -- for usage visualization

</code_context>

<deferred>
## Deferred Ideas

- Multi-org comparison dashboard -- v1.2
- Slack/Teams webhook notifications -- v1.2
- Custom metric builder -- v1.2
- Debug log viewer panel -- v1.2

</deferred>

---
*Phase: 05-monitor-enrichment*
*Context gathered: 2026-03-18*
