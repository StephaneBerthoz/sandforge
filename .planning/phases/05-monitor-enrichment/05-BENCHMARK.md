# Monitor Competitor Benchmark

**Date:** 2026-03-18
**Phase:** 05 -- Monitor Enrichment
**Purpose:** Document feature comparison vs. market alternatives to identify and close SandForge Monitor gaps.

## Competitors Analyzed

1. **Salesforce Inspector** -- Chrome extension, free, open-source. Popular with admins for quick data/limits inspection.
2. **ORGanizer for Salesforce** -- Free Chrome extension. Multi-org management, quick links, bookmarks.
3. **Salesforce Org Monitor** -- AppExchange managed package. Scheduled limit checks, email alerts.
4. **DevOps Center** -- Native Salesforce feature. Deployment tracking, change management.

## Feature Matrix

| Feature | SF Inspector | ORGanizer | Org Monitor | DevOps Center | SandForge (Before Phase 5) | SandForge (After Phase 5) |
|---|---|---|---|---|---|---|
| **Governor Limits Display** | Basic table | No | Scheduled snapshot | No | Full table + progress bars + sorting | Same + badges + export |
| **Health Scoring** | No | No | Basic (3-tier) | No | Detailed (multi-factor, radar chart) | Same (already best-in-class) |
| **Storage Breakdown** | Record counts via Data Export | No | Aggregate only | No | Aggregate KPI only | Per-object donut chart + table |
| **Deployment Tracking** | No | No | No | Full (CI/CD) | Backend only (DeploymentTracker) | Timeline panel with status badges |
| **API Usage Profiling** | Shows header info | No | Daily totals only | No | KPI + trend chart | Per-category breakdown table |
| **Trend Charts** | No | No | 7-day email digest | No | Area charts (multi-series) | Same + CSV export |
| **Alerts/Anomalies** | No | No | Email threshold alerts | No | Real-time alerts panel + AI scan | Same |
| **Active Jobs View** | No | No | No | No | Grouped table with abort | Same |
| **Multi-Org Support** | One at a time | Multi-org switcher | Per-org install | Per-org | Full multi-org + OrgSwitcher | Same |
| **Limit History Export** | No | No | No | No | No | CSV export button |
| **Audit Trail** | No | No | Email log | No | AuditTrailViewer (Reports) | Same |
| **Live Operations** | No | No | No | No | Real-time operation panel | Same |
| **Predictions (Time-to-Limit)** | No | No | No | No | ML-based predictions tile | Same |
| **Offline Support** | No | No | No | No | OfflineManager queuing | Same |

## Gap Analysis

### Gaps Identified (Before Phase 5)

1. **Storage Breakdown** -- Only aggregate KPI (total GB used/max). No per-object breakdown. SF Inspector shows record counts; Org Monitor shows totals. SandForge should show per-object record counts with visual breakdown.

2. **Deployment History** -- DeploymentTracker exists in backend but is not wired to UI. DevOps Center has full deployment tracking. SandForge should display recent deployments in a timeline.

3. **Limit History Export** -- No competitor offers CSV export. SandForge should add this as a differentiator -- export current limits + trend data for offline analysis or compliance reporting.

4. **API Usage Analytics** -- Only aggregate DailyApiRequests shown. sforceLimitParser already captures per-category data. SandForge should display per-category breakdown (Bulk, Streaming, REST, etc.).

5. **Health Score Handler Route** -- OrgHealthPanel UI exists but the `monitor:health-score` message has no registered route in ExtensionHandlers. The Scan button is non-functional.

### SandForge Advantages (Already Present)

- **Multi-factor Health Score** with radar chart -- no competitor has this
- **AI Anomaly Scan** -- unique to SandForge
- **Live Operations Panel** -- real-time ETL operation monitoring
- **Time-to-Limit Predictions** -- ML-based forecasting
- **Multi-org with OrgSwitcher** -- seamless org switching
- **Auto-refresh** with configurable interval

## Phase 5 Deliverables

| Gap | Solution | Priority |
|-----|----------|----------|
| Storage Breakdown | StorageBreakdownPanel with Recharts donut chart | P1 |
| Deployment History | DeploymentTimeline using existing Timeline component | P1 |
| Limit Export | LimitExportButton generating CSV via Blob API | P2 |
| API Usage | ApiUsagePanel with per-category ProgressBars | P1 |
| Health Score Route | Register monitor:health-score in ExtensionHandlers | P0 (bug fix) |

## Conclusion

After Phase 5, SandForge Monitor will be the most comprehensive sandbox monitoring tool available. The only area where DevOps Center has an edge (full CI/CD deployment management) is outside SandForge's scope -- SandForge focuses on ETL and sandbox health, not deployment pipelines. Every other monitoring feature is matched or exceeded.
