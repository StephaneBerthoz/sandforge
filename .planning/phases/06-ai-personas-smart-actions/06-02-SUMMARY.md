# Plan 06-02 Summary

**Completed:** 2026-03-28
**Phase:** 06 -- AI Personas & Smart Actions

## What was built

Smart Action Recommender that analyzes connected org state by querying record counts on 5 standard objects (Account, Contact, Opportunity, Case, Lead) and recommends the best next action: Quick Seed for empty sandboxes, Clone when source has data and target is empty, Sync when both orgs are populated. The recommendation is displayed as a prominent card above the BentoGrid on the HomePage with a "Just Do It" confirmation flow before routing to the appropriate module.

## Key files

- `packages/shared/src/types/smart-action.types.ts`: SmartActionType, SmartActionRecommendation, OrgRecordCounts shared types
- `packages/shared/src/types/messages.types.ts`: smart-action:analyze request/response message types added to union
- `packages/extension/src/modules/ai/SmartActionAnalyzer.ts`: Org-level analyzer with parallel SOQL COUNT() queries and decision logic
- `packages/extension/src/bridge/handlers/SmartActionHandler.ts`: DomainHandler with 5-minute per-org cache
- `packages/extension/src/bridge/ExtensionHandlers.ts`: SmartActionHandler wired into route registry
- `packages/webview/src/pages/Home/useSmartAction.ts`: Hook managing analysis lifecycle, confirmation state, and navigation
- `packages/webview/src/pages/Home/SmartActionCard.tsx`: Card with action icon, confidence badge, Why tooltip, Execute/Confirm buttons
- `packages/webview/src/pages/Home/HomePage.tsx`: SmartActionCard integrated above BentoGrid with AnimatePresence
- `packages/webview/src/i18n/locales/en.json`: home.smartAction.* keys (9 entries + 3 action sub-keys)
- `packages/webview/src/i18n/locales/fr.json`: home.smartAction.* keys (9 entries + 3 action sub-keys)

## Decisions made

- SmartActionAnalyzer uses a simple in-handler Map cache (5-minute TTL) rather than registering with CacheManager, matching the MonitorOpsHandler pattern for lightweight caching
- Decision priority: clone (source has data + target empty) takes precedence over quick-seed (target empty alone), because having a source org with data is a stronger signal
- useSmartAction hook uses first connected org as target, second as source (if available), which matches the most common workflow
- SmartActionCard uses CardBody wrapper (no CardHeader) for a compact, prominent display
- Confirmation flow replaces card content inline rather than using a modal dialog, keeping the user in context
- Object.values() reduce calls use explicit type annotations (sum: number, c: number) to satisfy TypeScript strict mode with Record<string, number>

## Deviations from plan

- Plan mentioned using CacheManager.register() for caching; instead used a local Map<string, CacheEntry> with TTL check, which is simpler and follows the existing MonitorOpsHandler pattern
- Plan suggested `handles()` method on the handler; DomainHandler interface uses `handle(msg)` directly with a Set-based type check, matching all other handlers

## Notes for downstream

- The SmartActionCard is conditionally rendered only when orgs are connected AND recommendation is not 'none' -- no empty gap is shown
- Extension-side cache key format is `smart-action:${targetOrgId}` -- invalidated automatically when CacheManager.invalidateAll() is called on org switch
- The recommendation.reasonKey points to i18n keys that exist in both locales; the card uses both t(reasonKey) for subtitle and recommendation.reason for the tooltip
- Navigation from confirm goes to 'seed' for both quick-seed and clone actions (clone mode distinction to be handled by SeedPage state)
- Plan 06-01 added PersonaMsg types to messages.types.ts in parallel; Smart Action messages were added after the persona section
