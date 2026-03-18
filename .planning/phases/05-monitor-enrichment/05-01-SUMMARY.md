# Plan 05-01 Summary

**Completed:** 2026-03-18
**Phase:** 05 -- Monitor Enrichment

## What was built

Documented a competitor benchmark comparing SandForge Monitor against SF Inspector, ORGanizer, Org Monitor, and DevOps Center. Implemented the top 5 feature gaps: StorageBreakdownPanel with Recharts donut chart showing per-object record counts, DeploymentTimeline using the existing Timeline UI component, LimitExportButton generating CSV via Blob API, ApiUsagePanel with per-category ProgressBars sorted by usage, and registered the missing monitor:health-score handler route in ExtensionHandlers.

## Key files

- `.planning/phases/05-monitor-enrichment/05-BENCHMARK.md`: Competitor comparison matrix with 14 features across 4 competitors
- `packages/shared/src/types/messages.types.ts`: Added StorageObjectEntry, DeploymentEntry, ApiUsageCategory types and 6 new message interfaces
- `packages/extension/src/bridge/handlers/MonitorOpsHandler.ts`: Added handleStorage, handleDeployments, handleApiUsage, handleHealthScore methods
- `packages/extension/src/bridge/ExtensionHandlers.ts`: Registered monitor:health-score, monitor:storage, monitor:deployments, monitor:api-usage routes
- `packages/webview/src/pages/Monitor/StorageBreakdownPanel.tsx`: Donut chart + per-object table
- `packages/webview/src/pages/Monitor/ApiUsagePanel.tsx`: Per-category API usage with ProgressBars and warning/critical badges
- `packages/webview/src/pages/Monitor/DeploymentTimeline.tsx`: Timeline display of recent deployments with status indicators
- `packages/webview/src/pages/Monitor/LimitExportButton.tsx`: CSV export via Blob + URL.createObjectURL
- `packages/webview/src/pages/Monitor/MonitorPage.tsx`: Integrated all 4 new components into dashboard layout
- `packages/webview/src/i18n/locales/en.json` / `fr.json`: Added monitor.storage.*, monitor.deployments.*, monitor.apiUsage.*, monitor.export.* keys

## Decisions made

- Used EntityDefinition SOQL query (RecordCount field) for storage breakdown rather than describe-based estimation -- more accurate and available in standard API
- DeployRequest SOQL query for deployments instead of DeploymentTracker.getHistory() -- DeployRequest gives richer data (component counts, error counts) directly from Salesforce
- CSV format includes 5 columns: Limit Name, Max, Remaining, Used %, Trend Direction -- trend direction computed from sparkline slope
- Badge wrapping pattern: Badge component does not spread extra HTML props, so data-testid attributes are placed on a wrapping span element
- Health-score handler reuses existing HealthScoreCalculator.calculate() for consistency with the refresh handler

## Deviations from plan

- Badge component does not accept data-testid prop -- wrapped in span elements instead (minor pattern deviation, no functional impact)
- handleHealthScore sends error on the response type itself (monitor:health-score:response) rather than a generic error type, for consistency with how the webview useBridgeQuery expects responses

## Notes for downstream

- Plan 05-02 (Dashboard Refresh UX) can build on these new panels: loading overlays, stale indicators, and error retry apply to StorageBreakdownPanel, ApiUsagePanel, and DeploymentTimeline
- The COALESCE(RecordCount, 0) in the storage SOQL may not work on all org editions -- consider a fallback query if EntityDefinition.RecordCount is null
- 2175 tests passing across 218 test files, typecheck clean across all 3 packages
