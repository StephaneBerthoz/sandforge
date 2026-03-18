# Plan 03-03 Summary

**Completed:** 2026-03-18
**Phase:** 03 -- UX Cleanup & Ghost Features

## What was built

Ghost feature cleanup for Scheduler and RealTime CDC modules. Created a NoOpHandler that returns clean "feature not available" responses for all 9 scheduler/realtime message types, preventing unhandled message warnings. Added "Coming Soon" overlays to SchedulerCalendar (v1.2) and RealTimeSyncPanel (v2.0) with disabled controls and reduced opacity. Audited messages.types.ts and added missing MonitorStartRequest/MonitorTrendsRequest type definitions.

## Key files

- `packages/extension/src/bridge/handlers/NoOpHandler.ts`: DomainHandler returning {success: false, comingSoon: true} for 9 ghost types
- `packages/extension/src/bridge/handlers/NoOpHandler.test.ts`: 7 tests covering all no-op handler behavior
- `packages/extension/src/bridge/ExtensionHandlers.ts`: NoOpHandler route registration
- `packages/webview/src/pages/Automation/SchedulerCalendar.tsx`: "Coming in v1.2" badge + disabled overlay
- `packages/webview/src/pages/Sync/RealTimeSyncPanel.tsx`: Simplified to static disabled preview with "Coming in v2.0" badge
- `packages/shared/src/types/messages.types.ts`: Added MonitorStartRequest, MonitorTrendsRequest types
- `packages/webview/src/i18n/locales/*.json`: scheduler.comingSoon and sync.realtime.comingSoon in all 6 locales

## Decisions made

- RealTimeSyncPanel simplified to static display (removed hooks/mutations/state since feature is unavailable) rather than keeping complex code behind a disabled overlay
- Badge component does not accept data-testid; wrapped in span elements for test access
- NoOpHandler uses Pick<HandlerDeps, 'nextId' | 'broker'> rather than full HandlerDeps since it needs minimal deps

## Deviations from plan

- Plan said "monitor:health-score: no UI consumer -- REMOVE" but OrgHealthPanel.tsx uses useBridgeMutation('monitor:health-score'). Kept the type definitions to avoid breaking the UI consumer.
- Plan mentioned removing orphaned types with zero handler AND zero consumer, but the audit found no such types beyond the scheduler/realtime types (which are now handled by NoOpHandler).

## Notes for downstream

- monitor:health-score has a UI consumer (OrgHealthPanel.tsx) but still has no handler route in ExtensionHandlers.ts. A future plan should either route it to MonitorOpsHandler or add it to the NoOpHandler.
- Several handler-routed types (compare:start, pipeline:execute, dataops:backup, etc.) exist in ExtensionHandlers route registrations but lack type definitions in messages.types.ts. These are outside this plan's scope but should be addressed in a future type audit.
- The i18n keys for scheduler.comingSoon and sync.realtime.comingSoon use English placeholders in de/es/ja/pt-BR locales.
