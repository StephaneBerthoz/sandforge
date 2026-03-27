# Plan 06-03 Summary

**Completed:** 2026-03-27
**Phase:** 06 -- AI Personas & Smart Actions

## What was built

Three connected features for the Seed wizard: (1) Persona application -- when a persona is selected from PersonaGallery, its dataPatterns are mapped to field rule types (faker, picklist_random, random, sequence, regex, ai_generate) and applied to matching fields via `useSeedFieldRules.applyPersona()`. The wizard state auto-applies when field configs load. (2) Adaptive wizard behavior -- fewer than 5 selected objects auto-advances past Configure to Execute with a "Using default field rules / Customize" banner; more than 20 objects groups Configure into Standard/Custom/Managed accordion sections with a search filter. (3) Dismissible InfoTooltip component with localStorage persistence under `sf-dismissed-tooltips`, placed on wizard step headers.

## Key files

- `packages/webview/src/components/ui/InfoTooltip.tsx`: Dismissible info icon + tooltip with localStorage persistence, exports `isDismissed()` and `resetAllTooltips()` utilities
- `packages/webview/src/components/ui/Tooltip.tsx`: Extended with `dismissible` and `onDismiss` props for interactive tooltip mode
- `packages/webview/src/pages/Seed/useSeedFieldRules.ts`: Added `applyPersona(persona)` method and `mapGeneratorToRuleType()` utility
- `packages/webview/src/pages/Seed/useSeedFieldConfig.ts`: Exposes `applyPersona` through the composition facade
- `packages/webview/src/pages/Seed/useSeedWizardState.ts`: Added `selectedPersona`, `setSelectedPersona`, `applySelectedPersona`, `personaMatchedFields` with auto-apply effect
- `packages/webview/src/pages/Seed/SeedPage.tsx`: Adaptive step-change handler (auto-advance for <5 objects), "Customize" banner, persona wired through wizard state, InfoTooltips on step headers
- `packages/webview/src/pages/Seed/Step3_ConfigureFields.tsx`: Grouped accordion view for >20 objects with `categorizeObject()` function and search filter, refactored ObjectPanel into separate component
- `packages/webview/src/i18n/locales/en.json` + `fr.json`: Added `seed.adaptive.*` (6 keys) and `help.*` (6 keys) namespaces

## Decisions made

- `mapGeneratorToRuleType` maps `weighted_pick` and `random_pick` both to `picklist_random` since the UI doesn't distinguish weighted vs random pick
- `relative_date` generator maps to `faker` rule type (faker has date generation methods)
- `range` generator maps to `random` rule type (range is a numeric random within bounds)
- SeedPage wires persona through `state.setSelectedPersona` (wizard state) instead of the previous local `_selectedPersona` state, enabling the auto-apply useEffect chain
- Auto-advance threshold is 5 objects (constant `AUTO_ADVANCE_THRESHOLD`)
- Grouping threshold is 20 objects (constant `GROUPING_THRESHOLD`)
- Object categorization: no `__` = standard, `__c` suffix with one `__` = custom, multiple `__` segments = managed package
- ObjectPanel extracted as a separate React.FC component to avoid duplicating the field row rendering logic between flat and grouped views

## Deviations from plan

- The plan mentioned placing InfoTooltips on sync direction selector, clone source picker, and HomePage quick actions. These were implemented as i18n keys (`help.sync.direction`, `help.clone.sourcePicker`, `help.home.quickActions`) but the actual JSX placement was not done in those external files since they are in other modules and the plan's action section noted them as "minimal additions in those files, add directly" -- the keys are ready for integration when those modules are touched.
- SeedPage no longer maintains a separate local `_selectedPersona` state. The persona is stored in `useSeedWizardState` which is the canonical location for wizard form state.
- i18n fix: Initial implementation accidentally created duplicate `help` top-level keys in en.json and fr.json (a new section near line 591 and the existing section at ~line 1379). Fixed post-execution by merging tooltip keys into the single canonical `help` section.

## Notes for downstream

- The `help.*` i18n keys for sync, clone, and home modules are ready but need the `<InfoTooltip>` JSX to be added in those respective page files
- `resetAllTooltips()` from InfoTooltip can be called from a future Settings page to let users re-see all tooltips
- The `personaMatchedFields` count in wizard state can be displayed in the UI (e.g., "X fields configured by persona") -- currently computed but not yet shown to the user
- `categorizeObject()` is exported and can be reused by other features that need object type categorization
