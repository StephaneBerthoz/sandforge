# Plan 06-01 Summary

**Completed:** 2026-03-27
**Phase:** 06 -- AI Personas & Smart Actions

## What was built

Full Persona Gallery UI for the Seed module's AI mode. Users can browse 10 built-in industry personas (insurance, healthcare, retail, banking, SaaS, real estate, education, logistics, HR, non-profit) displayed as cards with industry icons, locale badges, and field counts. A Preview button opens a popover with 5 sample records generated client-side. A Select button opens a customization panel for adjusting range min/max and pick values. A "Create Custom" card enables AI-powered persona creation. SeedPage's AI mode was restructured to show a fork: "Choose a Persona" (PersonaGallery) or "Start from Scratch" (existing wizard).

## Key files

- `packages/shared/src/types/messages.types.ts`: Added `SeedListPersonasRequest/Response` and `SeedCreatePersonaRequest/Response` message types with `PersonaMsg` and `PersonaFieldPatternMsg` interfaces
- `packages/extension/src/bridge/handlers/SeedOpsHandler.ts`: Wired `seed:list-personas` and `seed:create-persona` handlers using AIPersonaManager
- `packages/webview/src/pages/Seed/Persona/usePersonas.ts`: Hook for persona list fetching, selection, preview, and custom creation + `generateSampleRecords` utility
- `packages/webview/src/pages/Seed/Persona/PersonaCard.tsx`: Card component with industry icon mapping (10 Lucide icons), locale flags, and action buttons
- `packages/webview/src/pages/Seed/Persona/PersonaPreviewPopover.tsx`: Popover with DataTable showing 5 sample records, closes on outside click/Escape
- `packages/webview/src/pages/Seed/Persona/PersonaCustomizePanel.tsx`: Editable field rows for range, random_pick, weighted_pick generators with confirm/cancel
- `packages/webview/src/pages/Seed/Persona/PersonaGallery.tsx`: Responsive grid gallery with loading/error states, create-custom card, preview overlay
- `packages/webview/src/pages/Seed/SeedPage.tsx`: Extended SeedMode type with `ai-persona` and `ai-scratch` sub-modes, fork selector UI
- `packages/webview/src/i18n/locales/en.json` + `fr.json`: Added 25+ keys under `seed.persona.*` namespace

## Decisions made

- Used `PersonaMsg` and `PersonaFieldPatternMsg` as separate message-layer types in messages.types.ts (not importing from AIPersonaManager directly) to keep the shared package decoupled from extension internals
- CardHeader.title accepts string only, so industry icon is placed in the action slot alongside the custom badge
- PersonaPreviewPopover uses a fixed overlay with centered positioning rather than anchor-relative positioning, for better viewport handling in the VSCode webview
- SeedPage back button navigates from ai-persona/ai-scratch back to the fork selector, not directly to the mode selector
- SeedPage stores selected persona in local state (consistent with existing pattern noted in STATE.md decisions)
- generateSampleRecords is a pure function exported separately for testability

## Deviations from plan

- The plan specified `PersonaPreviewPopover` should use anchor-relative positioning with viewport-aware flip. Implemented as a centered fixed overlay instead, which is simpler and more reliable in the VSCode webview context
- The plan mentioned `anchorRef` prop on PersonaPreviewPopover -- replaced with a simpler centered overlay approach
- The `_selectedPersona` state variable is prefixed with underscore since it is not yet consumed by downstream wizard integration (reserved for Plan 06-03)

## Notes for downstream

- The `_selectedPersona` state in SeedPage is ready for Plan 06-03 to pass as a prop to SeedWizard for field pre-fill
- The `createCustom` flow in usePersonas calls `seed:create-persona` which requires an AI provider key in SecretVault -- the handler wiring is in place but actual AI generation depends on the AI provider being configured
- PersonaGallery's `onPersonaSelected` callback receives the customized PersonaMsg with potentially modified dataPatterns -- downstream can use this directly for field rule generation
