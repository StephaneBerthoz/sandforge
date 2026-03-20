# Plan 03-02 Summary

**Completed:** 2026-03-20
**Phase:** 03 -- Alerts & Governance

## What was built

Created GovernanceOpsHandler, a DomainHandler that wires GovernancePolicyStore CRUD operations and GovernanceEngine evaluation to the bridge message system. The handler responds to 8 governance message types (list, get, save, delete, export, import, evaluate, templates). The `governance:evaluate` endpoint fetches live Salesforce limits, builds MetricValues with usedPercent computation, runs GovernanceEngine.evaluatePolicy, and feeds failing rules into the shared AlertEngine (GOV-03 governance-to-alert pipeline). The handler was registered in ExtensionHandlers alongside all other domain handlers, sharing the AlertEngine instance from MonitorOpsHandler via its getAlertEngine() accessor.

## Key files

- `packages/extension/src/bridge/handlers/GovernanceOpsHandler.ts`: DomainHandler implementing all 8 governance message types with GOV-03 alert pipeline
- `packages/extension/src/bridge/handlers/GovernanceOpsHandler.test.ts`: 13 tests covering CRUD operations, evaluate with mock connection, GOV-03 alert feed, and edge cases
- `packages/extension/src/bridge/ExtensionHandlers.ts`: Updated to import, instantiate, and route GovernanceOpsHandler with shared AlertEngine

## Decisions made

- GovernanceOpsHandler receives AlertEngine from MonitorOpsHandler.getAlertEngine() at construction time in ExtensionHandlers, enabling immediate GOV-03 pipeline without deferred wiring
- Policy summaries returned by governance:policies:list include ruleCount (derived from rules.length) to match webview GovernancePolicySummary interface
- MetricValues keys use raw limit names (e.g. DailyApiRequests) not transformed names, since GovernanceEngine rule conditions reference metric names directly
- Invalid JSON on import is handled via the standard sendHandlerError path, returning the import response type so the webview can distinguish import errors from general governance errors

## Deviations from plan

- MonitorOpsHandler.getAlertEngine() was already present (added by Plan 03-01 running in parallel), so the accessor addition was idempotent

## Notes for downstream

- GovernancePanel.tsx (Plan 03-03) can use useMessageResponse hooks for all 8 governance message types
- The governance:evaluate endpoint does NOT use the 30s limits cache from MonitorOpsHandler (it fetches directly); this is intentional since governance evaluation is an explicit user action, not a periodic refresh
- Alert definitions for governance-sourced alerts use the `governance:` prefix on metric names to distinguish them from limit-sourced alerts
